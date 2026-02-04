/**
 * Volume Profile Strategy
 *
 * Uses volume analysis to confirm price moves.
 * High volume on direction = strong move, low volume = weak/reversal likely.
 *
 * Entry criteria:
 * - Volume spike (above average)
 * - Volume confirms price direction
 * - Volume trend (increasing or decreasing)
 */

import { BaseStrategy } from './baseStrategy.js';

export class VolumeProfileStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('VOLUME_PROFILE', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      volumeLookback: options.volumeLookback || 20,
      spikeThreshold: options.spikeThreshold || 1.5, // Times average
      trendLookback: options.trendLookback || 5,
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate average volume
   */
  getAverageVolume(candles) {
    const volumes = candles.map(c => c.volume);
    return volumes.reduce((a, b) => a + b, 0) / volumes.length;
  }

  /**
   * Check if current volume is a spike
   */
  isVolumeSpike(currentVolume, avgVolume) {
    return currentVolume > avgVolume * this.parameters.spikeThreshold;
  }

  /**
   * Calculate volume trend (increasing or decreasing)
   */
  getVolumeTrend(candles, lookback = 5) {
    if (candles.length < lookback) return 0;

    const recent = candles.slice(-lookback);
    const volumes = recent.map(c => c.volume);

    let increasing = 0;
    for (let i = 1; i < volumes.length; i++) {
      if (volumes[i] > volumes[i - 1]) increasing++;
    }

    // Return -1 to 1 (decreasing to increasing)
    return (increasing / (lookback - 1)) * 2 - 1;
  }

  /**
   * Analyze volume by direction (up vs down candles)
   */
  getDirectionalVolume(candles, lookback = 10) {
    const recent = candles.slice(-lookback);
    let upVolume = 0;
    let downVolume = 0;

    for (const c of recent) {
      if (c.close > c.open) {
        upVolume += c.volume;
      } else {
        downVolume += c.volume;
      }
    }

    const total = upVolume + downVolume;
    if (total === 0) return { upRatio: 0.5, downRatio: 0.5 };

    return {
      upRatio: upVolume / total,
      downRatio: downVolume / total,
      upVolume,
      downVolume
    };
  }

  /**
   * Detect volume divergence (price moves one way, volume another)
   */
  detectDivergence(candles, lookback = 5) {
    if (candles.length < lookback + 1) return null;

    const recent = candles.slice(-lookback);
    const priceChange = recent[recent.length - 1].close - recent[0].close;
    const volumeTrend = this.getVolumeTrend(candles, lookback);

    // Price going up but volume decreasing = bearish divergence
    if (priceChange > 0 && volumeTrend < -0.3) {
      return { type: 'BEARISH_DIVERGENCE', strength: Math.abs(volumeTrend) };
    }

    // Price going down but volume decreasing = bullish divergence
    if (priceChange < 0 && volumeTrend < -0.3) {
      return { type: 'BULLISH_DIVERGENCE', strength: Math.abs(volumeTrend) };
    }

    return null;
  }

  analyze(data) {
    const { candles, price, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.volumeLookback + 1) {
      return null;
    }

    const recent = candles.slice(-this.parameters.volumeLookback);
    const current = candles[candles.length - 1];
    const avgVolume = this.getAverageVolume(recent);
    const currentVolume = current.volume;

    const signals = {
      avgVolume,
      currentVolume,
      volumeRatio: currentVolume / avgVolume
    };

    // Get directional volume
    const directional = this.getDirectionalVolume(candles, 10);
    signals.directional = directional;

    // Get volume trend
    const volumeTrend = this.getVolumeTrend(candles, this.parameters.trendLookback);
    signals.volumeTrend = volumeTrend;

    // Check for volume spike
    const isSpike = this.isVolumeSpike(currentVolume, avgVolume);
    signals.isSpike = isSpike;

    // Current candle direction
    const currentDirection = current.close > current.open ? 'UP' : 'DOWN';
    signals.currentDirection = currentDirection;

    let side = null;
    let confidence = 0.50;

    // Strategy 1: Volume spike confirms direction
    if (isSpike) {
      side = currentDirection;
      confidence = 0.55;

      // Stronger spike = higher confidence
      const spikeStrength = signals.volumeRatio;
      confidence += Math.min(0.15, (spikeStrength - 1.5) * 0.05);

      // Volume trend confirms
      if ((side === 'UP' && volumeTrend > 0.3) || (side === 'DOWN' && volumeTrend > 0.3)) {
        confidence += 0.05;
        signals.trendConfirms = true;
      }
    }

    // Strategy 2: Strong directional volume imbalance
    if (!side && (directional.upRatio > 0.65 || directional.downRatio > 0.65)) {
      side = directional.upRatio > directional.downRatio ? 'UP' : 'DOWN';
      confidence = 0.55;

      const imbalance = Math.max(directional.upRatio, directional.downRatio);
      confidence += (imbalance - 0.65) * 0.3;
      signals.volumeImbalance = imbalance;
    }

    // Strategy 3: Volume divergence (contrarian)
    if (!side) {
      const divergence = this.detectDivergence(candles, 5);
      if (divergence) {
        signals.divergence = divergence;

        if (divergence.type === 'BULLISH_DIVERGENCE') {
          side = 'UP';
          confidence = 0.55 + divergence.strength * 0.1;
        } else if (divergence.type === 'BEARISH_DIVERGENCE') {
          side = 'DOWN';
          confidence = 0.55 + divergence.strength * 0.1;
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
    return 'Volume analysis: spikes, directional imbalance, and divergence';
  }
}

export default VolumeProfileStrategy;
