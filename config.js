export default {
  // Load from Environment Variables
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  AMOUNT_TO_SPEND: parseFloat(process.env.AMOUNT_TO_SPEND) || 0.01,
  SLIPPAGE_BPS: parseInt(process.env.SLIPPAGE_BPS) || 5000,
  PRIORITY_FEE_SOL: parseFloat(process.env.PRIORITY_FEE_SOL) || 0.001,
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com"
};
