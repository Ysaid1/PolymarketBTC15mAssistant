/**
 * Momentum/Trend Following Strategy
 *
 * Follows the prevailing price direction using multiple moving averages
 * and trend confirmation signals.
 *
 * Entry criteria:
 * - Price above/below EMA cascade (8, 21, 55)
 * - VWAP slope confirms direction
 * - Recent price action shows momentum (higher highs or lower lows)
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
      fastEma: options.fastEma || 8,
      mediumEma: options.mediumEma || 21,
      slowEma: options.slowEma || 55,
      minVwapSlope: options.minVwapSlope || 0.0001,
      minMomentumBars: options.minMomentumBars || 3, // consecutive directional bars
      minConfidence: options.minConfidence || 0.55
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
   * Analyze market data for momentum signals
   */
  analyze(data) {
    const { candles, price, vwap, vwapSlope, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.slowEma) {
      return null;
    }

    const closes = candles.map(c => c.close);

    // Calculate EMAs
    const ema8 = this.calculateEMA(closes, this.parameters.fastEma);
    const ema21 = this.calculateEMA(closes, this.parameters.mediumEma);
    const ema55 = this.calculateEMA(closes, this.parameters.slowEma);

    if (!ema8 || !ema21 || !ema55) return null;

    const signals = {
      ema8, ema21, ema55,
      price,
      vwap,
      vwapSlope
    };

    // Determine trend direction
    let upScore = 0;
    let downScore = 0;

    // EMA Cascade check (most important)
    if (price > ema8 && ema8 > ema21 && ema21 > ema55) {
      upScore += 3;
      signals.emaCascade = 'BULLISH';
    } else if (price < ema8 && ema8 < ema21 && ema21 < ema55) {
      downScore += 3;
      signals.emaCascade = 'BEARISH';
    } else {
      signals.emaCascade = 'MIXED';
    }

    // Price position relative to EMAs
    if (price > ema8) upScore += 1;
    else downScore += 1;

    if (price > ema21) upScore += 1;
    else downScore += 1;

    if (price > ema55) upScore += 1;
    else downScore += 1;

    // VWAP slope confirmation
    if (vwapSlope > this.parameters.minVwapSlope) {
      upScore += 2;
      signals.vwapTrend = 'UP';
    } else if (vwapSlope < -this.parameters.minVwapSlope) {
      downScore += 2;
      signals.vwapTrend = 'DOWN';
    } else {
      signals.vwapTrend = 'FLAT';
    }

    // Momentum bar count
    const upBars = this.countMomentumBars(candles, 'UP');
    const downBars = this.countMomentumBars(candles, 'DOWN');
    signals.momentumBarsUp = upBars;
    signals.momentumBarsDown = downBars;

    if (upBars >= this.parameters.minMomentumBars) {
      upScore += 2;
    }
    if (downBars >= this.parameters.minMomentumBars) {
      downScore += 2;
    }

    // Trend pattern (higher highs / lower lows)
    if (this.checkTrendPattern(candles, 'UP')) {
      upScore += 1;
      signals.trendPattern = 'HIGHER_HIGHS';
    } else if (this.checkTrendPattern(candles, 'DOWN')) {
      downScore += 1;
      signals.trendPattern = 'LOWER_LOWS';
    }

    // Calculate confidence
    const totalScore = upScore + downScore;
    if (totalScore === 0) return null;

    const maxPossibleScore = 10; // 3 (cascade) + 3 (price vs emas) + 2 (vwap) + 2 (momentum) + 1 (pattern) = 11 but we need differential

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

    // Time decay adjustment
    const timeDecay = Math.max(0.5, remainingMinutes / 15);
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
