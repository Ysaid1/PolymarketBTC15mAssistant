/**
 * Trend Confirmation Strategy
 *
 * Combines multiple trend indicators for high-confidence entries.
 * Only trades when EMA, VWAP, and price action all confirm the same direction.
 *
 * Entry criteria:
 * - EMA 8 > EMA 21 > EMA 55 (for UP) or reverse (for DOWN)
 * - Price above/below VWAP
 * - VWAP slope confirms direction
 * - At least 2 consecutive candles in direction
 */

import { BaseStrategy } from './baseStrategy.js';

export class TrendConfirmationStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('TREND_CONFIRM', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
      riskLevel: 'low'
    });

    this.parameters = {
      fastEma: options.fastEma || 8,
      mediumEma: options.mediumEma || 21,
      slowEma: options.slowEma || 55,
      minConsecutiveCandles: options.minConsecutiveCandles || 2,
      minConfidence: options.minConfidence || 0.60 // Higher threshold for quality
    };
  }

  calculateEMA(prices, period) {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  countConsecutiveDirectionalCandles(candles, direction) {
    let count = 0;
    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      const isBullish = c.close > c.open;
      if ((direction === 'UP' && isBullish) || (direction === 'DOWN' && !isBullish)) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

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

    if (!ema8 || !ema21 || !ema55 || !vwap) return null;

    const signals = { ema8, ema21, ema55, price, vwap, vwapSlope };

    // Check for perfect EMA cascade
    const bullishCascade = price > ema8 && ema8 > ema21 && ema21 > ema55;
    const bearishCascade = price < ema8 && ema8 < ema21 && ema21 < ema55;

    if (!bullishCascade && !bearishCascade) {
      return null; // No clear trend
    }

    const direction = bullishCascade ? 'UP' : 'DOWN';
    signals.cascade = direction;

    // Check VWAP alignment
    const vwapAligned = (direction === 'UP' && price > vwap && vwapSlope > 0) ||
                        (direction === 'DOWN' && price < vwap && vwapSlope < 0);

    if (!vwapAligned) {
      return null; // VWAP doesn't confirm
    }
    signals.vwapAligned = true;

    // Check consecutive candles
    const consecutiveCandles = this.countConsecutiveDirectionalCandles(candles, direction);
    signals.consecutiveCandles = consecutiveCandles;

    if (consecutiveCandles < this.parameters.minConsecutiveCandles) {
      return null; // Not enough momentum confirmation
    }

    // Calculate confidence based on alignment strength
    let confidence = 0.60; // Base for all confirmations met

    // Bonus for more consecutive candles
    confidence += Math.min(0.10, (consecutiveCandles - 2) * 0.03);

    // Bonus for strong VWAP slope
    const slopeStrength = Math.abs(vwapSlope);
    if (slopeStrength > 0.001) confidence += 0.05;

    // Time decay
    const timeDecay = Math.max(0.7, remainingMinutes / 15);
    confidence *= timeDecay;

    signals.timeDecay = timeDecay;

    if (confidence < this.parameters.minConfidence) {
      return null;
    }

    return {
      side: direction,
      confidence: Math.min(0.85, confidence),
      signals
    };
  }

  getDescription() {
    return 'High-confidence trend following requiring EMA cascade + VWAP + momentum confirmation';
  }
}

export default TrendConfirmationStrategy;
