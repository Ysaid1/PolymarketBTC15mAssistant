/**
 * Trading bot configuration
 * Reads from environment variables
 */

export const TRADING_CONFIG = {
  // Credentials
  privateKey: process.env.PRIVATE_KEY || "",
  apiKey: process.env.POLYMARKET_API_KEY || "",
  apiSecret: process.env.POLYMARKET_API_SECRET || "",
  passphrase: process.env.POLYMARKET_PASSPHRASE || "",

  // Trading settings
  enabled: process.env.TRADING_ENABLED === "true",
  dryRun: process.env.DRY_RUN !== "false", // Default to dry run for safety
  maxBetSize: Number(process.env.MAX_BET_SIZE) || 10,
  minEdgeThreshold: Number(process.env.MIN_EDGE_THRESHOLD) || 0.10,
  maxDailyLoss: Number(process.env.MAX_DAILY_LOSS) || 50,
  maxPositionsPerDay: Number(process.env.MAX_POSITIONS_PER_DAY) || 10,

  // Risk management
  stopLossEnabled: process.env.STOP_LOSS_ENABLED !== "false",

  // Polymarket CLOB API
  clobApiUrl: "https://clob.polymarket.com",
  chainId: 137, // Polygon mainnet
};

export function validateTradingConfig() {
  const errors = [];

  if (TRADING_CONFIG.enabled && !TRADING_CONFIG.dryRun) {
    if (!TRADING_CONFIG.privateKey || TRADING_CONFIG.privateKey === "your_private_key_here") {
      errors.push("PRIVATE_KEY is required for live trading");
    }
    if (!TRADING_CONFIG.apiKey || TRADING_CONFIG.apiKey === "your_api_key_here") {
      errors.push("POLYMARKET_API_KEY is required for live trading");
    }
    if (!TRADING_CONFIG.apiSecret || TRADING_CONFIG.apiSecret === "your_api_secret_here") {
      errors.push("POLYMARKET_API_SECRET is required for live trading");
    }
  }

  if (TRADING_CONFIG.maxBetSize <= 0) {
    errors.push("MAX_BET_SIZE must be positive");
  }

  if (TRADING_CONFIG.minEdgeThreshold < 0 || TRADING_CONFIG.minEdgeThreshold > 1) {
    errors.push("MIN_EDGE_THRESHOLD must be between 0 and 1");
  }

  return { valid: errors.length === 0, errors };
}
