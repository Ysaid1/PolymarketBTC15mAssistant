/**
 * Session State Manager
 *
 * Tracks daily trading session state including P/L, trades,
 * drawdown, and provides session lifecycle management.
 */

import { ALL_DAY_CONFIG } from './config.js';

export class SessionState {
  constructor(initialBalance = ALL_DAY_CONFIG.session.initialBalance) {
    this.initialBalance = initialBalance;
    this.reset();
  }

  /**
   * Reset session state (for new day or restart)
   */
  reset() {
    this.sessionStart = Date.now();
    this.sessionDate = new Date().toISOString().split('T')[0];

    // Balance tracking
    this.balance = this.initialBalance;
    this.peakBalance = this.initialBalance;
    this.dailyPnL = 0;
    this.realizedPnL = 0;
    this.unrealizedPnL = 0;

    // Drawdown tracking
    this.maxDrawdown = 0;
    this.currentDrawdown = 0;

    // Trade tracking
    this.tradesExecuted = 0;
    this.tradesWon = 0;
    this.tradesLost = 0;
    this.consecutiveLosses = 0;
    this.consecutiveWins = 0;

    // Market tracking
    this.marketsTraded = new Set();
    this.currentMarket = null;
    this.currentMarketStartPrice = null;

    // State flags
    this.tradingHalted = false;
    this.haltReason = null;
    this.haltTime = null;

    // Strategy performance this session
    this.strategyStats = {};
  }

  /**
   * Update balance after a trade result
   */
  updateBalance(pnl) {
    this.balance += pnl;
    this.dailyPnL += pnl;
    this.realizedPnL += pnl;

    // Update peak and drawdown
    if (this.balance > this.peakBalance) {
      this.peakBalance = this.balance;
    }

    this.currentDrawdown = (this.peakBalance - this.balance) / this.peakBalance;
    if (this.currentDrawdown > this.maxDrawdown) {
      this.maxDrawdown = this.currentDrawdown;
    }
  }

  /**
   * Record a completed trade
   */
  recordTrade(trade) {
    this.tradesExecuted++;

    if (trade.won) {
      this.tradesWon++;
      this.consecutiveWins++;
      this.consecutiveLosses = 0;
    } else {
      this.tradesLost++;
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
    }

    // Update strategy stats
    const stratName = trade.strategyName;
    if (!this.strategyStats[stratName]) {
      this.strategyStats[stratName] = {
        trades: 0,
        wins: 0,
        losses: 0,
        pnl: 0
      };
    }
    this.strategyStats[stratName].trades++;
    if (trade.won) {
      this.strategyStats[stratName].wins++;
    } else {
      this.strategyStats[stratName].losses++;
    }
    this.strategyStats[stratName].pnl += trade.pnl || 0;

    // Update balance
    if (trade.pnl) {
      this.updateBalance(trade.pnl);
    }

    // Check for halt conditions
    this.checkHaltConditions();
  }

  /**
   * Transition to a new market
   */
  onNewMarket(market, startPrice) {
    // Close out any state from previous market
    if (this.currentMarket && this.currentMarket.id !== market.id) {
      this.marketsTraded.add(this.currentMarket.id);
    }

    this.currentMarket = market;
    this.currentMarketStartPrice = startPrice;
  }

  /**
   * Check if trading should be halted
   */
  checkHaltConditions() {
    const config = ALL_DAY_CONFIG.risk;

    // Check daily loss limit
    const dailyLossPercent = -this.dailyPnL / this.initialBalance;
    if (dailyLossPercent >= config.dailyLossLimit) {
      this.halt(`Daily loss limit reached: ${(dailyLossPercent * 100).toFixed(1)}%`);
      return;
    }

    // Check consecutive losses
    if (this.consecutiveLosses >= config.consecutiveLossLimit) {
      this.halt(`Consecutive loss limit reached: ${this.consecutiveLosses} losses`);
      return;
    }

    // Check max daily trades
    if (this.tradesExecuted >= config.maxDailyTrades) {
      this.halt(`Max daily trades reached: ${this.tradesExecuted}`);
      return;
    }

    // Check drawdown scaling (complete stop at max threshold)
    const maxDrawdownThreshold = config.drawdownScaling.thresholds
      .find(t => t.sizeMultiplier === 0);
    if (maxDrawdownThreshold && this.currentDrawdown >= maxDrawdownThreshold.drawdown) {
      this.halt(`Max drawdown reached: ${(this.currentDrawdown * 100).toFixed(1)}%`);
      return;
    }
  }

  /**
   * Halt trading
   */
  halt(reason) {
    this.tradingHalted = true;
    this.haltReason = reason;
    this.haltTime = Date.now();
  }

  /**
   * Check if trading can continue
   */
  canTrade() {
    if (!this.tradingHalted) return true;

    // Check if cooldown has passed
    const config = ALL_DAY_CONFIG.risk;
    if (this.haltTime && (Date.now() - this.haltTime) >= config.cooldownAfterHalt) {
      // Only resume if halt was from consecutive losses (not daily limit)
      if (this.haltReason?.includes('Consecutive')) {
        this.tradingHalted = false;
        this.haltReason = null;
        this.haltTime = null;
        this.consecutiveLosses = 0;
        return true;
      }
    }

    return false;
  }

  /**
   * Get current win rate
   */
  getWinRate() {
    if (this.tradesExecuted === 0) return 0;
    return (this.tradesWon / this.tradesExecuted) * 100;
  }

  /**
   * Get return percentage
   */
  getReturnPercent() {
    return ((this.balance - this.initialBalance) / this.initialBalance) * 100;
  }

  /**
   * Get session duration in minutes
   */
  getSessionDuration() {
    return (Date.now() - this.sessionStart) / (1000 * 60);
  }

  /**
   * Get strategy stats for a specific strategy
   */
  getStrategyStats(strategyName) {
    return this.strategyStats[strategyName] || {
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0
    };
  }

  /**
   * Generate session summary
   */
  generateSummary() {
    return {
      sessionDate: this.sessionDate,
      durationMinutes: this.getSessionDuration().toFixed(1),
      initialBalance: this.initialBalance,
      finalBalance: this.balance,
      dailyPnL: this.dailyPnL,
      returnPercent: this.getReturnPercent().toFixed(2),
      maxDrawdown: (this.maxDrawdown * 100).toFixed(2),
      totalTrades: this.tradesExecuted,
      wins: this.tradesWon,
      losses: this.tradesLost,
      winRate: this.getWinRate().toFixed(1),
      marketsTraded: this.marketsTraded.size,
      tradingHalted: this.tradingHalted,
      haltReason: this.haltReason,
      strategyStats: { ...this.strategyStats }
    };
  }

  /**
   * Export state for persistence
   */
  exportState() {
    return {
      sessionStart: this.sessionStart,
      sessionDate: this.sessionDate,
      initialBalance: this.initialBalance,
      balance: this.balance,
      peakBalance: this.peakBalance,
      dailyPnL: this.dailyPnL,
      realizedPnL: this.realizedPnL,
      maxDrawdown: this.maxDrawdown,
      currentDrawdown: this.currentDrawdown,
      tradesExecuted: this.tradesExecuted,
      tradesWon: this.tradesWon,
      tradesLost: this.tradesLost,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins: this.consecutiveWins,
      marketsTraded: Array.from(this.marketsTraded),
      tradingHalted: this.tradingHalted,
      haltReason: this.haltReason,
      strategyStats: this.strategyStats
    };
  }

  /**
   * Import state from persistence
   */
  importState(state) {
    if (state.sessionDate !== this.sessionDate) {
      // Different day, don't import
      return false;
    }

    this.sessionStart = state.sessionStart;
    this.balance = state.balance;
    this.peakBalance = state.peakBalance;
    this.dailyPnL = state.dailyPnL;
    this.realizedPnL = state.realizedPnL;
    this.maxDrawdown = state.maxDrawdown;
    this.currentDrawdown = state.currentDrawdown;
    this.tradesExecuted = state.tradesExecuted;
    this.tradesWon = state.tradesWon;
    this.tradesLost = state.tradesLost;
    this.consecutiveLosses = state.consecutiveLosses;
    this.consecutiveWins = state.consecutiveWins;
    this.marketsTraded = new Set(state.marketsTraded || []);
    this.tradingHalted = state.tradingHalted;
    this.haltReason = state.haltReason;
    this.strategyStats = state.strategyStats || {};

    return true;
  }
}

export default SessionState;
