/**
 * Polymarket CLOB API Client
 * Uses the official @polymarket/clob-client SDK
 *
 * Authentication levels:
 * - L1: Private key signing (for creating/deriving API credentials)
 * - L2: API credentials (for trading operations)
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { TRADING_CONFIG } from "./config.js";

const HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

let client = null;
let isInitialized = false;

/**
 * Initialize the CLOB client with L1 or L2 auth
 */
export async function initializeClient() {
  if (isInitialized && client) {
    return client;
  }

  const hasPrivateKey = TRADING_CONFIG.privateKey &&
    TRADING_CONFIG.privateKey !== "your_private_key_here";

  const hasApiCreds = TRADING_CONFIG.apiKey &&
    TRADING_CONFIG.apiKey !== "your_api_key_here" &&
    TRADING_CONFIG.apiSecret &&
    TRADING_CONFIG.apiSecret !== "your_api_secret_here";

  if (!hasPrivateKey) {
    console.log("[Trading] No private key configured - client not initialized");
    return null;
  }

  try {
    const signer = new Wallet(TRADING_CONFIG.privateKey);
    const signerAddress = await signer.getAddress();

    console.log(`[Trading] Initializing client for address: ${signerAddress}`);

    if (hasApiCreds) {
      // L2 Authentication - use existing API credentials
      // Note: ClobClient expects 'key' not 'apiKey' for the credential object
      const apiCreds = {
        key: TRADING_CONFIG.apiKey,
        secret: TRADING_CONFIG.apiSecret,
        passphrase: TRADING_CONFIG.passphrase,
      };

      client = new ClobClient(
        HOST,
        CHAIN_ID,
        signer,
        apiCreds,
        0, // EOA signature type for standard wallets (MetaMask, etc.)
        signerAddress // funder address
      );

      console.log("[Trading] Client initialized with L2 credentials");
    } else {
      // L1 Authentication - will need to create/derive API credentials
      client = new ClobClient(
        HOST,
        CHAIN_ID,
        signer
      );

      console.log("[Trading] Client initialized with L1 only (need to create API credentials)");
    }

    isInitialized = true;
    return client;
  } catch (error) {
    console.error("[Trading] Failed to initialize client:", error.message);
    return null;
  }
}

/**
 * Create or derive API credentials using L1 auth
 * Run this once to get your API key, secret, and passphrase
 */
export async function createOrDeriveApiCredentials() {
  const cli = await initializeClient();
  if (!cli) {
    throw new Error("Client not initialized");
  }

  try {
    console.log("[Trading] Creating/deriving API credentials...");
    const creds = await cli.createOrDeriveApiKey();

    console.log("[Trading] API Credentials obtained!");
    console.log("[Trading] Add these to your .env file:");
    // SDK returns 'key' not 'apiKey'
    const apiKey = creds.apiKey || creds.key;
    console.log(`POLYMARKET_API_KEY=${apiKey}`);
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);

    return { apiKey, secret: creds.secret, passphrase: creds.passphrase };
  } catch (error) {
    console.error("[Trading] Failed to create API credentials:", error.message);
    throw error;
  }
}

/**
 * Get account balance
 */
export async function getBalance() {
  const cli = await initializeClient();
  if (!cli) return null;

  try {
    const balance = await cli.getBalanceAllowance();
    return balance;
  } catch (error) {
    console.error("[Trading] Failed to get balance:", error.message);
    return null;
  }
}

/**
 * Get open orders
 */
export async function getOpenOrders() {
  const cli = await initializeClient();
  if (!cli) return [];

  try {
    const orders = await cli.getOpenOrders();
    return orders;
  } catch (error) {
    console.error("[Trading] Failed to get open orders:", error.message);
    return [];
  }
}

/**
 * Create and post an order
 * @param {Object} params - Order parameters
 * @param {string} params.tokenId - The CLOB token ID for the outcome
 * @param {string} params.side - "BUY" or "SELL"
 * @param {number} params.size - Amount in USDC
 * @param {number} params.price - Limit price (0-1)
 * @param {string} params.tickSize - Market tick size (e.g., "0.01")
 */
export async function placeOrder({ tokenId, side, size, price, tickSize = "0.01" }) {
  const cli = await initializeClient();
  if (!cli) {
    throw new Error("Client not initialized");
  }

  try {
    const orderArgs = {
      tokenID: tokenId,
      price: price,
      size: size,
      side: side.toUpperCase(),
    };

    const options = {
      tickSize: tickSize,
      negRisk: false, // BTC markets are not neg risk
    };

    console.log(`[Trading] Placing order: ${side} ${size} @ ${price}`);
    const order = await cli.createAndPostOrder(orderArgs, options);

    // Check if order was actually placed (has an ID)
    if (!order || (!order.id && !order.orderID)) {
      throw new Error("Order was not placed - no order ID returned");
    }

    console.log(`[Trading] Order placed successfully: ${order.id || order.orderID}`);
    return order;
  } catch (error) {
    console.error("[Trading] Failed to place order:", error.message);
    throw error;
  }
}

/**
 * Cancel an order
 */
export async function cancelOrder(orderId) {
  const cli = await initializeClient();
  if (!cli) {
    throw new Error("Client not initialized");
  }

  try {
    const result = await cli.cancelOrder(orderId);
    console.log(`[Trading] Order cancelled: ${orderId}`);
    return result;
  } catch (error) {
    console.error("[Trading] Failed to cancel order:", error.message);
    throw error;
  }
}

/**
 * Cancel all open orders
 */
export async function cancelAllOrders() {
  const cli = await initializeClient();
  if (!cli) {
    throw new Error("Client not initialized");
  }

  try {
    const result = await cli.cancelAll();
    console.log("[Trading] All orders cancelled");
    return result;
  } catch (error) {
    console.error("[Trading] Failed to cancel all orders:", error.message);
    throw error;
  }
}

/**
 * Get current positions
 */
export async function getPositions() {
  const cli = await initializeClient();
  if (!cli) return [];

  try {
    // Note: Positions are tracked via the rewards API or by tracking fills
    const orders = await cli.getOpenOrders();
    return orders;
  } catch (error) {
    console.error("[Trading] Failed to get positions:", error.message);
    return [];
  }
}

/**
 * Get market info
 */
export async function getMarket(tokenId) {
  const cli = await initializeClient();
  if (!cli) return null;

  try {
    const market = await cli.getMarket(tokenId);
    return market;
  } catch (error) {
    console.error("[Trading] Failed to get market:", error.message);
    return null;
  }
}

/**
 * Get orderbook for a token
 */
export async function getOrderbook(tokenId) {
  const cli = await initializeClient();
  if (!cli) return null;

  try {
    const book = await cli.getOrderBook(tokenId);
    return book;
  } catch (error) {
    console.error("[Trading] Failed to get orderbook:", error.message);
    return null;
  }
}

/**
 * Check if API credentials are configured
 */
export function isConfigured() {
  return (
    TRADING_CONFIG.privateKey &&
    TRADING_CONFIG.privateKey !== "your_private_key_here" &&
    TRADING_CONFIG.apiKey &&
    TRADING_CONFIG.apiKey !== "your_api_key_here" &&
    TRADING_CONFIG.apiSecret &&
    TRADING_CONFIG.apiSecret !== "your_api_secret_here"
  );
}

/**
 * Check if only L1 is configured (can create API keys but not trade)
 */
export function hasL1Auth() {
  return (
    TRADING_CONFIG.privateKey &&
    TRADING_CONFIG.privateKey !== "your_private_key_here"
  );
}
