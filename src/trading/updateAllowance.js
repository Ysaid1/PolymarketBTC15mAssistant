#!/usr/bin/env node
/**
 * Update Polymarket CLOB allowance via API
 * This just syncs the on-chain allowances to the CLOB system
 */

import "dotenv/config";
import { initializeClient } from "./polymarketClient.js";

async function main() {
  console.log("=== Updating Polymarket CLOB Allowance ===\n");

  const client = await initializeClient();
  if (!client) {
    console.error("Failed to initialize client");
    process.exit(1);
  }

  try {
    // Get current balance/allowance from CLOB
    console.log("Fetching current CLOB balance/allowance...");
    const collateralStatus = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("Current status:", JSON.stringify(collateralStatus, null, 2));

    const balance = Number(collateralStatus?.balance || 0) / 1e6;
    console.log(`\nUSDC Balance on CLOB: $${balance.toFixed(2)}`);

    // Update the allowance on CLOB side
    console.log("\nUpdating CLOB collateral allowance...");
    await client.updateBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("✅ CLOB collateral allowance updated");

    // Check again
    const updatedStatus = await client.getBalanceAllowance({ asset_type: "COLLATERAL" });
    console.log("\nUpdated status:", JSON.stringify(updatedStatus, null, 2));

    const newBalance = Number(updatedStatus?.balance || 0) / 1e6;
    console.log(`\n=== Final Status ===`);
    console.log(`USDC Balance: $${newBalance.toFixed(2)}`);

    if (newBalance > 0) {
      console.log("\n✅ Ready to trade! Balance detected on CLOB.");
    } else {
      console.log("\n⚠️  No balance detected on CLOB.");
      console.log("Make sure you have USDC.e (bridged USDC) in your wallet.");
      console.log("Native USDC needs to be swapped to USDC.e for Polymarket.");
    }

  } catch (error) {
    console.error("Error:", error.message);
    if (error.response?.data) {
      console.error("Response:", JSON.stringify(error.response.data, null, 2));
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
