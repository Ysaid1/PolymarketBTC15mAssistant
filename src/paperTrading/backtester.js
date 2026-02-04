/**
 * Backtesting Module
 *
 * Fetches historical 15-minute BTC data and simulates trading strategies
 * to validate performance before live paper trading.
 */

import https from 'https';
import { PaperTradingEngine } from './engine.js';
import { MomentumStrategy } from './strategies/momentumStrategy.js';
import { MeanReversionStrategy } from './strategies/meanReversionStrategy.js';
import { VolatilityBreakoutStrategy } from './strategies/volatilityBreakoutStrategy.js';
import { RSIStrategy } from './strategies/rsiStrategy.js';
import { MACDStrategy } from './strategies/macdStrategy.js';

/**
 * Simple HTTPS fetch function
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
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
 * Fetch historical klines from Binance
 */
async function fetchHistoricalData(symbol = 'BTCUSDT', interval = '1m', days = 120) {
  const endTime = Date.now();
  const startTime = endTime - (days * 24 * 60 * 60 * 1000);

  const allKlines = [];
  let currentStart = startTime;
  const limit = 1000; // Binance limit per request

  console.log(`Fetching ${days} days of ${interval} data for ${symbol}...`);

  while (currentStart < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&limit=${limit}`;

    try {
      const klines = await httpsGet(url);
      if (klines.length === 0) break;

      for (const k of klines) {
        allKlines.push({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6]
        });
      }

      currentStart = klines[klines.length - 1][6] + 1;

      // Rate limiting
      await new Promise(r => setTimeout(r, 100));

      // Progress
      const progress = ((currentStart - startTime) / (endTime - startTime) * 100).toFixed(1);
      process.stdout.write(`\rFetching data: ${progress}% (${allKlines.length} candles)`);
    } catch (error) {
      console.error(`\nError fetching data: ${error.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`\nFetched ${allKlines.length} candles`);
  return allKlines;
}

/**
 * Calculate VWAP for a set of candles
 */
function calculateVWAP(candles) {
  if (!candles.length) return null;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumulativeTPV += typicalPrice * c.volume;
    cumulativeVolume += c.volume;
  }

  return cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : candles[candles.length - 1].close;
}

/**
 * Calculate VWAP slope
 */
function calculateVWAPSlope(candles, lookback = 5) {
  if (candles.length < lookback + 1) return 0;

  const currentVwap = calculateVWAP(candles);
  const prevCandles = candles.slice(0, -lookback);
  const prevVwap = calculateVWAP(prevCandles);

  if (!prevVwap || !currentVwap) return 0;
  return (currentVwap - prevVwap) / prevVwap;
}

/**
 * Calculate RSI
 */
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  let gains = 0;
  let losses = 0;

  for (let i = 0; i < period; i++) {
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

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Detect market regime
 */
function detectRegime(candles, vwap, vwapSlope) {
  if (!candles.length || !vwap) return 'UNKNOWN';

  const price = candles[candles.length - 1].close;

  if (vwapSlope > 0.0005 && price > vwap) return 'TREND_UP';
  if (vwapSlope < -0.0005 && price < vwap) return 'TREND_DOWN';
  if (Math.abs(vwapSlope) < 0.0002) return 'RANGE';
  return 'CHOP';
}

/**
 * Generate 15-minute market windows from 1-minute data
 */
function generate15MinWindows(klines) {
  const windows = [];
  const windowDuration = 15 * 60 * 1000; // 15 minutes in ms

  // Group into 15-minute periods
  let currentWindowStart = Math.floor(klines[0].openTime / windowDuration) * windowDuration;

  while (currentWindowStart < klines[klines.length - 1].closeTime) {
    const windowEnd = currentWindowStart + windowDuration;

    // Find candles in this window
    const windowCandles = klines.filter(k =>
      k.openTime >= currentWindowStart && k.openTime < windowEnd
    );

    if (windowCandles.length > 0) {
      const startPrice = windowCandles[0].open;
      const endPrice = windowCandles[windowCandles.length - 1].close;

      windows.push({
        startTime: currentWindowStart,
        endTime: windowEnd,
        startPrice,
        endPrice,
        outcome: endPrice > startPrice ? 'UP' : 'DOWN',
        candles: windowCandles
      });
    }

    currentWindowStart = windowEnd;
  }

  return windows;
}

/**
 * Run backtest for a single strategy
 */
function backtestStrategy(strategy, windows, klines, initialBalance = 500) {
  const engine = new PaperTradingEngine({
    initialBalance,
    minRiskPercent: 0.02,
    maxRiskPercent: 0.05
  });

  const trades = [];
  const lookbackCandles = 60; // Use 60 1-min candles for analysis

  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];

    // Find klines up to this window's start
    const analysisEndIdx = klines.findIndex(k => k.openTime >= window.startTime);
    if (analysisEndIdx < lookbackCandles) continue;

    const analysisCandles = klines.slice(analysisEndIdx - lookbackCandles, analysisEndIdx);
    if (analysisCandles.length < lookbackCandles) continue;

    const price = analysisCandles[analysisCandles.length - 1].close;
    const vwap = calculateVWAP(analysisCandles);
    const vwapSlope = calculateVWAPSlope(analysisCandles);
    const closes = analysisCandles.map(c => c.close);
    const rsi = calculateRSI(closes);
    const regime = detectRegime(analysisCandles, vwap, vwapSlope);

    // Simulate different entry points within the 15-min window
    // Entry at minute 2-3 (we have ~12 minutes remaining)
    const remainingMinutes = 12;

    const analysisData = {
      candles: analysisCandles,
      price,
      vwap,
      vwapSlope,
      rsi,
      regime,
      remainingMinutes
    };

    // Set simulated time for backtesting (use window start time)
    strategy.setSimulatedTime(window.startTime);

    // Check if strategy can trade (cooldown)
    if (!strategy.canTrade()) continue;

    // Get signal
    const signal = strategy.analyze(analysisData);
    if (!signal) continue;

    // Calculate bet size
    const { betSize } = engine.calculateBetSize(signal.confidence, strategy.name);
    if (betSize < 1) continue;

    // Simulate entry price based on confidence
    const marketPrice = signal.side === 'UP' ? 0.50 : 0.50; // Simplified
    const entryPrice = engine.calculateEntryPrice(marketPrice, signal.side, signal.confidence, remainingMinutes);

    // Open position
    const result = engine.openPosition({
      strategyName: strategy.name,
      side: signal.side,
      entryPrice,
      size: betSize,
      confidence: signal.confidence,
      marketId: `backtest_${window.startTime}`,
      marketSlug: `btc-15min-${new Date(window.startTime).toISOString()}`,
      remainingMinutes,
      signals: signal.signals,
      timestamp: window.startTime
    });

    if (!result.success) continue;

    strategy.recordTrade();

    // Close position with actual outcome
    const closeResult = engine.closePosition(
      result.tradeId,
      window.outcome,
      window.outcome === signal.side ? 1 : 0,
      window.endTime
    );

    if (closeResult.success) {
      trades.push({
        ...closeResult.trade,
        actualOutcome: window.outcome,
        startPrice: window.startPrice,
        endPrice: window.endPrice,
        priceChange: ((window.endPrice - window.startPrice) / window.startPrice) * 100
      });
    }
  }

  return {
    strategy: strategy.name,
    stats: engine.getStats(),
    trades,
    finalBalance: engine.balance
  };
}

/**
 * Run full backtest for all strategies
 */
export async function runBacktest(days = 120, initialBalance = 500) {
  console.log('\n=== BACKTESTING MODULE ===\n');
  console.log(`Period: ${days} days`);
  console.log(`Initial Balance: $${initialBalance}`);
  console.log('');

  // Fetch historical data
  const klines = await fetchHistoricalData('BTCUSDT', '1m', days);
  if (klines.length < 1000) {
    console.error('Insufficient data for backtest');
    return null;
  }

  // Generate 15-minute windows
  const windows = generate15MinWindows(klines);
  console.log(`Generated ${windows.length} 15-minute windows\n`);

  // Calculate baseline stats
  const upWindows = windows.filter(w => w.outcome === 'UP').length;
  const downWindows = windows.filter(w => w.outcome === 'DOWN').length;
  console.log(`Market Distribution: UP ${upWindows} (${(upWindows/windows.length*100).toFixed(1)}%) | DOWN ${downWindows} (${(downWindows/windows.length*100).toFixed(1)}%)\n`);

  // Initialize strategies - disable cooldown for backtesting to allow trading each window
  const strategies = [
    new MomentumStrategy({ minConfidence: 0.55, cooldownMs: 0 }),
    new MeanReversionStrategy({ minConfidence: 0.55, cooldownMs: 0 }),
    new VolatilityBreakoutStrategy({ minConfidence: 0.55, cooldownMs: 0 }),
    new RSIStrategy({ minConfidence: 0.55, cooldownMs: 0 }),
    new MACDStrategy({ minConfidence: 0.55, cooldownMs: 0 })
  ];

  // Run backtest for each strategy
  const results = [];

  for (const strategy of strategies) {
    console.log(`Backtesting ${strategy.name}...`);
    const result = backtestStrategy(strategy, windows, klines, initialBalance);
    results.push(result);

    const stats = result.stats;
    console.log(`  Trades: ${stats.totalTrades}`);
    console.log(`  Win Rate: ${stats.winRate.toFixed(1)}%`);
    console.log(`  P/L: $${stats.totalPnL.toFixed(2)} (${stats.returnPercent.toFixed(1)}%)`);
    console.log(`  Max Drawdown: ${(stats.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`  Final Balance: $${result.finalBalance.toFixed(2)}`);
    console.log('');
  }

  // Summary
  console.log('\n=== BACKTEST SUMMARY ===\n');
  console.log('Strategy Performance Ranking:\n');

  const ranked = results.sort((a, b) => b.stats.returnPercent - a.stats.returnPercent);

  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    console.log(`${i + 1}. ${r.strategy.padEnd(20)} | Win: ${r.stats.winRate.toFixed(1).padStart(5)}% | Return: ${r.stats.returnPercent >= 0 ? '+' : ''}${r.stats.returnPercent.toFixed(1).padStart(6)}% | Trades: ${r.stats.totalTrades.toString().padStart(4)}`);
  }

  // Combined stats
  const totalTrades = results.reduce((s, r) => s + r.stats.totalTrades, 0);
  const totalWins = results.reduce((s, r) => s + r.stats.wins, 0);
  const totalPnL = results.reduce((s, r) => s + r.stats.totalPnL, 0);

  console.log('\n--- Combined Performance ---');
  console.log(`Total Trades: ${totalTrades}`);
  console.log(`Combined Win Rate: ${(totalWins / totalTrades * 100).toFixed(1)}%`);
  console.log(`Combined P/L: $${totalPnL.toFixed(2)}`);

  return {
    results,
    windows,
    marketStats: { upWindows, downWindows, total: windows.length }
  };
}

/**
 * Quick backtest with less data for testing
 */
export async function quickBacktest(days = 30) {
  return runBacktest(days, 500);
}

// CLI execution
if (process.argv[1].includes('backtester')) {
  const days = parseInt(process.argv[2]) || 120;
  runBacktest(days).then(() => {
    console.log('\nBacktest complete.');
  }).catch(console.error);
}
