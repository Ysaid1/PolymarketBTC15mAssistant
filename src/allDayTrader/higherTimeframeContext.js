/**
 * Higher Timeframe Context Analyzer
 *
 * Analyzes 4H trend to provide context for 15-min trading decisions.
 * "Context is King" - only trade 15-min strategies that align with higher trend.
 *
 * Features:
 * - 4H trend direction (using EMA 20/50)
 * - Trend strength (ADX-like calculation)
 * - Key 4H levels (support/resistance)
 * - Signal filtering based on alignment
 */

export class HigherTimeframeContext {
  constructor(options = {}) {
    this.parameters = {
      fastEMA: options.fastEMA || 20,
      slowEMA: options.slowEMA || 50,
      trendStrengthPeriod: options.trendStrengthPeriod || 14,
      srLookback: options.srLookback || 20
    };

    // Cached 4H analysis
    this.htfTrend = null;
    this.lastUpdateTime = 0;
    this.updateInterval = 5 * 60 * 1000; // Update every 5 minutes
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
   * Calculate trend strength (simplified ADX-like measure)
   */
  calculateTrendStrength(candles, period) {
    if (candles.length < period + 1) return 0;

    const recent = candles.slice(-period - 1);
    let upMoves = 0;
    let downMoves = 0;

    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i].close - recent[i - 1].close;
      if (diff > 0) upMoves += diff;
      else downMoves -= diff;
    }

    const total = upMoves + downMoves;
    if (total === 0) return 0;

    // Directional strength: 0 = no trend, 1 = strong trend
    return Math.abs(upMoves - downMoves) / total;
  }

  /**
   * Calculate EMA slope (momentum direction)
   */
  getEMASlope(candles, period, lookback = 5) {
    if (candles.length < period + lookback) return 0;

    const closes = candles.map(c => c.close);
    const k = 2 / (period + 1);

    // Calculate EMA series
    const emaSeries = [];
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      emaSeries.push(ema);
    }

    if (emaSeries.length < lookback) return 0;

    const recent = emaSeries.slice(-lookback);
    return (recent[recent.length - 1] - recent[0]) / recent[0];
  }

  /**
   * Find key 4H support/resistance levels
   */
  findKeyLevels(candles, lookback) {
    if (candles.length < lookback) return { resistance: null, support: null };

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
   * Analyze 4H candles for trend context
   * candles4H should be 4-hour candles from Binance or similar
   */
  analyze(candles4H) {
    if (!candles4H || candles4H.length < this.parameters.slowEMA + 5) {
      return {
        trend: 'UNKNOWN',
        strength: 0,
        aligned: () => true, // No filtering if no data
        levels: null
      };
    }

    const closes = candles4H.map(c => c.close);
    const currentPrice = closes[closes.length - 1];

    // Calculate EMAs
    const ema20 = this.calculateEMA(closes, this.parameters.fastEMA);
    const ema50 = this.calculateEMA(closes, this.parameters.slowEMA);

    if (!ema20 || !ema50) {
      return {
        trend: 'UNKNOWN',
        strength: 0,
        aligned: () => true,
        levels: null
      };
    }

    // Determine trend direction
    let trend = 'RANGE';
    if (currentPrice > ema20 && ema20 > ema50) {
      trend = 'UPTREND';
    } else if (currentPrice < ema20 && ema20 < ema50) {
      trend = 'DOWNTREND';
    }

    // Calculate trend strength
    const strength = this.calculateTrendStrength(candles4H, this.parameters.trendStrengthPeriod);

    // Calculate EMA slopes for momentum
    const ema20Slope = this.getEMASlope(candles4H, this.parameters.fastEMA, 3);
    const ema50Slope = this.getEMASlope(candles4H, this.parameters.slowEMA, 3);

    // Find key levels
    const levels = this.findKeyLevels(candles4H, this.parameters.srLookback);

    // Build the analysis result
    const analysis = {
      trend,
      strength,
      ema20,
      ema50,
      ema20Slope,
      ema50Slope,
      currentPrice,
      levels,

      // Helper function to check if a 15-min signal aligns with 4H trend
      aligned: (signal15m) => {
        if (!signal15m || !signal15m.side) return true; // No filtering

        // Strong trends: require alignment
        if (strength > 0.6) {
          if (trend === 'UPTREND' && signal15m.side === 'DOWN') {
            return false; // Don't short in strong uptrend
          }
          if (trend === 'DOWNTREND' && signal15m.side === 'UP') {
            return false; // Don't long in strong downtrend
          }
        }

        return true;
      },

      // Get confidence adjustment based on alignment
      getConfidenceAdjustment: (signal15m) => {
        if (!signal15m || !signal15m.side) return 0;

        // Aligned with trend = bonus
        if ((trend === 'UPTREND' && signal15m.side === 'UP') ||
            (trend === 'DOWNTREND' && signal15m.side === 'DOWN')) {
          return strength * 0.10; // Up to +10% confidence
        }

        // Counter-trend = penalty
        if ((trend === 'UPTREND' && signal15m.side === 'DOWN') ||
            (trend === 'DOWNTREND' && signal15m.side === 'UP')) {
          return -strength * 0.15; // Up to -15% confidence
        }

        // Range = no adjustment
        return 0;
      },

      // Check if price is near a key 4H level (good for reversals)
      nearKeyLevel: (price, threshold = 0.005) => {
        if (!levels.resistance || !levels.support) return { near: false };

        const distToResistance = Math.abs(price - levels.resistance) / price;
        const distToSupport = Math.abs(price - levels.support) / price;

        if (distToResistance <= threshold) {
          return { near: true, level: 'resistance', distance: distToResistance };
        }
        if (distToSupport <= threshold) {
          return { near: true, level: 'support', distance: distToSupport };
        }

        return { near: false };
      }
    };

    this.htfTrend = analysis;
    this.lastUpdateTime = Date.now();

    return analysis;
  }

  /**
   * Get cached analysis or return neutral if stale
   */
  getCachedAnalysis() {
    if (!this.htfTrend || Date.now() - this.lastUpdateTime > this.updateInterval * 2) {
      return {
        trend: 'UNKNOWN',
        strength: 0,
        aligned: () => true,
        getConfidenceAdjustment: () => 0,
        nearKeyLevel: () => ({ near: false })
      };
    }

    return this.htfTrend;
  }

  /**
   * Filter signals based on 4H context
   * Returns null if signal should be rejected
   */
  filterSignal(signal15m, strictMode = false) {
    const htf = this.getCachedAnalysis();

    if (!signal15m) return null;

    // Check alignment
    if (!htf.aligned(signal15m)) {
      if (strictMode) {
        return null; // Reject counter-trend signals
      }
      // In non-strict mode, just reduce confidence
      signal15m.confidence *= 0.85;
      signal15m.signals.htfWarning = `Counter-trend (4H: ${htf.trend})`;
    }

    // Apply confidence adjustment
    const adjustment = htf.getConfidenceAdjustment(signal15m);
    signal15m.confidence = Math.max(0.50, Math.min(0.90, signal15m.confidence + adjustment));

    // Add HTF context to signals
    signal15m.signals.htfTrend = htf.trend;
    signal15m.signals.htfStrength = htf.strength;
    signal15m.signals.htfAligned = htf.aligned(signal15m);

    return signal15m;
  }
}

export default HigherTimeframeContext;
