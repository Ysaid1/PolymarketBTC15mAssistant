#!/usr/bin/env node
/**
 * View backtest statistics
 * Run with: node src/stats.js
 */

import fs from "node:fs";

const OUTCOMES_FILE = "./logs/outcomes.csv";

function analyzeBacktest() {
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║           POLYMARKET BTC 15M BACKTEST RESULTS                 ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  if (!fs.existsSync(OUTCOMES_FILE)) {
    console.log("❌ No backtest data found yet.");
    console.log("   Run the main app (npm start) and let it track some markets.\n");
    return;
  }

  const content = fs.readFileSync(OUTCOMES_FILE, "utf8");
  const lines = content.trim().split("\n");

  if (lines.length <= 1) {
    console.log("❌ No outcomes recorded yet.");
    console.log("   The app needs to complete at least one 15-minute window.\n");
    return;
  }

  const header = lines[0].split(",");
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const cols = line.split(",");
    return {
      marketId: cols[0],
      marketStart: cols[1],
      marketEnd: cols[2],
      priceToBeat: parseFloat(cols[3]),
      finalPrice: parseFloat(cols[4]),
      predictedDirection: cols[5],
      predictedConfidence: parseFloat(cols[6]),
      actualDirection: cols[7],
      correct: cols[8] === "TRUE",
      marketUpPrice: parseFloat(cols[9]),
      marketDownPrice: parseFloat(cols[10]),
      edgeCaptured: parseFloat(cols[11])
    };
  });

  // Overall stats
  const total = rows.length;
  const correct = rows.filter(r => r.correct).length;
  const wrong = total - correct;
  const accuracy = (correct / total) * 100;
  const totalPL = rows.reduce((sum, r) => sum + (isNaN(r.edgeCaptured) ? 0 : r.edgeCaptured), 0);

  console.log("📊 OVERALL STATISTICS");
  console.log("─────────────────────────────────────────");
  console.log(`   Total Predictions:  ${total}`);
  console.log(`   Correct:            ${correct} ✓`);
  console.log(`   Wrong:              ${wrong} ✗`);
  console.log(`   Accuracy:           ${accuracy.toFixed(1)}%`);
  console.log(`   Total P/L:          ${totalPL > 0 ? "+" : ""}${totalPL.toFixed(4)}`);
  console.log("");

  // By direction
  const upPredictions = rows.filter(r => r.predictedDirection === "UP");
  const downPredictions = rows.filter(r => r.predictedDirection === "DOWN");
  const upCorrect = upPredictions.filter(r => r.correct).length;
  const downCorrect = downPredictions.filter(r => r.correct).length;

  console.log("📈 BY PREDICTED DIRECTION");
  console.log("─────────────────────────────────────────");
  if (upPredictions.length > 0) {
    console.log(`   UP predictions:     ${upCorrect}/${upPredictions.length} (${((upCorrect/upPredictions.length)*100).toFixed(1)}%)`);
  }
  if (downPredictions.length > 0) {
    console.log(`   DOWN predictions:   ${downCorrect}/${downPredictions.length} (${((downCorrect/downPredictions.length)*100).toFixed(1)}%)`);
  }
  console.log("");

  // By confidence level
  const highConf = rows.filter(r => r.predictedConfidence >= 0.65);
  const medConf = rows.filter(r => r.predictedConfidence >= 0.55 && r.predictedConfidence < 0.65);
  const lowConf = rows.filter(r => r.predictedConfidence < 0.55);

  console.log("🎯 BY CONFIDENCE LEVEL");
  console.log("─────────────────────────────────────────");
  if (highConf.length > 0) {
    const hc = highConf.filter(r => r.correct).length;
    console.log(`   High (≥65%):        ${hc}/${highConf.length} (${((hc/highConf.length)*100).toFixed(1)}%)`);
  }
  if (medConf.length > 0) {
    const mc = medConf.filter(r => r.correct).length;
    console.log(`   Medium (55-65%):    ${mc}/${medConf.length} (${((mc/medConf.length)*100).toFixed(1)}%)`);
  }
  if (lowConf.length > 0) {
    const lc = lowConf.filter(r => r.correct).length;
    console.log(`   Low (<55%):         ${lc}/${lowConf.length} (${((lc/lowConf.length)*100).toFixed(1)}%)`);
  }
  console.log("");

  // Recent results
  console.log("📋 RECENT PREDICTIONS (last 10)");
  console.log("─────────────────────────────────────────");
  const recent = rows.slice(-10).reverse();
  for (const r of recent) {
    const icon = r.correct ? "✓" : "✗";
    const color = r.correct ? "\x1b[32m" : "\x1b[31m";
    const reset = "\x1b[0m";
    console.log(`   ${color}${icon}${reset} ${r.predictedDirection} (${(r.predictedConfidence*100).toFixed(0)}%) → ${r.actualDirection} | Edge: ${r.edgeCaptured > 0 ? "+" : ""}${r.edgeCaptured.toFixed(4)}`);
  }
  console.log("");

  // Profit simulation
  console.log("💰 PROFIT SIMULATION (if betting $100 per prediction)");
  console.log("─────────────────────────────────────────");
  const betAmount = 100;
  const simProfit = totalPL * betAmount;
  console.log(`   Starting bankroll:  $1,000`);
  console.log(`   Bet size:           $${betAmount}`);
  console.log(`   Net profit/loss:    $${simProfit > 0 ? "+" : ""}${simProfit.toFixed(2)}`);
  console.log(`   ROI:                ${((simProfit / (total * betAmount)) * 100).toFixed(2)}%`);
  console.log("");
}

analyzeBacktest();
