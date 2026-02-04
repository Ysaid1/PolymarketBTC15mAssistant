/**
 * EMA Crossover Strategy (5/20)
 *
 * Uses fast (5) and slow (20) Exponential Moving Averages to capture short-term trends.
 * Bullish when 5 EMA crosses above 20 EMA, bearish on reverse.
 *
 * Entry criteria:
 * - EMA crossover occurred recently (within last 3 candles)
 * - Price confirms direction (above/below both EMAs)
 * - Optional: 4H trend alignment for higher probability
 */

import { BaseStrategy } from './baseStrategy.js';

export class EMACrossoverStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('EMA_CROSS', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
      riskLevel: 'low'
    });

    this.parameters = {
      fastPeriod: options.fastPeriod || 5,
      slowPeriod: options.slowPeriod || 20,
      crossoverLookback: options.crossoverLookback || 3, // Look for cross in last 3 candles
      minSeparation: options.minSeparation || 0.0001, // Min EMA separation after cross
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate EMA for a price series
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
   * Get EMA series (for detecting crossovers)
   */
  getEMASeries(prices, period, length = 10) {
    if (prices.length < period + length) return [];

    const series = [];
    const k = 2 / (period + 1);

    // Initialize EMA
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
      if (i >= prices.length - length) {
        series.push(ema);
      }
    }

    return series;
  }

  /**
   * Detect recent crossover
   */
  detectCrossover(fastSeries, slowSeries, lookback) {
    if (fastSeries.length < lookback + 1 || slowSeries.length < lookback + 1) {
      return null;
    }

    const len = Math.min(fastSeries.length, slowSeries.length);

    for (let i = len - lookback; i < len; i++) {
      const prevFast = fastSeries[i - 1];
      const prevSlow = slowSeries[i - 1];
      const currFast = fastSeries[i];
      const currSlow = slowSeries[i];

      // Bullish crossover: fast crosses above slow
      if (prevFast <= prevSlow && currFast > currSlow) {
        return {
          type: 'BULLISH',
          candlesAgo: len - 1 - i,
          separation: (currFast - currSlow) / currSlow
        };
      }

      // Bearish crossover: fast crosses below slow
      if (prevFast >= prevSlow && currFast < currSlow) {
        return {
          type: 'BEARISH',
          candlesAgo: len - 1 - i,
          separation: (currSlow - currFast) / currSlow
        };
      }
    }

    return null;
  }

  /**
   * Check if price confirms the crossover direction
   */
  priceConfirms(price, fastEMA, slowEMA, direction) {
    if (direction === 'BULLISH') {
      return price > fastEMA && price > slowEMA;
    } else {
      return price < fastEMA && price < slowEMA;
    }
  }

  /**
   * Calculate EMA slope (momentum)
   */
  getEMASlope(series, lookback = 3) {
    if (series.length < lookback) return 0;
    const recent = series.slice(-lookback);
    return (recent[recent.length - 1] - recent[0]) / recent[0];
  }

  analyze(data) {
    const { candles, price, remainingMinutes, regime } = data;

    if (!candles || candles.length < this.parameters.slowPeriod + 10) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const signals = { price };

    // Calculate current EMAs
    const fastEMA = this.calculateEMA(closes, this.parameters.fastPeriod);
    const slowEMA = this.calculateEMA(closes, this.parameters.slowPeriod);

    if (!fastEMA || !slowEMA) return null;

    signals.fastEMA = fastEMA;
    signals.slowEMA = slowEMA;

    // Get EMA series for crossover detection
    const fastSeries = this.getEMASeries(closes, this.parameters.fastPeriod, 10);
    const slowSeries = this.getEMASeries(closes, this.parameters.slowPeriod, 10);

    // Detect crossover
    const crossover = this.detectCrossover(
      fastSeries,
      slowSeries,
      this.parameters.crossoverLookback
    );

    if (!crossover) {
      return null; // No recent crossover
    }

    signals.crossover = crossover;

    // Check EMA separation (avoid weak signals)
    if (Math.abs(crossover.separation) < this.parameters.minSeparation) {
      return null;
    }

    // Check price confirmation
    const direction = crossover.type === 'BULLISH' ? 'UP' : 'DOWN';
    const priceConfirmed = this.priceConfirms(price, fastEMA, slowEMA, crossover.type);
    signals.priceConfirmed = priceConfirmed;

    if (!priceConfirmed) {
      return null; // Price doesn't confirm crossover
    }

    // Calculate confidence
    let confidence = 0.58; // Base confidence for confirmed crossover

    // Bonus for recent crossover (more actionable)
    if (crossover.candlesAgo === 0) confidence += 0.05;
    else if (crossover.candlesAgo === 1) confidence += 0.03;

    // Bonus for strong separation
    if (Math.abs(crossover.separation) > 0.001) confidence += 0.05;

    // EMA slope confirmation
    const fastSlope = this.getEMASlope(fastSeries, 3);
    signals.fastSlope = fastSlope;

    if ((direction === 'UP' && fastSlope > 0) || (direction === 'DOWN' && fastSlope < 0)) {
      confidence += 0.03;
      signals.slopeConfirms = true;
    }

    // Regime alignment bonus
    if ((direction === 'UP' && regime === 'TREND_UP') ||
        (direction === 'DOWN' && regime === 'TREND_DOWN')) {
      confidence += 0.05;
      signals.regimeAligned = true;
    }

    // Time decay
    const timeDecay = Math.max(0.7, remainingMinutes / 15);
    confidence *= timeDecay;
    signals.timeDecay = timeDecay;

    if (confidence < this.parameters.minConfidence) {
      return null;
    }

    return {
      side: direction,
      confidence: Math.min(0.80, confidence),
      signals
    };
  }

  getDescription() {
    return 'EMA Crossover (5/20) - trades fast/slow EMA crossovers with price confirmation';
  }
}

export default EMACrossoverStrategy;
