/**
 * Position Manager
 *
 * Manages position lifecycle with dynamic exits including
 * take profit, stop loss, and scaling out.
 */

import { ALL_DAY_CONFIG } from './config.js';

export class PositionManager {
  constructor(engine) {
    this.engine = engine;
    this.config = ALL_DAY_CONFIG.position;
    this.scaledOutLevels = new Map(); // Track which scale-out levels have been hit
  }

  /**
   * Check all positions for exit conditions
   */
  checkExits(currentSharePrices, remainingMinutes) {
    const exits = [];

    for (const position of this.engine.positions) {
      const currentPrice = currentSharePrices[position.side];
      if (!currentPrice) continue;

      const exitRecommendation = this.checkPositionExit(
        position,
        currentPrice,
        remainingMinutes
      );

      if (exitRecommendation) {
        exits.push({
          position,
          currentPrice,
          ...exitRecommendation
        });
      }
    }

    return exits;
  }

  /**
   * Check a single position for exit conditions
   */
  checkPositionExit(position, currentSharePrice, remainingMinutes) {
    // Check take profit
    if (this.config.takeProfit.enabled) {
      const tpResult = this.checkTakeProfit(position, currentSharePrice);
      if (tpResult) return tpResult;
    }

    // Check stop loss
    if (this.config.stopLoss.enabled) {
      const slResult = this.checkStopLoss(position, currentSharePrice);
      if (slResult) return slResult;
    }

    // Check scale out levels
    if (this.config.scaleOut.enabled) {
      const scaleResult = this.checkScaleOut(position, currentSharePrice);
      if (scaleResult) return scaleResult;
    }

    // Check time decay
    if (this.config.timeDecay.enabled) {
      const timeResult = this.checkTimeDecay(position, remainingMinutes);
      if (timeResult) return timeResult;
    }

    return null;
  }

  /**
   * Check take profit conditions
   */
  checkTakeProfit(position, currentSharePrice) {
    const { targetMultiple, absoluteThreshold } = this.config.takeProfit;
    const priceMultiple = currentSharePrice / position.entryPrice;

    // Check target multiple
    if (priceMultiple >= targetMultiple) {
      return {
        action: 'TAKE_PROFIT',
        reason: 'TARGET_MULTIPLE',
        priceMultiple: priceMultiple.toFixed(2),
        recommendation: 'close'
      };
    }

    // Check absolute threshold
    if (currentSharePrice >= absoluteThreshold) {
      return {
        action: 'TAKE_PROFIT',
        reason: 'ABSOLUTE_THRESHOLD',
        currentPrice: currentSharePrice.toFixed(4),
        recommendation: 'close'
      };
    }

    return null;
  }

  /**
   * Check stop loss conditions
   */
  checkStopLoss(position, currentSharePrice) {
    const { percentDrop, absoluteFloor } = this.config.stopLoss;
    const priceDrop = 1 - (currentSharePrice / position.entryPrice);

    // Check percent drop
    if (priceDrop >= percentDrop) {
      return {
        action: 'STOP_LOSS',
        reason: 'PERCENT_DROP',
        priceDrop: (priceDrop * 100).toFixed(1) + '%',
        recommendation: 'close'
      };
    }

    // Check absolute floor
    if (currentSharePrice <= absoluteFloor) {
      return {
        action: 'STOP_LOSS',
        reason: 'ABSOLUTE_FLOOR',
        currentPrice: currentSharePrice.toFixed(4),
        recommendation: 'close'
      };
    }

    return null;
  }

  /**
   * Check scale out conditions
   */
  checkScaleOut(position, currentSharePrice) {
    const { levels } = this.config.scaleOut;
    const priceMultiple = currentSharePrice / position.entryPrice;

    // Get tracking key for this position
    const trackKey = `${position.tradeId}`;
    const hitLevels = this.scaledOutLevels.get(trackKey) || new Set();

    for (const level of levels) {
      const levelKey = `${level.priceMultiple}`;

      // Skip if already scaled out at this level
      if (hitLevels.has(levelKey)) continue;

      if (priceMultiple >= level.priceMultiple) {
        return {
          action: 'SCALE_OUT',
          reason: `LEVEL_${level.priceMultiple}x`,
          priceMultiple: priceMultiple.toFixed(2),
          exitPercentage: level.exitPercentage,
          recommendation: 'scale_out',
          levelKey
        };
      }
    }

    return null;
  }

  /**
   * Check time decay conditions
   */
  checkTimeDecay(position, remainingMinutes) {
    const { thresholds } = this.config.timeDecay;

    // Sort thresholds by time (highest first)
    const sortedThresholds = [...thresholds].sort((a, b) => b.timeLeftMin - a.timeLeftMin);

    for (const threshold of sortedThresholds) {
      if (remainingMinutes <= threshold.timeLeftMin) {
        // Check if we've already applied this threshold
        const alreadyScaled = position.scaledOutPercent || 0;
        const targetScale = threshold.reduceBy;

        if (alreadyScaled < targetScale) {
          const additionalScale = targetScale - alreadyScaled;

          return {
            action: 'TIME_DECAY',
            reason: `TIME_${threshold.timeLeftMin}MIN`,
            reduceBy: additionalScale,
            totalReduction: targetScale,
            recommendation: targetScale >= 1 ? 'close' : 'scale_out'
          };
        }
      }
    }

    return null;
  }

  /**
   * Execute an exit recommendation
   */
  executeExit(exitRecommendation, currentSharePrice) {
    const { position, action, recommendation, exitPercentage, levelKey } = exitRecommendation;

    if (recommendation === 'close') {
      // Full close
      const result = this.engine.closePositionEarly(
        position.tradeId,
        currentSharePrice,
        action
      );

      // Clean up tracking
      this.scaledOutLevels.delete(`${position.tradeId}`);

      return result;
    } else if (recommendation === 'scale_out') {
      // Partial close
      const percentage = exitPercentage || exitRecommendation.reduceBy || 0.5;
      const result = this.engine.scaleOutPosition(
        position.tradeId,
        percentage,
        currentSharePrice,
        action
      );

      // Track the level we just hit
      if (levelKey) {
        const trackKey = `${position.tradeId}`;
        const hitLevels = this.scaledOutLevels.get(trackKey) || new Set();
        hitLevels.add(levelKey);
        this.scaledOutLevels.set(trackKey, hitLevels);
      }

      return result;
    }

    return { success: false, error: 'Unknown recommendation' };
  }

  /**
   * Process all exits for current market state
   */
  processExits(currentSharePrices, remainingMinutes) {
    const exits = this.checkExits(currentSharePrices, remainingMinutes);
    const results = [];

    for (const exit of exits) {
      const result = this.executeExit(exit, exit.currentPrice);
      results.push({
        ...result,
        action: exit.action,
        reason: exit.reason,
        strategyName: exit.position.strategyName,
        side: exit.position.side
      });
    }

    return results;
  }

  /**
   * Check if we should enter a new position
   */
  shouldEnter(signal, riskManager) {
    // Check with risk manager
    if (!riskManager.canTrade()) {
      return { canEnter: false, reason: 'risk_limit' };
    }

    // Check if we already have a position in this direction for current market
    const existingSameDirection = this.engine.positions.filter(
      p => p.side === signal.side && p.marketId === signal.marketId
    );

    if (existingSameDirection.length >= ALL_DAY_CONFIG.risk.maxPositionsPerMarket) {
      return { canEnter: false, reason: 'max_positions_per_market' };
    }

    return { canEnter: true };
  }

  /**
   * Calculate entry parameters
   */
  calculateEntry(signal, marketData, riskManager) {
    // Get base bet size from engine
    const { betSize, riskPercent } = this.engine.calculateBetSize(
      signal.confidence,
      signal.signals?.[0]?.strategyName || 'AGGREGATED'
    );

    // Apply risk manager adjustments
    const adjustedSize = riskManager.adjustPositionSize(
      betSize,
      signal,
      this.engine.positions
    );

    // Calculate entry price
    const marketPrice = signal.side === 'UP'
      ? marketData.yesPrice
      : marketData.noPrice;

    const entryPrice = this.engine.calculateEntryPrice(
      marketPrice || 0.50,
      signal.side,
      signal.confidence,
      marketData.remainingMinutes || 15
    );

    return {
      size: adjustedSize,
      entryPrice,
      riskPercent,
      marketPrice
    };
  }

  /**
   * Get position summary for logging
   */
  getPositionSummary() {
    return this.engine.positions.map(p => ({
      tradeId: p.tradeId,
      strategy: p.strategyName,
      side: p.side,
      size: p.size,
      entry: p.entryPrice,
      scaledOut: p.scaledOutPercent || 0
    }));
  }

  /**
   * Clean up tracking when market changes
   */
  onMarketChange() {
    this.scaledOutLevels.clear();
  }
}

export default PositionManager;
