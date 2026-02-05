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
// New strategies
import { ORBStrategy } from '../paperTrading/strategies/orbStrategy.js';
import { EMACrossoverStrategy } from '../paperTrading/strategies/emaCrossoverStrategy.js';
import { SRFlipStrategy } from '../paperTrading/strategies/srFlipStrategy.js';
import { LiquiditySweepStrategy } from '../paperTrading/strategies/liquiditySweepStrategy.js';
import { CSVLogger } from '../paperTrading/csvLogger.js';

// 4H Trend Context
import { HigherTimeframeContext } from './higherTimeframeContext.js';

// Strategy Tracker for independent strategy testing
import { StrategyTracker } from './strategyTracker.js';

// Import data fetchers
import {
  fetchBinanceKlines,
  fetchBinanceLastPrice,
  fetchPolymarketEvents,
  fetchPolymarketOrderBook,
  fetchPolymarketPrice
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
    this.htfContext = new HigherTimeframeContext();

    // Strategies - OPTIMIZED based on 1000-market backtest results
    // REMOVED: RSI (35.8% win rate), MEAN_REVERSION (46%), LIQ_SWEEP (33.3%)
    // These strategies were significantly hurting overall performance
    this.strategies = [
      // TOP PERFORMERS (from backtest):
      new MACDStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),     // 72.1% WR, #1
      new MomentumStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }), // 63.9% WR, #2
      new VolatilityBreakoutStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }), // 86.9% WR
      new ORBStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),      // 65.2% WR
      // SOLID PERFORMERS:
      new VolumeProfileStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }), // 78.8% WR
      new SRFlipStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }),   // 62.2% WR
      new PriceActionStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence }), // 54.7% WR
      new TrendConfirmationStrategy({ minConfidence: 0.60 }), // Higher threshold
      new EMACrossoverStrategy({ minConfidence: ALL_DAY_CONFIG.signals.minConfidence })
      // REMOVED (underperforming):
      // - RSIStrategy: 35.8% win rate - TERRIBLE
      // - MeanReversionStrategy: 46.0% win rate - losing money
      // - LiquiditySweepStrategy: 33.3% win rate - TERRIBLE
    ];

    // Logger
    this.logger = new CSVLogger({ sessionId: `allday_${Date.now().toString(36)}` });

    // Strategy Tracker - each strategy gets $500 independently
    this.strategyTracker = new StrategyTracker({
      initialBalance: 500,
      sessionId: Date.now()
    });

    // Initialize all strategies in the tracker
    for (const strategy of this.strategies) {
      this.strategyTracker.initStrategy(strategy.name);
    }
    // Also track aggregated
    this.strategyTracker.initStrategy('AGGREGATED');

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
    this.candles4h = [];
    this.lastPrice = null;
    this.lastVwap = null;
    this.lastRsi = null;
    this.lastMacd = null;
    this.lastRegime = null;
    this.lastHtfUpdate = 0;
  }

  /**
   * Fetch market data from Binance
   */
  async fetchData() {
    try {
      // Fetch 1m and 5m candles every iteration
      const [klines1m, klines5m] = await Promise.all([
        fetchBinanceKlines('BTCUSDT', '1m', 240),
        fetchBinanceKlines('BTCUSDT', '5m', 200)
      ]);

      this.candles1m = klines1m;
      this.candles5m = klines5m;
      this.lastPrice = await fetchBinanceLastPrice('BTCUSDT');

      // Fetch 4H candles less frequently (every 5 minutes)
      const now = Date.now();
      if (now - this.lastHtfUpdate > 5 * 60 * 1000) {
        try {
          this.candles4h = await fetchBinanceKlines('BTCUSDT', '4h', 100);
          this.htfContext.analyze(this.candles4h);
          this.lastHtfUpdate = now;
        } catch (err) {
          console.error(`${colors.yellow}4H data fetch failed: ${err.message}${colors.reset}`);
        }
      }

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
      const regimeResult = detectRegime({
        price: this.lastPrice,
        vwap: this.lastVwap,
        vwapSlope: this.lastVwapSlope
      });
      this.lastRegime = regimeResult?.regime || 'RANGE';

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

      // Extract end time from market - try multiple possible fields
      let marketEndTime = null;
      const endDateField = market.endDate || market.end_date || market.endDateIso;
      if (endDateField) {
        const parsed = new Date(endDateField).getTime();
        if (Number.isFinite(parsed) && parsed > Date.now()) {
          marketEndTime = parsed;
        }
      }

      // Check if market changed
      const isNewMarket = this.currentMarket?.id !== market.id;

      if (isNewMarket) {
        if (this.currentMarket) {
          await this.resolveMarket(this.currentMarket);
        }

        this.currentMarket = market;
        this.currentMarket.endTime = marketEndTime;
        this.priceAtStart = this.lastPrice;
        this.marketStartTime = Date.now();
        this.positionManager.onMarketChange();
        this.microstructure.reset();

        this.sessionState.onNewMarket(market, this.priceAtStart);

        console.log(`\n${colors.cyan}=== NEW MARKET ===${colors.reset}`);
        console.log(`${market.slug}`);
        console.log(`Start Price: $${this.priceAtStart?.toFixed(2)}`);
        if (marketEndTime) {
          const endDate = new Date(marketEndTime);
          console.log(`End Time: ${endDate.toLocaleTimeString()} (${((marketEndTime - Date.now()) / 60000).toFixed(1)} min remaining)`);
        } else {
          console.log(`${colors.yellow}End Time: Unknown (estimating from detection time)${colors.reset}`);
        }
        console.log(`Regime: ${colors.yellow}${this.lastRegime}${colors.reset}`);

        // Debug: log token IDs for orderbook fetching
        let debugTokenIds = market.clobTokenIds;
        if (typeof debugTokenIds === 'string') {
          try { debugTokenIds = JSON.parse(debugTokenIds); } catch (e) { debugTokenIds = null; }
        }
        const yesToken = debugTokenIds?.[0] || market.tokens?.[0]?.token_id;
        const noToken = debugTokenIds?.[1] || market.tokens?.[1]?.token_id;
        console.log(`${colors.dim}[DEBUG] YES token: ${yesToken || 'NONE'}${colors.reset}`);
        console.log(`${colors.dim}[DEBUG] NO token: ${noToken || 'NONE'}${colors.reset}`);
      } else {
        // Same market - update end time if available
        if (marketEndTime) {
          this.currentMarket.endTime = marketEndTime;
        }
      }

      // ALWAYS fetch live prices from orderbook API
      // The outcomePrices field from /events is stale/cached and NOT reliable

      // Parse clobTokenIds if it's a JSON string
      let tokenIds = market.clobTokenIds;
      if (typeof tokenIds === 'string') {
        try {
          tokenIds = JSON.parse(tokenIds);
        } catch (e) {
          tokenIds = null;
        }
      }

      const yesTokenId = tokenIds?.[0] || market.tokens?.[0]?.token_id;
      const noTokenId = tokenIds?.[1] || market.tokens?.[1]?.token_id;

      // Fetch LIVE prices using the /price endpoint (this is accurate!)
      // curl "https://clob.polymarket.com/price?token_id=XXX&side=BUY"

      if (yesTokenId && noTokenId) {
        try {
          // Fetch both prices in parallel
          const [yesPrice, noPrice] = await Promise.all([
            fetchPolymarketPrice(yesTokenId, 'BUY'),
            fetchPolymarketPrice(noTokenId, 'BUY')
          ]);

          market.yesPrice = yesPrice;
          market.noPrice = noPrice;

          if (isNewMarket) {
            console.log(`${colors.dim}[DEBUG] Live prices from /price API: YES=${yesPrice}, NO=${noPrice}${colors.reset}`);
          }
        } catch (err) {
          console.error(`${colors.yellow}[WARN] Price fetch failed: ${err.message}${colors.reset}`);
          market.yesPrice = 0.50;
          market.noPrice = 0.50;
        }
      } else {
        market.yesPrice = 0.50;
        market.noPrice = 0.50;
      }

      // ALWAYS update currentMarket with fresh prices (not just on new market)
      if (this.currentMarket) {
        this.currentMarket.yesPrice = market.yesPrice;
        this.currentMarket.noPrice = market.noPrice;
      }

      if (isNewMarket) {
        console.log(`${colors.green}[PRICES] YES: ${(market.yesPrice * 100).toFixed(0)}c, NO: ${(market.noPrice * 100).toFixed(0)}c${colors.reset}`);
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

    // Use actual market end time if available
    let endTime = this.currentMarket.endTime;

    if (!endTime) {
      // Fallback to estimate based on when we first saw the market
      endTime = this.marketStartTime + 15 * 60 * 1000;
    }

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

    // Close all strategy tracker positions
    const strategyResults = this.strategyTracker.closeAllForMarket(market.id, outcome, endPrice);

    let wins = 0;
    let losses = 0;

    console.log(`\n${colors.cyan}Strategy Results:${colors.reset}`);
    for (const result of strategyResults) {
      if (result.success) {
        const pnlColor = result.won ? colors.green : colors.red;
        console.log(`  ${result.strategyName.padEnd(20)} | ${result.trade.side} → ${pnlColor}${formatUSD(result.pnl)}${colors.reset} | Bal: $${result.newBalance.toFixed(0)}`);

        if (result.won) wins++;
        else losses++;

        // Record for performance tracking
        this.performanceTracker.recordOutcome(
          result.strategyName,
          result.won,
          result.pnl,
          this.lastRegime
        );
      }
    }

    console.log(`\n  Total: ${colors.green}${wins} wins${colors.reset} / ${colors.red}${losses} losses${colors.reset}`);

    // Also close old engine positions (legacy)
    const results = this.engine.closeAllForMarket(market.id, outcome, outcome === 'UP' ? 1 : 0);
    for (const result of results) {
      if (result.success) {
        this.sessionState.recordTrade(result.trade);
        this.logger.logTrade(result.trade, this.engine.balance);
      }
    }

    // Write summary CSV
    this.strategyTracker.writeSummaryCSV();
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

    // 3. Don't trade in first minute or last 3 minutes
    // Late entries have poor risk/reward - not enough time for BTC to move
    if (remainingMinutes > 14 || remainingMinutes < 3) {
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

    // Get 4H trend info
    const htf = this.htfContext.getCachedAnalysis();
    const htfTrend = htf.trend || 'UNKNOWN';

    // Market data for entries
    const yesPrice = this.currentMarket?.yesPrice || 0.50;
    const noPrice = this.currentMarket?.noPrice || 0.50;

    // 5. INDEPENDENT STRATEGY TRADING
    // Each strategy can trade on its own with its own $500 balance
    const betSize = 35; // Fixed $35 bet per strategy

    let tradesOpened = 0;

    for (const strategy of this.strategies) {
      // Check if this strategy already has a position in this market
      const existingPos = this.strategyTracker.getPosition(strategy.name, this.currentMarket?.id);
      if (existingPos) continue;

      // Get signal from this strategy
      const signal = strategy.analyze(analysisData);

      if (signal && signal.side && signal.confidence >= ALL_DAY_CONFIG.signals.minConfidence) {
        // Calculate entry price based on side
        const contractPrice = signal.side === 'UP' ? yesPrice : noPrice;

        // PRICE GUARD: Skip trades at extreme prices (no edge possible)
        // Don't buy contracts above 85c or below 15c - risk/reward is terrible
        if (contractPrice > 0.85 || contractPrice < 0.15) {
          continue; // Skip this trade
        }

        const entryPrice = Math.min(0.99, contractPrice + 0.01); // Slight premium

        // Open position for this strategy
        const result = this.strategyTracker.openPosition(strategy.name, {
          side: signal.side,
          entryPrice,
          size: betSize,
          confidence: signal.confidence,
          marketId: this.currentMarket?.id,
          marketSlug: this.currentMarket?.slug,
          btcPriceAtEntry: this.lastPrice,
          btcPriceAtMarketStart: this.priceAtStart,
          contractPriceAtEntry: contractPrice,
          regime: this.lastRegime,
          htfTrend,
          remainingMinutes
        });

        if (result.success) {
          tradesOpened++;
          strategy.recordTrade();
        }
      }
    }

    // 6. Also run aggregated signal as its own "strategy"
    const aggregatedSignal = this.signalAggregator.aggregate(
      this.strategies,
      analysisData,
      this.lastRegime
    );

    if (aggregatedSignal.action === 'ENTER') {
      const existingAggPos = this.strategyTracker.getPosition('AGGREGATED', this.currentMarket?.id);

      if (!existingAggPos) {
        const contractPrice = aggregatedSignal.side === 'UP' ? yesPrice : noPrice;

        // PRICE GUARD: Skip trades at extreme prices (no edge possible)
        if (contractPrice <= 0.85 && contractPrice >= 0.15) {
          const entryPrice = Math.min(0.99, contractPrice + 0.01);

          const result = this.strategyTracker.openPosition('AGGREGATED', {
            side: aggregatedSignal.side,
            entryPrice,
            size: betSize,
            confidence: aggregatedSignal.confidence,
            marketId: this.currentMarket?.id,
            marketSlug: this.currentMarket?.slug,
            btcPriceAtEntry: this.lastPrice,
            btcPriceAtMarketStart: this.priceAtStart,
            contractPriceAtEntry: contractPrice,
            regime: this.lastRegime,
            htfTrend,
            remainingMinutes
          });

          if (result.success) {
            tradesOpened++;
          }
        }
      }
    }

    // 7. Print trades opened this iteration
    if (tradesOpened > 0) {
      const allPos = this.strategyTracker.getAllPositions();
      const marketPos = allPos.filter(p => p.marketId === this.currentMarket?.id);

      console.log(`\n${colors.bright}>>> ${tradesOpened} NEW TRADES <<<${colors.reset}`);
      for (const pos of marketPos.slice(-tradesOpened)) {
        const sideColor = pos.side === 'UP' ? colors.green : colors.red;
        console.log(`  ${pos.strategyName.padEnd(20)} | ${sideColor}${pos.side}${colors.reset} | $${pos.size.toFixed(0)} @ ${(pos.contractPriceAtEntry * 100).toFixed(0)}c | Conf: ${(pos.confidence * 100).toFixed(0)}%`);
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

    // Get strategy positions and contract prices
    const allPositions = this.strategyTracker.getAllPositions();
    const marketPositions = allPositions.filter(p => p.marketId === this.currentMarket?.id);
    const yesPrice = this.currentMarket?.yesPrice || 0.50;
    const noPrice = this.currentMarket?.noPrice || 0.50;

    let status = `${colors.dim}[${new Date().toLocaleTimeString()}]${colors.reset} `;
    status += `BTC: $${this.lastPrice?.toFixed(0) || '---'} | `;

    // Show contract prices
    status += `YES: ${(yesPrice * 100).toFixed(0)}c NO: ${(noPrice * 100).toFixed(0)}c | `;

    // Show position count
    status += `Pos: ${marketPositions.length} | `;
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

    // Strategy Leaderboard (Independent Trading)
    console.log(`${colors.cyan}STRATEGY LEADERBOARD${colors.reset}`);
    const summaries = this.strategyTracker.getAllStrategySummaries();
    for (const s of summaries) {
      const returnColor = s.returnPct >= 0 ? colors.green : colors.red;
      const wrColor = s.winRate >= 50 ? colors.green : colors.red;
      console.log(`  ${s.name.padEnd(20)} | $${s.balance.toFixed(0).padStart(5)} (${returnColor}${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%${colors.reset}) | W/L: ${s.wins}/${s.losses} (${wrColor}${s.winRate.toFixed(0)}%${colors.reset}) | Pos: ${s.activePositions}`);
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

    console.log(`Mode: ${colors.cyan}INDEPENDENT STRATEGY TESTING${colors.reset}`);
    console.log(`Each strategy gets: ${colors.green}$500${colors.reset}`);
    console.log(`Strategies: ${this.strategies.length + 1} (${this.strategies.map(s => s.name).join(', ')}, AGGREGATED)`);
    console.log(`Poll Interval: ${this.pollInterval}ms`);
    console.log(`CSV Log: ${colors.dim}${this.strategyTracker.tradesFile}${colors.reset}`);
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

    // Write final summary CSV
    const summaryFile = this.strategyTracker.writeSummaryCSV();

    console.log(`\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}                    FINAL STRATEGY RESULTS${colors.reset}`);
    console.log(`${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

    const summaries = this.strategyTracker.getAllStrategySummaries();
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const returnColor = s.returnPct >= 0 ? colors.green : colors.red;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
      console.log(`${medal} ${(i + 1).toString().padStart(2)}. ${s.name.padEnd(20)} | $${s.balance.toFixed(2).padStart(7)} (${returnColor}${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(2)}%${colors.reset}) | W/L: ${s.wins}/${s.losses} | WR: ${s.winRate.toFixed(1)}%`);
    }

    console.log(`\n${colors.cyan}CSV Files:${colors.reset}`);
    console.log(`  Trades: ${this.strategyTracker.tradesFile}`);
    console.log(`  Summary: ${summaryFile}`);
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
