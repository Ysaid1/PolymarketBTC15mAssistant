/**
 * Momentum/Trend Following Strategy (FIXED)
 *
 * Analyzes momentum WITHIN the current 15-minute market window only.
 * Previous version used 55+ candles of historical data which caused
 * it to predict based on past trends that had already reversed.
 *
 * Entry criteria:
 * - Price direction from market start (most important)
 * - Recent candle momentum within market window
 * - VWAP slope confirms direction
 * - Weighted average favoring recent price action
 */

import { BaseStrategy } from './baseStrategy.js';

export class MomentumStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('MOMENTUM', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
      riskLevel: 'medium'
    });

    this.parameters = {
      // Use much shorter lookbacks for 15-min markets
      fastEma: options.fastEma || 3,
      mediumEma: options.mediumEma || 5,
      slowEma: options.slowEma || 8,
      minVwapSlope: options.minVwapSlope || 0.0001,
      minMomentumBars: options.minMomentumBars || 2, // consecutive directional bars
      minConfidence: options.minConfidence || 0.55,
      // Max candles to use (15 min = ~15 1-min candles)
      maxCandleLookback: options.maxCandleLookback || 15
    };
  }

  /**
   * Calculate EMA
   */
  calculateEMA(prices, period) {
    if (prices.length < period) return null;

    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }

    return ema;
  }

  /**
   * Count consecutive directional candles
   */
  countMomentumBars(candles, direction) {
    let count = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      if (direction === 'UP' && c.close > c.open) {
        count++;
      } else if (direction === 'DOWN' && c.close < c.open) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Check for higher highs / lower lows pattern
   */
  checkTrendPattern(candles, direction, lookback = 5) {
    if (candles.length < lookback) return false;

    const recent = candles.slice(-lookback);

    if (direction === 'UP') {
      // Check for higher highs
      let higherHighs = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i].high > recent[i - 1].high) higherHighs++;
      }
      return higherHighs >= Math.floor(lookback * 0.6);
    } else {
      // Check for lower lows
      let lowerLows = 0;
      for (let i = 1; i < recent.length; i++) {
        if (recent[i].low < recent[i - 1].low) lowerLows++;
      }
      return lowerLows >= Math.floor(lookback * 0.6);
    }
  }

  /**
   * Filter candles to only those within the current market window
   * This is CRITICAL - we only want to analyze the current 15-min period
   */
  filterMarketCandles(candles, remainingMinutes) {
    // How many minutes into the market are we?
    const elapsedMinutes = 15 - remainingMinutes;
    // Take only the most recent candles from this market
    // Add 1 buffer candle for EMA calculation
    const candlesToUse = Math.min(
      Math.ceil(elapsedMinutes) + 1,
      this.parameters.maxCandleLookback,
      candles.length
    );
    return candles.slice(-candlesToUse);
  }

  /**
   * Calculate weighted price change - recent prices weighted more heavily
   */
  calculateWeightedMomentum(candles) {
    if (candles.length < 2) return 0;

    let weightedChange = 0;
    let totalWeight = 0;

    for (let i = 1; i < candles.length; i++) {
      // More recent candles get higher weight (exponential)
      const weight = Math.pow(1.5, i);
      const change = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
      weightedChange += change * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedChange / totalWeight : 0;
  }

  /**
   * Analyze market data for momentum signals (FIXED VERSION)
   * Now uses only candles from the current market window
   */
  analyze(data) {
    const { candles, price, vwap, vwapSlope, remainingMinutes } = data;

    if (!candles || candles.length < 3) {
      return null;
    }

    // CRITICAL FIX: Only use candles from this market's timeframe
    const marketCandles = this.filterMarketCandles(candles, remainingMinutes);

    // Need at least a few candles to analyze
    if (marketCandles.length < 3) {
      return null;
    }

    const closes = marketCandles.map(c => c.close);

    // Calculate short-term EMAs on market candles only
    const emaFast = this.calculateEMA(closes, Math.min(this.parameters.fastEma, closes.length));
    const emaMedium = this.calculateEMA(closes, Math.min(this.parameters.mediumEma, closes.length));
    const emaSlow = this.calculateEMA(closes, Math.min(this.parameters.slowEma, closes.length));

    const signals = {
      emaFast, emaMedium, emaSlow,
      price,
      vwap,
      vwapSlope,
      candlesUsed: marketCandles.length
    };

    // Determine trend direction
    let upScore = 0;
    let downScore = 0;

    // 1. MOST IMPORTANT: Price change from first candle of market
    const marketStartPrice = marketCandles[0].open;
    const priceChangePercent = ((price - marketStartPrice) / marketStartPrice) * 100;
    signals.priceChangeFromStart = priceChangePercent.toFixed(3) + '%';

    if (priceChangePercent > 0.05) {
      upScore += 4; // Strong weight for actual price direction
      signals.priceDirection = 'UP';
    } else if (priceChangePercent < -0.05) {
      downScore += 4;
      signals.priceDirection = 'DOWN';
    } else {
      signals.priceDirection = 'FLAT';
    }

    // 2. Weighted momentum (recent candles matter more)
    const weightedMomentum = this.calculateWeightedMomentum(marketCandles);
    signals.weightedMomentum = (weightedMomentum * 100).toFixed(4) + '%';

    if (weightedMomentum > 0.0001) {
      upScore += 2;
    } else if (weightedMomentum < -0.0001) {
      downScore += 2;
    }

    // 3. EMA position (using short-term EMAs)
    if (emaFast && emaMedium && emaSlow) {
      if (price > emaFast && emaFast > emaMedium) {
        upScore += 2;
        signals.emaTrend = 'BULLISH';
      } else if (price < emaFast && emaFast < emaMedium) {
        downScore += 2;
        signals.emaTrend = 'BEARISH';
      } else {
        signals.emaTrend = 'MIXED';
      }
    }

    // 4. VWAP slope confirmation
    if (vwapSlope > this.parameters.minVwapSlope) {
      upScore += 1;
      signals.vwapTrend = 'UP';
    } else if (vwapSlope < -this.parameters.minVwapSlope) {
      downScore += 1;
      signals.vwapTrend = 'DOWN';
    } else {
      signals.vwapTrend = 'FLAT';
    }

    // 5. Consecutive momentum bars (within market candles only)
    const upBars = this.countMomentumBars(marketCandles, 'UP');
    const downBars = this.countMomentumBars(marketCandles, 'DOWN');
    signals.momentumBarsUp = upBars;
    signals.momentumBarsDown = downBars;

    if (upBars >= this.parameters.minMomentumBars) {
      upScore += 1;
    }
    if (downBars >= this.parameters.minMomentumBars) {
      downScore += 1;
    }

    // Calculate confidence
    const totalScore = upScore + downScore;
    if (totalScore === 0) return null;

    const maxPossibleScore = 10; // 4 (price dir) + 2 (weighted) + 2 (ema) + 1 (vwap) + 1 (bars)

    let side, confidence;

    if (upScore > downScore) {
      side = 'UP';
      confidence = 0.5 + ((upScore - downScore) / maxPossibleScore) * 0.4;
    } else if (downScore > upScore) {
      side = 'DOWN';
      confidence = 0.5 + ((downScore - upScore) / maxPossibleScore) * 0.4;
    } else {
      return null; // No clear direction
    }

    // Slight time decay - but less aggressive since we're using market-only data
    const timeDecay = Math.max(0.7, remainingMinutes / 15);
    confidence = 0.5 + (confidence - 0.5) * timeDecay;

    signals.rawUpScore = upScore;
    signals.rawDownScore = downScore;
    signals.timeDecay = timeDecay;

    if (confidence < this.parameters.minConfidence) {
      return null;
    }

    return {
      side,
      confidence: Math.min(0.85, confidence),
      signals
    };
  }

  getDescription() {
    return 'Trend-following strategy using EMA cascade and momentum confirmation';
  }
}
