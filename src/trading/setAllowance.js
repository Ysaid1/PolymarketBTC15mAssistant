#!/usr/bin/env node
/**
 * Set Polymarket CLOB allowances
 * This script sets the on-chain token approvals needed for trading
 */

import "dotenv/config";
import { ethers } from "ethers";

const CHAIN_ID = 137;

// Contract addresses on Polygon
const USDC_E_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDC.e - used by Polymarket
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"; // Conditional Token Framework

// Polymarket exchange contracts that need approval
const CTF_EXCHANGE = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const NEG_RISK_ADAPTER = "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296";

// Minimal ABIs
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
];

const ERC1155_ABI = [
  "function setApprovalForAll(address operator, bool approved)",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("=== Polymarket Allowance Setup ===\n");

  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error("PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  // Use StaticJsonRpcProvider to avoid network detection issues
  const provider = new ethers.providers.StaticJsonRpcProvider(
    "https://polygon-bor-rpc.publicnode.com",
    { chainId: 137, name: "polygon" }
  );
  const wallet = new ethers.Wallet(privateKey, provider);
  const address = wallet.address;

  console.log(`Wallet: ${address}`);

  // Check balances
  const maticBalance = await provider.getBalance(address);
  console.log(`POL: ${ethers.utils.formatEther(maticBalance)}`);

  await sleep(500);

  const usdc = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, wallet);
  const usdcBalance = await usdc.balanceOf(address);
  console.log(`USDC.e: $${(Number(usdcBalance) / 1e6).toFixed(2)}`);

  if (usdcBalance.eq(0)) {
    console.log("\n No USDC.e balance. Nothing to approve.");
    return;
  }

  const MAX_UINT256 = ethers.constants.MaxUint256;
  const ctf = new ethers.Contract(CTF_ADDRESS, ERC1155_ABI, wallet);

  // Define all approvals needed
  const approvals = [
    { name: "USDC.e -> CTF Exchange", contract: usdc, spender: CTF_EXCHANGE, isErc20: true },
    { name: "USDC.e -> NegRisk Exchange", contract: usdc, spender: NEG_RISK_CTF_EXCHANGE, isErc20: true },
    { name: "USDC.e -> NegRisk Adapter", contract: usdc, spender: NEG_RISK_ADAPTER, isErc20: true },
    { name: "CTF -> CTF Exchange", contract: ctf, spender: CTF_EXCHANGE, isErc20: false },
    { name: "CTF -> NegRisk Exchange", contract: ctf, spender: NEG_RISK_CTF_EXCHANGE, isErc20: false },
    { name: "CTF -> NegRisk Adapter", contract: ctf, spender: NEG_RISK_ADAPTER, isErc20: false },
  ];

  console.log(`\n=== Setting ${approvals.length} Approvals ===\n`);

  for (const approval of approvals) {
    try {
      console.log(`Approving: ${approval.name}...`);

      // Get current gas prices dynamically - Polygon can have high base fees
      const feeData = await provider.getFeeData();
      console.log(`  Current base fee: ${ethers.utils.formatUnits(feeData.lastBaseFeePerGas || feeData.gasPrice, "gwei")} gwei`);

      // Use a buffer above current prices
      const baseFee = feeData.lastBaseFeePerGas || feeData.gasPrice;
      const gasOptions = {
        maxPriorityFeePerGas: ethers.utils.parseUnits("50", "gwei"),
        maxFeePerGas: baseFee.mul(2), // 2x base fee for safety
        gasLimit: 100000, // Set explicit gas limit
      };

      let tx;
      if (approval.isErc20) {
        tx = await approval.contract.approve(approval.spender, MAX_UINT256, gasOptions);
      } else {
        tx = await approval.contract.setApprovalForAll(approval.spender, true, gasOptions);
      }

      console.log(`  Tx: ${tx.hash}`);
      console.log(`  Waiting for confirmation...`);

      const receipt = await tx.wait();
      console.log(`  Confirmed in block ${receipt.blockNumber}\n`);

      await sleep(2000); // Wait between transactions
    } catch (error) {
      console.error(`  Failed: ${error.message}\n`);
    }
  }

  console.log("=== Done ===");
  console.log("\nNow run: node src/trading/updateAllowance.js");
  console.log("to sync the allowances with the CLOB API.");
}

main().catch(console.error);
