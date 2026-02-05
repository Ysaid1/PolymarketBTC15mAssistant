#!/usr/bin/env node

/**
 * Polymarket Backtesting Module
 *
 * Fetches REAL historical closed BTC 15-minute markets from Polymarket,
 * retrieves actual BTC price data during those windows, and tests all
 * trading strategies against actual outcomes.
 */

import https from 'https';
import { MomentumStrategy } from './paperTrading/strategies/momentumStrategy.js';
import { MeanReversionStrategy } from './paperTrading/strategies/meanReversionStrategy.js';
import { VolatilityBreakoutStrategy } from './paperTrading/strategies/volatilityBreakoutStrategy.js';
import { RSIStrategy } from './paperTrading/strategies/rsiStrategy.js';
import { MACDStrategy } from './paperTrading/strategies/macdStrategy.js';
import { TrendConfirmationStrategy } from './paperTrading/strategies/trendConfirmationStrategy.js';
import { PriceActionStrategy } from './paperTrading/strategies/priceActionStrategy.js';
import { VolumeProfileStrategy } from './paperTrading/strategies/volumeProfileStrategy.js';
import { ORBStrategy } from './paperTrading/strategies/orbStrategy.js';
import { EMACrossoverStrategy } from './paperTrading/strategies/emaCrossoverStrategy.js';
import { SRFlipStrategy } from './paperTrading/strategies/srFlipStrategy.js';
import { LiquiditySweepStrategy } from './paperTrading/strategies/liquiditySweepStrategy.js';
import { SignalAggregator } from './allDayTrader/signalAggregator.js';
import { PerformanceTracker } from './allDayTrader/performanceTracker.js';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m'
};

/**
 * Simple HTTPS fetch
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetch closed BTC 15-min markets from Polymarket
 */
async function fetchClosedMarkets(limit = 100) {
  console.log(`\n${colors.cyan}Fetching closed BTC 15-minute markets...${colors.reset}`);

  const allMarkets = [];
  let offset = 0;

  while (allMarkets.length < limit) {
    const url = `https://gamma-api.polymarket.com/events?tag_id=102467&closed=true&limit=50&offset=${offset}&order=endDate&ascending=false`;

    try {
      const events = await httpsGet(url);

      if (!events || events.length === 0) break;

      for (const event of events) {
        if (!event.markets) continue;

        for (const market of event.markets) {
          // Filter for BTC 15-min up/down markets
          if (!market.slug || !market.slug.includes('btc')) continue;
          if (!market.slug.includes('updown-15m') && !market.slug.includes('up-down')) continue;

          // Parse outcome from outcomePrices
          let outcome = null;
          if (market.outcomePrices) {
            try {
              const prices = typeof market.outcomePrices === 'string'
                ? JSON.parse(market.outcomePrices)
                : market.outcomePrices;

              if (prices[0] === '1' || prices[0] === 1) {
                outcome = 'UP';
              } else if (prices[1] === '1' || prices[1] === 1) {
                outcome = 'DOWN';
              }
            } catch (e) {}
          }

          if (!outcome) continue;

          // Parse token IDs
          let tokenIds = market.clobTokenIds;
          if (typeof tokenIds === 'string') {
            try { tokenIds = JSON.parse(tokenIds); } catch (e) { tokenIds = null; }
          }

          allMarkets.push({
            id: market.id,
            slug: market.slug,
            question: market.question,
            endDate: market.endDate,
            endTime: new Date(market.endDate).getTime(),
            outcome,
            upTokenId: tokenIds?.[0],
            downTokenId: tokenIds?.[1]
          });
        }
      }

      offset += 50;
      process.stdout.write(`\rFetched ${allMarkets.length} markets...`);

      // Rate limiting
      await new Promise(r => setTimeout(r, 200));

    } catch (error) {
      console.error(`\nError fetching markets: ${error.message}`);
      break;
    }
  }

  console.log(`\n${colors.green}Found ${allMarkets.length} closed BTC 15-min markets${colors.reset}`);

  // Sort by end date (oldest first for proper backtesting)
  allMarkets.sort((a, b) => a.endTime - b.endTime);

  return allMarkets.slice(0, limit);
}

/**
 * Fetch Binance klines for a specific time range
 */
async function fetchBinanceKlinesForWindow(startTime, endTime, interval = '1m') {
  // Fetch extra candles before for indicator calculation
  const lookbackMs = 60 * 60 * 1000; // 60 minutes before
  const fetchStart = startTime - lookbackMs;

  const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&startTime=${fetchStart}&endTime=${endTime}&limit=1000`;

  try {
    const klines = await httpsGet(url);

    return klines.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6]
    }));
  } catch (error) {
    console.error(`Error fetching Binance data: ${error.message}`);
    return [];
  }
}

/**
 * Calculate indicators for analysis
 */
function calculateIndicators(candles) {
  if (!candles || candles.length < 30) return null;

  const closes = candles.map(c => c.close);

  // VWAP
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumulativeTPV += tp * c.volume;
    cumulativeVolume += c.volume;
  }
  const vwap = cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : closes[closes.length - 1];

  // VWAP Slope
  const vwapSeries = [];
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
    vwapSeries.push(cumVol > 0 ? cumTPV / cumVol : c.close);
  }
  const vwapSlope = vwapSeries.length >= 5
    ? (vwapSeries[vwapSeries.length - 1] - vwapSeries[vwapSeries.length - 5]) / vwapSeries[vwapSeries.length - 5]
    : 0;

  // RSI
  const period = 14;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  let gains = 0, losses = 0;
  for (let i = 0; i < Math.min(period, changes.length); i++) {
    if (changes[i] > 0) gains += changes[i];
    else losses -= changes[i];
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < changes.length; i++) {
    const change = changes[i];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - change) / period;
    }
  }

  const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  // RSI Slope
  const rsiHistory = [];
  for (let len = 20; len <= closes.length; len++) {
    const subChanges = [];
    for (let i = 1; i < len; i++) {
      subChanges.push(closes[i] - closes[i - 1]);
    }
    let g = 0, l = 0;
    for (let i = 0; i < Math.min(period, subChanges.length); i++) {
      if (subChanges[i] > 0) g += subChanges[i];
      else l -= subChanges[i];
    }
    let ag = g / period, al = l / period;
    for (let i = period; i < subChanges.length; i++) {
      const ch = subChanges[i];
      if (ch > 0) {
        ag = (ag * (period - 1) + ch) / period;
        al = (al * (period - 1)) / period;
      } else {
        ag = (ag * (period - 1)) / period;
        al = (al * (period - 1) - ch) / period;
      }
    }
    rsiHistory.push(al === 0 ? 100 : 100 - (100 / (1 + ag / al)));
  }
  const rsiSlope = rsiHistory.length >= 5
    ? (rsiHistory[rsiHistory.length - 1] - rsiHistory[rsiHistory.length - 5]) / 5
    : 0;

  // MACD
  function ema(data, period) {
    const k = 2 / (period + 1);
    let emaVal = data[0];
    for (let i = 1; i < data.length; i++) {
      emaVal = data[i] * k + emaVal * (1 - k);
    }
    return emaVal;
  }

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 - ema26;

  // Calculate MACD history for signal line
  const macdHistory = [];
  for (let i = 26; i <= closes.length; i++) {
    const subCloses = closes.slice(0, i);
    const e12 = ema(subCloses, 12);
    const e26 = ema(subCloses, 26);
    macdHistory.push(e12 - e26);
  }
  const signalLine = macdHistory.length >= 9 ? ema(macdHistory, 9) : macdLine;
  const histogram = macdLine - signalLine;

  const macd = {
    line: macdLine,
    signal: signalLine,
    histogram
  };

  // Detect regime
  const price = closes[closes.length - 1];
  let regime = 'RANGE';
  if (vwapSlope > 0.0005 && price > vwap) regime = 'TREND_UP';
  else if (vwapSlope < -0.0005 && price < vwap) regime = 'TREND_DOWN';
  else if (Math.abs(vwapSlope) < 0.0002) regime = 'RANGE';
  else regime = 'CHOP';

  return {
    price,
    vwap,
    vwapSlope,
    rsi,
    rsiSlope,
    macd,
    regime
  };
}

/**
 * Strategy state tracker for backtesting
 */
class StrategyBacktestState {
  constructor(name, initialBalance = 500) {
    this.name = name;
    this.balance = initialBalance;
    this.initialBalance = initialBalance;
    this.trades = [];
    this.wins = 0;
    this.losses = 0;
    this.totalPnL = 0;
    this.consecutiveLosses = 0;
    this.maxConsecutiveLosses = 0;
    this.maxDrawdown = 0;
    this.peakBalance = initialBalance;
  }

  recordTrade(trade) {
    this.trades.push(trade);

    if (trade.won) {
      this.wins++;
      this.totalPnL += trade.profit;
      this.balance += trade.profit;
      this.consecutiveLosses = 0;
    } else {
      this.losses++;
      this.totalPnL -= trade.loss;
      this.balance -= trade.loss;
      this.consecutiveLosses++;
      this.maxConsecutiveLosses = Math.max(this.maxConsecutiveLosses, this.consecutiveLosses);
    }

    this.peakBalance = Math.max(this.peakBalance, this.balance);
    const drawdown = (this.peakBalance - this.balance) / this.peakBalance;
    this.maxDrawdown = Math.max(this.maxDrawdown, drawdown);
  }

  getStats() {
    const totalTrades = this.wins + this.losses;
    return {
      name: this.name,
      totalTrades,
      wins: this.wins,
      losses: this.losses,
      winRate: totalTrades > 0 ? (this.wins / totalTrades * 100) : 0,
      totalPnL: this.totalPnL,
      returnPct: ((this.balance - this.initialBalance) / this.initialBalance * 100),
      finalBalance: this.balance,
      maxDrawdown: this.maxDrawdown * 100,
      maxConsecutiveLosses: this.maxConsecutiveLosses
    };
  }
}

/**
 * Run backtest for all strategies
 */
async function runBacktest(options = {}) {
  const {
    maxMarkets = 200,
    betSize = 35,
    entryMinute = 3, // Enter at minute 3 of window (12 min remaining)
    minConfidence = 0.55
  } = options;

  console.log(`\n${colors.bright}╔═══════════════════════════════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}║           POLYMARKET HISTORICAL BACKTEST                      ║${colors.reset}`);
  console.log(`${colors.bright}╚═══════════════════════════════════════════════════════════════╝${colors.reset}\n`);

  // Fetch closed markets
  const markets = await fetchClosedMarkets(maxMarkets);

  if (markets.length < 10) {
    console.error('Insufficient markets for backtest');
    return null;
  }

  console.log(`\n${colors.cyan}Market Distribution:${colors.reset}`);
  const upMarkets = markets.filter(m => m.outcome === 'UP').length;
  const downMarkets = markets.filter(m => m.outcome === 'DOWN').length;
  console.log(`  UP: ${upMarkets} (${(upMarkets / markets.length * 100).toFixed(1)}%)`);
  console.log(`  DOWN: ${downMarkets} (${(downMarkets / markets.length * 100).toFixed(1)}%)`);
  console.log(`  Total: ${markets.length} markets`);

  // Initialize strategies
  const strategies = [
    new MomentumStrategy({ minConfidence, cooldownMs: 0 }),
    new MeanReversionStrategy({ minConfidence, cooldownMs: 0 }),
    new VolatilityBreakoutStrategy({ minConfidence, cooldownMs: 0 }),
    new RSIStrategy({ minConfidence, cooldownMs: 0 }),
    new MACDStrategy({ minConfidence, cooldownMs: 0 }),
    new TrendConfirmationStrategy({ minConfidence: 0.60, cooldownMs: 0 }),
    new PriceActionStrategy({ minConfidence, cooldownMs: 0 }),
    new VolumeProfileStrategy({ minConfidence, cooldownMs: 0 }),
    new ORBStrategy({ minConfidence, cooldownMs: 0 }),
    new EMACrossoverStrategy({ minConfidence, cooldownMs: 0 }),
    new SRFlipStrategy({ minConfidence, cooldownMs: 0 }),
    new LiquiditySweepStrategy({ minConfidence, cooldownMs: 0 })
  ];

  // Initialize signal aggregator
  const performanceTracker = new PerformanceTracker();
  const signalAggregator = new SignalAggregator(performanceTracker);

  // Strategy state trackers
  const strategyStates = {};
  for (const s of strategies) {
    strategyStates[s.name] = new StrategyBacktestState(s.name);
  }
  strategyStates['AGGREGATED'] = new StrategyBacktestState('AGGREGATED');

  console.log(`\n${colors.cyan}Running backtest...${colors.reset}`);
  console.log(`Strategies: ${strategies.length} + AGGREGATED`);
  console.log(`Bet Size: $${betSize}`);
  console.log(`Entry: Minute ${entryMinute} of window`);
  console.log(`Min Confidence: ${(minConfidence * 100).toFixed(0)}%`);
  console.log('');

  let processed = 0;
  let skipped = 0;

  for (const market of markets) {
    processed++;

    // Calculate window times (15 minutes before end)
    const windowEnd = market.endTime;
    const windowStart = windowEnd - 15 * 60 * 1000;

    // Entry time (e.g., minute 3)
    const entryTime = windowStart + entryMinute * 60 * 1000;

    // Fetch BTC data
    const candles = await fetchBinanceKlinesForWindow(windowStart, entryTime);

    if (candles.length < 60) {
      skipped++;
      continue;
    }

    // Calculate indicators
    const indicators = calculateIndicators(candles);

    if (!indicators) {
      skipped++;
      continue;
    }

    const analysisData = {
      candles,
      price: indicators.price,
      vwap: indicators.vwap,
      vwapSlope: indicators.vwapSlope,
      rsi: indicators.rsi,
      rsiSlope: indicators.rsiSlope,
      macd: indicators.macd,
      regime: indicators.regime,
      remainingMinutes: 15 - entryMinute
    };

    // Test each strategy
    for (const strategy of strategies) {
      // Set simulated time for cooldown handling
      if (strategy.setSimulatedTime) {
        strategy.setSimulatedTime(entryTime);
      }

      const signal = strategy.analyze(analysisData);

      if (signal && signal.side && signal.confidence >= minConfidence) {
        // Simulate trade
        const won = signal.side === market.outcome;

        // Calculate P/L (assuming contract price ~0.50)
        const contractPrice = 0.50;
        const profit = won ? betSize * (1 / contractPrice - 1) : 0;
        const loss = won ? 0 : betSize;

        strategyStates[strategy.name].recordTrade({
          marketId: market.id,
          side: signal.side,
          outcome: market.outcome,
          confidence: signal.confidence,
          won,
          profit,
          loss,
          regime: indicators.regime
        });

        // Record for performance tracker
        performanceTracker.recordOutcome(strategy.name, won, won ? profit : -loss, indicators.regime);
      }
    }

    // Test aggregated signal
    const aggregated = signalAggregator.aggregate(strategies, analysisData, indicators.regime);

    if (aggregated.action === 'ENTER') {
      const won = aggregated.side === market.outcome;
      const contractPrice = 0.50;
      const profit = won ? betSize * (1 / contractPrice - 1) : 0;
      const loss = won ? 0 : betSize;

      strategyStates['AGGREGATED'].recordTrade({
        marketId: market.id,
        side: aggregated.side,
        outcome: market.outcome,
        confidence: aggregated.confidence,
        won,
        profit,
        loss,
        regime: indicators.regime
      });
    }

    // Progress update
    if (processed % 10 === 0) {
      process.stdout.write(`\r  Processed: ${processed}/${markets.length} markets (${skipped} skipped)`);
    }

    // Rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n\n${colors.green}Backtest complete!${colors.reset}`);
  console.log(`Processed: ${processed} markets (${skipped} skipped due to data issues)`);

  // Generate results
  const results = Object.values(strategyStates).map(s => s.getStats());

  // Sort by return
  results.sort((a, b) => b.returnPct - a.returnPct);

  // Print results
  console.log(`\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}`);
  console.log(`${colors.bright}                    BACKTEST RESULTS                           ${colors.reset}`);
  console.log(`${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

  console.log(`${colors.cyan}Strategy Leaderboard:${colors.reset}\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  ';
    const returnColor = r.returnPct >= 0 ? colors.green : colors.red;
    const winRateColor = r.winRate >= 50 ? colors.green : colors.red;

    console.log(`${medal} ${(i + 1).toString().padStart(2)}. ${r.name.padEnd(22)} | `
      + `Trades: ${r.totalTrades.toString().padStart(4)} | `
      + `W/L: ${r.wins}/${r.losses} | `
      + `WR: ${winRateColor}${r.winRate.toFixed(1).padStart(5)}%${colors.reset} | `
      + `Return: ${returnColor}${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(1).padStart(6)}%${colors.reset} | `
      + `Final: $${r.finalBalance.toFixed(0)}`);
  }

  // Summary stats
  console.log(`\n${colors.cyan}Summary Statistics:${colors.reset}`);

  const profitable = results.filter(r => r.returnPct > 0).length;
  const avgReturn = results.reduce((s, r) => s + r.returnPct, 0) / results.length;
  const avgWinRate = results.reduce((s, r) => s + r.winRate, 0) / results.length;

  console.log(`  Profitable strategies: ${profitable}/${results.length}`);
  console.log(`  Average return: ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);
  console.log(`  Average win rate: ${avgWinRate.toFixed(1)}%`);

  // Aggregated stats
  const agg = results.find(r => r.name === 'AGGREGATED');
  if (agg) {
    console.log(`\n${colors.cyan}Signal Aggregator Performance:${colors.reset}`);
    console.log(`  Trades: ${agg.totalTrades}`);
    console.log(`  Win Rate: ${agg.winRate.toFixed(1)}%`);
    console.log(`  Return: ${agg.returnPct >= 0 ? '+' : ''}${agg.returnPct.toFixed(2)}%`);
    console.log(`  Max Drawdown: ${agg.maxDrawdown.toFixed(1)}%`);
  }

  // Best individual strategy
  const bestIndividual = results.filter(r => r.name !== 'AGGREGATED')[0];
  if (bestIndividual) {
    console.log(`\n${colors.cyan}Best Individual Strategy:${colors.reset}`);
    console.log(`  ${bestIndividual.name}`);
    console.log(`  Win Rate: ${bestIndividual.winRate.toFixed(1)}%`);
    console.log(`  Return: ${bestIndividual.returnPct >= 0 ? '+' : ''}${bestIndividual.returnPct.toFixed(2)}%`);
  }

  // Regime analysis
  console.log(`\n${colors.cyan}Regime Analysis:${colors.reset}`);
  for (const strat of Object.values(strategyStates)) {
    const regimeTrades = {};
    for (const trade of strat.trades) {
      if (!regimeTrades[trade.regime]) {
        regimeTrades[trade.regime] = { wins: 0, losses: 0 };
      }
      if (trade.won) regimeTrades[trade.regime].wins++;
      else regimeTrades[trade.regime].losses++;
    }

    if (strat.name === 'AGGREGATED' || strat.name === bestIndividual?.name) {
      console.log(`\n  ${strat.name}:`);
      for (const [regime, stats] of Object.entries(regimeTrades)) {
        const total = stats.wins + stats.losses;
        const wr = total > 0 ? (stats.wins / total * 100) : 0;
        console.log(`    ${regime.padEnd(12)}: W/L ${stats.wins}/${stats.losses} (${wr.toFixed(1)}%)`);
      }
    }
  }

  console.log(`\n${colors.bright}═══════════════════════════════════════════════════════════════${colors.reset}\n`);

  return {
    results,
    markets: markets.length,
    upMarkets,
    downMarkets
  };
}

// CLI execution
const args = process.argv.slice(2);
const maxMarketsIdx = args.indexOf('--markets');
const betSizeIdx = args.indexOf('--bet');
const entryMinuteIdx = args.indexOf('--entry');

const options = {
  maxMarkets: maxMarketsIdx >= 0 ? parseInt(args[maxMarketsIdx + 1]) : 200,
  betSize: betSizeIdx >= 0 ? parseFloat(args[betSizeIdx + 1]) : 35,
  entryMinute: entryMinuteIdx >= 0 ? parseInt(args[entryMinuteIdx + 1]) : 3
};

console.log(`\nOptions: ${JSON.stringify(options)}`);

runBacktest(options).catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});
