# MILo - Solana Meme Coin Auto-Trader & Twitter Bot

An automated trading bot that identifies promising new meme coins on Solana, purchases them, and posts about them on Twitter with AI-generated content.

## Features

- 🔍 Automatic detection of new Solana tokens via DexScreener
- 📊 Smart token selection based on multiple metrics:
  - Market capitalization
  - Liquidity
  - Trading volume
  - Token age
- 💰 Automated token purchases using Jupiter Aggregator
- 🐦 Automatic tweet generation using ChatGPT
- ⚡ Reliable transaction handling with retry mechanisms

## Prerequisites

- Node.js (v16 or higher)
- A Solana wallet with SOL for trading
- Twitter Developer Account with API access
- ChatGPT API key

## Installation

1. Clone the repository:
```bash
git clone [repository-url]
cd [repository-name]
```

2. Install dependencies:
```bash
npm install
```

3. Edit configuration files:

Edit `SECRETS.js`:
```
  APP_KEY: "your-twitter-app-key",
  APP_SECRET: "your-twitter-app-secret",
  ACCESS_TOKEN: "your-twitter-access-token",
  ACCESS_SECRET: "your-twitter-access-secret",
  CHATGPT_API_KEY: "your-chatgpt-api-key"
```

Edit `config.js`:
```
    // Your wallet's private key (keep this secure!)
    PRIVATE_KEY: "your-wallet-private-key-as-array-or-base58",
    
    // Amount of SOL to spend per trade
    AMOUNT_TO_SPEND: 0.01,
    
    // Slippage tolerance (1 bp = 0.01%, 5000 = 50%)
    SLIPPAGE_BPS: 5000,
    
    // Priority fee in SOL
    PRIORITY_FEE_SOL: 0.001,
    
    // RPC URL (use private RPC for better reliability)
    RPC_URL: "https://api.mainnet-beta.solana.com"
```

## How It Works

### Token Selection Process

1. Fetches latest tokens from DexScreener API
2. Filters tokens based on metrics
3. Calculates growth metrics per hour:
   - Market cap growth rate
   - Liquidity growth rate
   - Volume intensity
4. Ranks tokens based on combined score
5. Randomly selects one from top 5 performers

### Trading Process

1. Gets token decimals and validates token
2. Fetches quote from Jupiter Aggregator
3. Creates and sends swap transaction with:
   - Dynamic compute unit limit
   - Priority fees
   - Dynamic slippage protection
4. Monitors transaction status with retries
5. Verifies token receipt and balance

### Tweet Generation

1. Uses ChatGPT to generate engaging tweet content
2. Includes purchase amount and token details
3. Ensures tweet fits Twitter's character limit
4. Posts tweet with token URL

## Configuration Options

- `AMOUNT_TO_SPEND`: Amount of SOL to spend per trade
- `SLIPPAGE_BPS`: Maximum allowed slippage (in basis points)
- `PRIORITY_FEE_SOL`: Priority fee for faster transaction processing

## Safety Features

- Transaction retry mechanism
- Status verification for transactions
- Error handling and logging
- Duplicate token prevention
- Dynamic slippage protection

## Running the Bot

Start the bot:
```bash
node index.mjs
```

The bot will:
1. Run every 10 minutes
2. Look for new promising tokens
3. Attempt to purchase them
4. Post tweets about successful purchases

## Monitoring

The bot provides detailed console output:
- Token discovery process
- Transaction details
- Purchase confirmations
- Tweet status

## Important Notes

- Keep your private keys and API keys secure
- Monitor your SOL balance
- Test with small amounts first
- Use a private RPC for better reliability
- Consider using a dedicated trading wallet

## Error Handling

The bot handles various error scenarios:
- Transaction failures
- API timeouts
- Invalid tokens
- Insufficient liquidity
- Network issues

## Disclaimer

Trading cryptocurrency is risky. This bot is for educational purposes only. Use at your own risk. Always:
- Test with small amounts first
- Monitor the bot's activity
- Keep your keys secure
- Understand the risks involved 
