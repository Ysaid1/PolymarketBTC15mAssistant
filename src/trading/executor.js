/**
 * Trade Executor
 * Handles trade execution with safety checks
 */

import { TRADING_CONFIG } from "./config.js";
import { placeOrder, getBalance, isConfigured } from "./polymarketClient.js";
import { appendCsvRow } from "../utils.js";

const TRADES_LOG = "./logs/trades.csv";
const TRADES_HEADER = [
  "timestamp",
  "market_id",
  "side",
  "size",
  "price",
  "edge",
  "model_confidence",
  "status",
  "order_id",
  "dry_run"
];

// Track daily stats
let dailyStats = {
  date: new Date().toDateString(),
  tradesPlaced: 0,
  totalLoss: 0,
  totalWin: 0,
};

function resetDailyStatsIfNeeded() {
  const today = new Date().toDateString();
  if (dailyStats.date !== today) {
    dailyStats = {
      date: today,
      tradesPlaced: 0,
      totalLoss: 0,
      totalWin: 0,
    };
  }
}

/**
 * Check if we can place a trade based on risk limits
 */
function canTrade() {
  resetDailyStatsIfNeeded();

  if (!TRADING_CONFIG.enabled) {
    return { allowed: false, reason: "Trading disabled in config" };
  }

  if (dailyStats.tradesPlaced >= TRADING_CONFIG.maxPositionsPerDay) {
    return { allowed: false, reason: `Daily trade limit reached (${TRADING_CONFIG.maxPositionsPerDay})` };
  }

  if (dailyStats.totalLoss >= TRADING_CONFIG.maxDailyLoss) {
    return { allowed: false, reason: `Daily loss limit reached ($${TRADING_CONFIG.maxDailyLoss})` };
  }

  return { allowed: true, reason: "OK" };
}

/**
 * Calculate optimal bet size based on Kelly Criterion (simplified)
 */
function calculateBetSize(edge, modelConfidence) {
  // Use fractional Kelly (50%) with edge as the primary factor
  // Scale bet size: higher edge = larger bet, up to maxBetSize
  const kellyFraction = 0.5;

  // Base bet is a fraction of max, scaled by edge strength
  // Edge of 10% = 25% of max, Edge of 40% = 100% of max
  const edgeMultiplier = Math.min(edge / 0.4, 1.0); // Cap at 40% edge
  const optimalBet = kellyFraction * edgeMultiplier * TRADING_CONFIG.maxBetSize;

  // Ensure minimum viable bet of $5 (Polymarket minimum), clamp to max
  const betSize = Math.max(5, Math.min(optimalBet, TRADING_CONFIG.maxBetSize));

  // Round to 2 decimal places
  return Math.round(betSize * 100) / 100;
}

/**
 * Execute a trade based on signal
 * @param {Object} signal - Trading signal from the analysis engine
 * @param {Object} market - Market data from Polymarket
 */
export async function executeTrade({
  signal,
  marketId,
  upTokenId,
  downTokenId,
  marketUpPrice,
  marketDownPrice,
  modelUp,
  modelDown,
  edgeUp,
  edgeDown,
  timeLeftMin,
}) {
  resetDailyStatsIfNeeded();

  // Determine trade direction
  const side = signal.side; // "UP" or "DOWN"
  const tokenId = side === "UP" ? upTokenId : downTokenId;
  const marketPrice = side === "UP" ? marketUpPrice : marketDownPrice;
  const edge = side === "UP" ? edgeUp : edgeDown;
  const modelConfidence = side === "UP" ? modelUp : modelDown;

  // Safety checks
  const tradeCheck = canTrade();
  if (!tradeCheck.allowed) {
    console.log(`[Executor] Trade blocked: ${tradeCheck.reason}`);
    return { success: false, reason: tradeCheck.reason };
  }

  // Check minimum edge threshold
  if (edge < TRADING_CONFIG.minEdgeThreshold) {
    console.log(`[Executor] Edge too low: ${(edge * 100).toFixed(1)}% < ${(TRADING_CONFIG.minEdgeThreshold * 100).toFixed(1)}%`);
    return { success: false, reason: "Edge below threshold" };
  }

  // Don't trade in last 2 minutes (too risky)
  if (timeLeftMin < 2) {
    console.log(`[Executor] Too close to expiry: ${timeLeftMin.toFixed(1)} min left`);
    return { success: false, reason: "Too close to expiry" };
  }

  // Calculate bet size
  const betSize = calculateBetSize(edge, modelConfidence);
  if (betSize < 5) {
    console.log(`[Executor] Bet size too small: $${betSize} (minimum is $5)`);
    return { success: false, reason: "Bet size too small (minimum $5)" };
  }

  // Execute trade
  const tradeResult = {
    timestamp: new Date().toISOString(),
    marketId,
    side,
    size: betSize,
    price: marketPrice,
    edge,
    modelConfidence,
    status: "PENDING",
    orderId: null,
    dryRun: TRADING_CONFIG.dryRun,
  };

  if (TRADING_CONFIG.dryRun) {
    // Simulate trade
    console.log(`[Executor] DRY RUN: Would place ${side} order for $${betSize} @ ${marketPrice}`);
    tradeResult.status = "DRY_RUN";
    tradeResult.orderId = `DRY_${Date.now()}`;
  } else {
    // Check API configuration
    if (!isConfigured()) {
      console.log("[Executor] API not configured - cannot place live orders");
      return { success: false, reason: "API not configured" };
    }

    try {
      // Place actual order
      const order = await placeOrder({
        tokenId,
        side: "BUY",
        size: betSize,
        price: marketPrice,
      });

      tradeResult.status = "PLACED";
      tradeResult.orderId = order.id || order.orderID;
      dailyStats.tradesPlaced++;

      console.log(`[Executor] Order placed: ${side} $${betSize} @ ${marketPrice} (ID: ${tradeResult.orderId})`);
    } catch (error) {
      tradeResult.status = "FAILED";
      console.error(`[Executor] Order failed: ${error.message}`);
      return { success: false, reason: error.message };
    }
  }

  // Log trade
  appendCsvRow(TRADES_LOG, TRADES_HEADER, [
    tradeResult.timestamp,
    tradeResult.marketId,
    tradeResult.side,
    tradeResult.size,
    tradeResult.price,
    tradeResult.edge,
    tradeResult.modelConfidence,
    tradeResult.status,
    tradeResult.orderId,
    tradeResult.dryRun,
  ]);

  return { success: true, trade: tradeResult };
}

/**
 * Get daily trading stats
 */
export function getDailyStats() {
  resetDailyStatsIfNeeded();
  return { ...dailyStats };
}

/**
 * Check trading status
 */
export function getTradingStatus() {
  return {
    enabled: TRADING_CONFIG.enabled,
    dryRun: TRADING_CONFIG.dryRun,
    configured: isConfigured(),
    maxBetSize: TRADING_CONFIG.maxBetSize,
    minEdge: TRADING_CONFIG.minEdgeThreshold,
    dailyStats: getDailyStats(),
  };
}
