import https from 'https';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import { ChatGPTAPI } from 'chatgpt';
import { TwitterApi } from 'twitter-api-v2';
import bs58 from 'bs58';
import SECRETS from './SECRETS.js';
import config from './config.js';

// ========== INTELLIGENT MEME COIN CONFIGURATION ==========
const MEME_CONFIG = {
  // Trading Parameters
  AMOUNT_TO_SPEND: 0.006, // €8.10 per trade
  SLIPPAGE_BPS: 2000, // 20% slippage for meme coins
  PRIORITY_FEE_SOL: 0.0015, // High priority for fast execution
  
  // Portfolio Management
  MAX_POSITIONS: 20, // Maximum different tokens
  MIN_POSITION_VALUE_EUR: 1.50, // Cleanup very small positions
  
  // Intelligent Trailing Stop-Loss System
  TRAILING_STOP: {
    // Initial grace period - no stop loss for new positions
    GRACE_PERIOD_HOURS: 6, // Let meme coins develop for 6 hours
    
    // Initial stop-loss after grace period
    INITIAL_STOP_PERCENT: -70, // -70% stop loss after grace period
    
    // Trailing stop levels - when to move stop loss up
    LEVELS: [
      { profitThreshold: 30, stopLoss: -10 },   // At +30%, stop at -10%
      { profitThreshold: 80, stopLoss: 20 },    // At +80%, stop at +20%
      { profitThreshold: 150, stopLoss: 60 },   // At +150%, stop at +60%
      { profitThreshold: 300, stopLoss: 120 },  // At +300%, stop at +120%
      { profitThreshold: 600, stopLoss: 250 },  // At +600%, stop at +250%
      { profitThreshold: 1000, stopLoss: 400 }, // At +1000%, stop at +400%
      { profitThreshold: 2000, stopLoss: 800 }  // At +2000%, stop at +800%
    ],
    
    // Volatility buffer - don't trigger on small dips
    VOLATILITY_BUFFER: 15, // Allow 15% dip from peak before triggering
    
    // Time-based adjustments
    WEEKEND_MULTIPLIER: 1.3, // 30% more buffer on weekends (less liquidity)
    NIGHT_MULTIPLIER: 1.2,   // 20% more buffer during night hours (low volume)
  },
  
  // Market Cap Filters
  MIN_MARKET_CAP: 50000, // $50k minimum
  MAX_MARKET_CAP: 1000000, // $1M maximum
  MIN_LIQUIDITY: 15000, // $15k minimum liquidity
  
  // Performance Tracking
  PERFORMANCE_LOG_ENABLED: true,
  TARGET_WIN_RATE: 45, // Target 45% win rate
  
  // Risk Management
  MIN_WALLET_RESERVE: 0.05, // Keep 0.05 SOL for fees
  MAX_DAILY_TRADES: 10, // Limit daily trades to prevent overtrading
};

// ========== CONNECTION SETUP ==========
const connection = new Connection(config.RPC_URL || 'https://rpc.ankr.com/solana', {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
  wsEndpoint: (config.RPC_URL || 'https://rpc.ankr.com/solana').replace('https://', 'wss://')
});

// ========== CLIENT INITIALIZATION ==========
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
const portfolioTracker = new Map(); // Enhanced position tracking
const performanceLog = [];
const dailyTradeCount = new Map(); // Track daily trades
let totalTrades = 0;
let winningTrades = 0;

// ========== WALLET SETUP ==========
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

function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6; // Sunday = 0, Saturday = 6
}

function isNightTime() {
  const hour = getCurrentHourUTC();
  return hour >= 22 || hour <= 6; // 10PM - 6AM UTC
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

// ========== INTELLIGENT TRAILING STOP LOSS ==========
function calculateTrailingStopLoss(position) {
  const now = new Date();
  const ageInHours = (now - position.entryDate) / (1000 * 60 * 60);
  const currentPnL = position.pnlPercent || 0;
  
  // Grace period - no stop loss for new positions
  if (ageInHours < MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS) {
    return {
      stopLoss: null,
      reason: `Grace period (${ageInHours.toFixed(1)}h < ${MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS}h)`
    };
  }
  
  // Find the highest applicable trailing level
  let applicableStopLoss = MEME_CONFIG.TRAILING_STOP.INITIAL_STOP_PERCENT;
  let appliedLevel = null;
  
  for (const level of MEME_CONFIG.TRAILING_STOP.LEVELS) {
    if (position.highestPnL >= level.profitThreshold) {
      applicableStopLoss = level.stopLoss;
      appliedLevel = level;
    } else {
      break; // Levels are ordered, so we can break early
    }
  }
  
  // Apply time-based multipliers for volatility buffer
  let volatilityMultiplier = 1;
  if (isWeekend()) {
    volatilityMultiplier *= MEME_CONFIG.TRAILING_STOP.WEEKEND_MULTIPLIER;
  }
  if (isNightTime()) {
    volatilityMultiplier *= MEME_CONFIG.TRAILING_STOP.NIGHT_MULTIPLIER;
  }
  
  // Add volatility buffer
  const buffer = MEME_CONFIG.TRAILING_STOP.VOLATILITY_BUFFER * volatilityMultiplier;
  const adjustedStopLoss = applicableStopLoss - buffer;
  
  return {
    stopLoss: adjustedStopLoss,
    appliedLevel,
    volatilityMultiplier,
    buffer,
    reason: appliedLevel 
      ? `Trailing at level: +${appliedLevel.profitThreshold}% → ${appliedLevel.stopLoss}% (adjusted: ${adjustedStopLoss.toFixed(1)}%)`
      : `Initial stop: ${adjustedStopLoss.toFixed(1)}% (with ${buffer.toFixed(1)}% buffer)`
  };
}

function shouldSellWithTrailingStop(position) {
  const currentPnL = position.pnlPercent || 0;
  
  // Update highest PnL if current is higher
  if (currentPnL > (position.highestPnL || position.entryPnL || 0)) {
    position.highestPnL = currentPnL;
    position.highestPnLDate = new Date();
    console.log(`📈 New high for ${position.tokenName}: ${currentPnL.toFixed(2)}%`);
  }
  
  // Calculate current trailing stop
  const trailingStop = calculateTrailingStopLoss(position);
  
  // Update position with current stop level for tracking
  position.currentStopLoss = trailingStop.stopLoss;
  position.stopReason = trailingStop.reason;
  
  // Check if we should sell
  if (trailingStop.stopLoss !== null && currentPnL <= trailingStop.stopLoss) {
    return {
      shouldSell: true,
      reason: 'TRAILING_STOP',
      details: `Current: ${currentPnL.toFixed(2)}% ≤ Stop: ${trailingStop.stopLoss.toFixed(2)}%`,
      trailingInfo: trailingStop.reason
    };
  }
  
  // Age-based forced exit for very old positions with poor performance
  const ageInDays = (new Date() - position.entryDate) / (1000 * 60 * 60 * 24);
  if (ageInDays > 21 && currentPnL < -50) {
    return {
      shouldSell: true,
      reason: 'AGE_FORCED_EXIT',
      details: `${ageInDays.toFixed(1)} days old with ${currentPnL.toFixed(2)}% loss`
    };
  }
  
  // Cleanup very small positions
  if (position.currentValue < MEME_CONFIG.MIN_POSITION_VALUE_EUR) {
    return {
      shouldSell: true,
      reason: 'POSITION_CLEANUP',
      details: `Value: $${position.currentValue.toFixed(2)} < $${MEME_CONFIG.MIN_POSITION_VALUE_EUR}`
    };
  }
  
  return { shouldSell: false };
}

// ========== PERFORMANCE TRACKING ==========
function logPerformance(action, tokenAddress, tokenName, entryPrice, currentPrice, pnlPercent, additionalInfo = {}) {
  if (!MEME_CONFIG.PERFORMANCE_LOG_ENABLED) return;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    action,
    tokenAddress,
    tokenName,
    entryPrice,
    currentPrice,
    pnlPercent,
    tradeNumber: totalTrades,
    ...additionalInfo
  };
  
  performanceLog.push(logEntry);
  
  console.log(`\n📊 PERFORMANCE LOG - ${action.toUpperCase()}`);
  console.log(`Token: ${tokenName} (${tokenAddress.slice(0,8)}...)`);
  if (entryPrice && currentPrice) {
    console.log(`Entry: $${entryPrice.toFixed(6)} | Current: $${currentPrice.toFixed(6)}`);
  }
  if (pnlPercent !== undefined) {
    console.log(`P&L: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%`);
  }
  if (additionalInfo.holdTime) {
    console.log(`Hold Time: ${additionalInfo.holdTime}`);
  }
  if (additionalInfo.highestPnL) {
    console.log(`Peak Gain: +${additionalInfo.highestPnL.toFixed(2)}%`);
  }
  console.log(`Total Trades: ${totalTrades} | Win Rate: ${totalTrades > 0 ? (winningTrades/totalTrades*100).toFixed(1) : 0}%`);
}

// ========== TOKEN BALANCE & PRICE FUNCTIONS ==========
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
  console.log('\n🔄 Updating portfolio with intelligent tracking...');
  
  for (const [tokenAddress, position] of portfolioTracker) {
    const currentBalance = await getTokenBalance(tokenAddress);
    const currentPrice = await getTokenPrice(tokenAddress);
    const currentValue = currentBalance * currentPrice;
    const pnlPercent = position.entryPrice > 0 ? 
      ((currentPrice - position.entryPrice) / position.entryPrice) * 100 : 0;
    
    // Calculate hold time
    const holdTimeMs = new Date() - position.entryDate;
    const holdTimeHours = holdTimeMs / (1000 * 60 * 60);
    const holdTimeText = holdTimeHours < 24 ? 
      `${holdTimeHours.toFixed(1)}h` : 
      `${(holdTimeHours/24).toFixed(1)}d`;
    
    // Update position
    portfolioTracker.set(tokenAddress, {
      ...position,
      currentBalance,
      currentPrice,
      currentValue,
      pnlPercent,
      holdTime: holdTimeText,
      lastUpdated: new Date()
    });
    
    // Calculate current trailing stop for display
    const trailingInfo = calculateTrailingStopLoss(position);
    const stopDisplay = trailingInfo.stopLoss !== null ? 
      `Stop: ${trailingInfo.stopLoss.toFixed(1)}%` : 
      'No Stop (Grace)';
    
    console.log(`📈 ${position.tokenName}: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}% | $${currentValue.toFixed(2)} | ${holdTimeText} | ${stopDisplay}`);
  }
}

async function sellToken(tokenAddress, position, sellInfo) {
  try {
    console.log(`\n💰 SELLING ${position.tokenName} - ${sellInfo.reason}`);
    console.log(`📊 ${sellInfo.details}`);
    if (sellInfo.trailingInfo) {
      console.log(`🎯 ${sellInfo.trailingInfo}`);
    }
    
    const balance = await getTokenBalance(tokenAddress);
    if (balance <= 0) {
      console.log('❌ No balance to sell');
      return { success: false, error: 'No balance' };
    }
    
    // Get quote for selling
    const decimals = position.decimals || 9;
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${Math.floor(balance * Math.pow(10, decimals))}&slippageBps=${MEME_CONFIG.SLIPPAGE_BPS}`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();
    
    if (quoteData.error) {
      throw new Error(`Sell quote error: ${quoteData.error}`);
    }
    
    // Execute sell transaction
    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toString(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(MEME_CONFIG.PRIORITY_FEE_SOL * 1e9),
      dynamicSlippage: { maxBps: MEME_CONFIG.SLIPPAGE_BPS }
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
    console.log(`🔍 Explorer: https://solscan.io/tx/${signature}`);
    
    // Calculate final metrics
    const holdTimeMs = new Date() - position.entryDate;
    const holdTimeHours = holdTimeMs / (1000 * 60 * 60);
    const holdTimeText = holdTimeHours < 24 ? 
      `${holdTimeHours.toFixed(1)}h` : 
      `${(holdTimeHours/24).toFixed(1)}d`;
    
    // Update performance tracking
    if (position.pnlPercent > 0) {
      winningTrades++;
    }
    
    logPerformance('SELL', tokenAddress, position.tokenName, 
      position.entryPrice, position.currentPrice, position.pnlPercent, {
        holdTime: holdTimeText,
        highestPnL: position.highestPnL || position.pnlPercent,
        sellReason: sellInfo.reason,
        sellDetails: sellInfo.details
      });
    
    // Remove from portfolio tracker
    portfolioTracker.delete(tokenAddress);
    
    return { 
      success: true, 
      signature, 
      pnl: position.pnlPercent,
      holdTime: holdTimeText 
    };
    
  } catch (error) {
    console.error('❌ Error selling token:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== PORTFOLIO MANAGEMENT ==========
async function performIntelligentPortfolioManagement() {
  console.log('\n🧠 Performing intelligent portfolio management...');
  
  await updatePortfolioTracker();
  
  let sellActions = 0;
  for (const [tokenAddress, position] of portfolioTracker) {
    const sellDecision = shouldSellWithTrailingStop(position);
    
    if (sellDecision.shouldSell) {
      console.log(`\n🎯 Sell signal: ${position.tokenName} - ${sellDecision.reason}`);
      await sellToken(tokenAddress, position, sellDecision);
      sellActions++;
      await sleep(2000); // Pause between sells
    }
  }
  
  console.log(`📊 Portfolio management complete: ${sellActions} sells executed`);
  console.log(`📈 Current portfolio size: ${portfolioTracker.size} positions`);
  
  // Log portfolio summary
  if (portfolioTracker.size > 0) {
    const totalValue = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
    const avgPnL = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.pnlPercent || 0), 0) / portfolioTracker.size;
    
    console.log(`💰 Total portfolio value: $${totalValue.toFixed(2)}`);
    console.log(`📊 Average P&L: ${avgPnL > 0 ? '+' : ''}${avgPnL.toFixed(2)}%`);
  }
}

// ========== DAILY TRADE LIMIT CHECK ==========
function canTradeToday() {
  const today = getTodayKey();
  const todayTrades = dailyTradeCount.get(today) || 0;
  
  if (todayTrades >= MEME_CONFIG.MAX_DAILY_TRADES) {
    console.log(`⚠️ Daily trade limit reached: ${todayTrades}/${MEME_CONFIG.MAX_DAILY_TRADES}`);
    return false;
  }
  
  return true;
}

function incrementDailyTradeCount() {
  const today = getTodayKey();
  const currentCount = dailyTradeCount.get(today) || 0;
  dailyTradeCount.set(today, currentCount + 1);
}

// ========== RISK MANAGEMENT ==========
async function checkRiskLimits() {
  const solBalance = await connection.getBalance(wallet.publicKey) / 1e9;
  
  // Check minimum wallet reserve
  if (solBalance < MEME_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ LOW BALANCE: ${solBalance.toFixed(4)} SOL < ${MEME_CONFIG.MIN_WALLET_RESERVE} SOL reserve`);
    return false;
  }
  
  // Check daily trade limit
  if (!canTradeToday()) {
    return false;
  }
  
  // Check maximum positions
  if (portfolioTracker.size >= MEME_CONFIG.MAX_POSITIONS) {
    console.log(`⚠️ MAX POSITIONS: ${portfolioTracker.size}/${MEME_CONFIG.MAX_POSITIONS}`);
    await performIntelligentPortfolioManagement();
    
    if (portfolioTracker.size >= MEME_CONFIG.MAX_POSITIONS) {
      console.log('Still at max positions after management - skipping new trades');
      return false;
    }
  }
  
  return true;
}

// ========== TRANSACTION FUNCTIONS ==========
async function confirmTransactionWithRetry(connection, signature, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Confirmation attempt ${attempt}/${maxRetries}...`);
      
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
      console.log(`Attempt ${attempt} failed, retrying...`);
      await sleep(3000);
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
    console.log(`💵 Amount: ${amountSol} SOL (~€${(amountSol * 135).toFixed(2)})`);

    const outputDecimals = await getTokenDecimals(connection, tokenAddress);
    if (outputDecimals === null) {
      throw new Error('Failed to fetch token decimals');
    }

    const initialBalance = await connection.getBalance(wallet.publicKey);
    console.log(`💳 Current SOL balance: ${(initialBalance / 1e9).toFixed(4)} SOL`);

    // Get quote from Jupiter
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${Math.floor(amountSol * 1e9)}&slippageBps=${MEME_CONFIG.SLIPPAGE_BPS}`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();

    if (quoteData.error) {
      throw new Error(`Quote error: ${quoteData.error}`);
    }

    if (!quoteData.outAmount) {
      throw new Error(`Invalid quote response`);
    }

    const outputAmount = Number(quoteData.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = typeof quoteData.priceImpactPct === 'number' ? 
      quoteData.priceImpactPct : Number(quoteData.priceImpactPct);

    console.log(`📊 Quote: ${outputAmount.toFixed(6)} tokens | Impact: ${priceImpact.toFixed(2)}% | Route: ${quoteData.routePlan?.[0]?.swapInfo?.label || 'Unknown'}`);

    // Check price impact
    if (priceImpact > 12) {
      console.log(`⚠️ Price impact too high: ${priceImpact.toFixed(2)}% - skipping`);
      return { success: false, error: 'Price impact too high' };
    }

    // Create swap transaction
    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toString(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(MEME_CONFIG.PRIORITY_FEE_SOL * 1e9),
      dynamicSlippage: { maxBps: MEME_CONFIG.SLIPPAGE_BPS }
    };

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

    console.log('🚀 Sending transaction...');
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'confirmed'
    });

    console.log(`✅ Transaction sent: ${signature}`);
    console.log(`🔍 Explorer: https://solscan.io/tx/${signature}`);
    
    await confirmTransactionWithRetry(connection, signature);
    await sleep(2000);

    const tokenAmount = await getTokenBalance(tokenAddress);
    const finalBalance = await connection.getBalance(wallet.publicKey);
    const gasFee = (initialBalance - finalBalance - (amountSol * 1e9)) / 1e9;

    console.log(`✅ Purchase complete! Gas: ${gasFee.toFixed(6)} SOL | Tokens: ${tokenAmount}`);

    return {
      success: true,
      signature,
      tokenAmount,
      gasFee,
      priceImpact,
      outputDecimals
    };
  } catch (error) {
    console.error('❌ Buy error:', error.message);
    return { success: false, error: error.message };
  }
}

// ========== ENHANCED TOKEN SELECTION ==========
function selectBestMemeCoins(filteredPairs) {
  console.log('\n🎯 Intelligent meme coin selection...');
  
  const scoredPairs = filteredPairs.map(pair => {
    const createdAt = new Date(pair.pair.pairCreatedAt);
    const ageInHours = (new Date() - createdAt) / (1000 * 60 * 60);

    const marketCap = pair.marketCap || 0;
    const liquidity = pair.pair.liquidity?.usd || 0;
    const volume24h = pair.pair.volume?.h24 || 0;
    const volume5m = pair.pair.volume?.m5 || 0;

    // Advanced scoring for meme coins
    const momentumScore = volume5m * 12; // Recent activity
    const liquidityScore = liquidity / Math.max(marketCap, 1) * 100; // Liquidity ratio
    const ageScore = ageInHours < 3 ? 2.0 : ageInHours < 12 ? 1.5 : 1.0; // Fresh bonus
    const volumeScore = volume24h / Math.max(ageInHours, 1); // Volume per hour
    
    const totalScore = (
      (momentumScore * 0.30) +      // Recent momentum is key
      (liquidityScore * 0.25) +     // Good liquidity for exits
      (volumeScore * 0.25) +        // Sustained activity
      (marketCap * 0.15) +          // Size matters
      (ageScore * 1000 * 0.05)      // Fresh coin bonus
    );

    return {
      ...pair,
      ageInHours,
      totalScore,
      momentumScore,
      liquidityScore,
      ageScore,
      volumeScore
    };
  });

  const topPairs = scoredPairs
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 3);

  console.log('\n🏆 Top 3 meme coin candidates:');
  topPairs.forEach((pair, index) => {
    const ageText = pair.ageInHours < 1 ? 
      `${Math.round(pair.ageInHours * 60)}min` : 
      `${pair.ageInHours.toFixed(1)}h`;
    
    console.log(`\n${index + 1}. ${pair.pair.baseToken.name || 'Unknown'} (${pair.pair.baseToken.symbol})`);
    console.log(`   Age: ${ageText} | Score: ${Math.round(pair.totalScore)}`);
    console.log(`   MC: $${pair.marketCap.toLocaleString()} | Liq: $${pair.pair.liquidity?.usd?.toLocaleString() || '0'}`);
    console.log(`   Vol 24h: $${pair.pair.volume?.h24?.toLocaleString() || '0'} | 5m: $${pair.pair.volume?.m5?.toLocaleString() || '0'}`);
    console.log(`   Momentum: ${Math.round(pair.momentumScore)} | Liq Ratio: ${pair.liquidityScore.toFixed(2)}%`);
  });

  return topPairs;
}

// ========== MAIN TRADING PROCESS ==========
async function processIntelligentTrading(retryCount = 0, topTokens = null) {
  try {
    console.log(`\n🤖 INTELLIGENT MEME TRADING - Cycle ${retryCount + 1}`);
    console.log(`⏰ ${new Date().toLocaleString()} | UTC Hour: ${getCurrentHourUTC()}`);
    
    // Check risk limits first
    const riskCheckPassed = await checkRiskLimits();
    if (!riskCheckPassed) {
      console.log('🛑 Risk check failed - pausing trading');
      return;
    }
    
    // Portfolio management every 3rd cycle
    if (retryCount % 3 === 0 && portfolioTracker.size > 0) {
      await performIntelligentPortfolioManagement();
    }
    
    // Fetch new tokens if needed
    if (!topTokens) {
      console.log('🔍 Scanning for fresh meme coins...');
      const url = 'https://api.dexscreener.com/token-profiles/latest/v1';

      const response = await fetch(url);
      const jsonData = await response.json();

      if (!Array.isArray(jsonData) || jsonData.length === 0) {
        console.error("❌ No token data found");
        return;
      }

      let allPairs = [];
      console.log(`📊 Analyzing ${jsonData.length} potential meme coins...`);

      for (const token of jsonData) {
        // Skip if already processed or owned
        if (postedTokens.has(token.tokenAddress) || portfolioTracker.has(token.tokenAddress)) {
          continue;
        }

        try {
          const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${token.tokenAddress}`;
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
          // Skip problematic tokens
          continue;
        }
      }

      // Apply intelligent filters
      let filteredPairs = allPairs.filter(item => {
        return item.marketCap >= MEME_CONFIG.MIN_MARKET_CAP && 
               item.marketCap <= MEME_CONFIG.MAX_MARKET_CAP &&
               (item.pair.liquidity?.usd || 0) >= MEME_CONFIG.MIN_LIQUIDITY;
      });

      console.log(`✅ ${filteredPairs.length} meme coins passed filters`);

      if (filteredPairs.length === 0) {
        console.log("📊 No suitable meme coins found - waiting for next cycle");
        return;
      }

      topTokens = selectBestMemeCoins(filteredPairs);
      if (!topTokens || topTokens.length === 0) {
        console.log("🎯 No tokens selected after analysis");
        return;
      }
    }

    // Select token to buy
    const currentTokenIndex = retryCount % topTokens.length;
    const selectedToken = topTokens[currentTokenIndex];

    console.log(`\n🎯 Selected: ${selectedToken.pair.baseToken.name}`);
    console.log(`📊 MC: $${selectedToken.marketCap.toLocaleString()} | Score: ${Math.round(selectedToken.totalScore)}`);

    // Execute purchase
    const purchaseResult = await buyToken(selectedToken.token.tokenAddress, MEME_CONFIG.AMOUNT_TO_SPEND);

    if (!purchaseResult.success) {
      console.log(`❌ Purchase failed: ${purchaseResult.error}`);
      
      if (retryCount < topTokens.length * 2) {
        console.log(`🔄 Trying next token...`);
        await sleep(3000);
        return processIntelligentTrading(retryCount + 1, topTokens);
      } else {
        console.log('⚠️ Max retries reached');
        return;
      }
    }

    // Add to intelligent portfolio tracker
    const currentPrice = await getTokenPrice(selectedToken.token.tokenAddress);
    portfolioTracker.set(selectedToken.token.tokenAddress, {
      tokenName: selectedToken.pair.baseToken.name,
      tokenSymbol: selectedToken.pair.baseToken.symbol,
      entryDate: new Date(),
      entryPrice: currentPrice,
      entryPnL: 0,
      highestPnL: 0,
      highestPnLDate: new Date(),
      amountSol: MEME_CONFIG.AMOUNT_TO_SPEND,
      tokenAmount: purchaseResult.tokenAmount,
      decimals: purchaseResult.outputDecimals,
      signature: purchaseResult.signature,
      gasFee: purchaseResult.gasFee,
      priceImpact: purchaseResult.priceImpact,
      currentStopLoss: null,
      stopReason: 'Grace period active'
    });

    // Update counters
    totalTrades++;
    incrementDailyTradeCount();
    
    logPerformance('BUY', selectedToken.token.tokenAddress, 
      selectedToken.pair.baseToken.name, currentPrice, currentPrice, 0, {
        marketCap: selectedToken.marketCap,
        totalScore: selectedToken.totalScore,
        tradeNumber: totalTrades
      });

    // Generate tweet if configured
    if (SECRETS.CHATGPT_API_KEY && SECRETS.APP_KEY) {
      try {
        const prompt = `You are Milo, an AI trading bot. You just bought ${selectedToken.pair.baseToken.name} (${Math.floor(purchaseResult.tokenAmount)} ${selectedToken.pair.baseToken.symbol}). Write a confident but not overhyped tweet about this meme coin purchase. Keep it under 200 characters and professional.`;
       
        const chatResponse = await chatGPT.sendMessage(prompt);
        let tweetText = `${chatResponse.text}\n\n${selectedToken.pair.url}`;

        if (tweetText.length > 280) {
          tweetText = `Acquired ${Math.floor(purchaseResult.tokenAmount)} ${selectedToken.pair.baseToken.symbol} - ${selectedToken.pair.baseToken.name}. Intelligent selection based on momentum and liquidity analysis. 🎯\n\n${selectedToken.pair.url}`;
        }

        console.log("\n🐦 Posting tweet:", tweetText);
        await twitterClient.v2.tweet(tweetText);
        console.log("✅ Tweet posted successfully!");
      } catch (error) {
        console.log("❌ Tweet failed:", error.message);
      }
    }

    postedTokens.add(selectedToken.token.tokenAddress);
    
    console.log(`\n🎉 PURCHASE COMPLETE!`);
    console.log(`📊 Portfolio: ${portfolioTracker.size} positions | Daily: ${dailyTradeCount.get(getTodayKey()) || 0}/${MEME_CONFIG.MAX_DAILY_TRADES}`);
    console.log(`📈 Win Rate: ${totalTrades > 0 ? (winningTrades/totalTrades*100).toFixed(1) : 0}% (${winningTrades}/${totalTrades})`);

  } catch (error) {
    console.error('❌ Trading process error:', error.message);
    
    if (retryCount < 3) {
      console.log(`🔄 Retrying... (${retryCount + 2})`);
      await sleep(5000);
      return processIntelligentTrading(retryCount + 1, topTokens);
    }
  }
}

// ========== STARTUP ==========
async function startIntelligentMiloBot() {
  console.log('\n🤖 STARTING INTELLIGENT MILO 2.0');
  console.log('=====================================');
  console.log(`💰 Trade Size: ${MEME_CONFIG.AMOUNT_TO_SPEND} SOL (~€${(MEME_CONFIG.AMOUNT_TO_SPEND * 135).toFixed(2)})`);
  console.log(`📊 Max Positions: ${MEME_CONFIG.MAX_POSITIONS} | Daily Limit: ${MEME_CONFIG.MAX_DAILY_TRADES}`);
  console.log(`⚡ Slippage: ${MEME_CONFIG.SLIPPAGE_BPS/100}% | Priority: ${MEME_CONFIG.PRIORITY_FEE_SOL} SOL`);
  console.log(`🎯 MC Range: $${MEME_CONFIG.MIN_MARKET_CAP.toLocaleString()} - $${MEME_CONFIG.MAX_MARKET_CAP.toLocaleString()}`);
  console.log(`🛡️ Intelligent Trailing Stops: Grace ${MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS}h | Initial ${MEME_CONFIG.TRAILING_STOP.INITIAL_STOP_PERCENT}%`);
  console.log(`⏰ 24/7 Trading: Active | Weekend Buffer: +${(MEME_CONFIG.TRAILING_STOP.WEEKEND_MULTIPLIER-1)*100}%`);
  console.log('=====================================\n');
  
  // Wallet status
  const initialBalance = await connection.getBalance(wallet.publicKey) / 1e9;
  console.log(`💳 SOL Balance: ${initialBalance.toFixed(4)} SOL`);
  console.log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  
  if (initialBalance < MEME_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ LOW BALANCE WARNING! Minimum: ${MEME_CONFIG.MIN_WALLET_RESERVE} SOL`);
  }
  
  // Start trading
  const CYCLE_INTERVAL = 12 * 60 * 1000; // 12 minutes
  console.log(`⏱️ Cycle interval: ${CYCLE_INTERVAL/60000} minutes\n`);
  
  // First run
  processIntelligentTrading();
  
  // Scheduled runs
  setInterval(processIntelligentTrading, CYCLE_INTERVAL);
}

// ========== LAUNCH BOT ==========
startIntelligentMiloBot();
