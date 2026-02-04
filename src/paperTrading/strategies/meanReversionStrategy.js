/**
 * Mean Reversion Strategy
 *
 * Bets on price returning to mean (VWAP or moving average)
 * after significant deviation.
 *
 * Entry criteria:
 * - Price significantly deviated from VWAP (>1 standard deviation)
 * - Showing signs of reversal (momentum slowing, candle patterns)
 * - Not in strong trending market (avoid fighting the trend)
 */

import { BaseStrategy } from './baseStrategy.js';

export class MeanReversionStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('MEAN_REVERSION', {
      ...options,
      regimeCompatibility: ['RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      stdDevThreshold: options.stdDevThreshold || 1.5, // How far from mean before entry
      maxStdDev: options.maxStdDev || 3.0, // Don't enter if too extreme (breakout)
      lookbackPeriod: options.lookbackPeriod || 20, // Period for std dev calculation
      reversalConfirmation: options.reversalConfirmation || true, // Require reversal candle
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate standard deviation
   */
  calculateStdDev(prices) {
    if (prices.length < 2) return 0;
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const squaredDiffs = prices.map(p => Math.pow(p - mean, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / prices.length;
    return Math.sqrt(variance);
  }

  /**
   * Calculate Bollinger Bands
   */
  calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return null;

    const recentPrices = prices.slice(-period);
    const sma = recentPrices.reduce((a, b) => a + b, 0) / period;
    const stdDev = this.calculateStdDev(recentPrices);

    return {
      upper: sma + stdDevMultiplier * stdDev,
      middle: sma,
      lower: sma - stdDevMultiplier * stdDev,
      stdDev
    };
  }

  /**
   * Check for reversal candle pattern
   */
  checkReversalPattern(candles, direction) {
    if (candles.length < 3) return false;

    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    if (direction === 'UP') {
      // Bullish reversal patterns
      // Hammer: small body at top, long lower wick
      const bodySize = Math.abs(current.close - current.open);
      const lowerWick = Math.min(current.open, current.close) - current.low;
      const upperWick = current.high - Math.max(current.open, current.close);
      const totalRange = current.high - current.low;

      // Hammer
      if (lowerWick > bodySize * 2 && upperWick < bodySize && current.close > current.open) {
        return { pattern: 'HAMMER', strength: 0.8 };
      }

      // Bullish engulfing
      if (prev.close < prev.open && // Previous was bearish
          current.close > current.open && // Current is bullish
          current.close > prev.open && // Engulfs previous
          current.open < prev.close) {
        return { pattern: 'BULLISH_ENGULFING', strength: 0.9 };
      }

      // Morning doji star (simplified)
      if (bodySize / totalRange < 0.1 && prev.close < prev.open) {
        return { pattern: 'DOJI_REVERSAL', strength: 0.6 };
      }
    } else {
      // Bearish reversal patterns
      const bodySize = Math.abs(current.close - current.open);
      const upperWick = current.high - Math.max(current.open, current.close);
      const lowerWick = Math.min(current.open, current.close) - current.low;
      const totalRange = current.high - current.low;

      // Shooting star
      if (upperWick > bodySize * 2 && lowerWick < bodySize && current.close < current.open) {
        return { pattern: 'SHOOTING_STAR', strength: 0.8 };
      }

      // Bearish engulfing
      if (prev.close > prev.open && // Previous was bullish
          current.close < current.open && // Current is bearish
          current.open > prev.close && // Engulfs previous
          current.close < prev.open) {
        return { pattern: 'BEARISH_ENGULFING', strength: 0.9 };
      }

      // Evening doji star (simplified)
      if (bodySize / totalRange < 0.1 && prev.close > prev.open) {
        return { pattern: 'DOJI_REVERSAL', strength: 0.6 };
      }
    }

    return false;
  }

  /**
   * Check if momentum is fading
   */
  checkMomentumFading(candles) {
    if (candles.length < 5) return null;

    const recent = candles.slice(-5);
    const bodies = recent.map(c => Math.abs(c.close - c.open));

    // Check if bodies are shrinking (momentum fading)
    let shrinking = 0;
    for (let i = 1; i < bodies.length; i++) {
      if (bodies[i] < bodies[i - 1]) shrinking++;
    }

    return shrinking >= 3;
  }

  /**
   * Analyze market data for mean reversion signals
   */
  analyze(data) {
    const { candles, price, vwap, vwapSlope, rsi, regime, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.lookbackPeriod) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const bands = this.calculateBollingerBands(closes, this.parameters.lookbackPeriod);

    if (!bands || !vwap) return null;

    const signals = {
      price,
      vwap,
      bollingerUpper: bands.upper,
      bollingerLower: bands.lower,
      bollingerMiddle: bands.middle,
      stdDev: bands.stdDev
    };

    // Calculate deviation from VWAP in standard deviations
    const deviationFromVwap = (price - vwap) / bands.stdDev;
    signals.deviationFromVwap = deviationFromVwap;

    // Don't trade in strong trends (mean reversion fails)
    if (regime === 'TREND_UP' && deviationFromVwap > 0) return null;
    if (regime === 'TREND_DOWN' && deviationFromVwap < 0) return null;

    let side = null;
    let confidence = 0.5;

    // Oversold condition (price below mean)
    if (deviationFromVwap < -this.parameters.stdDevThreshold &&
        deviationFromVwap > -this.parameters.maxStdDev) {
      side = 'UP';
      signals.condition = 'OVERSOLD';

      // Base confidence from deviation magnitude
      const deviationScore = Math.min(1, (Math.abs(deviationFromVwap) - this.parameters.stdDevThreshold) /
        (this.parameters.maxStdDev - this.parameters.stdDevThreshold));
      confidence = 0.55 + deviationScore * 0.15;

      // Check RSI confirmation
      if (rsi && rsi < 30) {
        confidence += 0.05;
        signals.rsiConfirm = true;
      }

      // Check reversal pattern
      const reversal = this.checkReversalPattern(candles, 'UP');
      if (reversal) {
        confidence += reversal.strength * 0.1;
        signals.reversalPattern = reversal.pattern;
      }

      // Check momentum fading
      if (this.checkMomentumFading(candles)) {
        confidence += 0.05;
        signals.momentumFading = true;
      }
    }
    // Overbought condition (price above mean)
    else if (deviationFromVwap > this.parameters.stdDevThreshold &&
             deviationFromVwap < this.parameters.maxStdDev) {
      side = 'DOWN';
      signals.condition = 'OVERBOUGHT';

      // Base confidence from deviation magnitude
      const deviationScore = Math.min(1, (Math.abs(deviationFromVwap) - this.parameters.stdDevThreshold) /
        (this.parameters.maxStdDev - this.parameters.stdDevThreshold));
      confidence = 0.55 + deviationScore * 0.15;

      // Check RSI confirmation
      if (rsi && rsi > 70) {
        confidence += 0.05;
        signals.rsiConfirm = true;
      }

      // Check reversal pattern
      const reversal = this.checkReversalPattern(candles, 'DOWN');
      if (reversal) {
        confidence += reversal.strength * 0.1;
        signals.reversalPattern = reversal.pattern;
      }

      // Check momentum fading
      if (this.checkMomentumFading(candles)) {
        confidence += 0.05;
        signals.momentumFading = true;
      }
    } else {
      return null; // No significant deviation
    }

    // Time decay adjustment
    const timeDecay = Math.max(0.5, remainingMinutes / 15);
    confidence = 0.5 + (confidence - 0.5) * timeDecay;

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
    return 'Mean reversion strategy betting on price return to VWAP after extreme deviation';
  }
}
