import 'dotenv/config';
import RaydiumSwap from './RaydiumSwap';
import { Transaction, VersionedTransaction, Connection, PublicKey, LAMPORTS_PER_SOL, TransactionMessage, Keypair } from "@solana/web3.js";
import spl from "@solana/spl-token";
import { execSync } from 'child_process';
import { Wallet } from '@coral-xyz/anchor'
import axios from 'axios';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Market, TOKEN_PROGRAM_ID, SPL_ACCOUNT_LAYOUT } from "@raydium-io/raydium-sdk";
import bs58 from 'bs58'

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // --> Raydium "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" // --> competitor sniper bot "AupTbxArPau5H97izWurgska1hEvFNrYM1U8Yy9ijrWU"
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(process.env.RPC_URL, {
    wsEndpoint: process.env.WS_URL,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


// ============================
// ===== GLOBAL VARIABLES =====
// ============================

const MY_WALLET = "HDaBHzbsGnUS8tS9cPRsMZ5wEKWR12gZWsiK5XfgdFYD";
const PRIMED_TOKEN_ACCOUNT = new PublicKey("GLwbCu3z1MS922jSVvbCSwkULUfq6btAphJhc2SeCCc4");

let swapConfig = {
  executeSwap: true, // Send tx when true, simulate tx when false
  useVersionedTransaction: true,
  tokenAAmount: 0.0001, // Swap 0.1 SOL for USDC in this example
  tokenBAmount: 0,
  tokenAAddress: "So11111111111111111111111111111111111111112", // Token to swap for the other, SOL in this case
  tokenBAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC address
  maxLamports: .004 * 1000000000 * 8, // Micro lamports for priority fee, .004 = 225000 microLamports for a buy
  direction: "in" as "in" | "out", // Swap direction: 'in' or 'out'
  liquidityFile: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
  maxRetries: 20,
  retryFrequency: 1000,
  sellDelay: 1000,
};

let tradeInProgress = false; // prevents concurrent trade sequences, forces 1 token to be traded at a time
let startingSolBalance;
let tradeCount = 0;
let pingCount = 0;
let transactionAttemptCount = 0;


// ============================
// ===== HELPER FUNCTIONS =====
// ============================

// When first detecting a new listing, we need to have a pre-created tokenAccount ready and funded so that the actual buy transaction goes through faster
async function precreateTokenAccount(poolInfo, solAmount) {
  try {
    const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
    const creationTx = await raydiumSwap.getSwapTransaction(
      swapConfig.tokenBAddress,
      solAmount,
      poolInfo,
      swapConfig.maxLamports,
      swapConfig.useVersionedTransaction,
      swapConfig.direction,
      "precreateAccount",
      null
    );
    const creationTxId: any = swapConfig.useVersionedTransaction // Send the transaction to the network and log the transaction ID.
      ? await raydiumSwap.sendVersionedTransaction(creationTx as VersionedTransaction, swapConfig.maxRetries)
      : await raydiumSwap.sendLegacyTransaction(creationTx as Transaction, swapConfig.maxRetries);
    console.log(`PRE-CREATING TOKENACCOUNT: https://solscan.io/tx/${creationTxId}`);

  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR PRE-CREATING TOKENACCOUNT, RETRYING... ~~~");
  }
}


// Helper function to see my balance of a token
async function checkWalletBalance(tokenMintAddress) {
  try {
    const response = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        new PublicKey(MY_WALLET),
        {
          "mint": tokenMintAddress,
        },
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        },
      ],
    });

    if (response.data.result.value.length > 0) {
      return response.data.result.value[0].account.data.parsed.info.tokenAmount.uiAmount;
    } else {
      return 0;
    }

  } catch (error) {
    throw new Error(`checkWalletBalance Error: ${error}`);
  }
}


// Helper function to get pool info
async function getPoolData(raydiumIdo, raydiumAuthority, openBookMarketAccount) {
  try {

    // First, get liquidity pool info from Raydium
    const idoAccountString = raydiumIdo.toBase58();
    const liquidityResponse = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [
        idoAccountString,
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        }
      ],
    });

    // The response returns a JSON of data in base64. We convert it into a Buffer of Uint8Array for the Raydium library to decode
    const liquidityBinaryString = atob(liquidityResponse.data.result.value.data[0]);
    const liquidityUint8Array = Uint8Array.from(liquidityBinaryString, (char) => char.charCodeAt(0));
    const poolInfo: any = LIQUIDITY_STATE_LAYOUT_V4.decode(Buffer.from(liquidityUint8Array));
    poolInfo.id = raydiumIdo;
    poolInfo.programId = new PublicKey(RAYDIUM_PUBLIC_KEY);
    poolInfo.authority = raydiumAuthority;
    poolInfo.baseDecimals = poolInfo.baseDecimal.toNumber();
    poolInfo.quoteDecimals = poolInfo.quoteDecimal.toNumber();
    poolInfo.version = 4; // MIGHT BREAK?!?
    poolInfo.marketVersion = 4; // MIGHT BREAK?!?

    // Second, get market info from OpenBook
    const marketResponse = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [
        openBookMarketAccount,
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        }
      ],
    });

    // The response returns a JSON of data in base64. We convert it into a Buffer of Uint8Array for the Raydium library to decode
    const marketBinaryString = atob(marketResponse.data.result.value.data[0]);
    const marketUint8Array = Uint8Array.from(marketBinaryString, (char) => char.charCodeAt(0));
    const marketInfo: any = MARKET_STATE_LAYOUT_V3.decode(Buffer.from(marketUint8Array));
    const programId = new PublicKey(poolInfo.marketProgramId.toBase58());
    const marketId = new PublicKey(poolInfo.marketId.toBase58());
    poolInfo.marketAuthority = Market.getAssociatedAuthority({ programId, marketId }).publicKey;
    poolInfo.marketBaseVault = marketInfo.baseVault;
    poolInfo.marketQuoteVault = marketInfo.quoteVault;
    poolInfo.marketBids = marketInfo.bids;
    poolInfo.marketAsks = marketInfo.asks;
    poolInfo.marketEventQueue = marketInfo.eventQueue;

    // With poolInfo stitced together, it is now ready for making the swap!
    return poolInfo;

  } catch (error) {
    throw new Error(`getPoolData Error: ${error}`);
  }
}


// Helper function used in swap() to sell a token
async function sell(poolInfo, listingTime, primedTokenAccount) {
  await refreshBalance();
  console.log("=== SELLING ALL TOKENS NOW, AMOUNT: " + swapConfig.tokenBAddress + " ===");
  await swap(poolInfo, "sell", listingTime, primedTokenAccount);
}


// Helper function used in swap() whenever a successful trade sequence is finished
async function success() {
  console.log("!!! CONTINUING TRADING... !!!");
  tradeInProgress = false;
}


// Helper function used in swap() to get updated token balances
async function refreshBalance() {
  let myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
  swapConfig.tokenBAmount = myTokenBalance;
}


// Close unused tokenAccounts
async function closeOldTokenAccounts(poolInfo) {
  try {
    const walletTokenAccounts = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        new PublicKey(MY_WALLET),
        {
          "programId": TOKEN_PROGRAM_ID,
        },
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        },
      ],
    });

    const accounts = walletTokenAccounts.data.result.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: i.account.data.parsed.info,
    }))

    const wSolAccounts = accounts.filter(ix => ix.accountInfo.mint === "So11111111111111111111111111111111111111112").sort(function(a, b){return b.accountInfo.tokenAmount.uiAmount-a.accountInfo.tokenAmount.uiAmount});

    if (wSolAccounts.length > 1) {
      console.log("Remaining wSOL tokenAccounts: " + wSolAccounts.length);
      const tokenAccount = new PublicKey(wSolAccounts[1].pubkey);
      const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
      const tx = await raydiumSwap.getSwapTransaction( // Prepare the swap transaction with the given parameters.
        swapConfig.tokenBAddress,
        .0001,
        poolInfo,
        swapConfig.maxLamports,
        swapConfig.useVersionedTransaction,
        swapConfig.direction,
        "closeAccount",
        tokenAccount
      );
      const txid: any = swapConfig.useVersionedTransaction // Send the transaction to the network and log the transaction ID.
        ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
        : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);
      console.log(`CLOSED AN OLD TOKENACCOUNT: https://solscan.io/tx/${txid}`);
    }
  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR WITH closeOldTokenAccounts() ~~~");
  }
}


// ==========================
// ===== MAIN APP LOGIC =====
// ==========================


// Performs a token swap on the Raydium protocol. Depending on the configuration, it can execute the swap or simulate it.
async function swap(poolInfo, buyOrSell, listingTime, primedTokenAccount) {
  const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
  let inTokenAmount;
  let inTokenAddress;
  let outTokenAddress;
  if (pingCount >= 600) {
    console.log("~~~ GIVING UP AFTER 600 PINGS ~~~");
    tradeInProgress = false;
    return;
  }
  if (buyOrSell == "buy") {
    inTokenAmount = swapConfig.tokenAAmount;
    inTokenAddress = swapConfig.tokenAAddress;
    outTokenAddress = swapConfig.tokenBAddress;
  } else if (buyOrSell == "sell") {
    inTokenAmount = swapConfig.tokenBAmount;
    inTokenAddress = swapConfig.tokenBAddress;
    outTokenAddress = swapConfig.tokenAAddress;
  } else {
    throw new Error(`swap Error: ${buyOrSell} is not "buy" or "sell"`);
  }

  // Depending on the configuration, execute or simulate the swap.
  if (swapConfig.executeSwap) {
    try { // Try to make a trade
      console.log(`=== IN: ${inTokenAmount} ${inTokenAddress} | OUT: ${outTokenAddress} ===`);
      console.log("TimeNow: " + Date.now());
      const tx = await raydiumSwap.getSwapTransaction( // Prepare the swap transaction with the given parameters.
        outTokenAddress,
        inTokenAmount,
        poolInfo,
        swapConfig.maxLamports,
        swapConfig.useVersionedTransaction,
        swapConfig.direction,
        buyOrSell,
        primedTokenAccount
      );
      const txid: any = swapConfig.useVersionedTransaction // Send the transaction to the network and log the transaction ID.
        ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
        : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);
      console.log(`- https://solscan.io/tx/${txid}`);
      transactionAttemptCount++;
      console.log("transactionAttemptCount: [[[ " + transactionAttemptCount + " ]]]");

    // If a transaction error occurs, its because insufficient funds, or pool not open yet
    } catch (error) {
      if (buyOrSell == "sell") {
        await refreshBalance();
        if (swapConfig.tokenBAmount == 0) {
          console.log("Success: Insufficient funds error, everything sold!");
          await success();
          return;
        }

      // If a transaction attempt fails with a "buy", it is likely because the pool didn't launch yet, so we continue onward with our attempts
      } else {
        await refreshBalance();
        if (swapConfig.tokenBAmount > 0) { // ...unless we see tokens in our account, in which case it doesn't really matter and we should try to sell
          console.log("BUY SUCCESSFUL AT " + ((Date.now() - listingTime) / 1000) + " seconds after listing");
          console.log("WAITING THEN SELLING...");
          return await setTimeout(async () => {
            transactionAttemptCount = 0;
            await sell(poolInfo, listingTime, primedTokenAccount);
          }, swapConfig.sellDelay);
        }
        if (error) {
          pingCount++;
          pingCount < 5 ? console.log(error) : null;
          console.log("pingCount: [[[ " + pingCount + " ]]]");
          console.log("~~~ POOL NOT LAUNCHED YET, CONTINUE PINGING... ~~~");
          return await setTimeout(async () => {
            await swap(poolInfo, buyOrSell, listingTime, primedTokenAccount);
          }, swapConfig.retryFrequency);
        }
      }
    }

    // After the transaction, check balances (may not have happened immediately)
    await refreshBalance();
    console.log("- myTokenBalance: " + swapConfig.tokenBAmount);

    // Retry if failed
    if ((buyOrSell == "buy" && swapConfig.tokenBAmount == 0) || (buyOrSell == "sell" && swapConfig.tokenBAmount > 0)) {
      console.log("POOL LAUNCHED, TRANSACTION FAILED, DELAYING AND RETRYING...");
      await setTimeout(async () => {
        await swap(poolInfo, buyOrSell, listingTime, primedTokenAccount);
      }, swapConfig.retryFrequency);
    } else {

      // Sell all after a delay
      if (buyOrSell == "buy") {
        console.log("BUY SUCCESSFUL AT " + ((Date.now() - listingTime) / 1000) + " seconds after listing");
        console.log("WAITING THEN SELLING...");
        await setTimeout(async () => {
          transactionAttemptCount = 0;
          await sell(poolInfo, listingTime, primedTokenAccount);
        }, swapConfig.sellDelay);
      } else { // Sell successful! Log SOL amount and continue trading
        console.log("SELL SUCCESSFUL AT " + ((Date.now() - listingTime) / 1000) + " seconds after listing");
        await success();
      }
    }
  } else {
    try {
      const tx = await raydiumSwap.getSwapTransaction( // Prepare the swap transaction with the given parameters.
        outTokenAddress,
        inTokenAmount,
        poolInfo,
        swapConfig.maxLamports,
        swapConfig.useVersionedTransaction,
        swapConfig.direction,
        buyOrSell,
        primedTokenAccount
      );
      const simRes: any = swapConfig.useVersionedTransaction
        ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
        : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);
      console.log("ComputeUnits needed: " + simRes.value.unitsConsumed + " (" + buyOrSell + ")");
      if (buyOrSell == "sell") {
        swapConfig.executeSwap = true;
        await swap(poolInfo, buyOrSell, listingTime, primedTokenAccount);
      } else {
        console.log("~~~ BAD: POOL ALREADY OPEN, LOOKING FOR ANOTHER TOKEN... ~~~");
        tradeInProgress = false;
        return;
      }
    } catch (error) {
      console.log("GOOD: POOL NOT OPEN YET, PROCEEDING...");
      pingCount++;
      swapConfig.executeSwap = true;
      await swap(poolInfo, buyOrSell, listingTime, primedTokenAccount);
    }
  }
};


// Monitor Raydium logs and proceed if new LP found
async function main(connection, programAddress) {
    console.log("Monitoring logs for program:", programAddress.toString());
    connection.onLogs(
        programAddress,
        ({ logs, err, signature }) => {
            if (err) return;

            if (!tradeInProgress && logs && logs.some(log => log.includes("initialize2"))) {
                console.log("=== New LP Found ===");
                analyzeAndExecuteTrade(signature, connection);
            }
        },
        "confirmed"
    );
}


// Parse transaction and filter data
async function analyzeAndExecuteTrade(txId, connection) {
    const tx = await connection.getParsedTransaction(
        txId,
        {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

    // Get token accounts of the two tokens in the LP and log details when a new LP is found
    let accounts = null;
    try {
      accounts = tx?.transaction.message.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY).accounts;
    } catch (error) {
      console.log("No accounts found in the transaction: https://solscan.io/tx/" + txId);
      return;
    }
    if (!accounts) {
        console.log("No accounts found in the transaction: https://solscan.io/tx/" + txId);
        return;
    }
    const raydiumIdo = accounts[4];
    const raydiumAuthority = accounts[5];
    const tokenAAccount = accounts[9];
    const tokenBAccount = accounts[8];
    const openBookMarketAccount = accounts[16];
    const listingTime = tx.blockTime*1000;
    const displayData = [
        { "Token": "IDO", "Account Public Key": raydiumIdo.toBase58() },
        { "Token": "MarketAccount", "Account Public Key": openBookMarketAccount.toBase58() },
        { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
        { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
    ];
    console.log("PoolOpenTransactionTime: " + listingTime);
    console.log("TimeNow: " + Date.now());
    console.log("DetectionSpeed: " + ((Date.now() - listingTime) / 1000) + " seconds after listing");
    console.log("Transaction: https://solscan.io/tx/" + txId);
    console.table(displayData);

    // Continue if a SOL pair... FOR SIMPLICITY'S SAKE, ONLY TRADING PAIRS WHERE SOL IS THE TOKEN-A
    if (tokenAAccount == "So11111111111111111111111111111111111111112") {
      if (((Date.now() - listingTime) / 1000) < 5) { // Only trade if pool detected within 5 seconds
        if (!tradeInProgress) {
          tradeInProgress = true;
          tradeCount++;
          console.log("TRADECOUNT OF THIS SESSION: " + tradeCount);
          const poolInfo = await getPoolData(raydiumIdo, raydiumAuthority, openBookMarketAccount);
          swapConfig.tokenBAddress = tokenBAccount.toBase58();
          swapConfig.tokenBAmount = 0;
          swapConfig.direction = 'in';
          pingCount = 0;
          transactionAttemptCount = 0;
          swap(poolInfo, "buy", listingTime, PRIMED_TOKEN_ACCOUNT);
        }
      } else {
        const poolInfo = await getPoolData(raydiumIdo, raydiumAuthority, openBookMarketAccount);
        closeOldTokenAccounts(poolInfo);
        return console.log("~~~ NOT DETECTED FAST ENOUGH... MOVING ON... ~~~");
      }
    } else {
      return console.log("~~~ NOT A SOL PAIR... MOVING ON... ~~~");
    }
}


// Used for force-ending the script and re-running it with uncommented code below
async function manualSell(ido, mint, openBookMarketAccount) {
    const poolInfo = await getPoolData(new PublicKey(ido), new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), openBookMarketAccount);
    swapConfig.tokenBAddress = mint;
    await refreshBalance();
    await swap(poolInfo, "sell", Date.now(), PRIMED_TOKEN_ACCOUNT);
}

async function manualBuy(ido, mint, openBookMarketAccount) {
    const poolInfo = await getPoolData(new PublicKey(ido), new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"), openBookMarketAccount);
    swapConfig.tokenBAddress = mint;
    await swap(poolInfo, "buy", Date.now(), PRIMED_TOKEN_ACCOUNT);
}


// Run the script
main(connection, raydium).catch(console.error);
// manualSell("J67d7CA9sd6dzA6igkKnmKwhwXy27H1cgaHv7Y7iApUE", "9PJnp54d8rjSaQ88d3RnyvqyEKCaFddesKDDVBij7g7w");
// manualBuy("D3HAdi76gqg1LkP1AFsQMeZuSP5UQdnSLXvfu8jMmmdJ", "3iTzw7i1BmCN9gME426yKTHi9eu2sEENNK9LXhFjP1fa");
