/**
 * Signal Aggregator
 *
 * Combines signals from multiple strategies into a single
 * unified trading decision. Handles conflicts, applies weights,
 * and produces the final signal.
 */

import { ALL_DAY_CONFIG } from './config.js';
import { RegimeRouter } from './regimeRouter.js';

export class SignalAggregator {
  constructor(performanceTracker = null) {
    this.performanceTracker = performanceTracker;
    this.regimeRouter = new RegimeRouter();
    this.config = ALL_DAY_CONFIG.signals;
  }

  /**
   * Collect signals from all strategies
   */
  collectSignals(strategies, analysisData, regime) {
    const signals = [];

    // Filter strategies by regime
    const eligibleStrategies = this.regimeRouter.filterStrategies(strategies, regime);

    for (const strategy of eligibleStrategies) {
      // Skip if strategy can't trade (cooldown)
      if (!strategy.canTrade()) continue;

      try {
        const signal = strategy.analyze(analysisData);

        if (signal && signal.confidence >= this.config.minConfidence) {
          // Apply regime boost
          const adjustedSignal = this.regimeRouter.adjustSignal(
            signal,
            strategy.name,
            regime
          );

          // Get performance weight
          const weight = this.getStrategyWeight(strategy.name);

          signals.push({
            strategyName: strategy.name,
            side: adjustedSignal.side,
            confidence: adjustedSignal.confidence,
            weight,
            regimeBoost: adjustedSignal.regimeBoost || 0,
            signals: adjustedSignal.signals
          });
        }
      } catch (error) {
        console.error(`Strategy ${strategy.name} error:`, error.message);
      }
    }

    return signals;
  }

  /**
   * Get strategy weight from performance tracker
   */
  getStrategyWeight(strategyName) {
    if (this.performanceTracker) {
      return this.performanceTracker.getStrategyWeight(strategyName);
    }
    return ALL_DAY_CONFIG.performance.defaultWeight;
  }

  /**
   * Detect conflicts between signals
   */
  detectConflicts(signals) {
    const upSignals = signals.filter(s => s.side === 'UP');
    const downSignals = signals.filter(s => s.side === 'DOWN');

    const upWeight = upSignals.reduce((sum, s) => sum + s.confidence * s.weight, 0);
    const downWeight = downSignals.reduce((sum, s) => sum + s.confidence * s.weight, 0);
    const totalWeight = upWeight + downWeight;

    if (totalWeight === 0) {
      return { conflictLevel: 0, upRatio: 0.5, downRatio: 0.5 };
    }

    const upRatio = upWeight / totalWeight;
    const downRatio = downWeight / totalWeight;

    // Conflict level: 0 = no conflict (unanimous), 1 = perfect split
    const conflictLevel = Math.min(upRatio, downRatio) * 2;

    return {
      conflictLevel,
      upRatio,
      downRatio,
      upCount: upSignals.length,
      downCount: downSignals.length
    };
  }

  /**
   * Aggregate all signals into a single decision
   */
  aggregate(strategies, analysisData, regime) {
    // Collect signals from eligible strategies
    const signals = this.collectSignals(strategies, analysisData, regime);

    // No signals
    if (signals.length === 0) {
      return {
        action: 'NO_TRADE',
        reason: 'no_signals',
        signals: [],
        regime
      };
    }

    // Check minimum strategies requirement
    if (signals.length < this.config.minStrategiesToTrade) {
      return {
        action: 'NO_TRADE',
        reason: 'insufficient_signals',
        signalCount: signals.length,
        required: this.config.minStrategiesToTrade,
        signals,
        regime
      };
    }

    // Detect conflicts
    const conflict = this.detectConflicts(signals);

    // Too much disagreement
    if (conflict.conflictLevel > this.config.conflictThreshold) {
      return {
        action: 'NO_TRADE',
        reason: 'strategy_conflict',
        conflictLevel: conflict.conflictLevel,
        upCount: conflict.upCount,
        downCount: conflict.downCount,
        signals,
        regime
      };
    }

    // Determine direction
    const side = conflict.upRatio > conflict.downRatio ? 'UP' : 'DOWN';
    const dominantSignals = signals.filter(s => s.side === side);

    // Calculate weighted average confidence
    const totalWeight = dominantSignals.reduce((sum, s) => sum + s.weight, 0);
    const weightedConfidence = dominantSignals.reduce(
      (sum, s) => sum + s.confidence * s.weight,
      0
    ) / totalWeight;

    // Agreement bonus
    const agreementBonus = Math.min(
      0.10,
      (dominantSignals.length - 1) * this.config.agreementBonus
    );

    // Conflict penalty
    const conflictPenalty = conflict.conflictLevel * 0.5;

    // Final confidence
    let finalConfidence = weightedConfidence + agreementBonus - conflictPenalty;
    finalConfidence = Math.max(
      this.config.minConfidence,
      Math.min(this.config.maxConfidence, finalConfidence)
    );

    // Calculate signal strength
    const strength = this.calculateStrength(finalConfidence, dominantSignals.length);

    return {
      action: 'ENTER',
      side,
      confidence: finalConfidence,
      strength,
      agreementCount: dominantSignals.length,
      totalSignals: signals.length,
      conflictLevel: conflict.conflictLevel,
      signals: dominantSignals,
      allSignals: signals,
      regime,
      metadata: {
        weightedConfidence,
        agreementBonus,
        conflictPenalty
      }
    };
  }

  /**
   * Calculate signal strength category
   */
  calculateStrength(confidence, agreementCount) {
    if (confidence >= 0.75 && agreementCount >= 3) {
      return 'STRONG';
    } else if (confidence >= 0.65 && agreementCount >= 2) {
      return 'GOOD';
    } else if (confidence >= 0.55) {
      return 'WEAK';
    }
    return 'INSUFFICIENT';
  }

  /**
   * Get aggregation summary for logging
   */
  getSummary(result) {
    if (result.action === 'NO_TRADE') {
      return `NO_TRADE: ${result.reason}`;
    }

    const sigNames = result.signals.map(s => s.strategyName).join(', ');
    return `${result.side} (${(result.confidence * 100).toFixed(1)}%) - ${result.strength} - Strategies: ${sigNames}`;
  }
}

export default SignalAggregator;
