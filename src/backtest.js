/**
 * Backtesting module for tracking prediction accuracy
 * Records predictions at market start and outcomes at market end
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDir, appendCsvRow } from "./utils.js";

const OUTCOMES_FILE = "./logs/outcomes.csv";
const OUTCOMES_HEADER = [
  "market_id",
  "market_start",
  "market_end",
  "price_to_beat",
  "final_price",
  "predicted_direction",
  "predicted_confidence",
  "actual_direction",
  "correct",
  "market_up_price",
  "market_down_price",
  "edge_captured"
];

// Track active markets
const activeMarkets = new Map();

/**
 * Record a prediction when entering a new market window
 */
export function recordPrediction({
  marketId,
  marketStart,
  marketEnd,
  priceToBeat,
  predictedUp,
  predictedDown,
  marketUpPrice,
  marketDownPrice
}) {
  if (!marketId || activeMarkets.has(marketId)) return;

  const predictedDirection = predictedUp > predictedDown ? "UP" : "DOWN";
  const predictedConfidence = Math.max(predictedUp, predictedDown);

  activeMarkets.set(marketId, {
    marketId,
    marketStart,
    marketEnd,
    priceToBeat,
    predictedDirection,
    predictedConfidence,
    marketUpPrice,
    marketDownPrice,
    recordedAt: Date.now()
  });

  console.log(`[Backtest] Tracking market ${marketId} - Predicted: ${predictedDirection} (${(predictedConfidence * 100).toFixed(1)}%)`);
}

/**
 * Record the outcome when a market window closes
 */
export function recordOutcome({ marketId, finalPrice }) {
  const prediction = activeMarkets.get(marketId);
  if (!prediction) return null;

  const actualDirection = finalPrice > prediction.priceToBeat ? "UP" : "DOWN";
  const correct = prediction.predictedDirection === actualDirection;

  // Calculate edge captured (if we bet on our prediction)
  const betPrice = prediction.predictedDirection === "UP"
    ? prediction.marketUpPrice
    : prediction.marketDownPrice;
  const edgeCaptured = correct ? (1 - betPrice) : -betPrice;

  const row = [
    prediction.marketId,
    prediction.marketStart,
    prediction.marketEnd,
    prediction.priceToBeat,
    finalPrice,
    prediction.predictedDirection,
    prediction.predictedConfidence,
    actualDirection,
    correct ? "TRUE" : "FALSE",
    prediction.marketUpPrice,
    prediction.marketDownPrice,
    edgeCaptured?.toFixed(4) ?? ""
  ];

  appendCsvRow(OUTCOMES_FILE, OUTCOMES_HEADER, row);
  activeMarkets.delete(marketId);

  console.log(`[Backtest] Market ${marketId} - Predicted: ${prediction.predictedDirection}, Actual: ${actualDirection} - ${correct ? "✓ CORRECT" : "✗ WRONG"}`);

  return { correct, predictedDirection: prediction.predictedDirection, actualDirection, edgeCaptured };
}

/**
 * Check if any tracked markets have ended and need outcome recording
 */
export function checkPendingOutcomes(currentPrice) {
  const now = Date.now();
  const results = [];

  for (const [marketId, prediction] of activeMarkets) {
    const endMs = new Date(prediction.marketEnd).getTime();

    // If market ended more than 30 seconds ago, record the outcome
    if (now > endMs + 30000 && currentPrice !== null) {
      const result = recordOutcome({ marketId, finalPrice: currentPrice });
      if (result) results.push(result);
    }
  }

  return results;
}

/**
 * Get current backtest statistics
 */
export function getBacktestStats() {
  if (!fs.existsSync(OUTCOMES_FILE)) {
    return { total: 0, correct: 0, accuracy: 0, profitLoss: 0, message: "No outcomes recorded yet" };
  }

  const content = fs.readFileSync(OUTCOMES_FILE, "utf8");
  const lines = content.trim().split("\n").slice(1); // Skip header

  if (lines.length === 0) {
    return { total: 0, correct: 0, accuracy: 0, profitLoss: 0, message: "No outcomes recorded yet" };
  }

  let total = 0;
  let correct = 0;
  let profitLoss = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    total++;
    if (cols[8] === "TRUE") correct++;
    const edge = parseFloat(cols[11]);
    if (!isNaN(edge)) profitLoss += edge;
  }

  const accuracy = total > 0 ? (correct / total) * 100 : 0;

  return {
    total,
    correct,
    wrong: total - correct,
    accuracy: accuracy.toFixed(1),
    profitLoss: profitLoss.toFixed(4),
    message: `${correct}/${total} correct (${accuracy.toFixed(1)}%) | P/L: ${profitLoss > 0 ? "+" : ""}${profitLoss.toFixed(4)}`
  };
}

/**
 * Print backtest summary to console
 */
export function printBacktestSummary() {
  const stats = getBacktestStats();
  console.log("\n═══════════════════════════════════════");
  console.log("         BACKTEST SUMMARY");
  console.log("═══════════════════════════════════════");
  console.log(`Total Predictions: ${stats.total}`);
  console.log(`Correct:          ${stats.correct}`);
  console.log(`Wrong:            ${stats.wrong ?? 0}`);
  console.log(`Accuracy:         ${stats.accuracy}%`);
  console.log(`Profit/Loss:      ${stats.profitLoss}`);
  console.log("═══════════════════════════════════════\n");
  return stats;
}

export { activeMarkets };
