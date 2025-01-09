module.exports = {
    // Your wallet's private key (keep this secure!)
    PRIVATE_KEY: "[00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00,00]",
    
    // Amount of SOL to spend
    AMOUNT_TO_SPEND: 0.01,
    
    // Slippage tolerance in basis points (1 bp = 0.01%, 100 bp = 1%)
    SLIPPAGE_BPS: 5000,
    
    // Priority fee in SOL (optional, set to 0 for default fee)
    PRIORITY_FEE_SOL: 0.001,
    
    // RPC URL (you can use public ones, but private RPC is recommended for better reliability)
    RPC_URL: "https://api.mainnet-beta.solana.com"
} 