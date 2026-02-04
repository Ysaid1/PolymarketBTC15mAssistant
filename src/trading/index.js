/**
 * Trading module exports
 */

export { TRADING_CONFIG, validateTradingConfig } from "./config.js";
export { executeTrade, getTradingStatus, getDailyStats } from "./executor.js";
export {
  getBalance,
  getOpenOrders,
  placeOrder,
  cancelOrder,
  getPositions,
  isConfigured,
} from "./polymarketClient.js";
