/**
 * Strategy Tracker
 *
 * Tracks each strategy independently with its own $500 balance.
 * Records comprehensive metrics for analysis.
 */

import fs from 'fs';
import path from 'path';

export class StrategyTracker {
  constructor(options = {}) {
    this.initialBalance = options.initialBalance || 500;
    this.strategies = new Map(); // strategyName -> account state
    this.trades = []; // All trades for CSV export
    this.logDir = options.logDir || 'logs/strategy_analysis';
    this.sessionId = options.sessionId || Date.now();

    // Ensure log directory exists
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    // CSV file paths
    this.tradesFile = path.join(this.logDir, `trades_${this.sessionId}.csv`);
    this.summaryFile = path.join(this.logDir, `summary_${this.sessionId}.csv`);

    // Write CSV headers
    this.writeTradesHeader();
  }

  /**
   * Initialize a strategy account
   */
  initStrategy(strategyName) {
    if (!this.strategies.has(strategyName)) {
      this.strategies.set(strategyName, {
        name: strategyName,
        balance: this.initialBalance,
        initialBalance: this.initialBalance,
        positions: [], // Active positions
        closedTrades: [],
        stats: {
          totalTrades: 0,
          wins: 0,
          losses: 0,
          totalPnL: 0,
          maxDrawdown: 0,
          peakBalance: this.initialBalance,
          consecutiveWins: 0,
          consecutiveLosses: 0,
          currentStreak: 0,
          lastStreakType: null
        }
      });
    }
    return this.strategies.get(strategyName);
  }

  /**
   * Open a position for a specific strategy
   */
  openPosition(strategyName, params) {
    const account = this.initStrategy(strategyName);

    const {
      side,
      entryPrice,
      size,
      confidence,
      marketId,
      marketSlug,
      btcPriceAtEntry,
      btcPriceAtMarketStart,
      contractPriceAtEntry,
      regime,
      htfTrend,
      remainingMinutes,
      timestamp = Date.now()
    } = params;

    // Check if strategy already has a position in this market
    const existingPosition = account.positions.find(p => p.marketId === marketId);
    if (existingPosition) {
      return { success: false, error: 'Already has position in this market' };
    }

    // Check balance
    if (size > account.balance) {
      return { success: false, error: 'Insufficient balance' };
    }

    const tradeId = `${strategyName}_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;

    const position = {
      tradeId,
      strategyName,
      side,
      entryPrice,
      size,
      confidence,
      marketId,
      marketSlug,
      btcPriceAtEntry,
      btcPriceAtMarketStart,
      contractPriceAtEntry,
      regime,
      htfTrend,
      remainingMinutes,
      openTime: timestamp,
      openTimeStr: new Date(timestamp).toISOString(),
      status: 'OPEN'
    };

    account.positions.push(position);

    return { success: true, tradeId, position };
  }

  /**
   * Close a position (market resolution or early exit)
   */
  closePosition(strategyName, tradeId, closeParams) {
    const account = this.strategies.get(strategyName);
    if (!account) {
      return { success: false, error: 'Strategy not found' };
    }

    const positionIndex = account.positions.findIndex(p => p.tradeId === tradeId);
    if (positionIndex === -1) {
      return { success: false, error: 'Position not found' };
    }

    const position = account.positions[positionIndex];

    const {
      exitPrice,
      exitReason, // 'RESOLUTION', 'TAKE_PROFIT', 'STOP_LOSS', 'TIME_DECAY', 'MANUAL'
      outcome, // 'UP' or 'DOWN' (for resolution)
      btcPriceAtExit,
      btcPriceAtResolution,
      contractPriceAtExit,
      timestamp = Date.now()
    } = closeParams;

    // Calculate P/L
    let pnl;
    let won;

    if (exitReason === 'RESOLUTION') {
      // Binary outcome
      won = (position.side === 'UP' && outcome === 'UP') ||
            (position.side === 'DOWN' && outcome === 'DOWN');
      if (won) {
        pnl = position.size * ((1 / position.entryPrice) - 1);
      } else {
        pnl = -position.size;
      }
    } else {
      // Early exit - use share price difference
      const shares = position.size / position.entryPrice;
      pnl = (exitPrice - position.entryPrice) * shares;
      won = pnl > 0;
    }

    // Update account balance
    account.balance += pnl;

    // Update stats
    account.stats.totalTrades++;
    account.stats.totalPnL += pnl;

    if (won) {
      account.stats.wins++;
      if (account.stats.lastStreakType === 'win') {
        account.stats.currentStreak++;
      } else {
        account.stats.currentStreak = 1;
        account.stats.lastStreakType = 'win';
      }
      account.stats.consecutiveWins = Math.max(account.stats.consecutiveWins, account.stats.currentStreak);
    } else {
      account.stats.losses++;
      if (account.stats.lastStreakType === 'loss') {
        account.stats.currentStreak++;
      } else {
        account.stats.currentStreak = 1;
        account.stats.lastStreakType = 'loss';
      }
      account.stats.consecutiveLosses = Math.max(account.stats.consecutiveLosses, account.stats.currentStreak);
    }

    // Track peak/drawdown
    if (account.balance > account.stats.peakBalance) {
      account.stats.peakBalance = account.balance;
    }
    const currentDrawdown = (account.stats.peakBalance - account.balance) / account.stats.peakBalance;
    if (currentDrawdown > account.stats.maxDrawdown) {
      account.stats.maxDrawdown = currentDrawdown;
    }

    // Create closed trade record
    const closedTrade = {
      ...position,
      exitPrice,
      exitReason,
      outcome: outcome || (won ? position.side : (position.side === 'UP' ? 'DOWN' : 'UP')),
      btcPriceAtExit,
      btcPriceAtResolution: btcPriceAtResolution || btcPriceAtExit,
      contractPriceAtExit,
      closeTime: timestamp,
      closeTimeStr: new Date(timestamp).toISOString(),
      pnl,
      won,
      holdTimeMs: timestamp - position.openTime,
      holdTimeMin: (timestamp - position.openTime) / 60000,
      balanceAfter: account.balance,
      status: 'CLOSED'
    };

    account.closedTrades.push(closedTrade);
    this.trades.push(closedTrade);

    // Remove from open positions
    account.positions.splice(positionIndex, 1);

    // Write to CSV
    this.appendTradeToCSV(closedTrade);

    return {
      success: true,
      trade: closedTrade,
      pnl,
      won,
      newBalance: account.balance
    };
  }

  /**
   * Close all positions for a market (on resolution)
   */
  closeAllForMarket(marketId, outcome, btcPriceAtResolution) {
    const results = [];

    for (const [strategyName, account] of this.strategies) {
      const marketPositions = account.positions.filter(p => p.marketId === marketId);

      for (const position of marketPositions) {
        const result = this.closePosition(strategyName, position.tradeId, {
          exitPrice: outcome === position.side ? 1.0 : 0.0,
          exitReason: 'RESOLUTION',
          outcome,
          btcPriceAtExit: btcPriceAtResolution,
          btcPriceAtResolution,
          contractPriceAtExit: outcome === position.side ? 1.0 : 0.0
        });

        results.push({
          strategyName,
          ...result
        });
      }
    }

    return results;
  }

  /**
   * Get active position for a strategy in a market
   */
  getPosition(strategyName, marketId) {
    const account = this.strategies.get(strategyName);
    if (!account) return null;
    return account.positions.find(p => p.marketId === marketId);
  }

  /**
   * Get all active positions across all strategies
   */
  getAllPositions() {
    const positions = [];
    for (const [strategyName, account] of this.strategies) {
      for (const pos of account.positions) {
        positions.push({ strategyName, ...pos });
      }
    }
    return positions;
  }

  /**
   * Get strategy account state
   */
  getStrategyState(strategyName) {
    return this.strategies.get(strategyName);
  }

  /**
   * Get all strategy summaries
   */
  getAllStrategySummaries() {
    const summaries = [];

    for (const [name, account] of this.strategies) {
      const winRate = account.stats.totalTrades > 0
        ? (account.stats.wins / account.stats.totalTrades) * 100
        : 0;

      const returnPct = ((account.balance - account.initialBalance) / account.initialBalance) * 100;

      summaries.push({
        name,
        balance: account.balance,
        returnPct,
        totalTrades: account.stats.totalTrades,
        wins: account.stats.wins,
        losses: account.stats.losses,
        winRate,
        totalPnL: account.stats.totalPnL,
        maxDrawdown: account.stats.maxDrawdown * 100,
        consecutiveWins: account.stats.consecutiveWins,
        consecutiveLosses: account.stats.consecutiveLosses,
        activePositions: account.positions.length
      });
    }

    // Sort by balance descending
    summaries.sort((a, b) => b.balance - a.balance);

    return summaries;
  }

  /**
   * Write CSV header for trades file
   */
  writeTradesHeader() {
    const headers = [
      'tradeId',
      'strategyName',
      'marketId',
      'marketSlug',
      'side',
      'entryPrice',
      'exitPrice',
      'size',
      'pnl',
      'won',
      'exitReason',
      'outcome',
      'confidence',
      'regime',
      'htfTrend',
      'btcPriceAtMarketStart',
      'btcPriceAtEntry',
      'btcPriceAtExit',
      'btcPriceAtResolution',
      'contractPriceAtEntry',
      'contractPriceAtExit',
      'openTime',
      'closeTime',
      'holdTimeMin',
      'remainingMinutesAtEntry',
      'balanceAfter'
    ].join(',');

    fs.writeFileSync(this.tradesFile, headers + '\n');
  }

  /**
   * Append a trade to CSV
   */
  appendTradeToCSV(trade) {
    const row = [
      trade.tradeId,
      trade.strategyName,
      trade.marketId,
      trade.marketSlug,
      trade.side,
      trade.entryPrice?.toFixed(4),
      trade.exitPrice?.toFixed(4),
      trade.size?.toFixed(2),
      trade.pnl?.toFixed(2),
      trade.won ? 1 : 0,
      trade.exitReason,
      trade.outcome,
      trade.confidence?.toFixed(4),
      trade.regime,
      trade.htfTrend,
      trade.btcPriceAtMarketStart?.toFixed(2),
      trade.btcPriceAtEntry?.toFixed(2),
      trade.btcPriceAtExit?.toFixed(2),
      trade.btcPriceAtResolution?.toFixed(2),
      trade.contractPriceAtEntry?.toFixed(4),
      trade.contractPriceAtExit?.toFixed(4),
      trade.openTimeStr,
      trade.closeTimeStr,
      trade.holdTimeMin?.toFixed(2),
      trade.remainingMinutes?.toFixed(2),
      trade.balanceAfter?.toFixed(2)
    ].join(',');

    fs.appendFileSync(this.tradesFile, row + '\n');
  }

  /**
   * Write summary CSV
   */
  writeSummaryCSV() {
    const summaries = this.getAllStrategySummaries();

    const headers = [
      'strategyName',
      'balance',
      'returnPct',
      'totalTrades',
      'wins',
      'losses',
      'winRate',
      'totalPnL',
      'maxDrawdownPct',
      'consecutiveWins',
      'consecutiveLosses',
      'activePositions'
    ].join(',');

    let content = headers + '\n';

    for (const s of summaries) {
      const row = [
        s.name,
        s.balance.toFixed(2),
        s.returnPct.toFixed(2),
        s.totalTrades,
        s.wins,
        s.losses,
        s.winRate.toFixed(2),
        s.totalPnL.toFixed(2),
        s.maxDrawdown.toFixed(2),
        s.consecutiveWins,
        s.consecutiveLosses,
        s.activePositions
      ].join(',');
      content += row + '\n';
    }

    fs.writeFileSync(this.summaryFile, content);

    return this.summaryFile;
  }

  /**
   * Get leaderboard display string
   */
  getLeaderboard(topN = 5) {
    const summaries = this.getAllStrategySummaries().slice(0, topN);

    let output = '';
    for (let i = 0; i < summaries.length; i++) {
      const s = summaries[i];
      const returnColor = s.returnPct >= 0 ? '\x1b[32m' : '\x1b[31m';
      const reset = '\x1b[0m';
      output += `  ${i + 1}. ${s.name.padEnd(20)} | $${s.balance.toFixed(0).padStart(6)} (${returnColor}${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%${reset}) | W/L: ${s.wins}/${s.losses} (${s.winRate.toFixed(0)}%)\n`;
    }

    return output;
  }

  /**
   * Export state for persistence
   */
  exportState() {
    const strategiesObj = {};
    for (const [name, account] of this.strategies) {
      strategiesObj[name] = account;
    }

    return {
      sessionId: this.sessionId,
      strategies: strategiesObj,
      trades: this.trades,
      exportTime: Date.now()
    };
  }

  /**
   * Import state
   */
  importState(state) {
    this.sessionId = state.sessionId;
    this.strategies = new Map(Object.entries(state.strategies));
    this.trades = state.trades || [];
  }
}

export default StrategyTracker;
