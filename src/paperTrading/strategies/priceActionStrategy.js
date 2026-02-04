/**
 * Price Action Strategy
 *
 * Pure price action based on candlestick patterns and support/resistance.
 * No lagging indicators - focuses on current price behavior.
 *
 * Entry criteria:
 * - Identifies key support/resistance levels
 * - Looks for rejection patterns (pin bars, engulfing)
 * - Considers price relative to recent high/low range
 */

import { BaseStrategy } from './baseStrategy.js';

export class PriceActionStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('PRICE_ACTION', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      lookbackPeriod: options.lookbackPeriod || 20,
      pinBarRatio: options.pinBarRatio || 2.5, // Wick to body ratio
      engulfingMinSize: options.engulfingMinSize || 1.5, // Times average candle
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate average candle size
   */
  getAverageCandleSize(candles) {
    const sizes = candles.map(c => Math.abs(c.high - c.low));
    return sizes.reduce((a, b) => a + b, 0) / sizes.length;
  }

  /**
   * Detect pin bar (rejection candle)
   */
  detectPinBar(candle, avgSize) {
    const body = Math.abs(candle.close - candle.open);
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const totalSize = candle.high - candle.low;

    if (totalSize < avgSize * 0.5) return null; // Too small

    // Bullish pin bar (long lower wick, small body at top)
    if (lowerWick > body * this.parameters.pinBarRatio && lowerWick > upperWick * 2) {
      return { type: 'BULLISH_PIN', strength: lowerWick / body };
    }

    // Bearish pin bar (long upper wick, small body at bottom)
    if (upperWick > body * this.parameters.pinBarRatio && upperWick > lowerWick * 2) {
      return { type: 'BEARISH_PIN', strength: upperWick / body };
    }

    return null;
  }

  /**
   * Detect engulfing pattern
   */
  detectEngulfing(current, previous) {
    const currentBody = Math.abs(current.close - current.open);
    const prevBody = Math.abs(previous.close - previous.open);

    if (prevBody === 0) return null;

    // Bullish engulfing
    if (previous.close < previous.open && // Previous red
        current.close > current.open && // Current green
        current.open <= previous.close && // Opens at or below prev close
        current.close >= previous.open) { // Closes at or above prev open
      return { type: 'BULLISH_ENGULF', strength: currentBody / prevBody };
    }

    // Bearish engulfing
    if (previous.close > previous.open && // Previous green
        current.close < current.open && // Current red
        current.open >= previous.close && // Opens at or above prev close
        current.close <= previous.open) { // Closes at or below prev open
      return { type: 'BEARISH_ENGULF', strength: currentBody / prevBody };
    }

    return null;
  }

  /**
   * Find support/resistance levels
   */
  findKeyLevels(candles, lookback = 20) {
    const recent = candles.slice(-lookback);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);

    return {
      resistance: Math.max(...highs),
      support: Math.min(...lows),
      midpoint: (Math.max(...highs) + Math.min(...lows)) / 2
    };
  }

  /**
   * Determine price position in range
   */
  getPricePosition(price, support, resistance) {
    const range = resistance - support;
    if (range === 0) return 0.5;
    return (price - support) / range;
  }

  analyze(data) {
    const { candles, price, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.lookbackPeriod + 2) {
      return null;
    }

    const recent = candles.slice(-this.parameters.lookbackPeriod);
    const avgSize = this.getAverageCandleSize(recent);
    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const signals = { avgSize, price };

    // Find key levels
    const levels = this.findKeyLevels(candles, this.parameters.lookbackPeriod);
    signals.levels = levels;

    // Get price position
    const pricePosition = this.getPricePosition(price, levels.support, levels.resistance);
    signals.pricePosition = pricePosition;

    let side = null;
    let confidence = 0.50;
    let pattern = null;

    // Check for pin bar
    const pinBar = this.detectPinBar(current, avgSize);
    if (pinBar) {
      pattern = pinBar;
      signals.pattern = pinBar;

      if (pinBar.type === 'BULLISH_PIN') {
        side = 'UP';
        confidence = 0.55 + Math.min(0.15, pinBar.strength * 0.02);

        // Stronger at support
        if (pricePosition < 0.3) {
          confidence += 0.05;
          signals.atSupport = true;
        }
      } else if (pinBar.type === 'BEARISH_PIN') {
        side = 'DOWN';
        confidence = 0.55 + Math.min(0.15, pinBar.strength * 0.02);

        // Stronger at resistance
        if (pricePosition > 0.7) {
          confidence += 0.05;
          signals.atResistance = true;
        }
      }
    }

    // Check for engulfing (if no pin bar)
    if (!pattern) {
      const engulfing = this.detectEngulfing(current, previous);
      if (engulfing && engulfing.strength >= this.parameters.engulfingMinSize) {
        pattern = engulfing;
        signals.pattern = engulfing;

        if (engulfing.type === 'BULLISH_ENGULF') {
          side = 'UP';
          confidence = 0.55 + Math.min(0.15, (engulfing.strength - 1) * 0.05);

          if (pricePosition < 0.3) {
            confidence += 0.05;
          }
        } else if (engulfing.type === 'BEARISH_ENGULF') {
          side = 'DOWN';
          confidence = 0.55 + Math.min(0.15, (engulfing.strength - 1) * 0.05);

          if (pricePosition > 0.7) {
            confidence += 0.05;
          }
        }
      }
    }

    if (!side) return null;

    // Time decay
    const timeDecay = Math.max(0.7, remainingMinutes / 15);
    confidence *= timeDecay;
    signals.timeDecay = timeDecay;

    if (confidence < this.parameters.minConfidence) {
      return null;
    }

    return {
      side,
      confidence: Math.min(0.80, confidence),
      signals
    };
  }

  getDescription() {
    return 'Price action patterns (pin bars, engulfing) at key support/resistance levels';
  }
}

export default PriceActionStrategy;
