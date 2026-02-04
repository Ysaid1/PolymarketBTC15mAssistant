/**
 * Support/Resistance Flip Strategy
 *
 * Identifies key S/R levels, waits for breakout and retest.
 * Confirms with RSI (avoiding extreme overbought/oversold during trend continuation).
 *
 * Entry criteria:
 * - Clear support or resistance level identified
 * - Price breaks through level
 * - Price retests the level (support becomes resistance or vice versa)
 * - RSI confirms (not in extreme territory)
 */

import { BaseStrategy } from './baseStrategy.js';

export class SRFlipStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('SR_FLIP', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      srLookback: options.srLookback || 30, // Candles to find S/R
      touchThreshold: options.touchThreshold || 0.001, // 0.1% tolerance for level touch
      retestWindow: options.retestWindow || 5, // Candles to wait for retest
      rsiPeriod: options.rsiPeriod || 14,
      rsiOverbought: options.rsiOverbought || 70,
      rsiOversold: options.rsiOversold || 30,
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Find swing highs and lows (potential S/R levels)
   */
  findSwingPoints(candles, lookback = 3) {
    const highs = [];
    const lows = [];

    for (let i = lookback; i < candles.length - lookback; i++) {
      const current = candles[i];

      // Check for swing high
      let isSwingHigh = true;
      let isSwingLow = true;

      for (let j = 1; j <= lookback; j++) {
        if (candles[i - j].high >= current.high || candles[i + j].high >= current.high) {
          isSwingHigh = false;
        }
        if (candles[i - j].low <= current.low || candles[i + j].low <= current.low) {
          isSwingLow = false;
        }
      }

      if (isSwingHigh) {
        highs.push({ price: current.high, index: i, type: 'resistance' });
      }
      if (isSwingLow) {
        lows.push({ price: current.low, index: i, type: 'support' });
      }
    }

    return { highs, lows };
  }

  /**
   * Cluster nearby levels to find strong S/R zones
   */
  clusterLevels(points, tolerance) {
    if (points.length === 0) return [];

    const sorted = [...points].sort((a, b) => a.price - b.price);
    const clusters = [];
    let currentCluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const diff = (sorted[i].price - currentCluster[0].price) / currentCluster[0].price;

      if (diff <= tolerance) {
        currentCluster.push(sorted[i]);
      } else {
        if (currentCluster.length >= 2) {
          const avgPrice = currentCluster.reduce((sum, p) => sum + p.price, 0) / currentCluster.length;
          clusters.push({
            price: avgPrice,
            touches: currentCluster.length,
            type: currentCluster[0].type
          });
        }
        currentCluster = [sorted[i]];
      }
    }

    // Don't forget the last cluster
    if (currentCluster.length >= 2) {
      const avgPrice = currentCluster.reduce((sum, p) => sum + p.price, 0) / currentCluster.length;
      clusters.push({
        price: avgPrice,
        touches: currentCluster.length,
        type: currentCluster[0].type
      });
    }

    return clusters;
  }

  /**
   * Find the most relevant S/R level near current price
   */
  findNearestLevel(price, levels, maxDistance = 0.02) {
    let nearest = null;
    let minDist = Infinity;

    for (const level of levels) {
      const dist = Math.abs(price - level.price) / price;
      if (dist < minDist && dist <= maxDistance) {
        minDist = dist;
        nearest = { ...level, distance: dist };
      }
    }

    return nearest;
  }

  /**
   * Detect if price has broken through a level
   */
  detectBreakthrough(candles, level, threshold) {
    const recent = candles.slice(-10);

    // Find if price was on one side, then moved to the other
    let wasBelow = false;
    let wasAbove = false;
    let crossedAbove = false;
    let crossedBelow = false;

    for (const candle of recent) {
      const belowLevel = candle.close < level.price * (1 - threshold);
      const aboveLevel = candle.close > level.price * (1 + threshold);

      if (belowLevel) wasBelow = true;
      if (aboveLevel) wasAbove = true;

      if (wasBelow && aboveLevel) crossedAbove = true;
      if (wasAbove && belowLevel) crossedBelow = true;
    }

    if (crossedAbove) return { direction: 'UP', broke: 'resistance' };
    if (crossedBelow) return { direction: 'DOWN', broke: 'support' };

    return null;
  }

  /**
   * Check for retest of broken level
   */
  detectRetest(price, level, threshold) {
    const distance = Math.abs(price - level.price) / price;

    if (distance <= threshold * 2) {
      return {
        isRetesting: true,
        distance,
        pricePosition: price > level.price ? 'above' : 'below'
      };
    }

    return { isRetesting: false };
  }

  /**
   * Calculate RSI
   */
  calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  analyze(data) {
    const { candles, price, rsi, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.srLookback + 10) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const signals = { price };

    // Find swing points
    const recentCandles = candles.slice(-this.parameters.srLookback);
    const swings = this.findSwingPoints(recentCandles, 2);

    // Cluster into S/R levels
    const resistanceLevels = this.clusterLevels(swings.highs, this.parameters.touchThreshold * 3);
    const supportLevels = this.clusterLevels(swings.lows, this.parameters.touchThreshold * 3);
    const allLevels = [...resistanceLevels, ...supportLevels];

    signals.levelsFound = allLevels.length;

    if (allLevels.length === 0) {
      return null; // No clear S/R levels
    }

    // Find nearest level
    const nearestLevel = this.findNearestLevel(price, allLevels, 0.015);

    if (!nearestLevel) {
      return null; // No level near current price
    }

    signals.nearestLevel = nearestLevel;

    // Detect breakthrough
    const breakthrough = this.detectBreakthrough(candles, nearestLevel, this.parameters.touchThreshold);

    if (!breakthrough) {
      return null; // No breakthrough detected
    }

    signals.breakthrough = breakthrough;

    // Check for retest
    const retest = this.detectRetest(price, nearestLevel, this.parameters.touchThreshold);
    signals.retest = retest;

    // Validate the flip setup
    let validSetup = false;
    let side = null;

    // Bullish flip: broke resistance, retesting from above (resistance became support)
    if (breakthrough.direction === 'UP' && retest.isRetesting && retest.pricePosition === 'above') {
      validSetup = true;
      side = 'UP';
      signals.flipType = 'RESISTANCE_TO_SUPPORT';
    }

    // Bearish flip: broke support, retesting from below (support became resistance)
    if (breakthrough.direction === 'DOWN' && retest.isRetesting && retest.pricePosition === 'below') {
      validSetup = true;
      side = 'DOWN';
      signals.flipType = 'SUPPORT_TO_RESISTANCE';
    }

    if (!validSetup) {
      return null;
    }

    // RSI confirmation - avoid extreme levels during trend continuation
    const currentRSI = rsi || this.calculateRSI(closes, this.parameters.rsiPeriod);
    signals.rsi = currentRSI;

    // For bullish continuation, RSI shouldn't be extremely overbought
    // For bearish continuation, RSI shouldn't be extremely oversold
    let rsiConfirms = true;
    if (side === 'UP' && currentRSI > this.parameters.rsiOverbought + 5) {
      rsiConfirms = false;
      signals.rsiWarning = 'Extremely overbought';
    }
    if (side === 'DOWN' && currentRSI < this.parameters.rsiOversold - 5) {
      rsiConfirms = false;
      signals.rsiWarning = 'Extremely oversold';
    }

    signals.rsiConfirms = rsiConfirms;

    // Calculate confidence
    let confidence = 0.58; // Base for valid S/R flip setup

    // Bonus for level strength (more touches)
    if (nearestLevel.touches >= 3) confidence += 0.05;
    if (nearestLevel.touches >= 4) confidence += 0.03;

    // RSI confirmation bonus
    if (rsiConfirms) {
      confidence += 0.05;
      // Extra bonus if RSI is in favorable zone
      if (side === 'UP' && currentRSI > 40 && currentRSI < 60) confidence += 0.03;
      if (side === 'DOWN' && currentRSI > 40 && currentRSI < 60) confidence += 0.03;
    } else {
      confidence -= 0.10; // Penalty for RSI warning
    }

    // Proximity to level bonus (closer = cleaner retest)
    if (retest.distance < this.parameters.touchThreshold) {
      confidence += 0.03;
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
    return 'Support/Resistance Flip - trades breakout and retest of key levels with RSI confirmation';
  }
}

export default SRFlipStrategy;
