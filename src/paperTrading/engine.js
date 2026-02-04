/**
 * Paper Trading Engine
 * Simulates trading without real money, tracking positions and P/L
 */

export class PaperTradingEngine {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 500;
    this.balance = this.initialBalance;
    this.positions = []; // Active positions
    this.closedTrades = []; // Completed trades for analysis
    this.tradeIdCounter = 0;

    // Risk parameters
    this.minRiskPercent = options.minRiskPercent || 0.02; // 2%
    this.maxRiskPercent = options.maxRiskPercent || 0.05; // 5%
    this.maxPositionPercent = options.maxPositionPercent || 0.15; // 15% max single position
    this.maxTotalExposure = options.maxTotalExposure || 0.50; // 50% max total exposure

    // Performance tracking
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      maxDrawdown: 0,
      peakBalance: this.initialBalance,
      winStreak: 0,
      loseStreak: 0,
      currentStreak: 0,
      lastStreakType: null,
      byStrategy: {}
    };
  }

  /**
   * Get current account state
   */
  getAccountState() {
    const totalExposure = this.positions.reduce((sum, p) => sum + p.size, 0);
    return {
      balance: this.balance,
      availableBalance: this.balance - totalExposure,
      totalExposure,
      exposurePercent: (totalExposure / this.balance) * 100,
      openPositions: this.positions.length,
      initialBalance: this.initialBalance,
      totalPnL: this.balance - this.initialBalance,
      returnPercent: ((this.balance - this.initialBalance) / this.initialBalance) * 100
    };
  }

  /**
   * Calculate dynamic bet size based on confidence and recent performance
   */
  calculateBetSize(confidence, strategyName) {
    const account = this.getAccountState();

    // Base risk scales with confidence (0.5 to 1.0 maps to minRisk to maxRisk)
    const confidenceNormalized = Math.max(0, Math.min(1, (confidence - 0.5) * 2));
    const baseRiskPercent = this.minRiskPercent +
      (this.maxRiskPercent - this.minRiskPercent) * confidenceNormalized;

    // Adjust for recent strategy performance
    const strategyStats = this.stats.byStrategy[strategyName] || { wins: 0, losses: 0 };
    const strategyTrades = strategyStats.wins + strategyStats.losses;
    let performanceMultiplier = 1.0;

    if (strategyTrades >= 5) {
      const winRate = strategyStats.wins / strategyTrades;
      // Scale between 0.5x (30% win rate) and 1.5x (70% win rate)
      performanceMultiplier = 0.5 + (winRate - 0.3) * 2.5;
      performanceMultiplier = Math.max(0.5, Math.min(1.5, performanceMultiplier));
    }

    // Adjust for drawdown - reduce size during losing streaks
    let drawdownMultiplier = 1.0;
    if (this.stats.currentStreak < 0 && this.stats.lastStreakType === 'lose') {
      // Reduce by 10% per consecutive loss, max 50% reduction
      drawdownMultiplier = Math.max(0.5, 1 - Math.abs(this.stats.currentStreak) * 0.1);
    }

    // Calculate final bet size
    const adjustedRiskPercent = baseRiskPercent * performanceMultiplier * drawdownMultiplier;
    let betSize = this.balance * adjustedRiskPercent;

    // Apply position limits
    const maxPositionSize = this.balance * this.maxPositionPercent;
    betSize = Math.min(betSize, maxPositionSize);

    // Check total exposure limit
    const currentExposure = this.positions.reduce((sum, p) => sum + p.size, 0);
    const maxNewExposure = (this.balance * this.maxTotalExposure) - currentExposure;
    betSize = Math.min(betSize, maxNewExposure);

    // Don't bet more than available balance
    betSize = Math.min(betSize, account.availableBalance);

    // Minimum bet size
    betSize = Math.max(betSize, 1);

    return {
      betSize: Math.round(betSize * 100) / 100,
      riskPercent: adjustedRiskPercent * 100,
      confidenceNormalized,
      performanceMultiplier,
      drawdownMultiplier
    };
  }

  /**
   * Calculate dynamic price taking (how aggressive to enter)
   */
  calculateEntryPrice(marketPrice, side, confidence, remainingMinutes) {
    // Base spread we're willing to cross (in cents)
    const baseSpread = 0.01; // 1 cent

    // More aggressive with higher confidence
    const confidenceAdjustment = (confidence - 0.5) * 0.02;

    // More aggressive as time runs out
    const timeAdjustment = Math.max(0, (15 - remainingMinutes) / 15) * 0.01;

    // Total adjustment
    const totalAdjustment = baseSpread + confidenceAdjustment + timeAdjustment;

    // Apply to entry price
    if (side === 'UP') {
      // Willing to pay slightly more for UP
      return Math.min(0.99, marketPrice + totalAdjustment);
    } else {
      // Willing to pay slightly more for DOWN
      return Math.min(0.99, marketPrice + totalAdjustment);
    }
  }

  /**
   * Open a new paper position
   */
  openPosition(params) {
    const {
      strategyName,
      side, // 'UP' or 'DOWN'
      entryPrice,
      size,
      confidence,
      marketId,
      marketSlug,
      remainingMinutes,
      signals = {},
      timestamp = Date.now()
    } = params;

    // Validate
    if (size > this.getAccountState().availableBalance) {
      return { success: false, error: 'Insufficient balance' };
    }

    if (size <= 0) {
      return { success: false, error: 'Invalid size' };
    }

    const tradeId = ++this.tradeIdCounter;
    const position = {
      tradeId,
      strategyName,
      side,
      entryPrice,
      size,
      confidence,
      marketId,
      marketSlug,
      remainingMinutes,
      signals,
      openTime: timestamp,
      status: 'OPEN'
    };

    this.positions.push(position);

    return {
      success: true,
      tradeId,
      position
    };
  }

  /**
   * Close a position and record P/L
   */
  closePosition(tradeId, outcome, exitPrice, timestamp = Date.now()) {
    const positionIndex = this.positions.findIndex(p => p.tradeId === tradeId);
    if (positionIndex === -1) {
      return { success: false, error: 'Position not found' };
    }

    const position = this.positions[positionIndex];

    // Calculate P/L
    // In binary options: if you bet on UP and outcome is UP, you win (1 - entryPrice) * size
    // If outcome is DOWN, you lose the entire size
    let pnl;
    const won = (position.side === 'UP' && outcome === 'UP') ||
                (position.side === 'DOWN' && outcome === 'DOWN');

    if (won) {
      // Payout is size * (1 / entryPrice) - size for a winning binary bet
      // Simplified: you bet at price P, win 1/P - 1 per dollar
      pnl = position.size * ((1 / position.entryPrice) - 1);
    } else {
      pnl = -position.size; // Lose entire stake
    }

    // Update balance
    this.balance += pnl;

    // Track max drawdown
    if (this.balance > this.stats.peakBalance) {
      this.stats.peakBalance = this.balance;
    }
    const currentDrawdown = (this.stats.peakBalance - this.balance) / this.stats.peakBalance;
    if (currentDrawdown > this.stats.maxDrawdown) {
      this.stats.maxDrawdown = currentDrawdown;
    }

    // Update stats
    this.stats.totalTrades++;
    this.stats.totalPnL += pnl;

    if (won) {
      this.stats.wins++;
      if (this.stats.lastStreakType === 'win') {
        this.stats.currentStreak++;
      } else {
        this.stats.currentStreak = 1;
        this.stats.lastStreakType = 'win';
      }
      if (this.stats.currentStreak > this.stats.winStreak) {
        this.stats.winStreak = this.stats.currentStreak;
      }
    } else {
      this.stats.losses++;
      if (this.stats.lastStreakType === 'lose') {
        this.stats.currentStreak++;
      } else {
        this.stats.currentStreak = 1;
        this.stats.lastStreakType = 'lose';
      }
      if (this.stats.currentStreak > this.stats.loseStreak) {
        this.stats.loseStreak = this.stats.currentStreak;
      }
    }

    // Update strategy-specific stats
    if (!this.stats.byStrategy[position.strategyName]) {
      this.stats.byStrategy[position.strategyName] = {
        wins: 0,
        losses: 0,
        totalPnL: 0,
        trades: []
      };
    }
    const stratStats = this.stats.byStrategy[position.strategyName];
    if (won) {
      stratStats.wins++;
    } else {
      stratStats.losses++;
    }
    stratStats.totalPnL += pnl;

    // Create closed trade record
    const closedTrade = {
      ...position,
      outcome,
      exitPrice,
      closeTime: timestamp,
      pnl,
      won,
      holdTime: timestamp - position.openTime,
      status: 'CLOSED'
    };

    stratStats.trades.push(closedTrade);
    this.closedTrades.push(closedTrade);

    // Remove from open positions
    this.positions.splice(positionIndex, 1);

    return {
      success: true,
      trade: closedTrade,
      pnl,
      won,
      newBalance: this.balance
    };
  }

  /**
   * Close all positions for a specific market (used when market resolves)
   */
  closeAllForMarket(marketId, outcome, exitPrice, timestamp = Date.now()) {
    const results = [];
    const marketPositions = this.positions.filter(p => p.marketId === marketId);

    for (const position of marketPositions) {
      const result = this.closePosition(position.tradeId, outcome, exitPrice, timestamp);
      results.push(result);
    }

    return results;
  }

  /**
   * Close a position early (before market resolution)
   * Used for take profit, stop loss, and scaling out
   */
  closePositionEarly(tradeId, currentSharePrice, reason = 'EARLY_EXIT', timestamp = Date.now()) {
    const positionIndex = this.positions.findIndex(p => p.tradeId === tradeId);
    if (positionIndex === -1) {
      return { success: false, error: 'Position not found' };
    }

    const position = this.positions[positionIndex];

    // Calculate P/L for early exit
    // If we bought at entryPrice and sell at currentSharePrice:
    // P/L = (currentSharePrice - entryPrice) * shares
    // shares = size / entryPrice
    const shares = position.size / position.entryPrice;
    const pnl = (currentSharePrice - position.entryPrice) * shares;
    const won = pnl > 0;

    // Update balance
    this.balance += pnl;

    // Track max drawdown
    if (this.balance > this.stats.peakBalance) {
      this.stats.peakBalance = this.balance;
    }
    const currentDrawdown = (this.stats.peakBalance - this.balance) / this.stats.peakBalance;
    if (currentDrawdown > this.stats.maxDrawdown) {
      this.stats.maxDrawdown = currentDrawdown;
    }

    // Update stats
    this.stats.totalTrades++;
    this.stats.totalPnL += pnl;

    if (won) {
      this.stats.wins++;
      if (this.stats.lastStreakType === 'win') {
        this.stats.currentStreak++;
      } else {
        this.stats.currentStreak = 1;
        this.stats.lastStreakType = 'win';
      }
      if (this.stats.currentStreak > this.stats.winStreak) {
        this.stats.winStreak = this.stats.currentStreak;
      }
    } else {
      this.stats.losses++;
      if (this.stats.lastStreakType === 'lose') {
        this.stats.currentStreak++;
      } else {
        this.stats.currentStreak = 1;
        this.stats.lastStreakType = 'lose';
      }
      if (this.stats.currentStreak > this.stats.loseStreak) {
        this.stats.loseStreak = this.stats.currentStreak;
      }
    }

    // Update strategy-specific stats
    if (!this.stats.byStrategy[position.strategyName]) {
      this.stats.byStrategy[position.strategyName] = {
        wins: 0,
        losses: 0,
        totalPnL: 0,
        trades: []
      };
    }
    const stratStats = this.stats.byStrategy[position.strategyName];
    if (won) {
      stratStats.wins++;
    } else {
      stratStats.losses++;
    }
    stratStats.totalPnL += pnl;

    // Create closed trade record
    const closedTrade = {
      ...position,
      exitPrice: currentSharePrice,
      closeTime: timestamp,
      pnl,
      won,
      holdTime: timestamp - position.openTime,
      status: 'CLOSED',
      exitReason: reason
    };

    stratStats.trades.push(closedTrade);
    this.closedTrades.push(closedTrade);

    // Remove from open positions
    this.positions.splice(positionIndex, 1);

    return {
      success: true,
      trade: closedTrade,
      pnl,
      won,
      newBalance: this.balance,
      exitReason: reason
    };
  }

  /**
   * Reduce position size (scale out)
   * Returns the closed portion
   */
  scaleOutPosition(tradeId, percentage, currentSharePrice, reason = 'SCALE_OUT', timestamp = Date.now()) {
    const position = this.positions.find(p => p.tradeId === tradeId);
    if (!position) {
      return { success: false, error: 'Position not found' };
    }

    if (percentage <= 0 || percentage > 1) {
      return { success: false, error: 'Invalid percentage (must be 0-1)' };
    }

    // Calculate portion to close
    const closeSize = position.size * percentage;
    const remainingSize = position.size - closeSize;

    // Calculate P/L for closed portion
    const closedShares = closeSize / position.entryPrice;
    const pnl = (currentSharePrice - position.entryPrice) * closedShares;
    const won = pnl > 0;

    // Update balance
    this.balance += pnl;

    // Track max drawdown
    if (this.balance > this.stats.peakBalance) {
      this.stats.peakBalance = this.balance;
    }
    const currentDrawdown = (this.stats.peakBalance - this.balance) / this.stats.peakBalance;
    if (currentDrawdown > this.stats.maxDrawdown) {
      this.stats.maxDrawdown = currentDrawdown;
    }

    // Update stats (partial exit counts as a trade)
    this.stats.totalPnL += pnl;

    // Update strategy stats P/L without counting as full trade
    if (!this.stats.byStrategy[position.strategyName]) {
      this.stats.byStrategy[position.strategyName] = {
        wins: 0,
        losses: 0,
        totalPnL: 0,
        trades: []
      };
    }
    this.stats.byStrategy[position.strategyName].totalPnL += pnl;

    // Update position size
    position.size = remainingSize;
    position.scaledOutPercent = (position.scaledOutPercent || 0) + percentage;

    // Record the scale out
    const scaleRecord = {
      tradeId,
      strategyName: position.strategyName,
      side: position.side,
      entryPrice: position.entryPrice,
      exitPrice: currentSharePrice,
      closedSize: closeSize,
      remainingSize,
      pnl,
      won,
      timestamp,
      reason,
      status: 'PARTIAL_CLOSE'
    };

    this.closedTrades.push(scaleRecord);

    return {
      success: true,
      pnl,
      won,
      closedSize: closeSize,
      remainingSize,
      newBalance: this.balance,
      exitReason: reason
    };
  }

  /**
   * Check if a position should be closed early based on share price
   * Returns exit recommendation if applicable
   */
  checkEarlyExit(position, currentSharePrice, remainingMinutes, config = {}) {
    const {
      takeProfitMultiple = 2.0,
      takeProfitThreshold = 0.85,
      stopLossPercent = 0.30,
      stopLossFloor = 0.10,
      timeDecayThresholds = [
        { timeLeftMin: 3, reduceBy: 0.50 },
        { timeLeftMin: 1, reduceBy: 1.00 }
      ]
    } = config;

    // Calculate current price multiple
    const priceMultiple = currentSharePrice / position.entryPrice;

    // Check take profit
    if (priceMultiple >= takeProfitMultiple || currentSharePrice >= takeProfitThreshold) {
      return {
        action: 'TAKE_PROFIT',
        reason: priceMultiple >= takeProfitMultiple ? 'TARGET_MULTIPLE' : 'THRESHOLD',
        priceMultiple,
        recommendation: 'close'
      };
    }

    // Check stop loss
    const priceDrop = 1 - priceMultiple;
    if (priceDrop >= stopLossPercent || currentSharePrice <= stopLossFloor) {
      return {
        action: 'STOP_LOSS',
        reason: currentSharePrice <= stopLossFloor ? 'FLOOR' : 'PERCENT_DROP',
        priceDrop,
        recommendation: 'close'
      };
    }

    // Check time decay
    for (const threshold of timeDecayThresholds) {
      if (remainingMinutes <= threshold.timeLeftMin) {
        return {
          action: 'TIME_DECAY',
          reason: `TIME_${threshold.timeLeftMin}MIN`,
          reduceBy: threshold.reduceBy,
          recommendation: threshold.reduceBy >= 1 ? 'close' : 'scale_out'
        };
      }
    }

    return null;
  }

  /**
   * Get performance statistics
   */
  getStats() {
    const winRate = this.stats.totalTrades > 0
      ? (this.stats.wins / this.stats.totalTrades) * 100
      : 0;

    const avgWin = this.stats.wins > 0
      ? this.closedTrades.filter(t => t.won).reduce((s, t) => s + t.pnl, 0) / this.stats.wins
      : 0;

    const avgLoss = this.stats.losses > 0
      ? Math.abs(this.closedTrades.filter(t => !t.won).reduce((s, t) => s + t.pnl, 0) / this.stats.losses)
      : 0;

    const profitFactor = avgLoss > 0 ? (avgWin * this.stats.wins) / (avgLoss * this.stats.losses) : 0;

    return {
      ...this.stats,
      winRate,
      avgWin,
      avgLoss,
      profitFactor,
      currentBalance: this.balance,
      returnPercent: ((this.balance - this.initialBalance) / this.initialBalance) * 100
    };
  }

  /**
   * Get strategy-specific performance
   */
  getStrategyStats(strategyName) {
    const stratStats = this.stats.byStrategy[strategyName];
    if (!stratStats) {
      return null;
    }

    const totalTrades = stratStats.wins + stratStats.losses;
    const winRate = totalTrades > 0 ? (stratStats.wins / totalTrades) * 100 : 0;

    return {
      strategyName,
      totalTrades,
      wins: stratStats.wins,
      losses: stratStats.losses,
      winRate,
      totalPnL: stratStats.totalPnL,
      avgPnL: totalTrades > 0 ? stratStats.totalPnL / totalTrades : 0
    };
  }

  /**
   * Reset the engine to initial state
   */
  reset() {
    this.balance = this.initialBalance;
    this.positions = [];
    this.closedTrades = [];
    this.tradeIdCounter = 0;
    this.stats = {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      maxDrawdown: 0,
      peakBalance: this.initialBalance,
      winStreak: 0,
      loseStreak: 0,
      currentStreak: 0,
      lastStreakType: null,
      byStrategy: {}
    };
  }

  /**
   * Export state for persistence
   */
  exportState() {
    return {
      balance: this.balance,
      initialBalance: this.initialBalance,
      positions: this.positions,
      closedTrades: this.closedTrades,
      tradeIdCounter: this.tradeIdCounter,
      stats: this.stats,
      exportTime: Date.now()
    };
  }

  /**
   * Import state from persistence
   */
  importState(state) {
    this.balance = state.balance;
    this.initialBalance = state.initialBalance;
    this.positions = state.positions || [];
    this.closedTrades = state.closedTrades || [];
    this.tradeIdCounter = state.tradeIdCounter || 0;
    this.stats = state.stats || this.stats;
  }
}
