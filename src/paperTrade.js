#!/usr/bin/env node

/**
 * Paper Trading Entry Point
 *
 * Usage:
 *   node src/paperTrade.js                  # Start live paper trading
 *   node src/paperTrade.js --backtest       # Run 120-day backtest
 *   node src/paperTrade.js --backtest 30    # Run 30-day backtest
 *   node src/paperTrade.js --balance 1000   # Start with $1000
 */

import 'dotenv/config';
import { startPaperTrading } from './paperTrading/orchestrator.js';
import { runBacktest } from './paperTrading/backtester.js';

// Parse command line arguments
const args = process.argv.slice(2);
const isBacktest = args.includes('--backtest');
const balanceIdx = args.indexOf('--balance');
const initialBalance = balanceIdx >= 0 ? parseFloat(args[balanceIdx + 1]) || 500 : 500;

// Find backtest days if specified
let backtestDays = 120;
if (isBacktest) {
  const backtestIdx = args.indexOf('--backtest');
  const nextArg = args[backtestIdx + 1];
  if (nextArg && !nextArg.startsWith('--')) {
    backtestDays = parseInt(nextArg) || 120;
  }
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║         POLYMARKET BTC 15-MINUTE PAPER TRADING           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  if (isBacktest) {
    console.log(`Mode: BACKTEST (${backtestDays} days)`);
    console.log(`Initial Balance: $${initialBalance}\n`);

    const results = await runBacktest(backtestDays, initialBalance);

    if (results) {
      console.log('\n✓ Backtest complete. Review results above.');
    }
  } else {
    console.log('Mode: LIVE PAPER TRADING');
    console.log(`Initial Balance: $${initialBalance}`);
    console.log('\nPress Ctrl+C to stop.\n');

    await startPaperTrading({
      initialBalance,
      pollInterval: 5000,
      minConfidence: 0.55,
      minRiskPercent: 0.02,
      maxRiskPercent: 0.05
    });
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
