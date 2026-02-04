/**
 * Performance Tracker
 *
 * Tracks strategy performance over time and calculates
 * dynamic weights for signal aggregation.
 */

import { ALL_DAY_CONFIG } from './config.js';

export class PerformanceTracker {
  constructor() {
    this.config = ALL_DAY_CONFIG.performance;

    // Trade history per strategy
    this.strategyHistory = {};

    // Initialize for known strategies
    const strategies = ['MOMENTUM', 'MEAN_REVERSION', 'VOLATILITY_BREAKOUT', 'RSI', 'MACD'];
    for (const name of strategies) {
      this.strategyHistory[name] = {
        trades: [],
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        lastUpdated: null
      };
    }
  }

  /**
   * Record a trade outcome
   */
  recordOutcome(strategyName, won, pnl, regime = null) {
    if (!this.strategyHistory[strategyName]) {
      this.strategyHistory[strategyName] = {
        trades: [],
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        lastUpdated: null
      };
    }

    const history = this.strategyHistory[strategyName];

    // Add to rolling window
    history.trades.push({
      won,
      pnl,
      regime,
      timestamp: Date.now()
    });

    // Keep only windowSize trades
    if (history.trades.length > this.config.windowSize) {
      history.trades.shift();
    }

    // Update totals
    history.totalTrades++;
    if (won) {
      history.wins++;
    } else {
      history.losses++;
    }
    history.totalPnL += pnl || 0;
    history.lastUpdated = Date.now();
  }

  /**
   * Get rolling win rate for a strategy
   */
  getWinRate(strategyName, windowSize = null) {
    const size = windowSize || this.config.windowSize;
    const history = this.strategyHistory[strategyName];

    if (!history || history.trades.length === 0) {
      return 0.5; // Neutral assumption
    }

    const recentTrades = history.trades.slice(-size);
    const wins = recentTrades.filter(t => t.won).length;

    return wins / recentTrades.length;
  }

  /**
   * Get strategy weight based on performance
   */
  getStrategyWeight(strategyName) {
    const history = this.strategyHistory[strategyName];

    // Not enough trades - use default weight
    if (!history || history.trades.length < this.config.minTradesForWeighting) {
      return this.config.defaultWeight;
    }

    // Calculate rolling win rate
    const winRate = this.getWinRate(strategyName);

    // Map win rate to weight
    // Win rate 50% = weight 1.0
    // Win rate 60% = weight 1.2
    // Win rate 40% = weight 0.8
    const baseWeight = this.config.defaultWeight;
    const adjustment = (winRate - 0.5) * 2; // -1 to +1 range

    let weight = baseWeight + adjustment * 0.5;

    // Clamp to range
    const [minWeight, maxWeight] = this.config.weightRange;
    weight = Math.max(minWeight, Math.min(maxWeight, weight));

    return weight;
  }

  /**
   * Get all strategy weights
   */
  getAllWeights() {
    const weights = {};

    for (const name of Object.keys(this.strategyHistory)) {
      weights[name] = {
        weight: this.getStrategyWeight(name),
        winRate: this.getWinRate(name),
        trades: this.strategyHistory[name].trades.length,
        totalTrades: this.strategyHistory[name].totalTrades
      };
    }

    return weights;
  }

  /**
   * Identify underperforming strategies
   */
  identifyUnderperformers(minWinRate = 0.45) {
    const underperformers = [];

    for (const [name, history] of Object.entries(this.strategyHistory)) {
      if (history.trades.length >= this.config.minTradesForWeighting) {
        const winRate = this.getWinRate(name);
        if (winRate < minWinRate) {
          underperformers.push({
            name,
            winRate,
            trades: history.trades.length
          });
        }
      }
    }

    return underperformers;
  }

  /**
   * Get top performing strategies
   */
  getTopPerformers(count = 3) {
    const performers = [];

    for (const [name, history] of Object.entries(this.strategyHistory)) {
      if (history.trades.length >= this.config.minTradesForWeighting) {
        performers.push({
          name,
          winRate: this.getWinRate(name),
          pnl: history.totalPnL,
          trades: history.totalTrades
        });
      }
    }

    // Sort by win rate descending
    performers.sort((a, b) => b.winRate - a.winRate);

    return performers.slice(0, count);
  }

  /**
   * Get performance by regime
   */
  getPerformanceByRegime(strategyName) {
    const history = this.strategyHistory[strategyName];
    if (!history) return {};

    const byRegime = {};

    for (const trade of history.trades) {
      const regime = trade.regime || 'UNKNOWN';
      if (!byRegime[regime]) {
        byRegime[regime] = { trades: 0, wins: 0, pnl: 0 };
      }
      byRegime[regime].trades++;
      if (trade.won) byRegime[regime].wins++;
      byRegime[regime].pnl += trade.pnl || 0;
    }

    // Calculate win rates
    for (const regime of Object.keys(byRegime)) {
      byRegime[regime].winRate = byRegime[regime].wins / byRegime[regime].trades;
    }

    return byRegime;
  }

  /**
   * Generate performance report
   */
  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      strategies: {}
    };

    for (const [name, history] of Object.entries(this.strategyHistory)) {
      report.strategies[name] = {
        totalTrades: history.totalTrades,
        recentTrades: history.trades.length,
        wins: history.wins,
        losses: history.losses,
        totalPnL: history.totalPnL,
        rollingWinRate: this.getWinRate(name),
        currentWeight: this.getStrategyWeight(name),
        byRegime: this.getPerformanceByRegime(name)
      };
    }

    report.topPerformers = this.getTopPerformers();
    report.underperformers = this.identifyUnderperformers();

    return report;
  }

  /**
   * Export state for persistence
   */
  exportState() {
    return {
      strategyHistory: this.strategyHistory,
      timestamp: Date.now()
    };
  }

  /**
   * Import state from persistence
   */
  importState(state) {
    if (state.strategyHistory) {
      // Merge histories
      for (const [name, history] of Object.entries(state.strategyHistory)) {
        if (this.strategyHistory[name]) {
          // Keep recent trades only
          const combined = [
            ...history.trades,
            ...this.strategyHistory[name].trades
          ].slice(-this.config.windowSize);

          this.strategyHistory[name] = {
            ...history,
            trades: combined
          };
        } else {
          this.strategyHistory[name] = history;
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Reset all history
   */
  reset() {
    for (const name of Object.keys(this.strategyHistory)) {
      this.strategyHistory[name] = {
        trades: [],
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        lastUpdated: null
      };
    }
  }
}

export default PerformanceTracker;
