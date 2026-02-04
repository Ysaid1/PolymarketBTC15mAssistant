/**
 * Volatility Breakout Strategy
 *
 * Trades breakouts from consolidation ranges during high volatility periods.
 * Uses ATR and Bollinger Band squeeze detection.
 *
 * Entry criteria:
 * - Price breaks out of recent range (above/below Bollinger Bands)
 * - Volume confirms the breakout
 * - Volatility (ATR) expanding after squeeze
 */

import { BaseStrategy } from './baseStrategy.js';

export class VolatilityBreakoutStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('VOLATILITY_BREAKOUT', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
      riskLevel: 'high'
    });

    this.parameters = {
      atrPeriod: options.atrPeriod || 14,
      bbPeriod: options.bbPeriod || 20,
      bbStdDev: options.bbStdDev || 2,
      squeezeThreshold: options.squeezeThreshold || 0.5, // BB width / ATR ratio for squeeze
      volumeMultiplier: options.volumeMultiplier || 1.5, // Volume must be X times average
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate Average True Range (ATR)
   */
  calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      const tr = Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      );
      trueRanges.push(tr);
    }

    // Calculate ATR as EMA of true ranges
    const k = 2 / (period + 1);
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < trueRanges.length; i++) {
      atr = trueRanges[i] * k + atr * (1 - k);
    }

    return atr;
  }

  /**
   * Calculate Bollinger Bands
   */
  calculateBollingerBands(prices, period = 20, stdDevMultiplier = 2) {
    if (prices.length < period) return null;

    const recentPrices = prices.slice(-period);
    const sma = recentPrices.reduce((a, b) => a + b, 0) / period;
    const squaredDiffs = recentPrices.map(p => Math.pow(p - sma, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: sma + stdDevMultiplier * stdDev,
      middle: sma,
      lower: sma - stdDevMultiplier * stdDev,
      width: ((sma + stdDevMultiplier * stdDev) - (sma - stdDevMultiplier * stdDev)) / sma,
      stdDev
    };
  }

  /**
   * Check for Bollinger Band squeeze (low volatility consolidation)
   */
  detectSqueeze(candles, period = 20) {
    if (candles.length < period + 10) return null;

    const closes = candles.map(c => c.close);

    // Calculate current and historical BB width
    const currentBands = this.calculateBollingerBands(closes, period);
    const histBands = this.calculateBollingerBands(closes.slice(0, -5), period);

    if (!currentBands || !histBands) return null;

    // Compare to ATR
    const atr = this.calculateATR(candles, 14);
    if (!atr) return null;

    const widthToAtr = currentBands.width * closes[closes.length - 1] / atr;
    const isSqueezing = widthToAtr < this.parameters.squeezeThreshold;
    const wasSqueezing = histBands.width < currentBands.width; // BB expanding

    return {
      isSqueezing,
      wasSqueezing,
      currentWidth: currentBands.width,
      widthToAtr,
      expanding: currentBands.width > histBands.width
    };
  }

  /**
   * Check volume confirmation
   */
  checkVolumeConfirmation(candles) {
    if (candles.length < 20) return { confirmed: false };

    const volumes = candles.map(c => c.volume || 0);
    const avgVolume = volumes.slice(-20, -1).reduce((a, b) => a + b, 0) / 19;
    const currentVolume = volumes[volumes.length - 1];

    return {
      confirmed: currentVolume > avgVolume * this.parameters.volumeMultiplier,
      ratio: avgVolume > 0 ? currentVolume / avgVolume : 1,
      currentVolume,
      avgVolume
    };
  }

  /**
   * Identify breakout direction
   */
  identifyBreakout(candles, bands) {
    if (!bands) return null;

    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    // Check for breakout above upper band
    if (current.close > bands.upper && prev.close <= bands.upper) {
      return {
        direction: 'UP',
        strength: (current.close - bands.upper) / bands.stdDev,
        breakoutPrice: bands.upper
      };
    }

    // Check for breakout below lower band
    if (current.close < bands.lower && prev.close >= bands.lower) {
      return {
        direction: 'DOWN',
        strength: (bands.lower - current.close) / bands.stdDev,
        breakoutPrice: bands.lower
      };
    }

    // Check for continuation after breakout
    if (current.close > bands.upper && current.close > prev.close) {
      return {
        direction: 'UP',
        strength: (current.close - bands.upper) / bands.stdDev,
        breakoutPrice: bands.upper,
        continuation: true
      };
    }

    if (current.close < bands.lower && current.close < prev.close) {
      return {
        direction: 'DOWN',
        strength: (bands.lower - current.close) / bands.stdDev,
        breakoutPrice: bands.lower,
        continuation: true
      };
    }

    return null;
  }

  /**
   * Analyze market data for volatility breakout signals
   */
  analyze(data) {
    const { candles, price, vwap, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.bbPeriod + 10) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const bands = this.calculateBollingerBands(closes, this.parameters.bbPeriod, this.parameters.bbStdDev);
    const atr = this.calculateATR(candles, this.parameters.atrPeriod);
    const squeeze = this.detectSqueeze(candles);
    const volume = this.checkVolumeConfirmation(candles);
    const breakout = this.identifyBreakout(candles, bands);

    if (!bands || !atr || !squeeze) return null;

    const signals = {
      price,
      bollingerUpper: bands.upper,
      bollingerLower: bands.lower,
      bollingerMiddle: bands.middle,
      bollingerWidth: bands.width,
      atr,
      squeeze,
      volume,
      breakout
    };

    // Need a breakout to trade
    if (!breakout) return null;

    let side = breakout.direction;
    let confidence = 0.5;

    // Base confidence from breakout strength
    confidence += Math.min(0.15, breakout.strength * 0.05);

    // Squeeze release adds confidence (price compressed then released)
    if (squeeze.wasSqueezing && squeeze.expanding) {
      confidence += 0.1;
      signals.squeezeRelease = true;
    }

    // Volume confirmation
    if (volume.confirmed) {
      confidence += 0.08;
      signals.volumeConfirmed = true;
    } else if (volume.ratio > 1.0) {
      confidence += 0.03;
    }

    // VWAP alignment
    if (vwap) {
      if ((side === 'UP' && price > vwap) || (side === 'DOWN' && price < vwap)) {
        confidence += 0.05;
        signals.vwapAligned = true;
      }
    }

    // Continuation breakouts are slightly less reliable
    if (breakout.continuation) {
      confidence -= 0.05;
    }

    // Time considerations - breakouts need time to play out
    if (remainingMinutes < 5) {
      confidence -= 0.1; // Less time for breakout to develop
    } else if (remainingMinutes > 12) {
      confidence += 0.02; // More time for move
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
    return 'Volatility breakout strategy trading range breaks with volume confirmation';
  }
}
