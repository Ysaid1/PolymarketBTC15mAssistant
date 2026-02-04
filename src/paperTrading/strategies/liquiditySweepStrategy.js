/**
 * Liquidity Sweep Strategy
 *
 * Detects false breakouts (liquidity sweeps) where price shoots above/below
 * a recent high/low but instantly reverses - a classic institutional trap.
 *
 * Entry criteria:
 * - Price sweeps above a recent high or below a recent low
 * - Immediate reversal on the same or next candle
 * - Enter on the reversal, targeting the opposite end of the range
 */

import { BaseStrategy } from './baseStrategy.js';

export class LiquiditySweepStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('LIQ_SWEEP', {
      ...options,
      regimeCompatibility: ['RANGE', 'TREND_UP', 'TREND_DOWN'],
      riskLevel: 'high' // Higher risk, higher reward contrarian play
    });

    this.parameters = {
      lookbackPeriod: options.lookbackPeriod || 15, // Candles to find swing H/L
      sweepThreshold: options.sweepThreshold || 0.0005, // Min penetration (0.05%)
      maxSweepSize: options.maxSweepSize || 0.005, // Max penetration (0.5%)
      reversalStrength: options.reversalStrength || 0.3, // Min reversal relative to sweep
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Find recent swing high
   */
  findSwingHigh(candles, lookback) {
    if (candles.length < lookback) return null;

    const recent = candles.slice(-lookback, -1); // Exclude current candle
    let highest = recent[0];

    for (const candle of recent) {
      if (candle.high > highest.high) {
        highest = candle;
      }
    }

    return highest.high;
  }

  /**
   * Find recent swing low
   */
  findSwingLow(candles, lookback) {
    if (candles.length < lookback) return null;

    const recent = candles.slice(-lookback, -1); // Exclude current candle
    let lowest = recent[0];

    for (const candle of recent) {
      if (candle.low < lowest.low) {
        lowest = candle;
      }
    }

    return lowest.low;
  }

  /**
   * Detect liquidity sweep on current candle
   */
  detectSweep(candle, swingHigh, swingLow) {
    const open = candle.open;
    const close = candle.close;
    const high = candle.high;
    const low = candle.low;

    // Calculate wick sizes
    const upperWick = high - Math.max(open, close);
    const lowerWick = Math.min(open, close) - low;
    const body = Math.abs(close - open);
    const totalRange = high - low;

    // Bullish sweep: Swept below swing low, then closed higher
    // Long lower wick that went below swing low
    if (low < swingLow && close > low) {
      const sweepDepth = swingLow - low;
      const sweepPct = sweepDepth / swingLow;
      const reversal = close - low;
      const reversalRatio = totalRange > 0 ? reversal / totalRange : 0;

      // Valid bullish sweep: penetrated below, reversed strongly
      if (sweepPct >= this.parameters.sweepThreshold &&
          sweepPct <= this.parameters.maxSweepSize &&
          reversalRatio >= this.parameters.reversalStrength &&
          lowerWick > body * 1.5) { // Long lower wick
        return {
          type: 'BULLISH_SWEEP',
          sweptLevel: swingLow,
          sweepDepth,
          sweepPct,
          reversalRatio,
          wickRatio: lowerWick / body
        };
      }
    }

    // Bearish sweep: Swept above swing high, then closed lower
    // Long upper wick that went above swing high
    if (high > swingHigh && close < high) {
      const sweepDepth = high - swingHigh;
      const sweepPct = sweepDepth / swingHigh;
      const reversal = high - close;
      const reversalRatio = totalRange > 0 ? reversal / totalRange : 0;

      // Valid bearish sweep: penetrated above, reversed strongly
      if (sweepPct >= this.parameters.sweepThreshold &&
          sweepPct <= this.parameters.maxSweepSize &&
          reversalRatio >= this.parameters.reversalStrength &&
          upperWick > body * 1.5) { // Long upper wick
        return {
          type: 'BEARISH_SWEEP',
          sweptLevel: swingHigh,
          sweepDepth,
          sweepPct,
          reversalRatio,
          wickRatio: upperWick / body
        };
      }
    }

    return null;
  }

  /**
   * Check if previous candle also shows sweep confirmation
   */
  checkPreviousCandleConfirmation(prevCandle, currentCandle, sweepType) {
    if (sweepType === 'BULLISH_SWEEP') {
      // Previous candle was bearish (selling pressure), current shows reversal
      const prevWasBearish = prevCandle.close < prevCandle.open;
      const currentBullish = currentCandle.close > currentCandle.open;
      return prevWasBearish || currentBullish;
    }

    if (sweepType === 'BEARISH_SWEEP') {
      // Previous candle was bullish (buying pressure), current shows reversal
      const prevWasBullish = prevCandle.close > prevCandle.open;
      const currentBearish = currentCandle.close < currentCandle.open;
      return prevWasBullish || currentBearish;
    }

    return false;
  }

  /**
   * Calculate target (opposite end of range)
   */
  calculateTarget(sweepType, swingHigh, swingLow) {
    const range = swingHigh - swingLow;

    if (sweepType === 'BULLISH_SWEEP') {
      // Target: opposite end of range (swing high)
      return { target: swingHigh, range };
    }

    if (sweepType === 'BEARISH_SWEEP') {
      // Target: opposite end of range (swing low)
      return { target: swingLow, range };
    }

    return null;
  }

  analyze(data) {
    const { candles, price, remainingMinutes, regime } = data;

    if (!candles || candles.length < this.parameters.lookbackPeriod + 2) {
      return null;
    }

    const signals = { price };

    // Find swing levels
    const swingHigh = this.findSwingHigh(candles, this.parameters.lookbackPeriod);
    const swingLow = this.findSwingLow(candles, this.parameters.lookbackPeriod);

    if (!swingHigh || !swingLow) return null;

    signals.swingHigh = swingHigh;
    signals.swingLow = swingLow;
    signals.range = swingHigh - swingLow;

    // Get current and previous candle
    const currentCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];

    // Detect sweep on current candle
    const sweep = this.detectSweep(currentCandle, swingHigh, swingLow);

    if (!sweep) {
      return null; // No sweep detected
    }

    signals.sweep = sweep;

    // Check previous candle confirmation
    const prevConfirms = this.checkPreviousCandleConfirmation(prevCandle, currentCandle, sweep.type);
    signals.prevConfirms = prevConfirms;

    // Calculate target
    const targetInfo = this.calculateTarget(sweep.type, swingHigh, swingLow);
    signals.target = targetInfo;

    // Determine trade direction
    const side = sweep.type === 'BULLISH_SWEEP' ? 'UP' : 'DOWN';

    // Calculate confidence
    let confidence = 0.58; // Base for valid sweep

    // Reversal strength bonus
    if (sweep.reversalRatio > 0.5) confidence += 0.05;
    if (sweep.reversalRatio > 0.7) confidence += 0.05;

    // Wick ratio bonus (cleaner sweep pattern)
    if (sweep.wickRatio > 2.5) confidence += 0.03;
    if (sweep.wickRatio > 4) confidence += 0.02;

    // Previous candle confirmation bonus
    if (prevConfirms) confidence += 0.05;

    // Regime consideration
    // Sweeps work better in ranges or against weak trends
    if (regime === 'RANGE') {
      confidence += 0.05;
      signals.regimeBonus = 'Range favors sweeps';
    } else if ((sweep.type === 'BULLISH_SWEEP' && regime === 'TREND_DOWN') ||
               (sweep.type === 'BEARISH_SWEEP' && regime === 'TREND_UP')) {
      // Counter-trend sweep - risky but can mark reversals
      confidence -= 0.03;
      signals.regimeWarning = 'Counter-trend sweep';
    }

    // Time consideration - need time for price to reach target
    if (remainingMinutes < 3) {
      confidence -= 0.10; // Not enough time
    } else if (remainingMinutes > 10) {
      confidence += 0.03; // Plenty of time
    }

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
    return 'Liquidity Sweep - trades false breakouts/reversals at swing highs and lows';
  }
}

export default LiquiditySweepStrategy;
