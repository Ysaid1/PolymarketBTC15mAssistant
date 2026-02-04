/**
 * Opening Range Breakout (ORB) Strategy
 *
 * Identifies breakouts from the first 15 minutes of a major session.
 * Best used during high-volatility market openings.
 *
 * Entry criteria:
 * - Price breaks above/below the opening range high/low
 * - Volume confirms the breakout (above average)
 * - Breakout occurs within reasonable time after range formation
 */

import { BaseStrategy } from './baseStrategy.js';

export class ORBStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('ORB', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      rangePeriod: options.rangePeriod || 3, // First 3 candles (3 min at 1m timeframe)
      breakoutBuffer: options.breakoutBuffer || 0.0001, // 0.01% buffer
      volumeThreshold: options.volumeThreshold || 1.3, // 1.3x average volume
      minConfidence: options.minConfidence || 0.55
    };

    // Track session range
    this.sessionRange = null;
    this.lastSessionStart = null;
  }

  /**
   * Detect session start times (major market openings)
   * Returns true if we're near a major session opening
   */
  isNearSessionOpen(timestamp) {
    const date = new Date(timestamp);
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();

    // Major session opens (UTC):
    // - Tokyo: 00:00 UTC
    // - London: 08:00 UTC
    // - New York: 14:30 UTC (13:30 during DST)
    const sessionOpens = [
      { hour: 0, name: 'Tokyo' },
      { hour: 8, name: 'London' },
      { hour: 14, name: 'NewYork' }
    ];

    for (const session of sessionOpens) {
      // Within 30 minutes of session open
      if (hour === session.hour && minute < 30) {
        return { isOpen: true, session: session.name };
      }
    }

    return { isOpen: false };
  }

  /**
   * Calculate the opening range from first N candles
   */
  calculateOpeningRange(candles, period) {
    if (candles.length < period) return null;

    const rangeCandles = candles.slice(0, period);
    const high = Math.max(...rangeCandles.map(c => c.high));
    const low = Math.min(...rangeCandles.map(c => c.low));
    const avgVolume = rangeCandles.reduce((sum, c) => sum + c.volume, 0) / period;

    return {
      high,
      low,
      range: high - low,
      midpoint: (high + low) / 2,
      avgVolume
    };
  }

  /**
   * Check if price has broken out of the range
   */
  detectBreakout(price, range, buffer) {
    const bufferAmount = range.range * buffer;

    if (price > range.high + bufferAmount) {
      return { direction: 'UP', strength: (price - range.high) / range.range };
    }

    if (price < range.low - bufferAmount) {
      return { direction: 'DOWN', strength: (range.low - price) / range.range };
    }

    return null;
  }

  /**
   * Get average volume for comparison
   */
  getAverageVolume(candles, lookback = 20) {
    if (candles.length < lookback) return 0;
    const recent = candles.slice(-lookback);
    return recent.reduce((sum, c) => sum + c.volume, 0) / lookback;
  }

  analyze(data) {
    const { candles, price, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.rangePeriod + 5) {
      return null;
    }

    const signals = { price };

    // For 15-min Polymarket markets, treat each market as a "session"
    // Use the first few candles to establish the range
    const timeSinceMarketStart = 15 - remainingMinutes;

    // Only look for breakouts after range formation (after first 3 minutes)
    if (timeSinceMarketStart < 3) {
      return null; // Still forming range
    }

    // Calculate range from most recent candles representing the "opening"
    // Use last 20 candles, first 3 are the "range"
    const recentCandles = candles.slice(-20);
    const range = this.calculateOpeningRange(recentCandles, this.parameters.rangePeriod);

    if (!range || range.range === 0) {
      return null;
    }

    signals.range = range;

    // Check for breakout
    const breakout = this.detectBreakout(price, range, this.parameters.breakoutBuffer);

    if (!breakout) {
      return null;
    }

    signals.breakout = breakout;

    // Volume confirmation
    const currentCandle = candles[candles.length - 1];
    const avgVolume = this.getAverageVolume(candles, 20);
    const volumeRatio = currentCandle.volume / avgVolume;
    signals.volumeRatio = volumeRatio;

    // Check if volume confirms breakout
    const volumeConfirms = volumeRatio >= this.parameters.volumeThreshold;
    signals.volumeConfirms = volumeConfirms;

    if (!volumeConfirms) {
      // Weak breakout without volume - reduce confidence significantly
      signals.weakBreakout = true;
    }

    // Calculate confidence
    let confidence = 0.55;

    // Breakout strength bonus
    if (breakout.strength > 0.5) confidence += 0.05;
    if (breakout.strength > 1.0) confidence += 0.05;

    // Volume confirmation bonus
    if (volumeConfirms) {
      confidence += 0.10;
      if (volumeRatio > 2.0) confidence += 0.05;
    } else {
      confidence -= 0.05; // Penalty for weak volume
    }

    // Time remaining consideration
    if (remainingMinutes < 5) {
      confidence -= 0.05; // Less time for breakout to play out
    }

    // Time decay
    const timeDecay = Math.max(0.7, remainingMinutes / 15);
    confidence *= timeDecay;
    signals.timeDecay = timeDecay;

    if (confidence < this.parameters.minConfidence) {
      return null;
    }

    return {
      side: breakout.direction,
      confidence: Math.min(0.80, confidence),
      signals
    };
  }

  getDescription() {
    return 'Opening Range Breakout - trades breakouts from session opening range with volume confirmation';
  }
}

export default ORBStrategy;
