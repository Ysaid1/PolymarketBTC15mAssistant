#!/usr/bin/env node
/**
 * Check open orders and positions on Polymarket CLOB
 */

import "dotenv/config";
import { initializeClient } from "./polymarketClient.js";

async function main() {
  console.log("=== Checking Polymarket Positions ===\n");

  const client = await initializeClient();

  // Check balance
  console.log("--- Balance ---");
  const balance = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
  console.log(`USDC Balance: $${(Number(balance.balance) / 1e6).toFixed(2)}`);

  // Check open orders
  console.log("\n--- Open Orders ---");
  try {
    const openOrders = await client.getOpenOrders();
    if (openOrders && openOrders.length > 0) {
      for (const order of openOrders) {
        console.log(`  ${order.side} ${order.size} @ ${order.price} (ID: ${order.id?.slice(0, 10)}...)`);
      }
    } else {
      console.log("  No open orders");
    }
  } catch (e) {
    console.log(`  Error fetching orders: ${e.message}`);
  }

  // Check trades/fills
  console.log("\n--- Recent Trades ---");
  try {
    const trades = await client.getTrades();
    if (trades && trades.length > 0) {
      for (const trade of trades.slice(0, 10)) {
        const time = new Date(trade.timestamp || trade.created_at).toLocaleString();
        console.log(`  ${trade.side} ${trade.size} @ ${trade.price} - ${time}`);
      }
    } else {
      console.log("  No recent trades");
    }
  } catch (e) {
    console.log(`  Error fetching trades: ${e.message}`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
