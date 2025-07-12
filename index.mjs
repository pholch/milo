import https from 'https';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import { ChatGPTAPI } from 'chatgpt';
import { TwitterApi } from 'twitter-api-v2';
import bs58 from 'bs58';
import fs from 'fs/promises';
import path from 'path';
import http from 'http';
import SECRETS from './SECRETS.js';
import config from './config.js';

// ========== INTELLIGENT MEME COIN CONFIGURATION ==========
const MEME_CONFIG = {
  // Trading Parameters
  AMOUNT_TO_SPEND: 0.006,
  SLIPPAGE_BPS: 2000,
  PRIORITY_FEE_SOL: 0.0015,
  
  // Portfolio Management
  MAX_POSITIONS: 20,
  MIN_POSITION_VALUE_EUR: 1.50,
  
  // Intelligent Trailing Stop-Loss System
  TRAILING_STOP: {
    GRACE_PERIOD_HOURS: 6,
    INITIAL_STOP_PERCENT: -70,
    LEVELS: [
      { profitThreshold: 30, stopLoss: -10 },
      { profitThreshold: 80, stopLoss: 20 },
      { profitThreshold: 150, stopLoss: 60 },
      { profitThreshold: 300, stopLoss: 120 },
      { profitThreshold: 600, stopLoss: 250 },
      { profitThreshold: 1000, stopLoss: 400 },
      { profitThreshold: 2000, stopLoss: 800 }
    ],
    VOLATILITY_BUFFER: 15,
    WEEKEND_MULTIPLIER: 1.3,
    NIGHT_MULTIPLIER: 1.2,
  },
  
  // Market Cap Filters
  MIN_MARKET_CAP: 50000,
  MAX_MARKET_CAP: 1000000,
  MIN_LIQUIDITY: 15000,
  
  // Performance Tracking
  PERFORMANCE_LOG_ENABLED: true,
  TARGET_WIN_RATE: 45,
  
  // Risk Management
  MIN_WALLET_RESERVE: 0.05,
  MAX_DAILY_TRADES: 10,
  
  // Professional Logging System
  LOGGING: {
    SNAPSHOT_INTERVAL_MINUTES: 15,
    BACKUP_RETENTION_DAYS: 30,
    MAX_LOG_FILE_SIZE_MB: 50,
    SOL_PRICE_TRACKING: true,
    GAS_FEE_TRACKING: true,
    FAILED_TX_LOGGING: true
  }
};

// ========== LOGGING SYSTEM SETUP ==========
const LOG_DIR = './logs';
const BACKUP_DIR = './logs/backups';
const LOG_FILES = {
  TRANSACTIONS: path.join(LOG_DIR, 'transactions.json'),
  PORTFOLIO: path.join(LOG_DIR, 'portfolio.json'),
  SNAPSHOTS: path.join(LOG_DIR, 'portfolio_snapshots.json'),
  DAILY_SUMMARY: path.join(LOG_DIR, 'daily_summary.json'),
  FAILED_TRANSACTIONS: path.join(LOG_DIR, 'failed_transactions.json'),
  GAS_TRACKER: path.join(LOG_DIR, 'gas_tracker.json')
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
const portfolioTracker = new Map();
const performanceLog = [];
const dailyTradeCount = new Map();
let totalTrades = 0;
let winningTrades = 0;
let currentSolPrice = 135; // Will be updated

// ========== WALLET SETUP ==========
let privateKeyArray;
try {
  privateKeyArray = JSON.parse(config.PRIVATE_KEY);
} catch {
  privateKeyArray = Array.from(bs58.decode(config.PRIVATE_KEY));
}
const wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));

// ========== PROFESSIONAL LOGGING SYSTEM ==========

// Initialize logging directories
async function initializeLogging() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    console.log('📁 Logging system initialized');
    
    // Initialize empty log files if they don't exist
    for (const [name, filePath] of Object.entries(LOG_FILES)) {
      try {
        await fs.access(filePath);
      } catch {
        if (name === 'SNAPSHOTS') {
          await fs.writeFile(filePath, JSON.stringify({ snapshots: [] }, null, 2));
        } else {
          await fs.writeFile(filePath, JSON.stringify([], null, 2));
        }
        console.log(`📝 Created ${name.toLowerCase()}.json`);
      }
    }
  } catch (error) {
    console.error('❌ Logging initialization failed:', error.message);
  }
}

// Get current SOL price
async function updateSolPrice() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=eur');
    const data = await response.json();
    currentSolPrice = data.solana?.eur || 135;
    return currentSolPrice;
  } catch (error) {
    console.error('Error fetching SOL price:', error.message);
    return currentSolPrice;
  }
}

// Log transaction
async function logTransaction(transactionData) {
  try {
    const transactions = JSON.parse(await fs.readFile(LOG_FILES.TRANSACTIONS, 'utf8'));
    
    const logEntry = {
      id: `tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      sol_price_eur: currentSolPrice,
      ...transactionData
    };
    
    transactions.push(logEntry);
    
    await fs.writeFile(LOG_FILES.TRANSACTIONS, JSON.stringify(transactions, null, 2));
    console.log(`📝 Transaction logged: ${transactionData.action} ${transactionData.token_name}`);
    
    // Check file size and rotate if needed
    await rotateLogFileIfNeeded(LOG_FILES.TRANSACTIONS);
    
  } catch (error) {
    console.error('❌ Transaction logging failed:', error.message);
  }
}

// Log failed transaction
async function logFailedTransaction(failedTxData) {
  if (!MEME_CONFIG.LOGGING.FAILED_TX_LOGGING) return;
  
  try {
    const failedTxs = JSON.parse(await fs.readFile(LOG_FILES.FAILED_TRANSACTIONS, 'utf8'));
    
    const logEntry = {
      id: `fail_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      sol_price_eur: currentSolPrice,
      ...failedTxData
    };
    
    failedTxs.push(logEntry);
    await fs.writeFile(LOG_FILES.FAILED_TRANSACTIONS, JSON.stringify(failedTxs, null, 2));
    console.log(`📝 Failed transaction logged: ${failedTxData.error}`);
    
  } catch (error) {
    console.error('❌ Failed transaction logging error:', error.message);
  }
}

// Log gas fees
async function logGasFee(gasData) {
  if (!MEME_CONFIG.LOGGING.GAS_FEE_TRACKING) return;
  
  try {
    const gasTracker = JSON.parse(await fs.readFile(LOG_FILES.GAS_TRACKER, 'utf8'));
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      gas_fee_sol: gasData.gasFee,
      gas_fee_eur: gasData.gasFee * currentSolPrice,
      priority_fee_sol: gasData.priorityFee || MEME_CONFIG.PRIORITY_FEE_SOL,
      transaction_type: gasData.type,
      signature: gasData.signature,
      network_congestion: gasData.congestion || 'unknown'
    };
    
    gasTracker.push(logEntry);
    await fs.writeFile(LOG_FILES.GAS_TRACKER, JSON.stringify(gasTracker, null, 2));
    
  } catch (error) {
    console.error('❌ Gas tracking failed:', error.message);
  }
}

// Update current portfolio status
async function updatePortfolioLog() {
  try {
    await updatePortfolioTracker();
    
    const positions = Array.from(portfolioTracker.entries()).map(([address, position]) => ({
      token_address: address,
      token_name: position.tokenName,
      token_symbol: position.tokenSymbol,
      entry_date: position.entryDate.toISOString(),
      entry_price: position.entryPrice,
      current_price: position.currentPrice,
      amount_invested_sol: position.amountSol,
      amount_invested_eur: position.amountSol * currentSolPrice,
      current_value_sol: position.currentValue / currentSolPrice,
      current_value_eur: position.currentValue * currentSolPrice,
      token_amount: position.tokenAmount,
      pnl_percent: position.pnlPercent,
      pnl_absolute_sol: (position.currentValue / currentSolPrice) - position.amountSol,
      pnl_absolute_eur: ((position.currentValue / currentSolPrice) - position.amountSol) * currentSolPrice,
      hold_time: position.holdTime,
      highest_pnl: position.highestPnL || position.pnlPercent,
      current_stop_loss: position.currentStopLoss,
      stop_reason: position.stopReason,
      last_updated: position.lastUpdated?.toISOString()
    }));
    
    const totalInvested = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + pos.amountSol, 0);
    
    const totalCurrentValue = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.currentValue / currentSolPrice), 0);
    
    const totalPnLPercent = totalInvested > 0 ? 
      ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0;
    
    const portfolioData = {
      last_updated: new Date().toISOString(),
      sol_price_eur: currentSolPrice,
      total_positions: portfolioTracker.size,
      total_investment_sol: totalInvested,
      total_investment_eur: totalInvested * currentSolPrice,
      current_portfolio_value_sol: totalCurrentValue,
      current_portfolio_value_eur: totalCurrentValue * currentSolPrice,
      total_pnl_percent: totalPnLPercent,
      total_pnl_absolute_sol: totalCurrentValue - totalInvested,
      total_pnl_absolute_eur: (totalCurrentValue - totalInvested) * currentSolPrice,
      win_rate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      total_trades: totalTrades,
      winning_trades: winningTrades,
      positions: positions
    };
    
    await fs.writeFile(LOG_FILES.PORTFOLIO, JSON.stringify(portfolioData, null, 2));
    console.log(`📊 Portfolio updated: ${portfolioTracker.size} positions, ${totalPnLPercent.toFixed(2)}% P&L`);
    
  } catch (error) {
    console.error('❌ Portfolio logging failed:', error.message);
  }
}

// Create 15-minute portfolio snapshots
async function createPortfolioSnapshot() {
  try {
    const snapshots = JSON.parse(await fs.readFile(LOG_FILES.SNAPSHOTS, 'utf8'));
    
    await updatePortfolioTracker();
    await updateSolPrice();
    
    const positions = Array.from(portfolioTracker.entries()).map(([address, position]) => {
      const ageMinutes = (new Date() - position.entryDate) / (1000 * 60);
      return {
        token_address: address.slice(0, 8) + '...',
        token_name: position.tokenName,
        token_symbol: position.tokenSymbol,
        price_usd: position.currentPrice,
        value_sol: position.currentValue / currentSolPrice,
        value_eur: position.currentValue * currentSolPrice,
        pnl_percent: position.pnlPercent,
        age_minutes: Math.round(ageMinutes),
        highest_pnl: position.highestPnL || position.pnlPercent,
        current_stop_loss: position.currentStopLoss
      };
    });
    
    const totalInvested = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + pos.amountSol, 0);
    
    const totalCurrentValue = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.currentValue / currentSolPrice), 0);
    
    const snapshot = {
      timestamp: new Date().toISOString(),
      sol_price_eur: currentSolPrice,
      total_portfolio_value_sol: totalCurrentValue,
      total_portfolio_value_eur: totalCurrentValue * currentSolPrice,
      total_invested_sol: totalInvested,
      total_invested_eur: totalInvested * currentSolPrice,
      pnl_percent: totalInvested > 0 ? ((totalCurrentValue - totalInvested) / totalInvested) * 100 : 0,
      pnl_absolute_sol: totalCurrentValue - totalInvested,
      pnl_absolute_eur: (totalCurrentValue - totalInvested) * currentSolPrice,
      active_positions: portfolioTracker.size,
      total_trades_today: dailyTradeCount.get(getTodayKey()) || 0,
      overall_win_rate: totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0,
      positions: positions
    };
    
    snapshots.snapshots.push(snapshot);
    
    // Keep only last 672 snapshots (7 days * 24 hours * 4 snapshots per hour)
    if (snapshots.snapshots.length > 672) {
      snapshots.snapshots = snapshots.snapshots.slice(-672);
    }
    
    await fs.writeFile(LOG_FILES.SNAPSHOTS, JSON.stringify(snapshots, null, 2));
    console.log(`📸 Portfolio snapshot created: ${portfolioTracker.size} positions, €${(totalCurrentValue * currentSolPrice).toFixed(2)}`);
    
  } catch (error) {
    console.error('❌ Snapshot creation failed:', error.message);
  }
}

// Generate daily summary
async function generateDailySummary() {
  try {
    const today = getTodayKey();
    const transactions = JSON.parse(await fs.readFile(LOG_FILES.TRANSACTIONS, 'utf8'));
    
    // Filter today's transactions
    const todayTx = transactions.filter(tx => 
      tx.timestamp.startsWith(today)
    );
    
    const buyTx = todayTx.filter(tx => tx.action === 'BUY');
    const sellTx = todayTx.filter(tx => tx.action === 'SELL');
    
    const winningTx = sellTx.filter(tx => tx.pnl_percent > 0);
    const losingTx = sellTx.filter(tx => tx.pnl_percent <= 0);
    
    const totalInvested = buyTx.reduce((sum, tx) => sum + tx.amount_sol, 0);
    const totalReturned = sellTx.reduce((sum, tx) => sum + (tx.amount_sol * (1 + tx.pnl_percent / 100)), 0);
    
    const bestPerformer = sellTx.length > 0 ? 
      sellTx.reduce((best, tx) => tx.pnl_percent > best.pnl_percent ? tx : best) : null;
    
    const worstPerformer = sellTx.length > 0 ? 
      sellTx.reduce((worst, tx) => tx.pnl_percent < worst.pnl_percent ? tx : worst) : null;
    
    const summary = {
      date: today,
      timestamp: new Date().toISOString(),
      sol_price_eur: currentSolPrice,
      trades_count: todayTx.length,
      buy_trades: buyTx.length,
      sell_trades: sellTx.length,
      winning_trades: winningTx.length,
      losing_trades: losingTx.length,
      win_rate: sellTx.length > 0 ? (winningTx.length / sellTx.length) * 100 : 0,
      total_invested_sol: totalInvested,
      total_invested_eur: totalInvested * currentSolPrice,
      total_returned_sol: totalReturned,
      total_returned_eur: totalReturned * currentSolPrice,
      net_profit_sol: totalReturned - totalInvested,
      net_profit_eur: (totalReturned - totalInvested) * currentSolPrice,
      net_profit_percent: totalInvested > 0 ? ((totalReturned - totalInvested) / totalInvested) * 100 : 0,
      best_performer: bestPerformer ? {
        token_name: bestPerformer.token_name,
        token_symbol: bestPerformer.token_symbol,
        pnl_percent: bestPerformer.pnl_percent,
        hold_time: bestPerformer.hold_time
      } : null,
      worst_performer: worstPerformer ? {
        token_name: worstPerformer.token_name,
        token_symbol: worstPerformer.token_symbol,
        pnl_percent: worstPerformer.pnl_percent,
        hold_time: worstPerformer.hold_time
      } : null,
      average_hold_time_minutes: sellTx.length > 0 ? 
        sellTx.reduce((sum, tx) => sum + (tx.hold_time_minutes || 0), 0) / sellTx.length : 0,
      gas_fees_total_sol: todayTx.reduce((sum, tx) => sum + (tx.gas_fee || 0), 0)
    };
    
    await fs.writeFile(LOG_FILES.DAILY_SUMMARY, JSON.stringify(summary, null, 2));
    console.log(`📈 Daily summary generated: ${summary.trades_count} trades, ${summary.win_rate.toFixed(1)}% win rate`);
    
    return summary;
    
  } catch (error) {
    console.error('❌ Daily summary generation failed:', error.message);
    return null;
  }
}

// Rotate log files if they get too large
async function rotateLogFileIfNeeded(filePath) {
  try {
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    
    if (fileSizeMB > MEME_CONFIG.LOGGING.MAX_LOG_FILE_SIZE_MB) {
      const timestamp = new Date().toISOString().split('T')[0];
      const fileName = path.basename(filePath, '.json');
      const backupPath = path.join(BACKUP_DIR, `${timestamp}_${fileName}.json`);
      
      await fs.copyFile(filePath, backupPath);
      await fs.writeFile(filePath, JSON.stringify([], null, 2));
      
      console.log(`🔄 Rotated ${fileName}.json (${fileSizeMB.toFixed(1)}MB)`);
    }
  } catch (error) {
    console.error('❌ Log rotation failed:', error.message);
  }
}

// Cleanup old backups
async function cleanupOldBackups() {
  try {
    const files = await fs.readdir(BACKUP_DIR);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MEME_CONFIG.LOGGING.BACKUP_RETENTION_DAYS);
    
    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stats = await fs.stat(filePath);
      
      if (stats.mtime < cutoffDate) {
        await fs.unlink(filePath);
        console.log(`🗑️ Deleted old backup: ${file}`);
      }
    }
  } catch (error) {
    console.error('❌ Backup cleanup failed:', error.message);
  }
}

// ========== UTILITY FUNCTIONS ==========
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getCurrentHourUTC() {
  return new Date().getUTCHours();
}

function isWeekend() {
  const day = new Date().getUTCDay();
  return day === 0 || day === 6;
}

function isNightTime() {
  const hour = getCurrentHourUTC();
  return hour >= 22 || hour <= 6;
}

function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

// ========== INTELLIGENT TRAILING STOP LOSS ==========
function calculateTrailingStopLoss(position) {
  const now = new Date();
  const ageInHours = (now - position.entryDate) / (1000 * 60 * 60);
  const currentPnL = position.pnlPercent || 0;
  
  if (ageInHours < MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS) {
    return {
      stopLoss: null,
      reason: `Grace period (${ageInHours.toFixed(1)}h < ${MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS}h)`
    };
  }
  
  let applicableStopLoss = MEME_CONFIG.TRAILING_STOP.INITIAL_STOP_PERCENT;
  let appliedLevel = null;
  
  for (const level of MEME_CONFIG.TRAILING_STOP.LEVELS) {
    if (position.highestPnL >= level.profitThreshold) {
      applicableStopLoss = level.stopLoss;
      appliedLevel = level;
    } else {
      break;
    }
  }
  
  let volatilityMultiplier = 1;
  if (isWeekend()) {
    volatilityMultiplier *= MEME_CONFIG.TRAILING_STOP.WEEKEND_MULTIPLIER;
  }
  if (isNightTime()) {
    volatilityMultiplier *= MEME_CONFIG.TRAILING_STOP.NIGHT_MULTIPLIER;
  }
  
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
  
  if (currentPnL > (position.highestPnL || position.entryPnL || 0)) {
    position.highestPnL = currentPnL;
    position.highestPnLDate = new Date();
    console.log(`📈 New high for ${position.tokenName}: ${currentPnL.toFixed(2)}%`);
  }
  
  const trailingStop = calculateTrailingStopLoss(position);
  position.currentStopLoss = trailingStop.stopLoss;
  position.stopReason = trailingStop.reason;
  
  if (trailingStop.stopLoss !== null && currentPnL <= trailingStop.stopLoss) {
    return {
      shouldSell: true,
      reason: 'TRAILING_STOP',
      details: `Current: ${currentPnL.toFixed(2)}% ≤ Stop: ${trailingStop.stopLoss.toFixed(2)}%`,
      trailingInfo: trailingStop.reason
    };
  }
  
  const ageInDays = (new Date() - position.entryDate) / (1000 * 60 * 60 * 24);
  if (ageInDays > 21 && currentPnL < -50) {
    return {
      shouldSell: true,
      reason: 'AGE_FORCED_EXIT',
      details: `${ageInDays.toFixed(1)} days old with ${currentPnL.toFixed(2)}% loss`
    };
  }
  
  if (position.currentValue < MEME_CONFIG.MIN_POSITION_VALUE_EUR) {
    return {
      shouldSell: true,
      reason: 'POSITION_CLEANUP',
      details: `Value: $${position.currentValue.toFixed(2)} < $${MEME_CONFIG.MIN_POSITION_VALUE_EUR}`
    };
  }
  
  return { shouldSell: false };
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
    
    const holdTimeMs = new Date() - position.entryDate;
    const holdTimeHours = holdTimeMs / (1000 * 60 * 60);
    const holdTimeText = holdTimeHours < 24 ? 
      `${holdTimeHours.toFixed(1)}h` : 
      `${(holdTimeHours/24).toFixed(1)}d`;
    
    portfolioTracker.set(tokenAddress, {
      ...position,
      currentBalance,
      currentPrice,
      currentValue,
      pnlPercent,
      holdTime: holdTimeText,
      lastUpdated: new Date()
    });
    
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
    
    const decimals = position.decimals || 9;
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=So11111111111111111111111111111111111111112&amount=${Math.floor(balance * Math.pow(10, decimals))}&slippageBps=${MEME_CONFIG.SLIPPAGE_BPS}`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();
    
    if (quoteData.error) {
      const failedData = {
        action: 'SELL_QUOTE_FAILED',
        token_address: tokenAddress,
        token_name: position.tokenName,
        error: quoteData.error,
        reason: sellInfo.reason
      };
      await logFailedTransaction(failedData);
      throw new Error(`Sell quote error: ${quoteData.error}`);
    }
    
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
      const failedData = {
        action: 'SELL_SWAP_FAILED',
        token_address: tokenAddress,
        token_name: position.tokenName,
        error: 'Failed to create sell transaction',
        reason: sellInfo.reason
      };
      await logFailedTransaction(failedData);
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
    
    const gasFee = 0.002; // Estimated sell gas fee
    
    // Log the sell transaction
    const sellTxData = {
      action: 'SELL',
      token_address: tokenAddress,
      token_name: position.tokenName,
      token_symbol: position.tokenSymbol,
      amount_sol: position.amountSol,
      tokens_sold: balance,
      entry_price: position.entryPrice,
      exit_price: position.currentPrice,
      gas_fee: gasFee,
      signature: signature,
      pnl_percent: position.pnlPercent,
      pnl_absolute_sol: (position.currentValue / currentSolPrice) - position.amountSol,
      hold_time: holdTimeText,
      hold_time_minutes: Math.round(holdTimeMs / (1000 * 60)),
      sell_reason: sellInfo.reason,
      sell_details: sellInfo.details,
      highest_pnl: position.highestPnL || position.pnlPercent,
      market_cap: position.marketCap || 0,
      trailing_info: sellInfo.trailingInfo
    };
    
    await logTransaction(sellTxData);
    await logGasFee({
      gasFee: gasFee,
      priorityFee: MEME_CONFIG.PRIORITY_FEE_SOL,
      type: 'SELL',
      signature: signature
    });
    
    // Update performance tracking
    if (position.pnlPercent > 0) {
      winningTrades++;
    }
    
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
    
    const failedData = {
      action: 'SELL_EXECUTION_FAILED',
      token_address: tokenAddress,
      token_name: position.tokenName,
      error: error.message,
      reason: sellInfo.reason
    };
    await logFailedTransaction(failedData);
    
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
      await sleep(2000);
    }
  }
  
  console.log(`📊 Portfolio management complete: ${sellActions} sells executed`);
  console.log(`📈 Current portfolio size: ${portfolioTracker.size} positions`);
  
  // Update portfolio log after management
  await updatePortfolioLog();
  
  if (portfolioTracker.size > 0) {
    const totalValue = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.currentValue || 0), 0);
    const avgPnL = Array.from(portfolioTracker.values())
      .reduce((sum, pos) => sum + (pos.pnlPercent || 0), 0) / portfolioTracker.size;
    
    console.log(`💰 Total portfolio value: ${totalValue.toFixed(2)}`);
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
  
  if (solBalance < MEME_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ LOW BALANCE: ${solBalance.toFixed(4)} SOL < ${MEME_CONFIG.MIN_WALLET_RESERVE} SOL reserve`);
    return false;
  }
  
  if (!canTradeToday()) {
    return false;
  }
  
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
    console.log(`💵 Amount: ${amountSol} SOL (~€${(amountSol * currentSolPrice).toFixed(2)})`);

    const outputDecimals = await getTokenDecimals(connection, tokenAddress);
    if (outputDecimals === null) {
      const failedData = {
        action: 'BUY_DECIMALS_FAILED',
        token_address: tokenAddress,
        error: 'Failed to fetch token decimals',
        amount_sol: amountSol
      };
      await logFailedTransaction(failedData);
      throw new Error('Failed to fetch token decimals');
    }

    const initialBalance = await connection.getBalance(wallet.publicKey);
    console.log(`💳 Current SOL balance: ${(initialBalance / 1e9).toFixed(4)} SOL`);

    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${Math.floor(amountSol * 1e9)}&slippageBps=${MEME_CONFIG.SLIPPAGE_BPS}`;
    
    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();

    if (quoteData.error) {
      const failedData = {
        action: 'BUY_QUOTE_FAILED',
        token_address: tokenAddress,
        error: quoteData.error,
        amount_sol: amountSol
      };
      await logFailedTransaction(failedData);
      throw new Error(`Quote error: ${quoteData.error}`);
    }

    if (!quoteData.outAmount) {
      const failedData = {
        action: 'BUY_INVALID_QUOTE',
        token_address: tokenAddress,
        error: 'Invalid quote response',
        amount_sol: amountSol
      };
      await logFailedTransaction(failedData);
      throw new Error(`Invalid quote response`);
    }

    const outputAmount = Number(quoteData.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = typeof quoteData.priceImpactPct === 'number' ? 
      quoteData.priceImpactPct : Number(quoteData.priceImpactPct);

    console.log(`📊 Quote: ${outputAmount.toFixed(6)} tokens | Impact: ${priceImpact.toFixed(2)}% | Route: ${quoteData.routePlan?.[0]?.swapInfo?.label || 'Unknown'}`);

    if (priceImpact > 12) {
      const failedData = {
        action: 'BUY_HIGH_IMPACT',
        token_address: tokenAddress,
        error: `Price impact too high: ${priceImpact.toFixed(2)}%`,
        price_impact: priceImpact,
        amount_sol: amountSol
      };
      await logFailedTransaction(failedData);
      console.log(`⚠️ Price impact too high: ${priceImpact.toFixed(2)}% - skipping`);
      return { success: false, error: 'Price impact too high' };
    }

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
      const failedData = {
        action: 'BUY_SWAP_FAILED',
        token_address: tokenAddress,
        error: 'Failed to create swap transaction',
        amount_sol: amountSol
      };
      await logFailedTransaction(failedData);
      throw new Error('Failed to create swap transaction');
    }

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

    // Log gas fee
    await logGasFee({
      gasFee: gasFee,
      priorityFee: MEME_CONFIG.PRIORITY_FEE_SOL,
      type: 'BUY',
      signature: signature
    });

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
    
    const failedData = {
      action: 'BUY_EXECUTION_FAILED',
      token_address: tokenAddress,
      error: error.message,
      amount_sol: amountSol
    };
    await logFailedTransaction(failedData);
    
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

    const momentumScore = volume5m * 12;
    const liquidityScore = liquidity / Math.max(marketCap, 1) * 100;
    const ageScore = ageInHours < 3 ? 2.0 : ageInHours < 12 ? 1.5 : 1.0;
    const volumeScore = volume24h / Math.max(ageInHours, 1);
    
    const totalScore = (
      (momentumScore * 0.30) +
      (liquidityScore * 0.25) +
      (volumeScore * 0.25) +
      (marketCap * 0.15) +
      (ageScore * 1000 * 0.05)
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
    console.log(`   MC: ${pair.marketCap.toLocaleString()} | Liq: ${pair.pair.liquidity?.usd?.toLocaleString() || '0'}`);
    console.log(`   Vol 24h: ${pair.pair.volume?.h24?.toLocaleString() || '0'} | 5m: ${pair.pair.volume?.m5?.toLocaleString() || '0'}`);
    console.log(`   Momentum: ${Math.round(pair.momentumScore)} | Liq Ratio: ${pair.liquidityScore.toFixed(2)}%`);
  });

  return topPairs;
}

// ========== MAIN TRADING PROCESS ==========
async function processIntelligentTrading(retryCount = 0, topTokens = null) {
  try {
    console.log(`\n🤖 INTELLIGENT MEME TRADING - Cycle ${retryCount + 1}`);
    console.log(`⏰ ${new Date().toLocaleString()} | UTC Hour: ${getCurrentHourUTC()}`);
    
    // Update SOL price
    await updateSolPrice();
    
    const riskCheckPassed = await checkRiskLimits();
    if (!riskCheckPassed) {
      console.log('🛑 Risk check failed - pausing trading');
      return;
    }
    
    if (retryCount % 3 === 0 && portfolioTracker.size > 0) {
      await performIntelligentPortfolioManagement();
    }
    
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
          continue;
        }
      }

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

    const currentTokenIndex = retryCount % topTokens.length;
    const selectedToken = topTokens[currentTokenIndex];

    console.log(`\n🎯 Selected: ${selectedToken.pair.baseToken.name}`);
    console.log(`📊 MC: ${selectedToken.marketCap.toLocaleString()} | Score: ${Math.round(selectedToken.totalScore)}`);

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

    const currentPrice = await getTokenPrice(selectedToken.token.tokenAddress);
    
    // Add to intelligent portfolio tracker
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
      stopReason: 'Grace period active',
      marketCap: selectedToken.marketCap
    });

    // Log the buy transaction
    const buyTxData = {
      action: 'BUY',
      token_address: selectedToken.token.tokenAddress,
      token_name: selectedToken.pair.baseToken.name,
      token_symbol: selectedToken.pair.baseToken.symbol,
      amount_sol: MEME_CONFIG.AMOUNT_TO_SPEND,
      tokens_received: purchaseResult.tokenAmount,
      entry_price: currentPrice,
      gas_fee: purchaseResult.gasFee,
      signature: purchaseResult.signature,
      market_cap: selectedToken.marketCap,
      liquidity: selectedToken.pair.liquidity?.usd || 0,
      price_impact: purchaseResult.priceImpact,
      volume_24h: selectedToken.pair.volume?.h24 || 0,
      total_score: selectedToken.totalScore,
      route: selectedToken.pair.dexId || 'Unknown'
    };
    
    await logTransaction(buyTxData);

    totalTrades++;
    incrementDailyTradeCount();

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
    
    // Update portfolio log after purchase
    await updatePortfolioLog();
    
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

// ========== LOGGING SCHEDULER ==========
function startLoggingScheduler() {
  // Portfolio snapshots every 15 minutes
  const snapshotInterval = MEME_CONFIG.LOGGING.SNAPSHOT_INTERVAL_MINUTES * 60 * 1000;
  setInterval(createPortfolioSnapshot, snapshotInterval);
  
  // Daily summary at midnight UTC
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() < 15) {
      generateDailySummary();
    }
  }, 15 * 60 * 1000); // Check every 15 minutes
  
  // Cleanup old backups weekly
  setInterval(cleanupOldBackups, 7 * 24 * 60 * 60 * 1000);
  
  // Initial snapshot
  setTimeout(createPortfolioSnapshot, 30000); // After 30 seconds
  
  console.log(`📸 Snapshot scheduler started: Every ${MEME_CONFIG.LOGGING.SNAPSHOT_INTERVAL_MINUTES} minutes`);
}

// ========== SIMPLE HTTP SERVER FOR LOG VIEWING ==========
function startLogViewerServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
      if (req.url === '/portfolio') {
        const data = await fs.readFile(LOG_FILES.PORTFOLIO, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/transactions') {
        const data = await fs.readFile(LOG_FILES.TRANSACTIONS, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/snapshots') {
        const data = await fs.readFile(LOG_FILES.SNAPSHOTS, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/daily') {
        const data = await fs.readFile(LOG_FILES.DAILY_SUMMARY, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/failed') {
        const data = await fs.readFile(LOG_FILES.FAILED_TRANSACTIONS, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/gas') {
        const data = await fs.readFile(LOG_FILES.GAS_TRACKER, 'utf8');
        res.writeHead(200);
        res.end(data);
      } else if (req.url === '/status') {
        const status = {
          timestamp: new Date().toISOString(),
          sol_price_eur: currentSolPrice,
          portfolio_size: portfolioTracker.size,
          total_trades: totalTrades,
          win_rate: totalTrades > 0 ? (winningTrades/totalTrades*100) : 0,
          daily_trades: dailyTradeCount.get(getTodayKey()) || 0,
          wallet_address: wallet.publicKey.toString()
        };
        res.writeHead(200);
        res.end(JSON.stringify(status, null, 2));
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({
          message: 'Milo 2.0 Professional Logging API',
          endpoints: [
            '/portfolio - Current portfolio status',
            '/transactions - All transaction history', 
            '/snapshots - 15-minute portfolio snapshots',
            '/daily - Daily summary',
            '/failed - Failed transactions log',
            '/gas - Gas fee tracking',
            '/status - Current bot status'
          ],
          timestamp: new Date().toISOString()
        }, null, 2));
      }
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`🌐 Log viewer server running on port ${port}`);
    console.log(`📊 Access logs at: http://localhost:${port}/portfolio`);
  });
}

// ========== STARTUP ==========
async function startIntelligentMiloBot() {
  console.log('\n🤖 STARTING INTELLIGENT MILO 2.0 WITH PROFESSIONAL LOGGING');
  console.log('================================================================');
  console.log(`💰 Trade Size: ${MEME_CONFIG.AMOUNT_TO_SPEND} SOL (~€${(MEME_CONFIG.AMOUNT_TO_SPEND * 135).toFixed(2)})`);
  console.log(`📊 Max Positions: ${MEME_CONFIG.MAX_POSITIONS} | Daily Limit: ${MEME_CONFIG.MAX_DAILY_TRADES}`);
  console.log(`⚡ Slippage: ${MEME_CONFIG.SLIPPAGE_BPS/100}% | Priority: ${MEME_CONFIG.PRIORITY_FEE_SOL} SOL`);
  console.log(`🎯 MC Range: ${MEME_CONFIG.MIN_MARKET_CAP.toLocaleString()} - ${MEME_CONFIG.MAX_MARKET_CAP.toLocaleString()}`);
  console.log(`🛡️ Intelligent Trailing Stops: Grace ${MEME_CONFIG.TRAILING_STOP.GRACE_PERIOD_HOURS}h | Initial ${MEME_CONFIG.TRAILING_STOP.INITIAL_STOP_PERCENT}%`);
  console.log(`⏰ 24/7 Trading: Active | Weekend Buffer: +${(MEME_CONFIG.TRAILING_STOP.WEEKEND_MULTIPLIER-1)*100}%`);
  console.log(`📝 Professional Logging: ${MEME_CONFIG.LOGGING.SNAPSHOT_INTERVAL_MINUTES}min snapshots | ${MEME_CONFIG.LOGGING.BACKUP_RETENTION_DAYS}d retention`);
  console.log('================================================================\n');
  
  // Initialize logging system
  await initializeLogging();
  
  // Start logging scheduler
  startLoggingScheduler();
  
  // Start log viewer server
  startLogViewerServer();
  
  // Update SOL price
  await updateSolPrice();
  console.log(`💱 Current SOL price: €${currentSolPrice}`);
  
  // Wallet status
  const initialBalance = await connection.getBalance(wallet.publicKey) / 1e9;
  console.log(`💳 SOL Balance: ${initialBalance.toFixed(4)} SOL (€${(initialBalance * currentSolPrice).toFixed(2)})`);
  console.log(`🔑 Wallet: ${wallet.publicKey.toString()}`);
  
  if (initialBalance < MEME_CONFIG.MIN_WALLET_RESERVE) {
    console.log(`⚠️ LOW BALANCE WARNING! Minimum: ${MEME_CONFIG.MIN_WALLET_RESERVE} SOL`);
  }
  
  // Log initial state
  await updatePortfolioLog();
  await createPortfolioSnapshot();
  
  console.log('\n📊 PROFESSIONAL LOGGING ACTIVE:');
  console.log(`📝 Transactions: ${LOG_FILES.TRANSACTIONS}`);
  console.log(`📈 Portfolio: ${LOG_FILES.PORTFOLIO}`);
  console.log(`📸 Snapshots: ${LOG_FILES.SNAPSHOTS} (every ${MEME_CONFIG.LOGGING.SNAPSHOT_INTERVAL_MINUTES}min)`);
  console.log(`📋 Daily Summary: ${LOG_FILES.DAILY_SUMMARY}`);
  console.log(`❌ Failed TXs: ${LOG_FILES.FAILED_TRANSACTIONS}`);
  console.log(`⛽ Gas Tracker: ${LOG_FILES.GAS_TRACKER}`);
  
  // Start trading
  const CYCLE_INTERVAL = 12 * 60 * 1000; // 12 minutes
  console.log(`\n⏱️ Cycle interval: ${CYCLE_INTERVAL/60000} minutes`);
  console.log('🚀 Milo 2.0 with Professional Logging is now live!\n');
  
  // First run
  processIntelligentTrading();
  
  // Scheduled runs
  setInterval(processIntelligentTrading, CYCLE_INTERVAL);
}

// ========== LAUNCH BOT ==========
startIntelligentMiloBot();
