/**
 * Paper Trading Orchestrator
 *
 * Runs all 5 strategies in parallel, managing positions and P/L
 * across strategies with a shared balance pool.
 */

import { PaperTradingEngine } from './engine.js';
import { MomentumStrategy } from './strategies/momentumStrategy.js';
import { MeanReversionStrategy } from './strategies/meanReversionStrategy.js';
import { VolatilityBreakoutStrategy } from './strategies/volatilityBreakoutStrategy.js';
import { RSIStrategy } from './strategies/rsiStrategy.js';
import { MACDStrategy } from './strategies/macdStrategy.js';
import { CSVLogger } from './csvLogger.js';

// Use our custom HTTP client for Node.js < 18 compatibility
import {
  fetchBinanceKlines,
  fetchBinanceLastPrice,
  fetchPolymarketEvents,
  fetchPolymarketOrderBook
} from './httpClient.js';
import { computeSessionVwap, computeVwapSeries } from '../indicators/vwap.js';
import { computeRsi, slopeLast } from '../indicators/rsi.js';
import { computeMacd } from '../indicators/macd.js';
import { detectRegime } from '../engines/regime.js';
import { CONFIG } from '../config.js';

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m'
};

/**
 * Format currency
 */
function formatUSD(amount) {
  const sign = amount >= 0 ? '+' : '';
  return `${sign}$${amount.toFixed(2)}`;
}

/**
 * Format percentage
 */
function formatPct(pct) {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Paper Trading Orchestrator
 */
export class PaperTradingOrchestrator {
  constructor(options = {}) {
    // Configuration
    this.initialBalance = options.initialBalance || 500;
    this.pollInterval = options.pollInterval || 5000; // 5 seconds
    this.minConfidence = options.minConfidence || 0.55;

    // Trading engine
    this.engine = new PaperTradingEngine({
      initialBalance: this.initialBalance,
      minRiskPercent: options.minRiskPercent || 0.02,
      maxRiskPercent: options.maxRiskPercent || 0.05
    });

    // Initialize strategies
    this.strategies = [
      new MomentumStrategy({ minConfidence: this.minConfidence }),
      new MeanReversionStrategy({ minConfidence: this.minConfidence }),
      new VolatilityBreakoutStrategy({ minConfidence: this.minConfidence }),
      new RSIStrategy({ minConfidence: this.minConfidence }),
      new MACDStrategy({ minConfidence: this.minConfidence })
    ];

    // CSV Logger
    this.logger = new CSVLogger({
      sessionId: Date.now().toString(36)
    });

    // State tracking
    this.running = false;
    this.currentMarket = null;
    this.priceAtStart = null;
    this.marketStartTime = null;
    this.marketResolved = false;
    this.loopCount = 0;

    // Market data cache
    this.candles1m = [];
    this.candles5m = [];
    this.lastPrice = null;
    this.lastVwap = null;
    this.lastRsi = null;
    this.lastMacd = null;
    this.lastRegime = null;

    // Per-market positions (to close when market resolves)
    this.marketPositions = new Map();
  }

  /**
   * Fetch market data
   */
  async fetchData() {
    try {
      // Fetch candles using our HTTP client
      const [klines1m, klines5m] = await Promise.all([
        fetchBinanceKlines('BTCUSDT', '1m', 240),
        fetchBinanceKlines('BTCUSDT', '5m', 200)
      ]);

      this.candles1m = klines1m;
      this.candles5m = klines5m;

      // Get current price from Binance
      this.lastPrice = await fetchBinanceLastPrice('BTCUSDT');

      // Calculate indicators
      const closes = this.candles1m.map(c => c.close);
      this.lastVwap = computeSessionVwap(this.candles1m);

      // Calculate VWAP slope using series
      const vwapSeries = computeVwapSeries(this.candles1m);
      this.lastVwapSlope = vwapSeries.length >= 5
        ? slopeLast(vwapSeries, 5)
        : 0;

      this.lastRsi = computeRsi(closes, 14);

      // Calculate RSI slope
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
   * Helper to flatten event markets
   */
  flattenEventMarkets(events) {
    const out = [];
    for (const e of Array.isArray(events) ? events : []) {
      const markets = Array.isArray(e.markets) ? e.markets : [];
      for (const m of markets) {
        out.push(m);
      }
    }
    return out;
  }

  /**
   * Pick latest live market
   */
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

  /**
   * Summarize order book
   */
  summarizeOrderBook(book) {
    const bids = Array.isArray(book?.bids) ? book.bids : [];
    const asks = Array.isArray(book?.asks) ? book.asks : [];

    const bestBid = bids.length
      ? bids.reduce((best, lvl) => {
          const p = parseFloat(lvl.price);
          if (!Number.isFinite(p)) return best;
          return best === null ? p : Math.max(best, p);
        }, null)
      : null;

    const bestAsk = asks.length
      ? asks.reduce((best, lvl) => {
          const p = parseFloat(lvl.price);
          if (!Number.isFinite(p)) return best;
          return best === null ? p : Math.min(best, p);
        }, null)
      : null;

    return { bestBid, bestAsk };
  }

  /**
   * Fetch current Polymarket market
   */
  async fetchMarket() {
    try {
      // Fetch live events from the BTC 15m series
      const seriesId = CONFIG.polymarket?.seriesId || '10192';
      const events = await fetchPolymarketEvents(seriesId, 10);
      const markets = this.flattenEventMarkets(events);
      const market = this.pickLatestLiveMarket(markets);

      if (!market) return null;

      // Extract end time from market
      const marketEndTime = market.endDate ? new Date(market.endDate).getTime() : null;

      // Check if market changed
      if (this.currentMarket?.id !== market.id) {
        // New market - close positions from old market
        if (this.currentMarket && this.priceAtStart) {
          await this.resolveMarket(this.currentMarket);
        }

        this.currentMarket = market;
        this.currentMarket.endTime = marketEndTime;
        this.priceAtStart = this.lastPrice;
        this.marketStartTime = Date.now();
        this.marketPositions.set(market.id, []);
        this.marketResolved = false; // Track if this market was resolved

        console.log(`\n${colors.cyan}=== NEW MARKET ===${colors.reset}`);
        console.log(`${market.slug}`);
        console.log(`Start Price: $${this.priceAtStart ? this.priceAtStart.toFixed(2) : 'N/A'}`);
      } else {
        // Same market - update end time if available
        if (marketEndTime) {
          this.currentMarket.endTime = marketEndTime;
        }
      }

      // Fetch order book for market prices
      const yesTokenId = market.clobTokenIds?.[0] || market.tokens?.[0]?.token_id;
      if (yesTokenId) {
        try {
          const orderbook = await fetchPolymarketOrderBook(yesTokenId);
          const summary = this.summarizeOrderBook(orderbook);
          market.yesPrice = summary.bestBid || 0.50;
          market.noPrice = summary.bestAsk ? (1 - summary.bestAsk) : 0.50;
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

  /**
   * Calculate remaining time in current market
   */
  getRemainingMinutes() {
    if (!this.currentMarket) return 15;

    const endTime = this.currentMarket.endTime || (this.marketStartTime + 15 * 60 * 1000);
    const remaining = (endTime - Date.now()) / (1000 * 60);
    return Math.max(0, Math.min(15, remaining));
  }

  /**
   * Resolve a market (determine outcome and close positions)
   */
  async resolveMarket(market) {
    if (!market || !this.priceAtStart || this.marketResolved) return;

    this.marketResolved = true; // Prevent double resolution

    const endPrice = this.lastPrice;
    if (!endPrice) return;

    const outcome = endPrice > this.priceAtStart ? 'UP' : 'DOWN';

    console.log(`\n${colors.yellow}=== MARKET RESOLVED ===${colors.reset}`);
    console.log(`Start: $${this.priceAtStart.toFixed(2)} → End: $${endPrice.toFixed(2)}`);
    console.log(`Outcome: ${outcome === 'UP' ? colors.green : colors.red}${outcome}${colors.reset}`);

    // Close all positions for this market
    const results = this.engine.closeAllForMarket(market.id, outcome, outcome === 'UP' ? 1 : 0);

    for (const result of results) {
      if (result.success) {
        const trade = result.trade;
        const pnlColor = result.won ? colors.green : colors.red;

        console.log(`  ${trade.strategyName}: ${trade.side} → ${pnlColor}${formatUSD(result.pnl)}${colors.reset}`);

        // Log to CSV
        this.logger.logTrade(trade, this.engine.balance);
      }
    }

    // Log performance for each strategy
    for (const strategy of this.strategies) {
      const stats = this.engine.getStrategyStats(strategy.name);
      if (stats) {
        this.logger.logPerformance(strategy.name, {
          ...stats,
          currentBalance: this.engine.balance,
          maxDrawdown: this.engine.stats.maxDrawdown
        });
      }
    }
  }

  /**
   * Run all strategies and process signals
   */
  async runStrategies() {
    const remainingMinutes = this.getRemainingMinutes();

    // Don't trade in last minute (too risky)
    if (remainingMinutes < 1) return;

    // Don't trade in first minute (wait for price action)
    if (remainingMinutes > 14) return;

    // Prepare analysis data
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

    // Run each strategy
    for (const strategy of this.strategies) {
      if (!strategy.canTrade()) continue;

      try {
        const signal = strategy.analyze(analysisData);

        // Log signal (whether traded or not)
        this.logger.logSignal(signal, {
          strategyName: strategy.name,
          marketId: this.currentMarket?.id,
          price: this.lastPrice,
          vwap: this.lastVwap,
          vwapSlope: this.lastVwapSlope,
          rsi: this.lastRsi,
          macd: this.lastMacd?.histogram,
          regime: this.lastRegime,
          remainingMinutes,
          actionTaken: signal ? 'SIGNAL' : 'NO_SIGNAL'
        });

        if (!signal) continue;

        // Check if we already have a position from this strategy for this market
        const existingPosition = this.engine.positions.find(
          p => p.strategyName === strategy.name && p.marketId === this.currentMarket?.id
        );
        if (existingPosition) continue;

        // Calculate bet size
        const { betSize, riskPercent } = this.engine.calculateBetSize(
          signal.confidence,
          strategy.name
        );

        if (betSize < 1) continue;

        // Calculate entry price
        const marketPrice = signal.side === 'UP'
          ? (this.currentMarket?.yesPrice || 0.50)
          : (this.currentMarket?.noPrice || 0.50);

        const entryPrice = this.engine.calculateEntryPrice(
          marketPrice,
          signal.side,
          signal.confidence,
          remainingMinutes
        );

        // Open position
        const result = this.engine.openPosition({
          strategyName: strategy.name,
          side: signal.side,
          entryPrice,
          size: betSize,
          confidence: signal.confidence,
          marketId: this.currentMarket?.id,
          marketSlug: this.currentMarket?.slug,
          remainingMinutes,
          signals: signal.signals
        });

        if (result.success) {
          strategy.recordTrade();

          // Update signal log with action taken
          this.logger.logSignal(signal, {
            strategyName: strategy.name,
            marketId: this.currentMarket?.id,
            price: this.lastPrice,
            vwap: this.lastVwap,
            vwapSlope: this.lastVwapSlope,
            rsi: this.lastRsi,
            macd: this.lastMacd?.histogram,
            regime: this.lastRegime,
            remainingMinutes,
            actionTaken: 'TRADE_OPENED'
          });

          console.log(`\n${colors.bright}>>> NEW TRADE <<<${colors.reset}`);
          console.log(`  Strategy: ${colors.cyan}${strategy.name}${colors.reset}`);
          console.log(`  Side: ${signal.side === 'UP' ? colors.green : colors.red}${signal.side}${colors.reset}`);
          console.log(`  Size: $${betSize.toFixed(2)} (${riskPercent.toFixed(1)}% risk)`);
          console.log(`  Entry: ${entryPrice.toFixed(4)}`);
          console.log(`  Confidence: ${(signal.confidence * 100).toFixed(1)}%`);
        }
      } catch (error) {
        console.error(`${colors.red}Strategy ${strategy.name} error: ${error.message}${colors.reset}`);
      }
    }
  }

  /**
   * Display current status
   */
  displayStatus() {
    const account = this.engine.getAccountState();
    const stats = this.engine.getStats();
    const remaining = this.getRemainingMinutes();

    // Clear previous line
    process.stdout.write('\x1b[2K\r');

    // Compact status line
    const balanceColor = account.totalPnL >= 0 ? colors.green : colors.red;
    const winRateColor = stats.winRate >= 50 ? colors.green : colors.yellow;

    let status = `${colors.dim}[${new Date().toLocaleTimeString()}]${colors.reset} `;
    status += `BTC: $${this.lastPrice?.toFixed(0) || '---'} | `;
    status += `Balance: ${balanceColor}$${account.balance.toFixed(2)}${colors.reset} (${formatPct(account.returnPercent)}) | `;
    status += `Trades: ${stats.totalTrades} | `;
    status += `Win: ${winRateColor}${stats.winRate.toFixed(0)}%${colors.reset} | `;
    status += `Positions: ${account.openPositions} | `;
    status += `Time: ${remaining.toFixed(1)}m`;

    process.stdout.write(status);
  }

  /**
   * Display detailed dashboard (periodic)
   */
  displayDashboard() {
    console.log(`\n\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}`);
    console.log(`${colors.bright}                    PAPER TRADING DASHBOARD${colors.reset}`);
    console.log(`${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

    const account = this.engine.getAccountState();
    const stats = this.engine.getStats();

    // Account Summary
    console.log(`${colors.cyan}ACCOUNT${colors.reset}`);
    console.log(`  Initial Balance: $${this.initialBalance.toFixed(2)}`);
    console.log(`  Current Balance: $${account.balance.toFixed(2)}`);
    console.log(`  P/L: ${account.totalPnL >= 0 ? colors.green : colors.red}${formatUSD(account.totalPnL)} (${formatPct(account.returnPercent)})${colors.reset}`);
    console.log(`  Max Drawdown: ${colors.yellow}${(stats.maxDrawdown * 100).toFixed(1)}%${colors.reset}`);
    console.log('');

    // Trading Stats
    console.log(`${colors.cyan}TRADING STATS${colors.reset}`);
    console.log(`  Total Trades: ${stats.totalTrades}`);
    console.log(`  Wins: ${colors.green}${stats.wins}${colors.reset} | Losses: ${colors.red}${stats.losses}${colors.reset}`);
    console.log(`  Win Rate: ${stats.winRate >= 50 ? colors.green : colors.red}${stats.winRate.toFixed(1)}%${colors.reset}`);
    console.log(`  Avg Win: ${colors.green}${formatUSD(stats.avgWin)}${colors.reset} | Avg Loss: ${colors.red}${formatUSD(-stats.avgLoss)}${colors.reset}`);
    console.log(`  Profit Factor: ${stats.profitFactor.toFixed(2)}`);
    console.log('');

    // Strategy Performance
    console.log(`${colors.cyan}STRATEGY PERFORMANCE${colors.reset}`);
    for (const strategy of this.strategies) {
      const stratStats = this.engine.getStrategyStats(strategy.name);
      if (!stratStats || stratStats.totalTrades === 0) {
        console.log(`  ${strategy.name.padEnd(20)} | No trades yet`);
        continue;
      }

      const winColor = stratStats.winRate >= 50 ? colors.green : colors.red;
      const pnlColor = stratStats.totalPnL >= 0 ? colors.green : colors.red;

      console.log(`  ${strategy.name.padEnd(20)} | Trades: ${stratStats.totalTrades.toString().padStart(3)} | Win: ${winColor}${stratStats.winRate.toFixed(0).padStart(3)}%${colors.reset} | P/L: ${pnlColor}${formatUSD(stratStats.totalPnL).padStart(8)}${colors.reset}`);
    }
    console.log('');

    // Open Positions
    if (this.engine.positions.length > 0) {
      console.log(`${colors.cyan}OPEN POSITIONS${colors.reset}`);
      for (const pos of this.engine.positions) {
        const sideColor = pos.side === 'UP' ? colors.green : colors.red;
        console.log(`  ${pos.strategyName.padEnd(20)} | ${sideColor}${pos.side}${colors.reset} | $${pos.size.toFixed(2)} @ ${pos.entryPrice.toFixed(4)}`);
      }
      console.log('');
    }

    // Market Info
    if (this.currentMarket) {
      const remaining = this.getRemainingMinutes();
      const priceChange = this.lastPrice && this.priceAtStart
        ? ((this.lastPrice - this.priceAtStart) / this.priceAtStart) * 100
        : 0;
      const changeColor = priceChange >= 0 ? colors.green : colors.red;

      console.log(`${colors.cyan}CURRENT MARKET${colors.reset}`);
      console.log(`  ${this.currentMarket.slug}`);
      console.log(`  Start: $${this.priceAtStart?.toFixed(2)} | Current: $${this.lastPrice?.toFixed(2)} (${changeColor}${formatPct(priceChange)}${colors.reset})`);
      console.log(`  Time Remaining: ${remaining.toFixed(1)} minutes`);
      console.log('');
    }

    // Log Files
    const logPaths = this.logger.getLogPaths();
    console.log(`${colors.dim}Log files: ${logPaths.trades}${colors.reset}`);
    console.log(`${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);
  }

  /**
   * Main trading loop
   */
  async run() {
    console.log(`\n${colors.bright}Starting Paper Trading...${colors.reset}`);
    console.log(`Initial Balance: $${this.initialBalance}`);
    console.log(`Strategies: ${this.strategies.map(s => s.name).join(', ')}`);
    console.log(`Poll Interval: ${this.pollInterval}ms\n`);

    this.running = true;

    // Initial data fetch
    await this.fetchData();
    await this.fetchMarket();

    // Display initial dashboard
    this.displayDashboard();

    while (this.running) {
      try {
        this.loopCount++;

        // Fetch fresh data
        const dataOk = await this.fetchData();
        if (!dataOk) {
          await new Promise(r => setTimeout(r, this.pollInterval));
          continue;
        }

        // Check market
        await this.fetchMarket();

        // Run strategies
        await this.runStrategies();

        // Display status
        this.displayStatus();

        // Periodic dashboard (every 60 loops ~ 5 minutes)
        if (this.loopCount % 60 === 0) {
          this.displayDashboard();

          // Log summary to CSV
          const stats = this.engine.getStats();
          this.logger.logSummary({
            totalBalance: this.engine.balance,
            totalTrades: stats.totalTrades,
            totalWins: stats.wins,
            totalLosses: stats.losses,
            combinedWinRate: stats.winRate,
            combinedPnL: stats.totalPnL,
            combinedReturn: stats.returnPercent,
            openPositions: this.engine.positions.length,
            strategiesActive: this.strategies.filter(s => s.enabled).length
          });
        }

        // Wait for next iteration
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
    console.log(`\n${colors.yellow}Stopping paper trading...${colors.reset}`);
    this.running = false;

    // Final dashboard
    this.displayDashboard();

    // Log final summary
    const stats = this.engine.getStats();
    this.logger.logSummary({
      totalBalance: this.engine.balance,
      totalTrades: stats.totalTrades,
      totalWins: stats.wins,
      totalLosses: stats.losses,
      combinedWinRate: stats.winRate,
      combinedPnL: stats.totalPnL,
      combinedReturn: stats.returnPercent,
      openPositions: this.engine.positions.length,
      strategiesActive: 0 // Stopped
    });

    console.log(`\nFinal Balance: $${this.engine.balance.toFixed(2)}`);
    console.log(`Total P/L: ${formatUSD(stats.totalPnL)} (${formatPct(stats.returnPercent)})`);
    console.log(`\nLogs saved to: ${this.logger.getLogPaths().trades}`);
  }

  /**
   * Get current state (for external monitoring)
   */
  getState() {
    return {
      engine: this.engine.exportState(),
      currentMarket: this.currentMarket,
      priceAtStart: this.priceAtStart,
      lastPrice: this.lastPrice,
      running: this.running,
      loopCount: this.loopCount,
      strategies: this.strategies.map(s => ({
        name: s.name,
        enabled: s.enabled,
        lastTradeTime: s.lastTradeTime
      }))
    };
  }
}

/**
 * Create and run orchestrator
 */
export async function startPaperTrading(options = {}) {
  const orchestrator = new PaperTradingOrchestrator(options);

  // Handle shutdown
  process.on('SIGINT', () => {
    orchestrator.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    orchestrator.stop();
    process.exit(0);
  });

  await orchestrator.run();
  return orchestrator;
}
