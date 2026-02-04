/**
 * Risk Manager
 *
 * Enforces risk limits including daily loss limits,
 * drawdown scaling, exposure limits, and circuit breakers.
 */

import { ALL_DAY_CONFIG } from './config.js';

export class RiskManager {
  constructor(sessionState) {
    this.sessionState = sessionState;
    this.config = ALL_DAY_CONFIG.risk;
  }

  /**
   * Check if trading is allowed
   */
  canTrade() {
    // Check session state
    if (!this.sessionState.canTrade()) {
      return false;
    }

    // Check daily loss limit
    if (this.isDailyLossLimitHit()) {
      return false;
    }

    // Check consecutive loss limit
    if (this.isConsecutiveLossLimitHit()) {
      return false;
    }

    // Check max daily trades
    if (this.sessionState.tradesExecuted >= this.config.maxDailyTrades) {
      return false;
    }

    return true;
  }

  /**
   * Check if daily loss limit is hit
   */
  isDailyLossLimitHit() {
    const lossPercent = -this.sessionState.dailyPnL / this.sessionState.initialBalance;
    return lossPercent >= this.config.dailyLossLimit;
  }

  /**
   * Check if consecutive loss limit is hit
   */
  isConsecutiveLossLimitHit() {
    return this.sessionState.consecutiveLosses >= this.config.consecutiveLossLimit;
  }

  /**
   * Get current drawdown
   */
  getCurrentDrawdown() {
    return this.sessionState.currentDrawdown;
  }

  /**
   * Get drawdown-based size multiplier
   */
  getDrawdownMultiplier() {
    if (!this.config.drawdownScaling.enabled) {
      return 1.0;
    }

    const drawdown = this.getCurrentDrawdown();

    // Find applicable threshold
    for (const threshold of this.config.drawdownScaling.thresholds) {
      if (drawdown >= threshold.drawdown) {
        return threshold.sizeMultiplier;
      }
    }

    return 1.0;
  }

  /**
   * Check exposure limits
   */
  checkExposureLimits(proposedSize, currentPositions) {
    const currentExposure = currentPositions.reduce((sum, p) => sum + p.size, 0);
    const balance = this.sessionState.balance;

    // Check total exposure
    const maxTotalExposure = balance * this.config.maxTotalExposure;
    const availableExposure = maxTotalExposure - currentExposure;

    if (proposedSize > availableExposure) {
      return {
        allowed: false,
        reason: 'max_total_exposure',
        maxAllowed: availableExposure
      };
    }

    // Check single position limit
    const maxSingle = balance * this.config.maxSinglePosition;
    if (proposedSize > maxSingle) {
      return {
        allowed: false,
        reason: 'max_single_position',
        maxAllowed: maxSingle
      };
    }

    return { allowed: true, maxAllowed: Math.min(availableExposure, maxSingle) };
  }

  /**
   * Apply correlation penalty
   * When multiple strategies agree, they might all be wrong
   */
  getCorrelationMultiplier(signal, currentPositions) {
    // Check how many positions are in the same direction
    const sameDirection = currentPositions.filter(p => p.side === signal.side);

    if (sameDirection.length > 0) {
      // Apply penalty
      return 1 - this.config.correlationPenalty;
    }

    return 1.0;
  }

  /**
   * Adjust position size based on all risk factors
   */
  adjustPositionSize(baseSize, signal, currentPositions) {
    let adjustedSize = baseSize;

    // Apply drawdown scaling
    const drawdownMult = this.getDrawdownMultiplier();
    adjustedSize *= drawdownMult;

    // Apply correlation penalty
    const correlationMult = this.getCorrelationMultiplier(signal, currentPositions);
    adjustedSize *= correlationMult;

    // Check exposure limits
    const exposureCheck = this.checkExposureLimits(adjustedSize, currentPositions);
    if (!exposureCheck.allowed) {
      adjustedSize = Math.max(0, exposureCheck.maxAllowed);
    }

    // Apply min/max bet size
    adjustedSize = Math.max(this.config.minBetSize, adjustedSize);
    adjustedSize = Math.min(this.config.maxBetSize, adjustedSize);

    // Final check - don't trade if size is below minimum
    if (adjustedSize < this.config.minBetSize) {
      return 0;
    }

    return Math.round(adjustedSize * 100) / 100;
  }

  /**
   * Calculate optimal bet size using Kelly Criterion
   */
  calculateKellySize(edge, winProbability, balance) {
    // Kelly formula: f* = (bp - q) / b
    // where b = odds, p = win prob, q = 1-p
    // For binary options: b = (1/price) - 1

    // Simplified Kelly for binary: f* = edge / odds
    // With fractional Kelly (half Kelly recommended)
    const kellyFraction = this.config.kellyFraction;
    const optimalFraction = edge * kellyFraction;

    // Clamp to max risk percent
    const maxFraction = this.config.maxSinglePosition;
    const fraction = Math.min(optimalFraction, maxFraction);

    return Math.max(0, balance * fraction);
  }

  /**
   * Get risk status summary
   */
  getRiskStatus() {
    const drawdown = this.getCurrentDrawdown();
    const drawdownMult = this.getDrawdownMultiplier();
    const lossPercent = -this.sessionState.dailyPnL / this.sessionState.initialBalance;

    return {
      canTrade: this.canTrade(),
      dailyLoss: (lossPercent * 100).toFixed(2) + '%',
      dailyLossLimit: (this.config.dailyLossLimit * 100).toFixed(0) + '%',
      currentDrawdown: (drawdown * 100).toFixed(2) + '%',
      maxDrawdown: (this.sessionState.maxDrawdown * 100).toFixed(2) + '%',
      drawdownMultiplier: drawdownMult.toFixed(2),
      consecutiveLosses: this.sessionState.consecutiveLosses,
      consecutiveLossLimit: this.config.consecutiveLossLimit,
      tradesExecuted: this.sessionState.tradesExecuted,
      maxDailyTrades: this.config.maxDailyTrades,
      tradingHalted: this.sessionState.tradingHalted,
      haltReason: this.sessionState.haltReason
    };
  }

  /**
   * Log risk event
   */
  logRiskEvent(event, details = {}) {
    if (ALL_DAY_CONFIG.logging.logRiskEvents) {
      console.log(`[RISK] ${event}:`, JSON.stringify(details));
    }
  }

  /**
   * Trigger emergency stop
   */
  triggerEmergencyStop(reason) {
    this.sessionState.halt(`EMERGENCY: ${reason}`);
    this.logRiskEvent('EMERGENCY_STOP', { reason });
  }

  /**
   * Check if we should reduce exposure
   */
  shouldReduceExposure() {
    const drawdown = this.getCurrentDrawdown();

    // Check if approaching limits
    if (drawdown >= this.config.drawdownScaling.thresholds[0].drawdown * 0.8) {
      return {
        reduce: true,
        reason: 'approaching_drawdown_limit',
        suggestedReduction: 0.25
      };
    }

    return { reduce: false };
  }
}

export default RiskManager;
