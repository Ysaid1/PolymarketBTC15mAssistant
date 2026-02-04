/**
 * CSV Logger for Paper Trading
 *
 * Logs all trades, signals, and performance data to CSV files
 * for verification and analysis.
 */

import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '../../logs/paper_trading');

/**
 * Ensure log directory exists
 */
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Format date for filenames
 */
function formatDate(date = new Date()) {
  return date.toISOString().split('T')[0];
}

/**
 * Format timestamp for CSV
 */
function formatTimestamp(ts = Date.now()) {
  return new Date(ts).toISOString();
}

/**
 * Escape CSV value
 */
function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Create CSV row from object
 */
function toCSVRow(obj, columns) {
  return columns.map(col => escapeCSV(obj[col])).join(',');
}

/**
 * CSV Logger class
 */
export class CSVLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || LOG_DIR;
    this.sessionId = options.sessionId || Date.now().toString(36);
    this.dateStr = formatDate();

    ensureLogDir();

    // File paths
    this.files = {
      trades: join(this.logDir, `trades_${this.dateStr}.csv`),
      signals: join(this.logDir, `signals_${this.dateStr}.csv`),
      positions: join(this.logDir, `positions_${this.dateStr}.csv`),
      performance: join(this.logDir, `performance_${this.dateStr}.csv`),
      summary: join(this.logDir, `summary_${this.dateStr}.csv`)
    };

    // Column definitions
    this.columns = {
      trades: [
        'timestamp', 'session_id', 'trade_id', 'strategy', 'market_id', 'market_slug',
        'side', 'entry_price', 'size', 'confidence', 'outcome', 'exit_price',
        'pnl', 'won', 'balance_after', 'hold_time_ms', 'remaining_minutes',
        'signals_json'
      ],
      signals: [
        'timestamp', 'session_id', 'strategy', 'market_id', 'side', 'confidence',
        'raw_up_score', 'raw_down_score', 'price', 'vwap', 'vwap_slope',
        'rsi', 'macd', 'regime', 'remaining_minutes', 'action_taken', 'signals_json'
      ],
      positions: [
        'timestamp', 'session_id', 'trade_id', 'strategy', 'market_id', 'side',
        'entry_price', 'size', 'confidence', 'unrealized_pnl', 'remaining_minutes'
      ],
      performance: [
        'timestamp', 'session_id', 'strategy', 'total_trades', 'wins', 'losses',
        'win_rate', 'total_pnl', 'return_percent', 'max_drawdown', 'current_balance',
        'avg_win', 'avg_loss', 'profit_factor', 'win_streak', 'lose_streak'
      ],
      summary: [
        'timestamp', 'session_id', 'total_balance', 'total_trades', 'total_wins',
        'total_losses', 'combined_win_rate', 'combined_pnl', 'combined_return',
        'open_positions', 'strategies_active'
      ]
    };

    // Initialize files with headers
    this.initFiles();
  }

  /**
   * Initialize CSV files with headers
   */
  initFiles() {
    for (const [type, path] of Object.entries(this.files)) {
      if (!existsSync(path)) {
        writeFileSync(path, this.columns[type].join(',') + '\n');
      }
    }
  }

  /**
   * Log a completed trade
   */
  logTrade(trade, balanceAfter) {
    const row = {
      timestamp: formatTimestamp(trade.closeTime),
      session_id: this.sessionId,
      trade_id: trade.tradeId,
      strategy: trade.strategyName,
      market_id: trade.marketId,
      market_slug: trade.marketSlug,
      side: trade.side,
      entry_price: trade.entryPrice.toFixed(4),
      size: trade.size.toFixed(2),
      confidence: trade.confidence.toFixed(4),
      outcome: trade.outcome,
      exit_price: trade.exitPrice?.toFixed(4) || '',
      pnl: trade.pnl.toFixed(2),
      won: trade.won ? 1 : 0,
      balance_after: balanceAfter.toFixed(2),
      hold_time_ms: trade.holdTime,
      remaining_minutes: trade.remainingMinutes,
      signals_json: JSON.stringify(trade.signals || {})
    };

    appendFileSync(this.files.trades, toCSVRow(row, this.columns.trades) + '\n');
    return row;
  }

  /**
   * Log a signal (whether traded or not)
   */
  logSignal(signal, context) {
    const row = {
      timestamp: formatTimestamp(),
      session_id: this.sessionId,
      strategy: context.strategyName,
      market_id: context.marketId,
      side: signal?.side || 'NONE',
      confidence: signal?.confidence?.toFixed(4) || '',
      raw_up_score: signal?.signals?.rawUpScore || '',
      raw_down_score: signal?.signals?.rawDownScore || '',
      price: context.price?.toFixed(2) || '',
      vwap: context.vwap?.toFixed(2) || '',
      vwap_slope: context.vwapSlope?.toFixed(6) || '',
      rsi: context.rsi?.toFixed(2) || '',
      macd: context.macd?.toFixed(4) || '',
      regime: context.regime || '',
      remaining_minutes: context.remainingMinutes || '',
      action_taken: context.actionTaken || 'NO_TRADE',
      signals_json: JSON.stringify(signal?.signals || {})
    };

    appendFileSync(this.files.signals, toCSVRow(row, this.columns.signals) + '\n');
    return row;
  }

  /**
   * Log current open positions
   */
  logPositions(positions) {
    for (const pos of positions) {
      const row = {
        timestamp: formatTimestamp(),
        session_id: this.sessionId,
        trade_id: pos.tradeId,
        strategy: pos.strategyName,
        market_id: pos.marketId,
        side: pos.side,
        entry_price: pos.entryPrice.toFixed(4),
        size: pos.size.toFixed(2),
        confidence: pos.confidence.toFixed(4),
        unrealized_pnl: (pos.unrealizedPnl || 0).toFixed(2),
        remaining_minutes: pos.remainingMinutes
      };

      appendFileSync(this.files.positions, toCSVRow(row, this.columns.positions) + '\n');
    }
  }

  /**
   * Log strategy performance
   */
  logPerformance(strategyName, stats) {
    const row = {
      timestamp: formatTimestamp(),
      session_id: this.sessionId,
      strategy: strategyName,
      total_trades: stats.totalTrades,
      wins: stats.wins,
      losses: stats.losses,
      win_rate: stats.winRate.toFixed(2),
      total_pnl: stats.totalPnL.toFixed(2),
      return_percent: stats.returnPercent.toFixed(2),
      max_drawdown: (stats.maxDrawdown * 100).toFixed(2),
      current_balance: stats.currentBalance.toFixed(2),
      avg_win: stats.avgWin.toFixed(2),
      avg_loss: stats.avgLoss.toFixed(2),
      profit_factor: stats.profitFactor.toFixed(2),
      win_streak: stats.winStreak,
      lose_streak: stats.loseStreak
    };

    appendFileSync(this.files.performance, toCSVRow(row, this.columns.performance) + '\n');
    return row;
  }

  /**
   * Log overall summary
   */
  logSummary(summary) {
    const row = {
      timestamp: formatTimestamp(),
      session_id: this.sessionId,
      total_balance: summary.totalBalance.toFixed(2),
      total_trades: summary.totalTrades,
      total_wins: summary.totalWins,
      total_losses: summary.totalLosses,
      combined_win_rate: summary.combinedWinRate.toFixed(2),
      combined_pnl: summary.combinedPnL.toFixed(2),
      combined_return: summary.combinedReturn.toFixed(2),
      open_positions: summary.openPositions,
      strategies_active: summary.strategiesActive
    };

    appendFileSync(this.files.summary, toCSVRow(row, this.columns.summary) + '\n');
    return row;
  }

  /**
   * Get log file paths
   */
  getLogPaths() {
    return { ...this.files };
  }

  /**
   * Read trades from CSV
   */
  readTrades() {
    if (!existsSync(this.files.trades)) return [];

    const content = readFileSync(this.files.trades, 'utf-8');
    const lines = content.trim().split('\n');
    const headers = lines[0].split(',');

    return lines.slice(1).map(line => {
      const values = line.split(',');
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = values[i];
      });
      return obj;
    });
  }

  /**
   * Get session trades count
   */
  getSessionTradesCount() {
    const trades = this.readTrades();
    return trades.filter(t => t.session_id === this.sessionId).length;
  }
}

/**
 * Create a default logger instance
 */
export function createLogger(sessionId) {
  return new CSVLogger({ sessionId });
}
