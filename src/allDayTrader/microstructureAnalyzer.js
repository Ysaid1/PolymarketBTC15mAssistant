/**
 * Microstructure Analyzer
 *
 * Analyzes order book imbalance and price vs start
 * relationships to enhance probability estimates.
 */

import { ALL_DAY_CONFIG } from './config.js';

export class MicrostructureAnalyzer {
  constructor() {
    this.config = ALL_DAY_CONFIG.microstructure;
    this.history = {
      imbalances: [],
      priceVsStart: []
    };
  }

  /**
   * Calculate order book imbalance
   * Positive = more bid pressure (bullish)
   * Negative = more ask pressure (bearish)
   */
  calculateImbalance(orderbook) {
    if (!orderbook) return 0;

    const bidLiquidity = orderbook.bidLiquidity || 0;
    const askLiquidity = orderbook.askLiquidity || 0;
    const total = bidLiquidity + askLiquidity;

    if (total === 0) return 0;

    const imbalance = (bidLiquidity - askLiquidity) / total;

    // Track history
    this.history.imbalances.push({
      imbalance,
      timestamp: Date.now()
    });

    // Keep last 100 readings
    if (this.history.imbalances.length > 100) {
      this.history.imbalances.shift();
    }

    return imbalance;
  }

  /**
   * Analyze spread as confidence signal
   * Tighter spread = more confident market
   */
  analyzeSpread(orderbook) {
    if (!orderbook) return { spreadAnalysis: 'unknown', confidence: 0 };

    const spread = orderbook.spread || 0;
    const bestBid = orderbook.bestBid || 0;
    const bestAsk = orderbook.bestAsk || 1;

    // Calculate spread as percentage of midpoint
    const midpoint = (bestBid + bestAsk) / 2;
    const spreadPercent = midpoint > 0 ? spread / midpoint : 0;

    let analysis;
    let confidenceImpact;

    if (spreadPercent < 0.02) {
      analysis = 'tight';
      confidenceImpact = 0.02; // Slight confidence boost
    } else if (spreadPercent < 0.05) {
      analysis = 'normal';
      confidenceImpact = 0;
    } else if (spreadPercent < 0.10) {
      analysis = 'wide';
      confidenceImpact = -0.02; // Slight confidence reduction
    } else {
      analysis = 'very_wide';
      confidenceImpact = -0.05; // Larger confidence reduction
    }

    return {
      spreadAnalysis: analysis,
      spreadPercent: spreadPercent * 100,
      confidenceImpact
    };
  }

  /**
   * Track price vs market start price
   * This is the actual binary outcome determinant
   */
  trackPriceRelativeToStart(currentPrice, priceToBeat) {
    if (!currentPrice || !priceToBeat) return null;

    const diff = currentPrice - priceToBeat;
    const percentDiff = (diff / priceToBeat) * 100;
    const direction = diff > 0 ? 'ABOVE' : diff < 0 ? 'BELOW' : 'AT';

    const reading = {
      currentPrice,
      priceToBeat,
      diff,
      percentDiff,
      direction,
      timestamp: Date.now()
    };

    this.history.priceVsStart.push(reading);

    // Keep last 100 readings
    if (this.history.priceVsStart.length > 100) {
      this.history.priceVsStart.shift();
    }

    return reading;
  }

  /**
   * Get price vs start trend
   * How has the price moved relative to start over recent history
   */
  getPriceVsStartTrend(lookback = 10) {
    const recent = this.history.priceVsStart.slice(-lookback);
    if (recent.length < 2) return { trend: 'unknown', strength: 0 };

    let aboveCount = 0;
    let belowCount = 0;
    let totalDiff = 0;

    for (const reading of recent) {
      if (reading.direction === 'ABOVE') aboveCount++;
      else if (reading.direction === 'BELOW') belowCount++;
      totalDiff += reading.percentDiff;
    }

    const avgDiff = totalDiff / recent.length;
    const trend = aboveCount > belowCount ? 'UP' : aboveCount < belowCount ? 'DOWN' : 'FLAT';
    const strength = Math.abs(aboveCount - belowCount) / recent.length;

    return {
      trend,
      strength,
      avgDiff,
      aboveCount,
      belowCount,
      readings: recent.length
    };
  }

  /**
   * Adjust model probability based on microstructure
   */
  adjustModelProbability(modelUpProb, marketData, remainingMinutes) {
    let adjustment = 0;
    const reasons = [];

    // 1. Order book imbalance
    if (marketData.orderbook) {
      const imbalance = this.calculateImbalance(marketData.orderbook);

      if (Math.abs(imbalance) >= this.config.imbalance.significantThreshold) {
        const imbalanceAdjust = imbalance * this.config.imbalance.adjustmentFactor;
        adjustment += imbalanceAdjust;
        reasons.push({
          factor: 'imbalance',
          value: imbalance.toFixed(3),
          adjustment: imbalanceAdjust.toFixed(4)
        });
      }
    }

    // 2. Price vs start (only apply in late phase)
    if (this.config.priceVsStart.enabled && remainingMinutes <= this.config.priceVsStart.timeThreshold) {
      const priceReading = this.trackPriceRelativeToStart(
        marketData.currentPrice,
        marketData.priceToBeat
      );

      if (priceReading) {
        const trend = this.getPriceVsStartTrend();

        // If price is above start and trending up, boost UP probability
        if (priceReading.direction === 'ABOVE' && trend.trend === 'UP') {
          adjustment += this.config.priceVsStart.confirmationBoost;
          reasons.push({
            factor: 'price_vs_start',
            direction: 'ABOVE',
            trend: 'UP',
            adjustment: this.config.priceVsStart.confirmationBoost.toFixed(4)
          });
        }
        // If price is below start and trending down, reduce UP probability
        else if (priceReading.direction === 'BELOW' && trend.trend === 'DOWN') {
          adjustment -= this.config.priceVsStart.confirmationBoost;
          reasons.push({
            factor: 'price_vs_start',
            direction: 'BELOW',
            trend: 'DOWN',
            adjustment: (-this.config.priceVsStart.confirmationBoost).toFixed(4)
          });
        }
      }
    }

    // 3. Spread analysis
    if (marketData.orderbook) {
      const spreadInfo = this.analyzeSpread(marketData.orderbook);
      if (spreadInfo.confidenceImpact !== 0) {
        // Spread affects confidence, not direction
        // Wide spread = less confident in any direction
        reasons.push({
          factor: 'spread',
          analysis: spreadInfo.spreadAnalysis,
          impact: 'confidence_only'
        });
      }
    }

    // Apply adjustment with bounds
    let adjustedProb = modelUpProb + adjustment;
    adjustedProb = Math.max(0.05, Math.min(0.95, adjustedProb));

    return {
      originalProb: modelUpProb,
      adjustedProb,
      adjustment,
      reasons
    };
  }

  /**
   * Get imbalance momentum
   * Is imbalance increasing or decreasing?
   */
  getImbalanceMomentum(lookback = 5) {
    const recent = this.history.imbalances.slice(-lookback);
    if (recent.length < 2) return { momentum: 0, direction: 'flat' };

    const first = recent[0].imbalance;
    const last = recent[recent.length - 1].imbalance;
    const momentum = last - first;

    let direction;
    if (momentum > 0.05) direction = 'increasing_bullish';
    else if (momentum < -0.05) direction = 'increasing_bearish';
    else direction = 'flat';

    return {
      momentum,
      direction,
      first,
      last
    };
  }

  /**
   * Get analysis summary
   */
  getSummary(marketData, remainingMinutes) {
    const imbalance = marketData.orderbook
      ? this.calculateImbalance(marketData.orderbook)
      : 0;

    const spread = marketData.orderbook
      ? this.analyzeSpread(marketData.orderbook)
      : { spreadAnalysis: 'unknown' };

    const priceVsStart = this.history.priceVsStart.length > 0
      ? this.history.priceVsStart[this.history.priceVsStart.length - 1]
      : null;

    const trend = this.getPriceVsStartTrend();

    return {
      imbalance: {
        current: imbalance.toFixed(3),
        interpretation: imbalance > 0.1 ? 'bullish' : imbalance < -0.1 ? 'bearish' : 'neutral'
      },
      spread: spread.spreadAnalysis,
      priceVsStart: priceVsStart ? {
        direction: priceVsStart.direction,
        diff: priceVsStart.percentDiff.toFixed(3) + '%'
      } : null,
      trend: {
        direction: trend.trend,
        strength: trend.strength.toFixed(2)
      }
    };
  }

  /**
   * Reset history (e.g., on market change)
   */
  reset() {
    this.history = {
      imbalances: [],
      priceVsStart: []
    };
  }
}

export default MicrostructureAnalyzer;
