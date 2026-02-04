#!/usr/bin/env node
/**
 * Check Polymarket balance and allowance
 */

import "dotenv/config";
import { initializeClient } from "./polymarketClient.js";

async function main() {
  console.log("Checking Polymarket balance and allowance...\n");

  const client = await initializeClient();
  if (!client) {
    console.log("Failed to initialize client");
    process.exit(1);
  }

  try {
    const balanceAllowance = await client.getBalanceAllowance();
    console.log("Balance/Allowance Response:");
    console.log(JSON.stringify(balanceAllowance, null, 2));

    // Parse the values
    const balance = Number(balanceAllowance?.balance || 0) / 1e6; // USDC has 6 decimals
    const allowance = Number(balanceAllowance?.allowance || 0) / 1e6;

    console.log("\n=== Summary ===");
    console.log(`USDC Balance: $${balance.toFixed(2)}`);
    console.log(`USDC Allowance: $${allowance.toFixed(2)}`);

    if (allowance < balance) {
      console.log("\n⚠️  WARNING: Allowance is less than balance!");
      console.log("You need to approve the Polymarket contract to spend your USDC.");
      console.log("\nTo fix this:");
      console.log("1. Go to polymarket.com");
      console.log("2. Try to place a manual trade on any market");
      console.log("3. This will prompt you to approve USDC spending");
      console.log("4. Or go to Settings > Trading and look for 'Enable Trading'");
    } else {
      console.log("\n✓ Allowance is sufficient for trading");
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

main();
