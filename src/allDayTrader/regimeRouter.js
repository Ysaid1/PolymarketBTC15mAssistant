/**
 * Regime Router
 *
 * Routes strategies based on detected market regime.
 * Enables/disables strategies and adjusts their confidence
 * based on regime compatibility.
 */

import { ALL_DAY_CONFIG, STRATEGY_METADATA } from './config.js';

export class RegimeRouter {
  constructor() {
    this.routingConfig = ALL_DAY_CONFIG.regimeRouting;
    this.strategyMetadata = STRATEGY_METADATA;
  }

  /**
   * Get the regime configuration for a given regime
   */
  getRegimeConfig(regime) {
    return this.routingConfig[regime] || this.routingConfig.RANGE;
  }

  /**
   * Check if a strategy is enabled for the current regime
   */
  isStrategyEnabled(strategyName, regime) {
    const config = this.getRegimeConfig(regime);

    // Explicitly disabled
    if (config.disabled && config.disabled.includes(strategyName)) {
      return false;
    }

    // Explicitly enabled (if specified, only those are allowed)
    if (config.enabled && config.enabled.length > 0) {
      return config.enabled.includes(strategyName);
    }

    // Default to enabled if not in disabled list
    return true;
  }

  /**
   * Get confidence boost for a strategy in current regime
   */
  getConfidenceBoost(strategyName, regime) {
    const config = this.getRegimeConfig(regime);
    return config.confidenceBoost?.[strategyName] || 0;
  }

  /**
   * Get size multiplier for current regime
   */
  getSizeMultiplier(regime) {
    const config = this.getRegimeConfig(regime);
    return config.sizeMultiplier || 1.0;
  }

  /**
   * Filter strategies based on regime
   */
  filterStrategies(strategies, regime) {
    return strategies.filter(strategy => {
      // Check strategy's own regime compatibility
      if (strategy.isCompatibleWithRegime && !strategy.isCompatibleWithRegime(regime)) {
        return false;
      }

      // Check router configuration
      return this.isStrategyEnabled(strategy.name, regime);
    });
  }

  /**
   * Apply regime-based adjustments to a signal
   */
  adjustSignal(signal, strategyName, regime) {
    if (!signal) return null;

    const boost = this.getConfidenceBoost(strategyName, regime);
    const adjustedConfidence = Math.min(
      ALL_DAY_CONFIG.signals.maxConfidence,
      signal.confidence + boost
    );

    return {
      ...signal,
      confidence: adjustedConfidence,
      regimeBoost: boost,
      regime
    };
  }

  /**
   * Get routing summary for logging
   */
  getRoutingSummary(strategies, regime) {
    const config = this.getRegimeConfig(regime);
    const enabled = [];
    const disabled = [];

    for (const strategy of strategies) {
      if (this.isStrategyEnabled(strategy.name, regime)) {
        const boost = this.getConfidenceBoost(strategy.name, regime);
        enabled.push({
          name: strategy.name,
          boost: boost > 0 ? `+${(boost * 100).toFixed(0)}%` : null
        });
      } else {
        disabled.push(strategy.name);
      }
    }

    return {
      regime,
      sizeMultiplier: config.sizeMultiplier || 1.0,
      enabled,
      disabled
    };
  }

  /**
   * Get recommended strategies for a regime
   * Returns strategies in order of preference
   */
  getRecommendedStrategies(regime) {
    const config = this.getRegimeConfig(regime);
    const recommendations = [];

    if (config.enabled) {
      for (const name of config.enabled) {
        const meta = this.strategyMetadata[name];
        const boost = config.confidenceBoost?.[name] || 0;

        recommendations.push({
          name,
          description: meta?.description || '',
          boost,
          riskLevel: meta?.riskLevel || 'medium'
        });
      }
    }

    // Sort by boost (higher first)
    recommendations.sort((a, b) => b.boost - a.boost);

    return recommendations;
  }

  /**
   * Validate regime value
   */
  isValidRegime(regime) {
    return ['TREND_UP', 'TREND_DOWN', 'RANGE', 'CHOP'].includes(regime);
  }

  /**
   * Get regime description for display
   */
  getRegimeDescription(regime) {
    const descriptions = {
      TREND_UP: 'Bullish trend - momentum strategies favored',
      TREND_DOWN: 'Bearish trend - momentum strategies favored',
      RANGE: 'Sideways market - mean reversion favored',
      CHOP: 'Choppy/uncertain - conservative trading'
    };

    return descriptions[regime] || 'Unknown regime';
  }
}

export default RegimeRouter;
