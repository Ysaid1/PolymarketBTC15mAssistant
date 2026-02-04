/**
 * MACD Strategy
 *
 * Uses MACD crossovers, histogram analysis, and divergence for trade signals.
 * Combined with signal line and zero-line analysis.
 *
 * Entry criteria:
 * - MACD line crosses signal line
 * - Histogram momentum (increasing/decreasing bars)
 * - MACD divergence from price
 * - Zero-line crossovers
 */

import { BaseStrategy } from './baseStrategy.js';

export class MACDStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('MACD', {
      ...options,
      regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
      riskLevel: 'medium'
    });

    this.parameters = {
      fastPeriod: options.fastPeriod || 12,
      slowPeriod: options.slowPeriod || 26,
      signalPeriod: options.signalPeriod || 9,
      histogramThreshold: options.histogramThreshold || 0, // Min histogram for signal
      divergenceLookback: options.divergenceLookback || 10,
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
   * Calculate EMA series
   */
  calculateEMASeries(prices, period) {
    if (prices.length < period) return [];

    const k = 2 / (period + 1);
    const emaSeries = [];
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    emaSeries.push(ema);

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
      emaSeries.push(ema);
    }

    return emaSeries;
  }

  /**
   * Calculate full MACD data
   */
  calculateMACD(prices) {
    const { fastPeriod, slowPeriod, signalPeriod } = this.parameters;

    if (prices.length < slowPeriod + signalPeriod) return null;

    const fastEMA = this.calculateEMASeries(prices, fastPeriod);
    const slowEMA = this.calculateEMASeries(prices, slowPeriod);

    // Align series (slow EMA starts later)
    const offset = slowPeriod - fastPeriod;
    const macdLine = [];

    for (let i = 0; i < slowEMA.length; i++) {
      macdLine.push(fastEMA[i + offset] - slowEMA[i]);
    }

    // Calculate signal line (EMA of MACD line)
    const signalLine = this.calculateEMASeries(macdLine, signalPeriod);

    // Align again for signal line
    const histogramOffset = signalPeriod - 1;
    const histogram = [];

    for (let i = 0; i < signalLine.length; i++) {
      histogram.push(macdLine[i + histogramOffset] - signalLine[i]);
    }

    return {
      macd: macdLine[macdLine.length - 1],
      signal: signalLine[signalLine.length - 1],
      histogram: histogram[histogram.length - 1],
      macdSeries: macdLine.slice(-20),
      signalSeries: signalLine.slice(-20),
      histogramSeries: histogram.slice(-20)
    };
  }

  /**
   * Detect MACD crossover
   */
  detectCrossover(macdData) {
    const { macdSeries, signalSeries } = macdData;

    if (macdSeries.length < 2 || signalSeries.length < 2) return null;

    const currentMacd = macdSeries[macdSeries.length - 1];
    const prevMacd = macdSeries[macdSeries.length - 2];
    const currentSignal = signalSeries[signalSeries.length - 1];
    const prevSignal = signalSeries[signalSeries.length - 2];

    // Bullish crossover: MACD crosses above signal
    if (prevMacd <= prevSignal && currentMacd > currentSignal) {
      return {
        type: 'BULLISH_CROSSOVER',
        direction: 'UP',
        strength: (currentMacd - currentSignal) / Math.abs(currentSignal || 0.0001)
      };
    }

    // Bearish crossover: MACD crosses below signal
    if (prevMacd >= prevSignal && currentMacd < currentSignal) {
      return {
        type: 'BEARISH_CROSSOVER',
        direction: 'DOWN',
        strength: (currentSignal - currentMacd) / Math.abs(currentSignal || 0.0001)
      };
    }

    return null;
  }

  /**
   * Detect zero-line crossover
   */
  detectZeroLineCrossover(macdData) {
    const { macdSeries } = macdData;

    if (macdSeries.length < 2) return null;

    const current = macdSeries[macdSeries.length - 1];
    const prev = macdSeries[macdSeries.length - 2];

    // Cross above zero (bullish)
    if (prev <= 0 && current > 0) {
      return {
        type: 'ZERO_CROSS_UP',
        direction: 'UP'
      };
    }

    // Cross below zero (bearish)
    if (prev >= 0 && current < 0) {
      return {
        type: 'ZERO_CROSS_DOWN',
        direction: 'DOWN'
      };
    }

    return null;
  }

  /**
   * Analyze histogram momentum
   */
  analyzeHistogramMomentum(histogramSeries) {
    if (histogramSeries.length < 5) return null;

    const recent = histogramSeries.slice(-5);
    let increasing = 0;
    let decreasing = 0;

    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i - 1]) increasing++;
      else if (recent[i] < recent[i - 1]) decreasing++;
    }

    const current = recent[recent.length - 1];

    if (current > 0 && increasing >= 3) {
      return {
        type: 'BULLISH_MOMENTUM',
        direction: 'UP',
        consecutiveBars: increasing
      };
    }

    if (current < 0 && decreasing >= 3) {
      return {
        type: 'BEARISH_MOMENTUM',
        direction: 'DOWN',
        consecutiveBars: decreasing
      };
    }

    // Momentum shift detection
    if (current > 0 && recent[0] < 0) {
      return {
        type: 'MOMENTUM_SHIFT_BULLISH',
        direction: 'UP',
        consecutiveBars: recent.filter(h => h > 0).length
      };
    }

    if (current < 0 && recent[0] > 0) {
      return {
        type: 'MOMENTUM_SHIFT_BEARISH',
        direction: 'DOWN',
        consecutiveBars: recent.filter(h => h < 0).length
      };
    }

    return null;
  }

  /**
   * Detect MACD divergence from price
   */
  detectDivergence(candles, macdData, lookback = 10) {
    const { macdSeries } = macdData;

    if (macdSeries.length < lookback || candles.length < lookback) return null;

    const recentCandles = candles.slice(-lookback);
    const recentMacd = macdSeries.slice(-lookback);

    const priceHighs = recentCandles.map(c => c.high);
    const priceLows = recentCandles.map(c => c.low);

    const currentPriceHigh = priceHighs[priceHighs.length - 1];
    const currentPriceLow = priceLows[priceLows.length - 1];
    const currentMacd = recentMacd[recentMacd.length - 1];

    const maxPrevPriceHigh = Math.max(...priceHighs.slice(0, -1));
    const minPrevPriceLow = Math.min(...priceLows.slice(0, -1));
    const maxPrevMacd = Math.max(...recentMacd.slice(0, -1));
    const minPrevMacd = Math.min(...recentMacd.slice(0, -1));

    // Bearish divergence: price higher high, MACD lower high
    if (currentPriceHigh >= maxPrevPriceHigh && currentMacd < maxPrevMacd) {
      return {
        type: 'BEARISH_DIVERGENCE',
        direction: 'DOWN',
        strength: (maxPrevMacd - currentMacd) / Math.abs(maxPrevMacd || 0.0001)
      };
    }

    // Bullish divergence: price lower low, MACD higher low
    if (currentPriceLow <= minPrevPriceLow && currentMacd > minPrevMacd) {
      return {
        type: 'BULLISH_DIVERGENCE',
        direction: 'UP',
        strength: (currentMacd - minPrevMacd) / Math.abs(minPrevMacd || 0.0001)
      };
    }

    return null;
  }

  /**
   * Analyze market data for MACD signals
   */
  analyze(data) {
    const { candles, price, vwap, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.slowPeriod + this.parameters.signalPeriod + 10) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const macdData = this.calculateMACD(closes);

    if (!macdData) return null;

    const crossover = this.detectCrossover(macdData);
    const zeroLineCross = this.detectZeroLineCrossover(macdData);
    const histogramMomentum = this.analyzeHistogramMomentum(macdData.histogramSeries);
    const divergence = this.detectDivergence(candles, macdData, this.parameters.divergenceLookback);

    const signals = {
      macd: macdData.macd,
      signal: macdData.signal,
      histogram: macdData.histogram,
      crossover,
      zeroLineCross,
      histogramMomentum,
      divergence
    };

    let side = null;
    let confidence = 0.5;

    // Priority 1: Fresh crossover
    if (crossover) {
      side = crossover.direction;
      confidence = 0.58;

      // Stronger crossover = more confidence
      confidence += Math.min(0.1, crossover.strength * 0.05);

      // Zero line position adds conviction
      if (side === 'UP' && macdData.macd < 0) {
        // Bullish crossover below zero (early trend)
        confidence += 0.02;
        signals.earlyTrendSignal = true;
      } else if (side === 'DOWN' && macdData.macd > 0) {
        // Bearish crossover above zero (early trend)
        confidence += 0.02;
        signals.earlyTrendSignal = true;
      }
    }
    // Priority 2: Zero line crossover
    else if (zeroLineCross) {
      side = zeroLineCross.direction;
      confidence = 0.56;
      signals.zeroLineCrossover = zeroLineCross.type;
    }
    // Priority 3: Strong histogram momentum without crossover
    else if (histogramMomentum) {
      side = histogramMomentum.direction;
      confidence = 0.54 + histogramMomentum.consecutiveBars * 0.01;
      signals.momentumSignal = histogramMomentum.type;
    }
    // Priority 4: Divergence
    else if (divergence) {
      side = divergence.direction;
      confidence = 0.55 + Math.min(0.1, divergence.strength * 0.05);
      signals.divergenceSignal = divergence.type;
    } else {
      return null; // No clear signal
    }

    // Histogram confirmation (if we have another signal)
    if (histogramMomentum && histogramMomentum.direction === side && !signals.momentumSignal) {
      confidence += 0.03;
      signals.histogramConfirms = true;
    }

    // Divergence adds to any signal
    if (divergence && divergence.direction === side && !signals.divergenceSignal) {
      confidence += 0.05;
      signals.divergenceConfirms = true;
    }

    // VWAP alignment
    if (vwap) {
      if ((side === 'UP' && price > vwap) || (side === 'DOWN' && price < vwap)) {
        confidence += 0.03;
        signals.vwapAligned = true;
      }
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
    return 'MACD strategy using crossovers, histogram momentum, and divergence analysis';
  }
}
