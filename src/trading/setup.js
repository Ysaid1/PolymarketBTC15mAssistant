#!/usr/bin/env node
/**
 * Trading Setup Script
 * Run this ONCE to create your Polymarket API credentials
 *
 * Usage:
 * 1. Add your PRIVATE_KEY to .env
 * 2. Run: npm run setup-trading
 * 3. Copy the output credentials to your .env file
 */

import { createOrDeriveApiCredentials, hasL1Auth } from "./polymarketClient.js";
import { TRADING_CONFIG } from "./config.js";

async function main() {
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║         POLYMARKET TRADING SETUP                              ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");
  console.log("");

  // Check if private key is configured
  if (!hasL1Auth()) {
    console.log("❌ ERROR: No private key configured");
    console.log("");
    console.log("To set up trading, you need to:");
    console.log("1. Open your .env file");
    console.log("2. Replace 'your_private_key_here' with your wallet's private key");
    console.log("");
    console.log("To get your private key:");
    console.log("  MetaMask: Settings → Security & Privacy → Export Private Key");
    console.log("  Coinbase Wallet: Settings → Developer Settings → Export Private Key");
    console.log("");
    console.log("⚠️  SECURITY WARNING:");
    console.log("  - NEVER share your private key with anyone");
    console.log("  - Use a wallet with only trading funds (not your main wallet)");
    console.log("  - Start with a small amount to test");
    console.log("");
    process.exit(1);
  }

  // Check if API credentials already exist
  if (
    TRADING_CONFIG.apiKey &&
    TRADING_CONFIG.apiKey !== "your_api_key_here"
  ) {
    console.log("✓ API credentials already configured in .env");
    console.log("");
    console.log("If you want to regenerate credentials, remove the existing ones from .env first.");
    process.exit(0);
  }

  console.log("Creating API credentials from your private key...");
  console.log("(This uses L1 authentication to derive L2 credentials)");
  console.log("");

  try {
    const creds = await createOrDeriveApiCredentials();

    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("✓ SUCCESS! Add these to your .env file:");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");
    console.log(`POLYMARKET_API_KEY=${creds.apiKey}`);
    console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
    console.log(`POLYMARKET_PASSPHRASE=${creds.passphrase}`);
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("");
    console.log("After adding these to .env, you can run the trading bot:");
    console.log("  npm run trade");
    console.log("");
    console.log("Remember to start with DRY_RUN=true for testing!");
    console.log("");
  } catch (error) {
    console.log("");
    console.log("❌ ERROR:", error.message);
    console.log("");
    console.log("Common issues:");
    console.log("  - Invalid private key format (should start with 0x)");
    console.log("  - Wallet not connected to Polymarket before");
    console.log("  - Network issues");
    console.log("");
    process.exit(1);
  }
}

main();
