/**
 * All-Day Trading Configuration
 *
 * Centralized configuration for the all-day automated trading system.
 * Paper trading only - validates algorithm before live deployment.
 */

export const ALL_DAY_CONFIG = {
  // ============================================
  // SESSION SETTINGS
  // ============================================
  session: {
    // Initial paper trading balance
    initialBalance: 500,

    // Poll interval in milliseconds
    pollInterval: 5000,

    // Timezone for logging (UTC recommended)
    timezone: 'UTC'
  },

  // ============================================
  // SIGNAL AGGREGATION
  // ============================================
  signals: {
    // Minimum strategies that must agree to trade
    minStrategiesToTrade: 1,

    // Maximum conflict level before skipping (0-1)
    // 0 = no conflict, 1 = perfect 50/50 split
    conflictThreshold: 0.4,

    // Minimum aggregated confidence to trade
    minConfidence: 0.55,

    // Agreement bonus per additional agreeing strategy
    agreementBonus: 0.02,

    // Maximum confidence cap
    maxConfidence: 0.90
  },

  // ============================================
  // REGIME-STRATEGY ROUTING
  // ============================================
  regimeRouting: {
    TREND_UP: {
      enabled: ['MOMENTUM', 'MACD', 'VOLATILITY_BREAKOUT', 'TREND_CONFIRM', 'VOLUME_PROFILE'],
      disabled: ['MEAN_REVERSION'],
      confidenceBoost: { MOMENTUM: 0.05, TREND_CONFIRM: 0.05 },
      sizeMultiplier: 1.0
    },
    TREND_DOWN: {
      enabled: ['MOMENTUM', 'MACD', 'VOLATILITY_BREAKOUT', 'TREND_CONFIRM', 'VOLUME_PROFILE'],
      disabled: ['MEAN_REVERSION'],
      confidenceBoost: { MOMENTUM: 0.05, TREND_CONFIRM: 0.05 },
      sizeMultiplier: 1.0
    },
    RANGE: {
      enabled: ['MEAN_REVERSION', 'RSI', 'MACD', 'PRICE_ACTION', 'VOLUME_PROFILE'],
      disabled: ['MOMENTUM', 'TREND_CONFIRM'],
      confidenceBoost: { MEAN_REVERSION: 0.05, PRICE_ACTION: 0.03 },
      sizeMultiplier: 1.0
    },
    CHOP: {
      enabled: ['RSI', 'PRICE_ACTION'],
      disabled: ['MOMENTUM', 'VOLATILITY_BREAKOUT', 'MEAN_REVERSION', 'TREND_CONFIRM'],
      confidenceBoost: {},
      sizeMultiplier: 0.5 // Reduce size in choppy markets
    }
  },

  // ============================================
  // POSITION MANAGEMENT (Conservative)
  // ============================================
  position: {
    // Take Profit settings
    takeProfit: {
      enabled: true,
      // Exit when share price reaches this multiple of entry
      targetMultiple: 2.0, // e.g., bought at 0.35, exit at 0.70
      // Or exit if share price exceeds this absolute value
      absoluteThreshold: 0.85
    },

    // Stop Loss settings
    stopLoss: {
      enabled: true,
      // Exit when share price drops by this percentage from entry
      percentDrop: 0.30, // e.g., bought at 0.50, exit at 0.35
      // Never let share price go below this without exiting
      absoluteFloor: 0.10
    },

    // Time-based scaling
    timeDecay: {
      enabled: true,
      // Scale out thresholds
      thresholds: [
        { timeLeftMin: 3, reduceBy: 0.50 }, // At 3 min, reduce by 50%
        { timeLeftMin: 1, reduceBy: 1.00 }  // At 1 min, close fully
      ]
    },

    // Partial profit taking
    scaleOut: {
      enabled: true,
      levels: [
        { priceMultiple: 1.5, exitPercentage: 0.33 }, // Take 33% at 1.5x
        { priceMultiple: 2.0, exitPercentage: 0.50 }  // Take 50% at 2x
      ]
    }
  },

  // ============================================
  // RISK MANAGEMENT
  // ============================================
  risk: {
    // Daily limits
    dailyLossLimit: 0.10, // Stop trading at 10% daily loss
    maxDailyTrades: 100,  // Maximum trades per day

    // Position limits
    maxSinglePosition: 0.15, // 15% of balance per position
    maxTotalExposure: 0.50,  // 50% max in active positions
    maxPositionsPerMarket: 2, // Max positions per 15-min market

    // Bet sizing
    minBetSize: 5,   // Minimum bet size in dollars
    maxBetSize: 50,  // Maximum bet size in dollars

    // Kelly fraction for sizing (0.5 = half Kelly)
    kellyFraction: 0.5,

    // Correlation management
    correlationPenalty: 0.20, // Reduce size 20% when strategies agree

    // Drawdown management
    drawdownScaling: {
      enabled: true,
      thresholds: [
        { drawdown: 0.05, sizeMultiplier: 0.80 }, // At 5%, trade 80%
        { drawdown: 0.08, sizeMultiplier: 0.50 }, // At 8%, trade 50%
        { drawdown: 0.10, sizeMultiplier: 0.00 }  // At 10%, stop
      ]
    },

    // Circuit breakers
    consecutiveLossLimit: 5, // Halt after 5 consecutive losses
    cooldownAfterHalt: 30 * 60 * 1000 // 30 min cooldown
  },

  // ============================================
  // PERFORMANCE TRACKING
  // ============================================
  performance: {
    // Rolling window for calculating win rate
    windowSize: 20,

    // Minimum trades before applying performance weighting
    minTradesForWeighting: 5,

    // Base weight for strategies without history
    defaultWeight: 1.0,

    // Weight multiplier range [min, max]
    weightRange: [0.5, 1.5]
  },

  // ============================================
  // MICROSTRUCTURE ANALYSIS
  // ============================================
  microstructure: {
    // Order book imbalance thresholds
    imbalance: {
      // Significant imbalance threshold
      significantThreshold: 0.3, // 30% imbalance
      // Probability adjustment per imbalance point
      adjustmentFactor: 0.05
    },

    // Price vs start analysis
    priceVsStart: {
      enabled: true,
      // Confidence boost when price confirms direction
      confirmationBoost: 0.05,
      // Time threshold to apply boost (minutes remaining)
      timeThreshold: 5
    }
  },

  // ============================================
  // LOGGING
  // ============================================
  logging: {
    // Verbose console output
    verbose: false,

    // Log individual signals
    logSignals: true,

    // Log position exits
    logExits: true,

    // Log risk events
    logRiskEvents: true,

    // Dashboard update frequency (every N loops)
    dashboardFrequency: 60
  }
};

// Strategy metadata - defines which regimes each strategy is designed for
export const STRATEGY_METADATA = {
  MOMENTUM: {
    description: 'Trend-following with EMA cascade',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
    timeframePreference: 'any',
    riskLevel: 'medium'
  },
  MEAN_REVERSION: {
    description: 'Contrarian trades at VWAP extremes',
    regimeCompatibility: ['RANGE'],
    timeframePreference: 'any',
    riskLevel: 'medium'
  },
  VOLATILITY_BREAKOUT: {
    description: 'Breakouts from Bollinger Band squeezes',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
    timeframePreference: 'longer',
    riskLevel: 'high'
  },
  RSI: {
    description: 'RSI zone crossings and divergence',
    regimeCompatibility: ['RANGE', 'CHOP', 'TREND_UP', 'TREND_DOWN'],
    timeframePreference: 'any',
    riskLevel: 'low'
  },
  MACD: {
    description: 'MACD crossovers and histogram momentum',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
    timeframePreference: 'any',
    riskLevel: 'medium'
  },
  TREND_CONFIRM: {
    description: 'High-confidence trend following with EMA+VWAP+momentum',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN'],
    timeframePreference: 'any',
    riskLevel: 'low'
  },
  PRICE_ACTION: {
    description: 'Candlestick patterns at support/resistance',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
    timeframePreference: 'any',
    riskLevel: 'medium'
  },
  VOLUME_PROFILE: {
    description: 'Volume spikes, directional imbalance, divergence',
    regimeCompatibility: ['TREND_UP', 'TREND_DOWN', 'RANGE'],
    timeframePreference: 'any',
    riskLevel: 'medium'
  }
};

export default ALL_DAY_CONFIG;
