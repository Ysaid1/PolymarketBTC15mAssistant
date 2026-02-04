#!/usr/bin/env node

/**
 * All-Day Trading System
 *
 * Unified automated trading across multiple 15-minute BTC markets.
 * Features: Signal aggregation, dynamic exits, risk management.
 *
 * Usage:
 *   node src/allDayTrader/index.js
 *   node src/allDayTrader/index.js --balance 1000
 */

import 'dotenv/config';

// Import components
import { ALL_DAY_CONFIG } from './config.js';
import { SessionState } from './sessionState.js';
import { PerformanceTracker } from './performanceTracker.js';
import { SignalAggregator } from './signalAggregator.js';
import { RegimeRouter } from './regimeRouter.js';
import { PositionManager } from './positionManager.js';
import { RiskManager } from './riskManager.js';
import { MicrostructureAnalyzer } from './microstructureAnalyzer.js';

// Import existing infrastructure
import { PaperTradingEngine } from '../paperTrading/engine.js';
import { MomentumStrategy } from '../paperTrading/strategies/momentumStrategy.js';
import { MeanReversionStrategy } from '../paperTrading/strategies/meanReversionStrategy.js';
import { VolatilityBreakoutStrategy } from '../paperTrading/strategies/volatilityBreakoutStrategy.js';
import { RSIStrategy } from '../paperTrading/strategies/rsiStrategy.js';
import { MACDStrategy } from '../paperTrading/strategies/macdStrategy.js';
import { TrendConfirmationStrategy } from '../paperTrading/strategies/trendConfirmationStrategy.js';
import { PriceActionStrategy } from '../paperTrading/strategies/priceActionStrategy.js';
import { VolumeProfileStrategy } from '../paperTrading/strategies/volumeProfileStrategy.js';
import { CSVLogger } from '../paperTrading/csvLogger.js';

// Import data fetchers
import {
  fetchBinanceKlines,
  fetchBinanceLastPrice,
  fetchPolymarketEvents,
  fetchPolymarketOrderBook
} from '../paperTrading/httpClient.js';
import { computeSessionVwap, computeVwapSeries } from '../indicators/vwap.js';
import { computeRsi, slopeLast } from '../indicators/rsi.js';
import { computeMacd } from '../indicators/macd.js';
import { detectRegime } from '../engines/regime.js';
import { CONFIG } from '../config.js';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function formatUSD(amount) {
  const sign = amount >= 0 ? '+' : '';
  return `${sign}$${amount.toFixed(2)}`;
}

function formatPct(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * All-Day Trading Orchestrator
 */
class AllDayTrader {
  constructor(options = {}) {
    const initialBalance = options.initialBalance || ALL_DAY_CONFIG.session.initialBalance;
    const pollInterval = options.pollInterval || ALL_DAY_CONFIG.session.pollInterval;

    // Core state
    this.sessionState = new SessionState(initialBalance);
    this.performanceTracker = new PerformanceTracker();

    // Trading engine
    this.engine = new PaperTradingEngine({
      initialBalance,
      minRiskPercent: ALL_DAY_CONFIG.risk.minBetSize / initialBalance,
      maxRiskPercent: ALL_DAY_CONFIG.risk.maxSinglePosition,
      maxTotalExposure: ALL_DAY_CONFIG.risk.maxTotalExposure
    });

    // Components
    this.signalAggregator = new SignalAggregator(this.performanceTracker);
    this.regimeRouter = new RegimeRouter();
    this.positionManager = new PositionManager(this.engine);
    this.riskManager = new RiskManager(this.sessionState);
    this.microstructure = new MicrostructureAnalyzer();

    // Strategies
    // 8 strategies for signal aggregation
    this.strategies = [
      // Original 5
      new MomentumStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      new MeanReversionStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      new VolatilityBreakoutStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      new RSIStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      new MACDStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      // New 3
      new TrendConfirmationStrategy({ minConfidence: 0.60 }), // Higher threshold
      new PriceActionStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),
      new VolumeProfileStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence })
    ];

    // Logger
    this.logger = new CSVLogger({ sessionId: `allday_${Date.now().toString(36)}` });

    // Configuration
    this.pollInterval = pollInterval;
    this.running = false;
    this.loopCount = 0;

    // Market state
    this.currentMarket = null;
    this.priceAtStart = null;
    this.marketStartTime = null;

    // Data cache
    this.candles1m = [];
    this.candles5m = [];
    this.lastPrice = null;
    this.lastVwap = null;
    this.lastRsi = null;
    this.lastMacd = null;
    this.lastRegime = null;
  }

  /**
   * Fetch market data from Binance
   */
  async fetchData() {
    try {
      const [klines1m, klines5m] = await Promise.all([
        fetchBinanceKlines('BTCUSDT', '1m', 240),
        fetchBinanceKlines('BTCUSDT', '5m', 200)
      ]);

      this.candles1m = klines1m;
      this.candles5m = klines5m;
      this.lastPrice = await fetchBinanceLastPrice('BTCUSDT');

      // Calculate indicators
      const closes = this.candles1m.map(c => c.close);
      this.lastVwap = computeSessionVwap(this.candles1m);

      const vwapSeries = computeVwapSeries(this.candles1m);
      this.lastVwapSlope = vwapSeries.length >= 5 ? slopeLast(vwapSeries, 5) : 0;

      this.lastRsi = computeRsi(closes, 14);

      const rsiSeries = [];
      for (let i = 14; i <= closes.length; i++) {
        rsiSeries.push(computeRsi(closes.slice(0, i), 14));
      }
      this.lastRsiSlope = rsiSeries.length >= 5 ? slopeLast(rsiSeries, 5) : 0;

      this.lastMacd = computeMacd(closes, 12, 26, 9);
      this.lastRegime = detectRegime({
        price: this.lastPrice,
        vwap: this.lastVwap,
        vwapSlope: this.lastVwapSlope
      });

      return true;
    } catch (error) {
      console.error(`${colors.red}Data fetch error: ${error.message}${colors.reset}`);
      return false;
    }
  }

  /**
   * Fetch Polymarket market data
   */
  async fetchMarket() {
    try {
      const seriesId = CONFIG.polymarket?.seriesId || '10192';
      const events = await fetchPolymarketEvents(seriesId, 10);
      const markets = this.flattenEventMarkets(events);
      const market = this.pickLatestLiveMarket(markets);

      if (!market) return null;

      // Check if market changed
      if (this.currentMarket?.id !== market.id) {
        if (this.currentMarket) {
          await this.resolveMarket(this.currentMarket);
        }

        this.currentMarket = market;
        this.priceAtStart = this.lastPrice;
        this.marketStartTime = Date.now();
        this.positionManager.onMarketChange();
        this.microstructure.reset();

        this.sessionState.onNewMarket(market, this.priceAtStart);

        console.log(`\n${colors.cyan}=== NEW MARKET ===${colors.reset}`);
        console.log(`${market.slug}`);
        console.log(`Start Price: $${this.priceAtStart?.toFixed(2)}`);
        console.log(`Regime: ${colors.yellow}${this.lastRegime}${colors.reset}`);
      }

      // Fetch order book
      const yesTokenId = market.clobTokenIds?.[0] || market.tokens?.[0]?.token_id;
      if (yesTokenId) {
        try {
          const orderbook = await fetchPolymarketOrderBook(yesTokenId);
          market.orderbook = this.summarizeOrderBook(orderbook);
          market.yesPrice = market.orderbook.bestBid || 0.50;
          market.noPrice = market.orderbook.bestAsk ? (1 - market.orderbook.bestAsk) : 0.50;
        } catch {
          market.yesPrice = 0.50;
          market.noPrice = 0.50;
        }
      }

      return market;
    } catch (error) {
      console.error(`${colors.red}Market fetch error: ${error.message}${colors.reset}`);
      return this.currentMarket;
    }
  }

  flattenEventMarkets(events) {
    const out = [];
    for (const e of Array.isArray(events) ? events : []) {
      for (const m of Array.isArray(e.markets) ? e.markets : []) {
        out.push(m);
      }
    }
    return out;
  }

  pickLatestLiveMarket(markets, nowMs = Date.now()) {
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const enriched = markets
      .map((m) => {
        const endMs = m.endDate ? new Date(m.endDate).getTime() : null;
        const startMs = m.eventStartTime || m.startTime || m.startDate
          ? new Date(m.eventStartTime || m.startTime || m.startDate).getTime()
          : null;
        return { m, endMs, startMs };
      })
      .filter((x) => x.endMs !== null && Number.isFinite(x.endMs));

    const live = enriched
      .filter((x) => {
        const started = x.startMs === null ? true : x.startMs <= nowMs;
        return started && nowMs < x.endMs;
      })
      .sort((a, b) => a.endMs - b.endMs);

    if (live.length) return live[0].m;

    const upcoming = enriched
      .filter((x) => nowMs < x.endMs)
      .sort((a, b) => a.endMs - b.endMs);

    return upcoming.length ? upcoming[0].m : null;
  }

  summarizeOrderBook(book) {
    const bids = Array.isArray(book?.bids) ? book.bids : [];
    const asks = Array.isArray(book?.asks) ? book.asks : [];

    let bestBid = null;
    let bidLiquidity = 0;
    for (const lvl of bids.slice(0, 5)) {
      const p = parseFloat(lvl.price);
      const s = parseFloat(lvl.size);
      if (Number.isFinite(p)) {
        if (bestBid === null || p > bestBid) bestBid = p;
        if (Number.isFinite(s)) bidLiquidity += s;
      }
    }

    let bestAsk = null;
    let askLiquidity = 0;
    for (const lvl of asks.slice(0, 5)) {
      const p = parseFloat(lvl.price);
      const s = parseFloat(lvl.size);
      if (Number.isFinite(p)) {
        if (bestAsk === null || p < bestAsk) bestAsk = p;
        if (Number.isFinite(s)) askLiquidity += s;
      }
    }

    const spread = bestBid && bestAsk ? bestAsk - bestBid : null;

    return { bestBid, bestAsk, spread, bidLiquidity, askLiquidity };
  }

  getRemainingMinutes() {
    if (!this.currentMarket) return 15;
    const endTime = this.currentMarket.endTime || (this.marketStartTime + 15 * 60 * 1000);
    const remaining = (endTime - Date.now()) / (1000 * 60);
    return Math.max(0, Math.min(15, remaining));
  }

  /**
   * Resolve a market and close positions
   */
  async resolveMarket(market) {
    if (!market || !this.priceAtStart) return;

    const endPrice = this.lastPrice;
    const outcome = endPrice > this.priceAtStart ? 'UP' : 'DOWN';

    console.log(`\n${colors.yellow}=== MARKET RESOLVED ===${colors.reset}`);
    console.log(`Start: $${this.priceAtStart.toFixed(2)} → End: $${endPrice.toFixed(2)}`);
    console.log(`Outcome: ${outcome === 'UP' ? colors.green : colors.red}${outcome}${colors.reset}`);

    const results = this.engine.closeAllForMarket(market.id, outcome, outcome === 'UP' ? 1 : 0);

    for (const result of results) {
      if (result.success) {
        const trade = result.trade;
        const pnlColor = result.won ? colors.green : colors.red;

        console.log(`  ${trade.strategyName}: ${trade.side} → ${pnlColor}${formatUSD(result.pnl)}${colors.reset}`);

        // Record for tracking
        this.sessionState.recordTrade(trade);
        this.performanceTracker.recordOutcome(
          trade.strategyName,
          result.won,
          result.pnl,
          this.lastRegime
        );

        this.logger.logTrade(trade, this.engine.balance);
      }
    }
  }

  /**
   * Main trading loop iteration
   */
  async runIteration() {
    const remainingMinutes = this.getRemainingMinutes();

    // 1. Check early exits on existing positions
    if (this.engine.positions.length > 0) {
      const currentSharePrices = {
        UP: this.currentMarket?.yesPrice || 0.50,
        DOWN: this.currentMarket?.noPrice || 0.50
      };

      const exitResults = this.positionManager.processExits(currentSharePrices, remainingMinutes);

      for (const result of exitResults) {
        if (result.success) {
          const pnlColor = result.won ? colors.green : colors.red;
          console.log(`\n${colors.yellow}>>> EXIT: ${result.action} <<<${colors.reset}`);
          console.log(`  Strategy: ${result.strategyName}`);
          console.log(`  Side: ${result.side}`);
          console.log(`  P/L: ${pnlColor}${formatUSD(result.pnl)}${colors.reset}`);

          // Record
          this.sessionState.recordTrade({
            strategyName: result.strategyName,
            won: result.won,
            pnl: result.pnl
          });

          if (ALL_DAY_CONFIG.logging.logExits) {
            this.logger.logSignal(null, {
              strategyName: result.strategyName,
              actionTaken: result.action,
              pnl: result.pnl
            });
          }
        }
      }
    }

    // 2. Check if we can trade
    if (!this.riskManager.canTrade()) {
      return;
    }

    // 3. Don't trade in first or last minute
    if (remainingMinutes > 14 || remainingMinutes < 1) {
      return;
    }

    // 4. Prepare analysis data
    const analysisData = {
      candles: this.candles1m,
      candles5m: this.candles5m,
      price: this.lastPrice,
      vwap: this.lastVwap,
      vwapSlope: this.lastVwapSlope,
      rsi: this.lastRsi,
      rsiSlope: this.lastRsiSlope,
      macd: this.lastMacd,
      regime: this.lastRegime,
      remainingMinutes
    };

    // 5. Get aggregated signal
    const aggregatedSignal = this.signalAggregator.aggregate(
      this.strategies,
      analysisData,
      this.lastRegime
    );

    // 6. Log signal
    if (ALL_DAY_CONFIG.logging.logSignals) {
      this.logger.logSignal(aggregatedSignal, {
        strategyName: 'AGGREGATED',
        marketId: this.currentMarket?.id,
        price: this.lastPrice,
        regime: this.lastRegime,
        remainingMinutes,
        actionTaken: aggregatedSignal.action
      });
    }

    // 7. Execute if we have an entry signal
    if (aggregatedSignal.action === 'ENTER') {
      // Check if we should enter
      const canEnter = this.positionManager.shouldEnter(
        { ...aggregatedSignal, marketId: this.currentMarket?.id },
        this.riskManager
      );

      if (!canEnter.canEnter) {
        return;
      }

      // Prepare market data for entry calculation
      const marketData = {
        yesPrice: this.currentMarket?.yesPrice || 0.50,
        noPrice: this.currentMarket?.noPrice || 0.50,
        remainingMinutes,
        orderbook: this.currentMarket?.orderbook
      };

      // Calculate entry parameters
      const entry = this.positionManager.calculateEntry(
        aggregatedSignal,
        marketData,
        this.riskManager
      );

      if (entry.size < ALL_DAY_CONFIG.risk.minBetSize) {
        return;
      }

      // Apply regime size multiplier
      const regimeMult = this.regimeRouter.getSizeMultiplier(this.lastRegime);
      const finalSize = entry.size * regimeMult;

      // Open position
      const result = this.engine.openPosition({
        strategyName: 'AGGREGATED',
        side: aggregatedSignal.side,
        entryPrice: entry.entryPrice,
        size: finalSize,
        confidence: aggregatedSignal.confidence,
        marketId: this.currentMarket?.id,
        marketSlug: this.currentMarket?.slug,
        remainingMinutes,
        signals: aggregatedSignal.signals
      });

      if (result.success) {
        // Record trades for each contributing strategy
        for (const signal of aggregatedSignal.signals) {
          const strategy = this.strategies.find(s => s.name === signal.strategyName);
          if (strategy) strategy.recordTrade();
        }

        console.log(`\n${colors.bright}>>> NEW TRADE <<<${colors.reset}`);
        console.log(`  Signal: ${colors.cyan}AGGREGATED${colors.reset}`);
        console.log(`  Strategies: ${aggregatedSignal.signals.map(s => s.strategyName).join(', ')}`);
        console.log(`  Side: ${aggregatedSignal.side === 'UP' ? colors.green : colors.red}${aggregatedSignal.side}${colors.reset}`);
        console.log(`  Size: $${finalSize.toFixed(2)}`);
        console.log(`  Entry: ${entry.entryPrice.toFixed(4)}`);
        console.log(`  Confidence: ${(aggregatedSignal.confidence * 100).toFixed(1)}%`);
        console.log(`  Strength: ${aggregatedSignal.strength}`);
      }
    }
  }

  /**
   * Display status line
   */
  displayStatus() {
    const remaining = this.getRemainingMinutes();
    const riskStatus = this.riskManager.getRiskStatus();

    process.stdout.write('\x1b[2K\r');

    const balanceColor = this.sessionState.dailyPnL >= 0 ? colors.green : colors.red;
    const winRate = this.sessionState.getWinRate();
    const winRateColor = winRate >= 50 ? colors.green : colors.yellow;

    let status = `${colors.dim}[${new Date().toLocaleTimeString()}]${colors.reset} `;
    status += `BTC: $${this.lastPrice?.toFixed(0) || '---'} | `;
    status += `Balance: ${balanceColor}$${this.sessionState.balance.toFixed(2)}${colors.reset} (${formatPct(this.sessionState.getReturnPercent())}) | `;
    status += `Trades: ${this.sessionState.tradesExecuted} | `;
    status += `Win: ${winRateColor}${winRate.toFixed(0)}%${colors.reset} | `;
    status += `Positions: ${this.engine.positions.length} | `;
    status += `Regime: ${this.lastRegime || '---'} | `;
    status += `Time: ${remaining.toFixed(1)}m`;

    if (riskStatus.tradingHalted) {
      status += ` | ${colors.red}HALTED${colors.reset}`;
    }

    process.stdout.write(status);
  }

  /**
   * Display dashboard
   */
  displayDashboard() {
    console.log(`\n\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}                    ALL-DAY TRADING DASHBOARD${colors.reset}`);
    console.log(`${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

    const summary = this.sessionState.generateSummary();
    const riskStatus = this.riskManager.getRiskStatus();

    // Session Summary
    console.log(`${colors.cyan}SESSION${colors.reset}`);
    console.log(`  Date: ${summary.sessionDate}`);
    console.log(`  Duration: ${summary.durationMinutes} minutes`);
    console.log(`  Markets Traded: ${summary.marketsTraded}`);
    console.log('');

    // Account
    console.log(`${colors.cyan}ACCOUNT${colors.reset}`);
    console.log(`  Initial: $${summary.initialBalance.toFixed(2)}`);
    console.log(`  Current: $${summary.finalBalance.toFixed(2)}`);
    const pnlColor = summary.dailyPnL >= 0 ? colors.green : colors.red;
    console.log(`  P/L: ${pnlColor}${formatUSD(summary.dailyPnL)} (${summary.returnPercent}%)${colors.reset}`);
    console.log(`  Max Drawdown: ${colors.yellow}${summary.maxDrawdown}%${colors.reset}`);
    console.log('');

    // Trading Stats
    console.log(`${colors.cyan}TRADING STATS${colors.reset}`);
    console.log(`  Total Trades: ${summary.totalTrades}`);
    console.log(`  Wins: ${colors.green}${summary.wins}${colors.reset} | Losses: ${colors.red}${summary.losses}${colors.reset}`);
    console.log(`  Win Rate: ${parseFloat(summary.winRate) >= 50 ? colors.green : colors.red}${summary.winRate}%${colors.reset}`);
    console.log('');

    // Risk Status
    console.log(`${colors.cyan}RISK STATUS${colors.reset}`);
    console.log(`  Can Trade: ${riskStatus.canTrade ? colors.green + 'YES' : colors.red + 'NO'}${colors.reset}`);
    console.log(`  Daily Loss: ${riskStatus.dailyLoss} / ${riskStatus.dailyLossLimit}`);
    console.log(`  Consecutive Losses: ${riskStatus.consecutiveLosses} / ${riskStatus.consecutiveLossLimit}`);
    console.log(`  Drawdown Multiplier: ${riskStatus.drawdownMultiplier}x`);
    if (riskStatus.tradingHalted) {
      console.log(`  ${colors.red}HALTED: ${riskStatus.haltReason}${colors.reset}`);
    }
    console.log('');

    // Strategy Performance
    console.log(`${colors.cyan}STRATEGY WEIGHTS${colors.reset}`);
    const weights = this.performanceTracker.getAllWeights();
    for (const [name, data] of Object.entries(weights)) {
      const wr = (data.winRate * 100).toFixed(0);
      const wrColor = data.winRate >= 0.5 ? colors.green : colors.red;
      console.log(`  ${name.padEnd(20)} | Weight: ${data.weight.toFixed(2)} | Win: ${wrColor}${wr}%${colors.reset} | Trades: ${data.trades}`);
    }
    console.log('');

    // Current Market
    if (this.currentMarket) {
      const remaining = this.getRemainingMinutes();
      const priceChange = this.lastPrice && this.priceAtStart
        ? ((this.lastPrice - this.priceAtStart) / this.priceAtStart) * 100
        : 0;
      const changeColor = priceChange >= 0 ? colors.green : colors.red;

      console.log(`${colors.cyan}CURRENT MARKET${colors.reset}`);
      console.log(`  ${this.currentMarket.slug}`);
      console.log(`  Start: $${this.priceAtStart?.toFixed(2)} | Current: $${this.lastPrice?.toFixed(2)} (${changeColor}${formatPct(priceChange)}${colors.reset})`);
      console.log(`  Regime: ${colors.yellow}${this.lastRegime}${colors.reset}`);
      console.log(`  Time Remaining: ${remaining.toFixed(1)} minutes`);
    }

    console.log(`\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
  }

  /**
   * Main run loop
   */
  async run() {
    console.log(`\n${colors.bright}╔═══════════════════════════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.bright}║           ALL-DAY BTC TRADING SYSTEM                      ║${colors.reset}`);
    console.log(`${colors.bright}╚═══════════════════════════════════════════════════════════╝${colors.reset}\n`);

    console.log(`Initial Balance: $${this.sessionState.initialBalance}`);
    console.log(`Strategies: ${this.strategies.map(s => s.name).join(', ')}`);
    console.log(`Poll Interval: ${this.pollInterval}ms`);
    console.log(`\nFeatures:`);
    console.log(`  - Signal Aggregation: ${colors.green}ON${colors.reset}`);
    console.log(`  - Dynamic Exits (TP/SL): ${ALL_DAY_CONFIG.position.takeProfit.enabled ? colors.green + 'ON' : colors.red + 'OFF'}${colors.reset}`);
    console.log(`  - Regime Routing: ${colors.green}ON${colors.reset}`);
    console.log(`  - Risk Management: ${colors.green}ON${colors.reset}`);
    console.log(`\nPress Ctrl+C to stop.\n`);

    this.running = true;

    // Initial fetch
    await this.fetchData();
    await this.fetchMarket();
    this.displayDashboard();

    while (this.running) {
      try {
        this.loopCount++;

        // Fetch data
        const dataOk = await this.fetchData();
        if (!dataOk) {
          await new Promise(r => setTimeout(r, this.pollInterval));
          continue;
        }

        // Check market
        await this.fetchMarket();

        // Run trading logic
        await this.runIteration();

        // Display
        this.displayStatus();

        // Periodic dashboard
        if (this.loopCount % ALL_DAY_CONFIG.logging.dashboardFrequency === 0) {
          this.displayDashboard();
        }

        await new Promise(r => setTimeout(r, this.pollInterval));
      } catch (error) {
        console.error(`\n${colors.red}Loop error: ${error.message}${colors.reset}`);
        await new Promise(r => setTimeout(r, this.pollInterval));
      }
    }
  }

  /**
   * Stop trading
   */
  stop() {
    console.log(`\n${colors.yellow}Stopping all-day trading...${colors.reset}`);
    this.running = false;
    this.displayDashboard();

    const summary = this.sessionState.generateSummary();
    console.log(`\nFinal Balance: $${summary.finalBalance.toFixed(2)}`);
    console.log(`Total P/L: ${formatUSD(summary.dailyPnL)} (${summary.returnPercent}%)`);
    console.log(`Total Trades: ${summary.totalTrades}`);
    console.log(`Win Rate: ${summary.winRate}%`);
  }
}

// Parse CLI args
const args = process.argv.slice(2);
const balanceIdx = args.indexOf('--balance');
const initialBalance = balanceIdx >= 0 ? parseFloat(args[balanceIdx + 1]) || 500 : 500;

// Create and run
const trader = new AllDayTrader({ initialBalance });

process.on('SIGINT', () => {
  trader.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  trader.stop();
  process.exit(0);
});

trader.run().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
