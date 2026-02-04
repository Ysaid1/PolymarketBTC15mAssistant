#!/usr/bin/env node
/**
 * Polymarket BTC 15m Trading Bot
 * Automatically trades based on TA signals
 *
 * Usage: node src/trading/bot.js
 *
 * IMPORTANT: Set DRY_RUN=true in .env for testing!
 */

import { CONFIG } from "../config.js";
import { fetchKlines, fetchLastPrice } from "../data/binance.js";
import { fetchChainlinkBtcUsd } from "../data/chainlink.js";
import { startChainlinkPriceStream } from "../data/chainlinkWs.js";
import { startPolymarketChainlinkPriceStream } from "../data/polymarketLiveWs.js";
import {
  fetchLiveEventsBySeriesId,
  flattenEventMarkets,
  pickLatestLiveMarket,
  fetchClobPrice,
  fetchOrderBook,
  summarizeOrderBook
} from "../data/polymarket.js";
import { computeSessionVwap, computeVwapSeries } from "../indicators/vwap.js";
import { computeRsi, sma, slopeLast } from "../indicators/rsi.js";
import { computeMacd } from "../indicators/macd.js";
import { computeHeikenAshi, countConsecutive } from "../indicators/heikenAshi.js";
import { detectRegime } from "../engines/regime.js";
import { scoreDirection, applyTimeAwareness } from "../engines/probability.js";
import { computeEdge, decide } from "../engines/edge.js";
import { sleep, getCandleWindowTiming } from "../utils.js";
import { startBinanceTradeStream } from "../data/binanceWs.js";
import { applyGlobalProxyFromEnv } from "../net/proxy.js";
import { TRADING_CONFIG, validateTradingConfig } from "./config.js";
import { executeTrade, getTradingStatus, getDailyStats } from "./executor.js";
import { getBacktestStats } from "../backtest.js";

applyGlobalProxyFromEnv();

// ANSI colors for console output
const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[97m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function log(level, message) {
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  const colors = {
    INFO: ANSI.cyan,
    WARN: ANSI.yellow,
    ERROR: ANSI.red,
    TRADE: ANSI.green,
    SIGNAL: ANSI.magenta,
  };
  const color = colors[level] || ANSI.white;
  console.log(`${ANSI.dim}[${timestamp}]${ANSI.reset} ${color}[${level}]${ANSI.reset} ${message}`);
}

// Track positions to avoid duplicate trades
const activePositions = new Map();

async function resolveCurrentMarket() {
  const events = await fetchLiveEventsBySeriesId({ seriesId: CONFIG.polymarket.seriesId, limit: 25 });
  const markets = flattenEventMarkets(events);
  return pickLatestLiveMarket(markets);
}

function extractTokenIds(market) {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : JSON.parse(market.outcomes || "[]");
  const clobTokenIds = Array.isArray(market.clobTokenIds) ? market.clobTokenIds : JSON.parse(market.clobTokenIds || "[]");

  let upTokenId = null;
  let downTokenId = null;

  for (let i = 0; i < outcomes.length; i++) {
    const label = String(outcomes[i]).toLowerCase();
    const tokenId = clobTokenIds[i] ? String(clobTokenIds[i]) : null;
    if (!tokenId) continue;

    if (label === "up") upTokenId = tokenId;
    if (label === "down") downTokenId = tokenId;
  }

  return { upTokenId, downTokenId };
}

async function runTradingLoop() {
  log("INFO", "Starting trading bot...");

  // Validate configuration
  const configValidation = validateTradingConfig();
  if (!configValidation.valid) {
    log("ERROR", "Configuration errors:");
    configValidation.errors.forEach((e) => log("ERROR", `  - ${e}`));
    if (!TRADING_CONFIG.dryRun) {
      log("ERROR", "Fix configuration or enable DRY_RUN mode");
      process.exit(1);
    }
  }

  // Show trading status
  const status = getTradingStatus();
  log("INFO", `Trading: ${status.enabled ? "ENABLED" : "DISABLED"}`);
  log("INFO", `Dry Run: ${status.dryRun ? "YES (simulated)" : "NO (LIVE!)"}`);
  log("INFO", `Max Bet: $${status.maxBetSize}`);
  log("INFO", `Min Edge: ${(status.minEdge * 100).toFixed(0)}%`);

  if (!status.dryRun && status.enabled) {
    log("WARN", "");
    log("WARN", "!!! LIVE TRADING ENABLED !!!");
    log("WARN", "Real money will be used!");
    log("WARN", "Press Ctrl+C within 10 seconds to cancel...");
    log("WARN", "");
    await sleep(10000);
  }

  // Start data streams
  const binanceStream = startBinanceTradeStream({ symbol: CONFIG.symbol });
  const polymarketLiveStream = startPolymarketChainlinkPriceStream({});
  const chainlinkStream = startChainlinkPriceStream({});

  let priceToBeatState = { slug: null, value: null };

  log("INFO", "Data streams connected. Monitoring for signals...");

  while (true) {
    try {
      const timing = getCandleWindowTiming(CONFIG.candleWindowMinutes);

      // Get WebSocket prices
      const wsTick = binanceStream.getLast();
      const wsPrice = wsTick?.price ?? null;
      const polymarketWsTick = polymarketLiveStream.getLast();
      const polymarketWsPrice = polymarketWsTick?.price ?? null;
      const chainlinkWsTick = chainlinkStream.getLast();
      const chainlinkWsPrice = chainlinkWsTick?.price ?? null;

      // Fetch market data
      const chainlinkPromise = polymarketWsPrice !== null
        ? Promise.resolve({ price: polymarketWsPrice })
        : chainlinkWsPrice !== null
          ? Promise.resolve({ price: chainlinkWsPrice })
          : fetchChainlinkBtcUsd();

      const [klines1m, lastPrice, chainlink, market] = await Promise.all([
        fetchKlines({ interval: "1m", limit: 240 }),
        fetchLastPrice(),
        chainlinkPromise,
        resolveCurrentMarket(),
      ]);

      if (!market) {
        log("WARN", "No active market found");
        await sleep(5000);
        continue;
      }

      const marketSlug = market.slug || market.id;
      const currentPrice = chainlink?.price ?? null;

      // Get settlement time
      const settlementMs = market.endDate ? new Date(market.endDate).getTime() : null;
      const timeLeftMin = settlementMs ? (settlementMs - Date.now()) / 60000 : timing.remainingMinutes;

      // Update price to beat
      if (priceToBeatState.slug !== marketSlug) {
        priceToBeatState = { slug: marketSlug, value: currentPrice };
        log("INFO", `New market: ${marketSlug} | Price to beat: $${currentPrice?.toFixed(2) || "?"}`);
      }

      const priceToBeat = priceToBeatState.value;

      // Get token IDs and prices
      const { upTokenId, downTokenId } = extractTokenIds(market);

      if (!upTokenId || !downTokenId) {
        log("WARN", "Could not extract token IDs");
        await sleep(5000);
        continue;
      }

      const [upPrice, downPrice] = await Promise.all([
        fetchClobPrice({ tokenId: upTokenId, side: "buy" }),
        fetchClobPrice({ tokenId: downTokenId, side: "buy" }),
      ]);

      // Run technical analysis
      const candles = klines1m;
      const closes = candles.map((c) => c.close);
      const vwapSeries = computeVwapSeries(candles);
      const vwapNow = vwapSeries[vwapSeries.length - 1];
      const vwapSlope = vwapSeries.length >= 5 ? (vwapNow - vwapSeries[vwapSeries.length - 5]) / 5 : null;
      const vwapDist = vwapNow ? (lastPrice - vwapNow) / vwapNow : null;

      const rsiNow = computeRsi(closes, CONFIG.rsiPeriod);
      const rsiSeries = [];
      for (let i = 0; i < closes.length; i++) {
        const r = computeRsi(closes.slice(0, i + 1), CONFIG.rsiPeriod);
        if (r !== null) rsiSeries.push(r);
      }
      const rsiSlope = slopeLast(rsiSeries, 3);

      const macd = computeMacd(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSignal);
      const ha = computeHeikenAshi(candles);
      const consec = countConsecutive(ha);

      const failedVwapReclaim = vwapNow !== null && vwapSeries.length >= 3
        ? closes[closes.length - 1] < vwapNow && closes[closes.length - 2] > vwapSeries[vwapSeries.length - 2]
        : false;

      // Score direction
      const scored = scoreDirection({
        price: lastPrice,
        vwap: vwapNow,
        vwapSlope,
        rsi: rsiNow,
        rsiSlope,
        macd,
        heikenColor: consec.color,
        heikenCount: consec.count,
        failedVwapReclaim,
      });

      const timeAware = applyTimeAwareness(scored.rawUp, timeLeftMin, CONFIG.candleWindowMinutes);

      // Compute edge
      const edge = computeEdge({
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
        marketYes: upPrice,
        marketNo: downPrice,
      });

      // Get trading decision
      const decision = decide({
        remainingMinutes: timeLeftMin,
        edgeUp: edge.edgeUp,
        edgeDown: edge.edgeDown,
        modelUp: timeAware.adjustedUp,
        modelDown: timeAware.adjustedDown,
      });

      // Log current state
      const statusLine = [
        `${marketSlug.slice(0, 25)}`,
        `Time: ${timeLeftMin.toFixed(1)}m`,
        `BTC: $${currentPrice?.toFixed(0) || "?"}`,
        `Up: ${(timeAware.adjustedUp * 100).toFixed(0)}%`,
        `Edge: ${(Math.max(edge.edgeUp, edge.edgeDown) * 100).toFixed(1)}%`,
        `Signal: ${decision.action === "ENTER" ? decision.side : "HOLD"}`,
      ].join(" | ");
      process.stdout.write(`\r${ANSI.dim}${statusLine}${ANSI.reset}                    `);

      // Check for trade signal
      if (decision.action === "ENTER" && TRADING_CONFIG.enabled) {
        const positionKey = `${marketSlug}_${decision.side}`;

        // Avoid duplicate trades on same market/side
        if (activePositions.has(positionKey)) {
          // Already traded this market
        } else {
          console.log(""); // New line after status
          log("SIGNAL", `${decision.side} signal detected! Edge: ${((decision.side === "UP" ? edge.edgeUp : edge.edgeDown) * 100).toFixed(1)}%`);

          const result = await executeTrade({
            signal: decision,
            marketId: marketSlug,
            upTokenId,
            downTokenId,
            marketUpPrice: upPrice,
            marketDownPrice: downPrice,
            modelUp: timeAware.adjustedUp,
            modelDown: timeAware.adjustedDown,
            edgeUp: edge.edgeUp,
            edgeDown: edge.edgeDown,
            timeLeftMin,
          });

          if (result.success) {
            activePositions.set(positionKey, result.trade);
            log("TRADE", `Executed: ${result.trade.side} $${result.trade.size} @ ${result.trade.price} (${result.trade.dryRun ? "DRY RUN" : "LIVE"})`);
          } else {
            log("WARN", `Trade not executed: ${result.reason}`);
          }
        }
      }

      // Clean up old positions when market changes
      for (const [key, position] of activePositions) {
        if (!key.startsWith(marketSlug)) {
          activePositions.delete(key);
        }
      }

      await sleep(CONFIG.pollIntervalMs);
    } catch (error) {
      console.log("");
      log("ERROR", error.message);
      await sleep(5000);
    }
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("");
  log("INFO", "Shutting down trading bot...");
  const stats = getDailyStats();
  log("INFO", `Daily trades: ${stats.tradesPlaced}`);
  process.exit(0);
});

// Run the bot
runTradingLoop().catch((error) => {
  log("ERROR", `Fatal error: ${error.message}`);
  process.exit(1);
});
