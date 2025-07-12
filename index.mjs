import https from 'https';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import { ChatGPTAPI } from 'chatgpt';
import { TwitterApi } from 'twitter-api-v2';
import bs58 from 'bs58';
import SECRETS from './SECRETS.js';
import config from './config.js';

// ========== OPTIMIZED CONFIGURATION ==========
const OPTIMIZED_CONFIG = {
  // Trading Parameters
  AMOUNT_TO_SPEND: 0.006, // €8.10 per trade - optimal for diversification
  SLIPPAGE_BPS: 2000, // 20% instead of 50% for better prices
  PRIORITY_FEE_SOL: 0.0015, // Higher priority for faster execution
  
  // Portfolio Management
  MAX_POSITIONS: 20, // Maximum different tokens to hold
  MIN_POSITION_VALUE_EUR: 2, // Cleanup positions below this value
  
  // Risk Management
  STOP_LOSS_PERCENT: -80, // Exit if token drops 80%
  TAKE_PROFIT_PERCENT: 200, // Exit if token gains 200%
  MAX_TOKEN_AGE_DAYS: 14, // Sell stagnant tokens after 14 days
  MIN_WALLET_RESERVE: 0.05, // Keep minimum SOL for fees
  
  // Market Cap Filters (optimized range)
  MIN_MARKET_CAP: 50000, // Increased from 20k to avoid scams
  MAX_MARKET_CAP: 1000000, // Decreased from 2M for better upside
  
  // Trading Schedule (UTC hours when to trade)
  ACTIVE_HOURS: [14, 15, 16, 17, 18, 20, 21, 22, 23], // Peak times
  
  // Performance Tracking
  PERFORMANCE_LOG_ENABLED: true,
  WIN_RATE_TARGET: 40, // Target 40% win rate
};

// ========== ENHANCED CONNECTION ==========
const connection = new Connection(config.RPC_URL || 'https://rpc.ankr.com/solana', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
  wsEndpoint: (config.RPC_URL || 'https://rpc.ankr.com/solana').replace('https://', 'wss://')
});

// ========== TWITTER & AI CLIENTS ==========
const twitterClient = new TwitterApi({
  appKey: SECRETS.APP_KEY,
  appSecret: SECRETS.APP_SECRET,
  accessToken: SECRETS.ACCESS_TOKEN,
  accessSecret: SECRETS.ACCESS_SECRET,
});

const chatGPT = new ChatGPTAPI({ 
  apiKey: SECRETS.CHATGPT_API_KEY,
  model: 'gpt-4'
});

// ========== GLOBAL STATE ==========
const postedTokens = new Set();
const portfolioTracker = new Map(); // Track all positions
const performanceLog = [];
let totalTrades = 0;
let winnigTrades = 0;

// ========== INITIALIZE WALLET ==========
let privateKeyArray;
try {
  privateKeyArray = JSON.parse(config.PRIVATE_KEY);
} catch {
  privateKeyArray = Array.from(bs58.decode(config.PRIVATE_KEY));
}
const wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));

// ========== UTILITY FUNCTIONS ==========
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentHourUTC() {
  return new Date().getUTCHours();
}

function isActiveTradingTime() {
  const currentHour = getCurrentHourUTC();
  return OPTIMIZED_CONFIG.ACTIVE_HOURS.includes(currentHour);
}

function logPerformance(action, tokenAddress, tokenName, entryPrice, currentPrice, pnlPercent) {
  if (!OPTIMIZED_CONFIG.PERFORMANCE_LOG_ENABLED) return;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    tokenAddress,
    tokenName,
    entryPrice,
    currentPrice,
    pnlPercent,
    tradeNumber: totalTrades
  };
  
  performanceLog.push(logEntry);
  console.log(`\n📊 PERFORMANCE LOG - ${action.toUpperCase()}`);
  console.log(`Token: ${tokenName} (${tokenAddress.slice(0,8)}...)`);
  console.log(`Entry: $${entryPrice.toFixed(6)} | Current: $${currentPrice.toFixed(6)}`);
  console.log(`P&L: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
  console.log(`Total Trades: ${totalTrades} | Win Rate: ${(winnigTrades/totalTrades*100).toFixed(1)}%`);
}

// ========== ENHANCED TOKEN BALANCE FUNCTIONS ==========
async function getTokenBalance(tokenAddress) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(tokenAddress)
    });
    
    if (tokenAccounts.value.length > 0) {
      return tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
    }
    return 0;
  } catch (error) {
    console.error('Error getting token balance:', error.message);
    return 0;
  }
}

async function getTokenPrice(tokenAddress) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const data = await response.json();
    
    if (data.pairs && data.pairs.length > 0) {
      return parseFloat(data.pairs[0].priceUsd) || 0;
    }
    return 0;
  } catch (error) {
    console.error('Error getting token price:', error.message);
    return 0;
  }
}

// ========== PORTFOLIO MANAGEMENT ==========
async function updatePortfolioTracker() {
  console.log('\n🔄 Updating portfolio tracker...');
  
  for (const [tokenAddress, position] of portfolioTracker) {
    const currentBalance = await getTokenBalance(tokenAddress);
    const currentPrice = await getTokenPrice(tokenAddress);
    const currentValue = currentBalance * currentPrice;
    const pnlPercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    
    portfolioTracker.set(tokenAddress, {
      ...position,
      currentBalance,
      currentPrice,
      currentValue,
      pnlPercent,
      lastUpdated: new Date()
    });
    
    console.log(`📈 ${position.tokenName}: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}% | $${currentValue.toFixed(2)}`);
  }
}

async function shouldSellToken(tokenAddress, position) {
  const daysSinceEntry = (new Date() - position.entryDate) / (1000 * 60 * 60 * 24);
  
  // Stop Loss - Token dropped 80%
  if (position.pnlPercent <= OPTIMIZED_CONFIG.STOP_LOSS_PERCENT) {
    console.log(`🔴 STOP LOSS triggered for ${position.tokenName}: ${position.pnlPercent.toFixed(2)}%`);
    return { shouldSell: true, reason: 'STOP_LOSS' };
  }
  
  // Take Profit - Token gained 200%
  if (position.pnlPercent >= OPTIMIZED_CONFIG.TAKE_PROFIT_PERCENT) {
    console.log(`🟢 TAKE PROFIT triggered for ${position.tokenName}: ${position.pnlPercent.toFixed(2)}%`);
    return { shouldSell: true, reason: 'TAKE_PROFIT' };
  }
  
  // Age-based exit - Token older than 14 days with poor performance
  if (daysSinceEntry > OPTIMIZED_CONFIG.MAX_TOKEN_AGE_DAYS && position.pnlPercent < 0) {
    console.log(`🕐 AGE EXIT triggered for ${position.tokenName}: ${daysSinceEntry.toFixed(1)} days old`);
    return { shouldSell: true, reason: 'AGE_EXIT' };
  }
  
  // Value-based cleanup - Position worth less than €2
  if (position.currentValue < OPTIMIZED_CONFIG.MIN_POSITION_VALUE_EUR) {
    console.log(`🧹 CLEANUP triggered for ${position.tokenName}: $${position.currentValue.toFixed(2)}`);
    return { shouldSell: true, reason: 'CLEANUP' };
  }
  
  return { shouldSell: false, reason: null };
}

async function sellToken(tokenAddress, position, reason) {
  try {
    console.log(`\n💰 Selling ${position.tokenName} - Reason: ${reason}`);
    
    const balance = await getTokenBalance(tokenAddress);
    if (balance <= 0) {
      console.log('No balance to sell');
      return { success: false, error: 'No balance' };
    }
    
    // Get quote for selling
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${Math.floor(balance * Math.pow(10, position.decimals || 9))}&slippageBps=${OPTIMIZED_CONFIG.SLIPPAGE_BPS}`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();
    
    if (quoteData.error) {
      throw new Error(`Sell quote error: ${quoteData.error}`);
    }
    
    // Execute sell transaction (similar to buy logic)
    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toString(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: OPTIMIZED_CONFIG.PRIORITY_FEE_SOL * 1e9,
      dynamicSlippage: { maxBps: OPTIMIZED_CONFIG.SLIPPAGE_BPS }
    };
    
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapRequestBody)
    });
    
    const swapData = await swapResponse.json();
    if (!swapData.swapTransaction) {
      throw new Error('Failed to create sell transaction');
    }
    
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'confirmed'
    });
    
    console.log(`✅ Sell transaction sent: ${signature}`);
    
    // Update performance tracking
    if (position.pnlPercent > 0) {
      winnigTrades++;
    }
    
    logPerformance('SELL', tokenAddress, position.tokenName, position.entryPrice, position.currentPrice, position.pnlPercent);
    
    // Remove from portfolio tracker
    portfolioTracker.delete(tokenAddress);
    
    return { success: true, signature, pnl: position.pnlPercent };
    
  } catch (error) {
    console.error('Error selling token:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== PORTFOLIO CLEANUP ==========
async function performPortfolioCleanup() {
  console.log('\n🧹 Performing portfolio cleanup...');
  
  await updatePortfolioTracker();
  
  for (const [tokenAddress, position] of portfolioTracker) {
    const { shouldSell, reason } = await shouldSellToken(tokenAddress, position);
    
    if (shouldSell) {
      await sellToken(tokenAddress, position, reason);
      await sleep(2000); // Wait between sells
    }
  }
  
  console.log(`📊 Portfolio size after cleanup: ${portfolioTracker.size} positions`);
}

// ========== RISK MANAGEMENT ==========
async function checkRiskLimits() {
  const solBalance = await connection.getBalance(wallet.publicKey) / 1e9;
  
  // Check minimum wallet reserve
  if (solBalance < OPTIMIZED_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ LOW BALANCE WARNING: ${solBalance.toFixed(4)} SOL remaining`);
    console.log(`Trading paused - minimum reserve: ${OPTIMIZED_CONFIG.MIN_WALLET_RESERVE} SOL`);
    return false;
  }
  
  // Check maximum positions
  if (portfolioTracker.size >= OPTIMIZED_CONFIG.MAX_POSITIONS) {
    console.log(`⚠️ MAX POSITIONS REACHED: ${portfolioTracker.size}/${OPTIMIZED_CONFIG.MAX_POSITIONS}`);
    console.log('Performing cleanup before new trades...');
    await performPortfolioCleanup();
    
    if (portfolioTracker.size >= OPTIMIZED_CONFIG.MAX_POSITIONS) {
      console.log('Still at max positions after cleanup - skipping new trades');
      return false;
    }
  }
  
  return true;
}

// ========== ENHANCED TRANSACTION FUNCTIONS ==========
async function confirmTransactionWithRetry(connection, signature, maxRetries = 3, timeoutSeconds = 60) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\nConfirmation attempt ${attempt}/${maxRetries}...`);
      
      const latestBlockhash = await connection.getLatestBlockhash();
      
      const confirmation = await connection.confirmTransaction({
        signature: signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
      }, 'confirmed');

      if (confirmation?.value?.err) {
        throw new Error(`Transaction failed: ${confirmation.value.err}`);
      }

      return true;
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to confirm after ${maxRetries} attempts: ${error.message}`);
      }
      console.log(`Attempt ${attempt} failed, retrying in 5 seconds...`);
      await sleep(5000);
    }
  }
}

async function getTokenDecimals(connection, mintAddress) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
    return info.value?.data?.parsed?.info?.decimals || null;
  } catch (error) {
    console.error('Error fetching token decimals:', error.message);
    return null;
  }
}

// ========== ENHANCED BUY FUNCTION ==========
async function buyToken(tokenAddress, amountSol) {
  try {
    console.log(`\n💰 Attempting to buy token: ${tokenAddress}`);
    console.log(`Amount to spend: ${amountSol} SOL (€${(amountSol * 135).toFixed(2)})`);

    const outputDecimals = await getTokenDecimals(connection, tokenAddress);
    if (outputDecimals === null) {
      throw new Error('Failed to fetch token decimals');
    }

    // Get initial balance
    const initialBalance = await connection.getBalance(wallet.publicKey);
    console.log(`Initial SOL balance: ${(initialBalance / 1e9).toFixed(4)} SOL`);

    // Get quote from Jupiter with optimized parameters
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${Math.floor(amountSol * 1e9)}&slippageBps=${OPTIMIZED_CONFIG.SLIPPAGE_BPS}`;
    console.log(`\n🔍 Fetching optimized quote from Jupiter...`);

    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();

    if (quoteData.error) {
      throw new Error(`Quote error: ${quoteData.error}`);
    }

    if (!quoteData.outAmount) {
      throw new Error(`Invalid quote response: Missing output amount`);
    }

    const outputAmount = Number(quoteData.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = typeof quoteData.priceImpactPct === 'number' ? 
      quoteData.priceImpactPct : 
      Number(quoteData.priceImpactPct);

    console.log(`\n📊 Quote details:`);
    console.log(`Input: ${amountSol} SOL | Output: ${outputAmount.toFixed(6)} tokens`);
    console.log(`Price Impact: ${priceImpact.toFixed(4)}% | Route: ${quoteData.routePlan?.[0]?.swapInfo?.label || 'Unknown'}`);

    // Check if price impact is reasonable
    if (priceImpact > 15) {
      console.log(`⚠️ HIGH PRICE IMPACT: ${priceImpact.toFixed(2)}% - Skipping trade`);
      return { success: false, error: 'Price impact too high' };
    }

    // Get swap transaction with optimized parameters
    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toString(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(OPTIMIZED_CONFIG.PRIORITY_FEE_SOL * 1e9),
      dynamicSlippage: { maxBps: OPTIMIZED_CONFIG.SLIPPAGE_BPS }
    };

    console.log('\n⚡ Requesting optimized swap transaction...');
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapRequestBody)
    });

    const swapData = await swapResponse.json();
    if (!swapData.swapTransaction) {
      throw new Error('Failed to create swap transaction');
    }

    // Execute transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([wallet]);

    console.log('\n🚀 Sending transaction with high priority...');
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'confirmed'
    });

    console.log(`✅ Transaction sent! Signature: ${signature}`);
    console.log(`🔍 Explorer: https://solscan.io/tx/${signature}`);
    
    // Confirm transaction
    await confirmTransactionWithRetry(connection, signature);
    await sleep(2000);

    // Get final token balance
    let tokenAmount = await getTokenBalance(tokenAddress);
    const finalBalance = await connection.getBalance(wallet.publicKey);
    const gasFee = (initialBalance - finalBalance - (amountSol * 1e9)) / 1e9;

    console.log(`\n📈 Transaction summary:`);
    console.log(`Gas fee: ${gasFee.toFixed(6)} SOL`);
    console.log(`Priority fee: ${OPTIMIZED_CONFIG.PRIORITY_FEE_SOL} SOL`);
    console.log(`Remaining SOL: ${(finalBalance / 1e9).toFixed(4)} SOL`);
    console.log(`Token balance: ${tokenAmount} tokens`);

    return {
      success: true,
      signature,
      tokenAmount,
      gasFee,
      priceImpact,
      outputDecimals
    };
  } catch (error) {
    console.error('❌ Error buying token:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// ========== ENHANCED TOKEN SELECTION ==========
function selectBestTokensOptimized(filteredPairs) {
  console.log('\n🎯 Optimized token selection algorithm...');
  
  const scoredPairs = filteredPairs.map(pair => {
    const createdAt = new Date(pair.pair.pairCreatedAt);
    const now = new Date();
    const ageInHours = (now - createdAt) / (1000 * 60 * 60);

    const marketCap = pair.marketCap || 0;
    const liquidity = pair.pair.liquidity?.usd || 0;
    const volume24h = pair.pair.volume?.h24 || 0;
    const volume5m = pair.pair.volume?.m5 || 0;

    // Enhanced scoring algorithm
    const marketCapPerHour = marketCap / Math.max(ageInHours, 0.1);
    const liquidityPerHour = liquidity / Math.max(ageInHours, 0.1);
    const volumePerHour = volume24h / Math.min(ageInHours, 24);
    const recentVolumeScore = volume5m * 12; // 5min volume * 12 = hourly estimate

    // New factors
    const liquidityRatio = liquidity / marketCap; // Higher is better for trading
    const ageBonus = ageInHours < 2 ? 1.5 : 1; // Bonus for very new tokens
    const volumeConsistency = volume5m > 0 ? 1.2 : 0.8; // Recent activity bonus

    const score = (
      (marketCapPerHour * 0.25) +
      (liquidityPerHour * 0.25) +
      (volumePerHour * 0.20) +
      (recentVolumeScore * 0.15) +
      (liquidityRatio * 10000 * 0.10) + // Normalized liquidity ratio
      (ageBonus * 1000 * 0.05)
    ) * volumeConsistency;

    return {
      ...pair,
      ageInHours,
      score,
      marketCapPerHour,
      liquidityPerHour,
      volumePerHour,
      liquidityRatio,
      ageBonus,
      volumeConsistency
    };
  });

  const topPairs = scoredPairs
    .sort((a, b) => b.score - a.score)
    .slice(0, 3); // Reduced to top 3 for better quality

  console.log('\n🏆 Top 3 optimized token candidates:');
  topPairs.forEach((pair, index) => {
    const createdAt = new Date(pair.pair.pairCreatedAt);
    const ageText = pair.ageInHours < 1 
      ? `${Math.round(pair.ageInHours * 60)}min` 
      : `${Math.round(pair.ageInHours)}h`;
    
    console.log(`\n${index + 1}. ${pair.pair.baseToken.name || 'Unknown'} (${pair.pair.baseToken.symbol})`);
    console.log(`   Age: ${ageText} | Score: ${Math.round(pair.score)}`);
    console.log(`   MC: $${pair.marketCap.toLocaleString()} | Liq: $${pair.pair.liquidity?.usd?.toLocaleString() || '0'}`);
    console.log(`   Vol 24h: $${pair.pair.volume?.h24?.toLocaleString() || '0'} | Vol 5m: $${pair.pair.volume?.m5?.toLocaleString() || '0'}`);
    console.log(`   Liq Ratio: ${(pair.liquidityRatio * 100).toFixed(2)}%`);
    console.log(`   Address: ${pair.token.tokenAddress.slice(0,8)}...`);
  });

  return topPairs;
}

// ========== MAIN ENHANCED PROCESS ==========
async function processNewTokenOptimized(retryCount = 0, topTokens = null) {
  try {
    console.log(`\n🚀 OPTIMIZED Trading Cycle ${retryCount + 1} - ${new Date().toLocaleString()}`);
    
    // Check if it's active trading time
    if (!isActiveTradingTime()) {
      console.log(`⏰ Outside active trading hours (${getCurrentHourUTC()}:00 UTC) - skipping`);
      return;
    }
    
    // Check risk limits
    const riskCheckPassed = await checkRiskLimits();
    if (!riskCheckPassed) {
      console.log('🛑 Risk limits exceeded - skipping trading cycle');
      return;
    }
    
    // Perform portfolio cleanup every 5th cycle
    if (retryCount % 5 === 0 && portfolioTracker.size > 0) {
      await performPortfolioCleanup();
    }
    
    // Fetch new tokens only if we don't have topTokens from previous attempt
    if (!topTokens) {
      console.log('🔍 Fetching latest token data from DexScreener...');
      const url = 'https://api.dexscreener.com/token-profiles/latest/v1';

      const response = await fetch(url);
      const jsonData = await response.json();

      if (!Array.isArray(jsonData) || jsonData.length === 0) {
        console.error("❌ No valid token data found");
        return;
      }

      let allPairs = [];
      console.log(`📊 Processing ${jsonData.length} potential tokens...`);

      for (const token of jsonData) {
        if (postedTokens.has(token.tokenAddress)) continue;
        if (portfolioTracker.has(token.tokenAddress)) continue; // Skip tokens we already own

        const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${token.tokenAddress}`;
        
        try {
          const searchResponse = await fetch(searchUrl);
          const searchResult = await searchResponse.json();

          if (searchResult?.pairs?.[0]?.chainId === 'solana' && searchResult.pairs[0].marketCap) {
            allPairs.push({
              token,
              pair: searchResult.pairs[0],
              marketCap: searchResult.pairs[0].marketCap,
            });
          }
        } catch (error) {
          console.log(`Skipping token due to fetch error: ${token.tokenAddress.slice(0,8)}...`);
        }
      }

      // Apply optimized filters
      let filteredPairs = allPairs.filter(item => {
        return item.marketCap >= OPTIMIZED_CONFIG.MIN_MARKET_CAP && 
               item.marketCap <= OPTIMIZED_CONFIG.MAX_MARKET_CAP &&
               item.pair.liquidity?.usd > 10000; // Minimum liquidity requirement
      });

      console.log(`✅ Found ${filteredPairs.length} tokens matching optimized criteria`);

      if (filteredPairs.length === 0) {
        console.log("📊 No tokens found with suitable criteria - waiting for next cycle");
        return;
      }

      // Get top tokens using optimized selection
      topTokens = selectBestTokensOptimized(filteredPairs);
      if (!topTokens || topTokens.length === 0) {
        console.log("🎯 No suitable tokens selected after optimization");
        return;
      }
    }

    // Try to buy the next available token from top tokens
    const currentTokenIndex = retryCount % topTokens.length;
    const selectedToken = topTokens[currentTokenIndex];

    console.log(`\n🎯 Attempting to buy: ${selectedToken.pair.baseToken.name}`);
    console.log(`📊 Token metrics: MC $${selectedToken.marketCap.toLocaleString()} | Score: ${Math.round(selectedToken.score)}`);

    // Buy the token with optimized amount
    const purchaseResult = await buyToken(selectedToken.token.tokenAddress, OPTIMIZED_CONFIG.AMOUNT_TO_SPEND);

    if (!purchaseResult.success) {
      console.log(`❌ Failed to purchase token: ${purchaseResult.error}`);
      
      // If we haven't tried all tokens yet, retry with next token
      if (retryCount < topTokens.length * 2) {
        console.log(`🔄 Retrying with different token (Attempt ${retryCount + 2})...`);
        await sleep(3000);
        return processNewTokenOptimized(retryCount + 1, topTokens);
      } else {
        console.log('⚠️ Exceeded maximum retry attempts. Waiting for next cycle.');
        return;
      }
    }

    // Add to portfolio tracker
    const currentPrice = await getTokenPrice(selectedToken.token.tokenAddress);
    portfolioTracker.set(selectedToken.token.tokenAddress, {
      tokenName: selectedToken.pair.baseToken.name,
      tokenSymbol: selectedToken.pair.baseToken.symbol,
      entryDate: new Date(),
      entryPrice: currentPrice,
      amountSol: OPTIMIZED_CONFIG.AMOUNT_TO_SPEND,
      tokenAmount: purchaseResult.tokenAmount,
      decimals: purchaseResult.outputDecimals,
      signature: purchaseResult.signature,
      gasFee: purchaseResult.gasFee,
      priceImpact: purchaseResult.priceImpact
    });

    // Update performance tracking
    totalTrades++;
    logPerformance('BUY', selectedToken.token.tokenAddress, selectedToken.pair.baseToken.name, currentPrice, currentPrice, 0);

    // Generate and send tweet (if enabled)
    if (SECRETS.CHATGPT_API_KEY && SECRETS.APP_KEY) {
      try {
        const purchaseInfo = `${Math.floor(purchaseResult.tokenAmount)}`;
        const prompt = `You are "Milo", an AI trading bot. You just bought ${selectedToken.pair.baseToken.name} (${purchaseInfo} ${selectedToken.pair.baseToken.symbol}). Write a short tweet about this purchase - be confident but not overhyped. Include the token name and amount. Keep it under 200 characters and professional.`;
       
        const chatResponse = await chatGPT.sendMessage(prompt);
        let tweetText = `${chatResponse.text}\n\n${selectedToken.pair.url}`;

        if (tweetText.length > 280) {
          tweetText = `Just bought ${purchaseInfo} ${selectedToken.pair.baseToken.symbol} - ${selectedToken.pair.baseToken.name}. Smart money moves. 🚀\n\n${selectedToken.pair.url}`;
        }

        console.log("\n🐦 Generated Tweet:", tweetText);
        await twitterClient.v2.tweet(tweetText);
        console.log("✅ Tweet sent successfully!");
      } catch (error) {
        console.log("❌ Tweet generation/sending failed:", error.message);
      }
    }

    postedTokens.add(selectedToken.token.tokenAddress);
    
    console.log(`\n🎉 SUCCESS! Token purchase completed`);
    console.log(`📊 Portfolio size: ${portfolioTracker.size} positions`);
    console.log(`📈 Total trades: ${totalTrades} | Win rate: ${(winnigTrades/totalTrades*100).toFixed(1)}%`);

  } catch (error) {
    console.error('❌ Error in optimized trading process:', error.message);
    
    // Retry on error if we haven't exceeded retry limit
    if (retryCount < 5) {
      console.log(`🔄 Retrying due to error (Attempt ${retryCount + 2})...`);
      await sleep(5000);
      return processNewTokenOptimized(retryCount + 1, topTokens);
    }
  }
}

// ========== ENHANCED STARTUP ==========
async function startOptimizedMilo() {
  console.log('\n🤖 STARTING OPTIMIZED MILO TRADING BOT');
  console.log('=========================================');
  console.log(`💰 Trade Size: ${OPTIMIZED_CONFIG.AMOUNT_TO_SPEND} SOL (~€${(OPTIMIZED_CONFIG.AMOUNT_TO_SPEND * 135).toFixed(2)})`);
  console.log(`📊 Max Positions: ${OPTIMIZED_CONFIG.MAX_POSITIONS}`);
  console.log(`⚡ Slippage: ${OPTIMIZED_CONFIG.SLIPPAGE_BPS/100}% | Priority Fee: ${OPTIMIZED_CONFIG.PRIORITY_FEE_SOL} SOL`);
  console.log(`🎯 Market Cap Range: $${OPTIMIZED_CONFIG.MIN_MARKET_CAP.toLocaleString()} - $${OPTIMIZED_CONFIG.MAX_MARKET_CAP.toLocaleString()}`);
  console.log(`⏰ Active Hours: ${OPTIMIZED_CONFIG.ACTIVE_HOURS.join(', ')} UTC`);
  console.log('=========================================\n');
  
  // Initial wallet check
  const initialBalance = await connection.getBalance(wallet.publicKey) / 1e9;
  console.log(`💳 Current SOL Balance: ${initialBalance.toFixed(4)} SOL`);
  console.log(`🚀 Wallet Address: ${wallet.publicKey.toString()}`);
  
  if (initialBalance < OPTIMIZED_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ WARNING: Low balance! Minimum recommended: ${OPTIMIZED_CONFIG.MIN_WALLET_RESERVE} SOL`);
  }
  
  // Start the enhanced trading loop
  const ENHANCED_INTERVAL = 12 * 60 * 1000; // 12 minutes for better timing
  console.log(`⏱️ Trading cycle: Every ${ENHANCED_INTERVAL/60000} minutes`);
  
  // Run immediately
  processNewTokenOptimized();
  
  // Then run on interval
  setInterval(processNewTokenOptimized, ENHANCED_INTERVAL);
}

// ========== START THE OPTIMIZED BOT ==========
startOptimizedMilo();
