/**
 * RSI Overbought/Oversold Strategy
 *
 * Uses RSI with multiple confirmations to identify reversal points.
 * Includes RSI divergence detection and momentum analysis.
 *
 * Entry criteria:
 * - RSI in extreme zones (oversold <30, overbought >70)
 * - RSI divergence from price (hidden or regular)
 * - RSI crossing back from extreme zones
 */

import { BaseStrategy } from './baseStrategy.js';

export class RSIStrategy extends BaseStrategy {
  constructor(options = {}) {
    super('RSI', {
      ...options,
      regimeCompatibility: ['RANGE', 'CHOP', 'TREND_UP', 'TREND_DOWN'],
      riskLevel: 'low'
    });

    this.parameters = {
      rsiPeriod: options.rsiPeriod || 14,
      oversoldLevel: options.oversoldLevel || 30,
      overboughtLevel: options.overboughtLevel || 70,
      extremeOversold: options.extremeOversold || 20,
      extremeOverbought: options.extremeOverbought || 80,
      divergenceLookback: options.divergenceLookback || 10,
      minConfidence: options.minConfidence || 0.55
    };
  }

  /**
   * Calculate RSI
   */
  calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;

    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    let gains = 0;
    let losses = 0;

    // Initial average
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) gains += changes[i];
      else losses -= changes[i];
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    // Smoothed RSI
    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      if (change > 0) {
        avgGain = (avgGain * (period - 1) + change) / period;
        avgLoss = (avgLoss * (period - 1)) / period;
      } else {
        avgGain = (avgGain * (period - 1)) / period;
        avgLoss = (avgLoss * (period - 1) - change) / period;
      }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate RSI series for divergence analysis
   */
  calculateRSISeries(prices, period = 14) {
    if (prices.length < period + 1) return [];

    const rsiSeries = [];
    for (let i = period + 1; i <= prices.length; i++) {
      const subPrices = prices.slice(0, i);
      rsiSeries.push(this.calculateRSI(subPrices, period));
    }

    return rsiSeries;
  }

  /**
   * Detect RSI divergence
   * Regular divergence: price makes new high/low but RSI doesn't (trend reversal)
   * Hidden divergence: RSI makes new high/low but price doesn't (trend continuation)
   */
  detectDivergence(candles, rsiSeries, lookback = 10) {
    if (rsiSeries.length < lookback || candles.length < lookback) return null;

    const recentCandles = candles.slice(-lookback);
    const recentRSI = rsiSeries.slice(-lookback);

    const priceHighs = recentCandles.map(c => c.high);
    const priceLows = recentCandles.map(c => c.low);

    // Find local extremes
    const priceHighIdx = priceHighs.indexOf(Math.max(...priceHighs));
    const priceLowIdx = priceLows.indexOf(Math.min(...priceLows));
    const rsiHighIdx = recentRSI.indexOf(Math.max(...recentRSI));
    const rsiLowIdx = recentRSI.indexOf(Math.min(...recentRSI));

    const currentPriceHigh = priceHighs[priceHighs.length - 1];
    const currentPriceLow = priceLows[priceLows.length - 1];
    const currentRSI = recentRSI[recentRSI.length - 1];

    // Regular bearish divergence: price higher high, RSI lower high
    if (currentPriceHigh >= Math.max(...priceHighs.slice(0, -1)) &&
        currentRSI < Math.max(...recentRSI.slice(0, -1)) &&
        currentRSI > 50) {
      return {
        type: 'REGULAR_BEARISH',
        direction: 'DOWN',
        strength: (Math.max(...recentRSI.slice(0, -1)) - currentRSI) / 10
      };
    }

    // Regular bullish divergence: price lower low, RSI higher low
    if (currentPriceLow <= Math.min(...priceLows.slice(0, -1)) &&
        currentRSI > Math.min(...recentRSI.slice(0, -1)) &&
        currentRSI < 50) {
      return {
        type: 'REGULAR_BULLISH',
        direction: 'UP',
        strength: (currentRSI - Math.min(...recentRSI.slice(0, -1))) / 10
      };
    }

    // Hidden bullish divergence: price higher low, RSI lower low (continuation UP)
    if (currentPriceLow > Math.min(...priceLows.slice(0, -1)) &&
        currentRSI < Math.min(...recentRSI.slice(0, -1)) &&
        currentRSI < 50) {
      return {
        type: 'HIDDEN_BULLISH',
        direction: 'UP',
        strength: 0.5 // Hidden divergences are less reliable
      };
    }

    // Hidden bearish divergence: price lower high, RSI higher high (continuation DOWN)
    if (currentPriceHigh < Math.max(...priceHighs.slice(0, -1)) &&
        currentRSI > Math.max(...recentRSI.slice(0, -1)) &&
        currentRSI > 50) {
      return {
        type: 'HIDDEN_BEARISH',
        direction: 'DOWN',
        strength: 0.5
      };
    }

    return null;
  }

  /**
   * Detect RSI crossing back from extreme zones
   */
  detectZoneCrossing(rsiSeries) {
    if (rsiSeries.length < 3) return null;

    const current = rsiSeries[rsiSeries.length - 1];
    const prev = rsiSeries[rsiSeries.length - 2];
    const prevPrev = rsiSeries[rsiSeries.length - 3];

    // Crossing back from oversold
    if (prev < this.parameters.oversoldLevel && current >= this.parameters.oversoldLevel) {
      return {
        type: 'OVERSOLD_CROSS_UP',
        direction: 'UP',
        wasExtreme: prevPrev < this.parameters.extremeOversold
      };
    }

    // Crossing back from overbought
    if (prev > this.parameters.overboughtLevel && current <= this.parameters.overboughtLevel) {
      return {
        type: 'OVERBOUGHT_CROSS_DOWN',
        direction: 'DOWN',
        wasExtreme: prevPrev > this.parameters.extremeOverbought
      };
    }

    return null;
  }

  /**
   * Calculate RSI slope/momentum
   */
  calculateRSISlope(rsiSeries, lookback = 5) {
    if (rsiSeries.length < lookback) return 0;

    const recent = rsiSeries.slice(-lookback);
    const slope = (recent[recent.length - 1] - recent[0]) / lookback;
    return slope;
  }

  /**
   * Analyze market data for RSI signals
   */
  analyze(data) {
    const { candles, price, vwap, remainingMinutes } = data;

    if (!candles || candles.length < this.parameters.rsiPeriod + this.parameters.divergenceLookback) {
      return null;
    }

    const closes = candles.map(c => c.close);
    const rsi = this.calculateRSI(closes, this.parameters.rsiPeriod);
    const rsiSeries = this.calculateRSISeries(closes, this.parameters.rsiPeriod);

    if (rsi === null || rsiSeries.length < 3) return null;

    const divergence = this.detectDivergence(candles, rsiSeries, this.parameters.divergenceLookback);
    const zoneCrossing = this.detectZoneCrossing(rsiSeries);
    const rsiSlope = this.calculateRSISlope(rsiSeries);

    const signals = {
      rsi,
      rsiSlope,
      divergence,
      zoneCrossing
    };

    let side = null;
    let confidence = 0.5;

    // Strategy 1: Zone crossing (primary signal)
    if (zoneCrossing) {
      side = zoneCrossing.direction;

      // Base confidence
      confidence = 0.58;

      // Extra confidence if came from extreme zone
      if (zoneCrossing.wasExtreme) {
        confidence += 0.08;
        signals.extremeRecovery = true;
      }

      // RSI slope should confirm direction
      if ((side === 'UP' && rsiSlope > 0) || (side === 'DOWN' && rsiSlope < 0)) {
        confidence += 0.05;
        signals.slopeConfirms = true;
      }
    }
    // Strategy 2: Extreme RSI without crossing yet (anticipatory)
    else if (rsi < this.parameters.extremeOversold) {
      side = 'UP';
      confidence = 0.55;
      signals.extremeOversold = true;

      // More extreme = higher confidence
      confidence += (this.parameters.extremeOversold - rsi) * 0.005;
    } else if (rsi > this.parameters.extremeOverbought) {
      side = 'DOWN';
      confidence = 0.55;
      signals.extremeOverbought = true;

      // More extreme = higher confidence
      confidence += (rsi - this.parameters.extremeOverbought) * 0.005;
    }
    // Strategy 3: RSI divergence
    else if (divergence) {
      side = divergence.direction;
      confidence = 0.54 + divergence.strength * 0.1;
      signals.divergenceSignal = divergence.type;
    } else {
      return null; // No clear signal
    }

    // VWAP alignment bonus
    if (vwap) {
      if ((side === 'UP' && price < vwap) || (side === 'DOWN' && price > vwap)) {
        // Contrarian trade aligns with RSI signal
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
    return 'RSI strategy using overbought/oversold zones, divergence detection, and zone crossings';
  }
}
