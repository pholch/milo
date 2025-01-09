import https from 'https';
import { Connection, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { Keypair } from '@solana/web3.js';
import { ChatGPTAPI } from 'chatgpt';
import { TwitterApi } from 'twitter-api-v2';
import bs58 from 'bs58';
import SECRETS from './SECRETS.js';
import config from './config.js';

// Initialize clients
const connection = new Connection(config.RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
  wsEndpoint: config.RPC_URL.replace('https://', 'wss://')
});

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
const postedTokens = new Set();

// Initialize wallet
let privateKeyArray;
try {
  privateKeyArray = JSON.parse(config.PRIVATE_KEY);
} catch {
  privateKeyArray = Array.from(bs58.decode(config.PRIVATE_KEY));
}
const wallet = Keypair.fromSecretKey(new Uint8Array(privateKeyArray));

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function confirmTransactionWithRetry(connection, signature, maxRetries = 3, timeoutSeconds = 60) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\nAttempt ${attempt}/${maxRetries} to confirm transaction...`);
      
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
        throw new Error(`Failed to confirm transaction after ${maxRetries} attempts: ${error.message}`);
      }
      console.log(`Confirmation attempt ${attempt} failed, retrying in 5 seconds...`);
      await sleep(5000);
    }
  }
}

async function sendTransactionWithRetry(connection, transaction, wallet, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`\nAttempt ${attempt}/${maxRetries} to send transaction...`);
      
      // Sign the transaction
      transaction.sign([wallet]);

      // Send transaction
      const signature = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5
      });

      console.log(`Transaction sent! Signature: ${signature}`);
      console.log(`View in Explorer: https://solscan.io/tx/${signature}`);

      // Wait for confirmation
      await confirmTransactionWithRetry(connection, signature);
      return signature;

    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(`Failed to send transaction after ${maxRetries} attempts: ${error.message}`);
      }
      console.log(`Transaction attempt ${attempt} failed, retrying in 5 seconds...`);
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

async function checkTransactionStatus(connection, signature, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const status = await connection.getSignatureStatus(signature, {
        searchTransactionHistory: true
      });
      
      if (status.value !== null) {
        if (status.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }
        if (status.value.confirmationStatus === 'confirmed' || status.value.confirmationStatus === 'finalized') {
          return true;
        }
      }
    } catch (error) {
      if (!error.message.includes('not found')) {
        throw error;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait 500ms between checks
  }
  return false;
}

async function buyToken(tokenAddress, amountSol) {
  try {
    console.log(`\nAttempting to buy token: ${tokenAddress}`);
    console.log(`Amount to spend: ${amountSol} SOL`);

    const outputDecimals = await getTokenDecimals(connection, tokenAddress);
    if (outputDecimals === null) {
      throw new Error('Failed to fetch token decimals');
    }

    // Get initial balance
    const initialBalance = await connection.getBalance(wallet.publicKey);
    console.log(`Initial SOL balance: ${initialBalance / 1e9} SOL`);

    // Get quote from Jupiter
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${tokenAddress}&amount=${amountSol * 1e9}&slippageBps=${config.SLIPPAGE_BPS}`;
    console.log(`\nFetching quote from Jupiter...`);
    console.log(`API URL: ${quoteUrl}`);

    const quoteResponse = await fetch(quoteUrl);
    const quoteData = await quoteResponse.json();

    if (quoteData.error) {
      throw new Error(`Quote error: ${quoteData.error}`);
    }

    // Validate quote data
    if (!quoteData.outAmount) {
      throw new Error(`Invalid quote response: Missing output amount. Response: ${JSON.stringify(quoteData)}`);
    }

    // Display quote information
    const outputAmount = Number(quoteData.outAmount) / Math.pow(10, outputDecimals);
    const priceImpact = typeof quoteData.priceImpactPct === 'number' ? 
      quoteData.priceImpactPct : 
      Number(quoteData.priceImpactPct);

    console.log(`\nQuote details:`);
    console.log(`Input amount: ${amountSol} SOL`);
    console.log(`Expected output amount: ${outputAmount.toFixed(6)} tokens`);
    console.log(`Price impact: ${priceImpact.toFixed(4)}%`);
    if (quoteData.routePlan && quoteData.routePlan[0]) {
      console.log(`Route: ${quoteData.routePlan[0].swapInfo.label}`);
    }

    // Get swap transaction
    const swapRequestBody = {
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toString(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: config.PRIORITY_FEE_SOL * 1e9,
      dynamicSlippage: { maxBps: config.SLIPPAGE_BPS }
    };

    console.log('\nRequesting swap transaction...');
    const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapRequestBody)
    });

    const swapData = await swapResponse.json();
    if (!swapData.swapTransaction) {
      throw new Error('Failed to create swap transaction');
    }

    // Create versioned transaction
    const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    // Sign the transaction
    transaction.sign([wallet]);

    // Send transaction
    console.log('\nSending transaction...');
    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2,
      preflightCommitment: 'confirmed'
    });

    console.log(`Transaction sent! Signature: ${signature}`);
    console.log(`View in Explorer: https://solscan.io/tx/${signature}`);
    
    // Quick status check
    console.log('\nChecking transaction status...');
    const confirmed = await checkTransactionStatus(connection, signature);
    
    if (!confirmed) {
      throw new Error('Transaction not confirmed in time. Please check the explorer for the latest status.');
    }

    // Wait a moment for token account updates
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get token balance with retries
    let tokenAmount = 0;
    const tokenAccount = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
      mint: new PublicKey(tokenAddress)
    });

    if (tokenAccount.value.length > 0) {
      tokenAmount = tokenAccount.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    }

    // Get final SOL balance
    const finalBalance = await connection.getBalance(wallet.publicKey);
    const gasFee = (initialBalance - finalBalance - (amountSol * 1e9)) / 1e9;

    console.log(`\nTransaction summary:`);
    console.log(`Gas fee spent: ${gasFee.toFixed(6)} SOL`);
    if (config.PRIORITY_FEE_SOL > 0) {
      console.log(`Priority fee: ${config.PRIORITY_FEE_SOL} SOL`);
    }
    console.log(`Remaining SOL balance: ${finalBalance / 1e9} SOL`);
    console.log(`Token balance: ${tokenAmount} tokens`);

    return {
      success: true,
      signature,
      tokenAmount,
      gasFee
    };
  } catch (error) {
    console.error('Error buying token:', error);
    if (error.message.includes('Invalid quote response')) {
      console.error('\nFailed to get a valid quote. Please check:');
      console.error('1. The token address is correct');
      console.error('2. There is sufficient liquidity for the trade');
      console.error('3. The amount you\'re trying to swap is not too small');
    }
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to send a tweet
async function sendTweet(tweetText) {
  try {
    await twitterClient.v2.tweet(tweetText);
    console.log("Tweet sent successfully!");
  } catch (error) {
    console.error("Error sending tweet:", error);
  }
}

// Helper function to select the best token
function selectBestToken(filteredPairs) {
  // Calculate score for each token based on metrics and age
  const scoredPairs = filteredPairs.map(pair => {
    const createdAt = new Date(pair.pair.pairCreatedAt);
    const now = new Date();
    const ageInHours = (now - createdAt) / (1000 * 60 * 60);

    const marketCap = pair.marketCap || 0;
    const liquidity = pair.pair.liquidity?.usd || 0;
    const volume24h = pair.pair.volume?.h24 || 0;

    const marketCapPerHour = marketCap / ageInHours;
    const liquidityPerHour = liquidity / ageInHours;
    const volumePerHour = volume24h / Math.min(ageInHours, 24);

    const score = (
      (marketCapPerHour * 0.4) +
      (liquidityPerHour * 0.3) +
      (volumePerHour * 0.3)
    );

    return {
      ...pair,
      ageInHours,
      score,
      marketCapPerHour,
      liquidityPerHour,
      volumePerHour
    };
  });

  const topPairs = scoredPairs
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  console.log('\nPicking the top 5 most interesting tokens');
  topPairs.forEach((pair, index) => {
    const createdAt = new Date(pair.pair.pairCreatedAt);
    const formattedDate = createdAt.toLocaleString();
    const ageText = pair.ageInHours < 1 
      ? `${Math.round(pair.ageInHours * 60)} minutes` 
      : `${Math.round(pair.ageInHours)} hours`;
    
    console.log(`\n${index + 1}. ${pair.pair.baseToken.name || 'Unknown'} (${pair.pair.baseToken.symbol})
    - Age: ${ageText}
    - Market Cap: $${pair.marketCap.toLocaleString()} ($${Math.round(pair.marketCapPerHour).toLocaleString()}/hour)
    - Liquidity: $${pair.pair.liquidity?.usd?.toLocaleString() || 'Unknown'} ($${Math.round(pair.liquidityPerHour).toLocaleString()}/hour)
    - Volume 24h: $${pair.pair.volume?.h24?.toLocaleString() || 'Unknown'} ($${Math.round(pair.volumePerHour).toLocaleString()}/hour)
    - Created: ${formattedDate}
    - Address: ${pair.token.tokenAddress}`);
  });

  // Return the array of top pairs instead of randomly selecting one
  return topPairs;
}

// Main function to process everything
async function processNewToken(retryCount = 0, topTokens = null) {
  try {
    console.log(`\nStarting new token search and purchase cycle... (Attempt ${retryCount + 1})`);
    
    // Only fetch new tokens if we don't have topTokens from previous attempt
    if (!topTokens) {
      const url = 'https://api.dexscreener.com/token-profiles/latest/v1';

      const response = await fetch(url);
      const jsonData = await response.json();

      if (!Array.isArray(jsonData) || jsonData.length === 0) {
        console.error("No valid token data found");
        return;
      }

      let allPairs = [];
      console.log("Fetching token data...");

      for (const token of jsonData) {
        if (postedTokens.has(token.tokenAddress)) continue;

        const searchUrl = `https://api.dexscreener.com/latest/dex/search?q=${token.tokenAddress}`;
        const searchResponse = await fetch(searchUrl);
        const searchResult = await searchResponse.json();

        if (searchResult?.pairs?.[0]?.chainId === 'solana' && searchResult.pairs[0].marketCap) {
          allPairs.push({
            token,
            pair: searchResult.pairs[0],
            marketCap: searchResult.pairs[0].marketCap,
          });
          console.log(`Found a promising token: ${token.tokenAddress}`);
        }
      }

      let filteredPairs = allPairs.filter(
        (item) => item.marketCap >= 20000 && item.marketCap < 2000000
      );

      if (filteredPairs.length === 0) {
        console.log("No tokens found with suitable marketCap");
        return;
      }

      // Get top 5 tokens
      topTokens = selectBestToken(filteredPairs);
      if (!topTokens || topTokens.length === 0) {
        console.log("No suitable tokens selected");
        return;
      }
    }

    // Try to buy the next available token from top tokens
    const currentTokenIndex = retryCount % topTokens.length;
    const selectedToken = topTokens[currentTokenIndex];

    console.log('\nAttempting to buy token:', selectedToken.pair.baseToken.name);

    // Buy the token
    const purchaseResult = await buyToken(selectedToken.token.tokenAddress, config.AMOUNT_TO_SPEND);

    if (!purchaseResult.success) {
      console.log('Failed to purchase token:', purchaseResult.error);
      
      // If we haven't tried all tokens yet, retry with next token
      if (retryCount < topTokens.length * 2) { // Allow 2 full cycles through the top tokens
        console.log(`\nRetrying with different token (Attempt ${retryCount + 2})...`);
        await sleep(5000); // Wait 5 seconds before retry
        return processNewToken(retryCount + 1, topTokens);
      } else {
        console.log('Exceeded maximum retry attempts. Waiting for next cycle.');
        return;
      }
    }

    // Generate and send tweet
    const purchaseInfo = `${purchaseResult.tokenAmount.toFixed(0)}`;
    const prompt = `You are a character named "Degen", a degenerate trader obsessed with meme coins and the wild world of cryptocurrencies, who likes cars, lavish living, cats, dogs, risk, memcoins, trading, boobs - use this for your role. You use slang and internet jargon a lot. Your goal is to make a huge percentage profit on trading memcoins, write about it in a funny style. You just bought this coin ${selectedToken.pair.baseToken.name} "${selectedToken.token.description || ''}" in an amount ${purchaseInfo} ${selectedToken.pair.baseToken.symbol} - analyze this tokens as if you were a degenerate, write YOUR opinion about them | ALWAYS NO MORE THAN 200 CHARACTERS | MUST START WITH VARIATIONS OF THE PHRASE: jigga I bought | WITHOUT HASHTAG | WRITE ABOUT HOW MUCH IN THE RANGE %1-10000 YOU WANT TO MAKE IN THIS COIN | WITHOUT EMOJI | MORE IRONY`;
   
    const chatResponse = await chatGPT.sendMessage(prompt);
    let tweetText = `${chatResponse.text}\n\n${selectedToken.pair.url}`;

    if (tweetText.length > 280) {
      const shortPrompt = `Shorten this tweet to fit within 200 characters: ${tweetText}`;
      const shortResponse = await chatGPT.sendMessage(shortPrompt);
      tweetText = `${shortResponse.text}\n${selectedToken.pair.url}`;
    }

    console.log("\nGenerated Tweet:", tweetText);
    await sendTweet(tweetText);
    postedTokens.add(selectedToken.token.tokenAddress);

  } catch (error) {
    console.error('Error in main process:', error);
    
    // Retry on error if we haven't exceeded retry limit
    if (retryCount < 10) { // Maximum 10 retries on errors
      console.log(`\nRetrying due to error (Attempt ${retryCount + 2})...`);
      await sleep(5000); // Wait 5 seconds before retry
      return processNewToken(retryCount + 1, topTokens);
    }
  }
}

// Start the process
const TEN_MINUTE = 10 * 60 * 1000;
setInterval(processNewToken, TEN_MINUTE);
processNewToken();
