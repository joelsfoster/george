import 'dotenv/config';
import RaydiumSwap from './RaydiumSwap';
import { Transaction, VersionedTransaction, Connection, PublicKey, TransactionMessage, Keypair } from "@solana/web3.js";
import axios from 'axios';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Market, TOKEN_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import bs58 from 'bs58';
import base64 from 'base64-js';
import { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createCloseAccountInstruction } from "@solana/spl-token";

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(process.env.RPC_URL, {
    wsEndpoint: process.env.WS_URL,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


// ============================
// ===== GLOBAL VARIABLES =====
// ============================

const MY_WALLET = "HDaBHzbsGnUS8tS9cPRsMZ5wEKWR12gZWsiK5XfgdFYD";
const PRIMED_WSOL_ACCOUNT = new PublicKey("GLwbCu3z1MS922jSVvbCSwkULUfq6btAphJhc2SeCCc4");
const PRIORITY_FEE_DEFAULT = .006 * 1000000000;
const PRIORITY_FEE_MULTIPLIER = 120;

let swapConfig = {
  executeSwap: true, // Send tx when true, simulate tx when false
  useVersionedTransaction: true,
  tokenAAmount: 0.0001, // Swap 0.1 SOL for USDC in this example
  tokenBAmount: 0,
  tokenAAddress: "So11111111111111111111111111111111111111112", // Token to swap for the other, SOL in this case
  tokenBAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC address
  maxLamports: PRIORITY_FEE_DEFAULT,
  direction: "in" as "in" | "out", // Swap direction: 'in' or 'out'
  liquidityFile: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
  maxRetries: 20,
  retryFrequency: 1000,
  sellDelay: 5000,
};

let tradeInProgress = false; // prevents concurrent trade sequences, forces 1 token to be traded at a time
let tradeCount = 0;
let pingCount = 0;
let transactionAttemptCount = 0;


// ============================
// ===== HELPER FUNCTIONS =====
// ============================

// Scrape priority fee in real time from Quicknode's website
async function getPriorityFee() {
  try {
    const response = await axios.get("https://quicknode.com/_gas-tracker?slug=solana", {});
    const microLamports = Number(Object.values(response.data.sol.per_transaction.percentiles)[2]);
    if (microLamports) {
      const myFee = microLamports * PRIORITY_FEE_MULTIPLIER;
      swapConfig.maxLamports = myFee;
      console.log("RECOMMENDED FEES: " + microLamports);
      console.log("MY FEES: " + myFee);
      return;
    } else {
      throw "WARNING: COULDNT GET UPDATED PRIORITY FEE";
    }
  } catch (error) {
    console.log("WARNING: COULDNT GET UPDATED PRIORITY FEE");
    swapConfig.maxLamports = PRIORITY_FEE_DEFAULT;
  }
}


// Used for DIY transactions
async function getLatestBlockhash() {
  try {
    const response = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getLatestBlockhash',
      params: [
        {
          "commitment": "finalized",
        }
      ],
    });

    return response.data.result.value;
  } catch (error) {
    return console.log("~~~ ERROR WITH getLatestBlockhash() ~~~");
  }
}


// When first detecting a new listing, we need to have a pre-created tokenAccount ready and funded so that the actual buy transaction goes through faster
async function precreateTokenAccount(connection, signature) {
  try {
    const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    let accountsObject = null;
    try {
      accountsObject = tx?.transaction.message.instructions.find(ix => ix.programId.toBase58() === "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
    } catch (error) {
      return console.log("No accounts found in the transaction: https://solscan.io/tx/" + signature);
    }
    if (!accountsObject) { return console.log("No accounts found in the transaction: https://solscan.io/tx/" + signature); }
    const accounts = accountsObject.accounts;
    const tokenAAccount = accounts[8];
    const tokenBAccount = accounts[7];

    // Continue if a SOL pair... FOR SIMPLICITY'S SAKE, ONLY TRADING PAIRS WHERE SOL IS THE TOKEN-A
    if (accounts.length == 10 && tokenAAccount.toBase58() == "So11111111111111111111111111111111111111112") {
      const myAta = await getAssociatedTokenAddress(
        tokenBAccount, // mint
        new PublicKey(MY_WALLET), // owner
        false // allow owner off curve
      );

      // Log everything
      const displayData = [
          { "Token": "My ATA", "Account Public Key": myAta.toBase58() },
          { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
          { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
      ];
      console.table(displayData);

      // Create an ATA
      await sendAtaTransaction(myAta, tokenBAccount);
    } else {
      return console.log("~~~ NOT A SOL PAIR... MOVING ON... ~~~");
    }
  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR WITH precreateTokenAccount() ~~~");
  }
}


// For precreating the tokenAccount
async function sendAtaTransaction(myAta, tokenBAccount) {
  try {
    let tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(MY_WALLET),
        recentBlockhash: await getLatestBlockhash().then((res => res.blockhash)),
        instructions: [
          await createAssociatedTokenAccountInstruction(
            new PublicKey(MY_WALLET), // payer
            myAta, // ata
            new PublicKey(MY_WALLET), // owner
            tokenBAccount // mint
          )
        ],
      }).compileToV0Message()
    );
    tx.sign([Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)))]);

    const serializedTx = tx.serialize();
    const serializedTxBase58 = bs58.encode(serializedTx);
    const ataTxRes = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendTransaction',
      params: [serializedTxBase58],
    });
    const ataTx = ataTxRes.data.result;
    // console.log(`PRE-CREATING TOKENACCOUNT FOR ` + tokenBAccount.toBase58() + `: https://solscan.io/tx/${ataTx}`);

    // Check my token accounts to see if this ATA exists and retry if failed
    const response = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        new PublicKey(MY_WALLET),
        {
          "mint": tokenBAccount,
        },
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        },
      ],
    });

    if (response.data.result.value.length > 0) {
      console.log("WOOHOO! ATA FOR " + tokenBAccount.toBase58() + " CREATED SUCCESSFULLY!");
      return true;
    } else {
      await new Promise(r => setTimeout(r, swapConfig.retryFrequency));
      return await sendAtaTransaction(myAta, tokenBAccount);
    }
  } catch (error) {
    console.log(error);
    console.log("~~~ ERROR WITH sendAtaTransaction() ~~~");
    return false;
  }
}


// Helper function used in swap() whenever a successful trade sequence is finished
async function success() {
  console.log("!!! CONTINUING TRADING... !!!");
  tradeInProgress = false;
}


// Helper function used in swap() to sell a token
async function sell(poolInfo, primedWSolAccount) {
  await refreshBalance();
  console.log("=== SELLING ALL TOKENS NOW, AMOUNT: " + swapConfig.tokenBAmount + " ===");
  await swap(poolInfo, "sell", primedWSolAccount);
}


// Helper function used in swap() to get updated token balances
async function refreshBalance() {
  let myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
  swapConfig.tokenBAmount = myTokenBalance;
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


// Check if tokenAccount is precreated
async function checkForTokenAccount(tokenBAccount) {
  try {
    // Check my token accounts to see if this ATA exists and retry if failed
    const response = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTokenAccountsByOwner',
      params: [
        new PublicKey(MY_WALLET),
        {
          "mint": tokenBAccount,
        },
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
        },
      ],
    });

    if (response.data.result.value.length > 0) {
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR WITH checkForTokenAccount() ~~~");
  }
}


// Main function to get all necessary data
async function getPoolInfo(openBookMarketAccount) {
  try {
    const marketResponse = await axios.post(process.env.RPC_URL, { // Get openBook market data
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

    // Stiching together the poolInfo
    const tokenAAccount = marketInfo.quoteMint;
    const tokenBAccount = marketInfo.baseMint;
    const poolInfo = await getAmmInfo(tokenAAccount, tokenBAccount);
    if (!poolInfo) { return console.log("COULD NOT GET POOL INFO FAST ENOUGH, MOVING ON...") };
    const programId = new PublicKey(poolInfo.marketProgramId.toBase58());
    const marketId = new PublicKey(poolInfo.marketId.toBase58());
    poolInfo.marketAuthority = Market.getAssociatedAuthority({ programId, marketId }).publicKey;
    poolInfo.marketBaseVault = marketInfo.baseVault;
    poolInfo.marketQuoteVault = marketInfo.quoteVault;
    poolInfo.marketBids = marketInfo.bids;
    poolInfo.marketAsks = marketInfo.asks;
    poolInfo.marketEventQueue = marketInfo.eventQueue;
    poolInfo.programId = new PublicKey(RAYDIUM_PUBLIC_KEY);
    poolInfo.authority = new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
    poolInfo.baseDecimals = poolInfo.baseDecimal.toNumber();
    poolInfo.quoteDecimals = poolInfo.quoteDecimal.toNumber();
    poolInfo.version = 4; // MIGHT BREAK?!?
    poolInfo.marketVersion = 4; // MIGHT BREAK?!?

    if (poolInfo.id) {
      return poolInfo;
    } else {
      return null;
    }
  } catch (error) {
    console.log("~~~ ERROR WITH getPoolInfo() ~~~");
    return null;
  }
}


// Get the Raydium AMM ID
async function getAmmInfo(tokenAAccount, tokenBAccount) {
  try {
    const response = await axios.post(process.env.RPC_URL, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        new PublicKey(RAYDIUM_PUBLIC_KEY),
        {
          commitment: "processed",
          encoding: "base64",
          filters: [
            { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("baseMint"),
                bytes: tokenBAccount.toBase58(),
              },
            },
            {
              memcmp: {
                offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf("quoteMint"),
                bytes: tokenAAccount.toBase58(),
              },
            },
          ],
        }
      ],
    });

    if (response.data.result.length > 0) {
      // The response returns a JSON of data in base64. We convert it into a Buffer of Uint8Array for the Raydium library to decode
      const binaryString = atob(response.data.result[0].account.data[0]);
      const uint8Array = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
      const poolInfo: any = LIQUIDITY_STATE_LAYOUT_V4.decode(Buffer.from(uint8Array));
      poolInfo.id = new PublicKey(response.data.result[0].pubkey);
      return poolInfo;
    } else {
      return null;
    }
  } catch (error) {
    console.log(error);
    console.log("~~~ ERROR WITH getAmmInfo() ~~~");
    return null;
  }
}


// ==========================
// ===== MAIN APP LOGIC =====
// ==========================

// Monitor OpenBook logs and precreate a tokenAccount if new market found
async function watchOpenBook(connection) {
  console.log("Monitoring logs for program: srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX");
  connection.onLogs(
    new PublicKey ("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"),
    ({ logs, err, signature }) => {
      if (err) return;
      if (logs && logs.some(log => log.includes("Transfer"))) {
        // nothing
      } else {
        if (
          !tradeInProgress &&
          logs.length > 3 &&
          logs[logs.length - 4].substring(0,40) == "Program 11111111111111111111111111111111" &&
          logs[logs.length - 3].substring(0,51) == "Program srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX" &&
          logs[logs.length - 2].substring(0,51) == "Program srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX" &&
          logs[logs.length - 1].substring(0,51) == "Program srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX"
        ) {
          console.log("=== New OpenBook Market Detected ===");
          console.log("https://solscan.io/tx/" + signature);
          precreateTokenAccount(connection, signature);
        }
      }
    },
    "confirmed"
  );
}


// Monitor Raydium logs and proceed if new LP found; goes through OpenBook to find the market
async function main(connection, programAddress) {
  console.log("Monitoring logs for program:", programAddress.toString());
  watchOpenBook(connection);
  connection.onLogs(
    programAddress,
    ({ logs, err, signature }) => {
      if (err) return;

      if (!tradeInProgress && logs && logs.some(log => log.includes("initialize2"))) {
        console.log("=== New LP Found ===");
        console.log("https://solscan.io/tx/" + signature);
        const detectionTime = Date.now();
        const rayLogString = logs.find((arrayString) => arrayString.includes("ray_log"));
        const encodedOpenBookMarketAccount = rayLogString.split(" ")[3];
        const openBookMarketAccount = new PublicKey(decodeInitLog(base64.toByteArray(encodedOpenBookMarketAccount)));

        function decodeInitLog(bytes) {
          const logType = bytes[0];
          if (logType !== 0) { throw new Error("Incorrect LogType"); }
          bytes = bytes.slice(1);
          const log = { market: bs58.encode(Buffer.from(bytes.slice(42), 'hex')) };
          return log.market;
        }

        analyzeAndExecuteTrade(signature, openBookMarketAccount, detectionTime);
      }
    },
    "processed"
  );
}


// Parse transaction and filter data
async function analyzeAndExecuteTrade(txId, openBookMarketAccount, detectionTime) {
  let badTrade = false;

  // Only trade if pool detected within 5 seconds
  connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
    .then( (result) => {
      if (result) {
        const reactionTime = (detectionTime - result.blockTime*1000) / 1000;
        console.log("PoolOpenTransactionTime: " + result.blockTime*1000 + " | " + reactionTime + " seconds late");
        if (reactionTime > 5) {
          badTrade = true;
          return;
        } else {
          console.log("MEH... DETECTED RIGHT AT CONFIRMATION...");
          // badTrade = true;
          // return;
        }
      } else {
        console.log("GOOD: DETECTED BEFORE CONFIRMATION, PROCEEDING...");
      }
    });

  const poolInfo = await getPoolInfo(openBookMarketAccount);
  if (!poolInfo) { return console.log("COULD NOT GET POOL INFO FAST ENOUGH, MOVING ON...") };
  const tokenAAccount = poolInfo.quoteMint;
  const tokenBAccount = poolInfo.baseMint;
  const tokenAccountExists = await checkForTokenAccount(tokenBAccount);

  if (tokenAccountExists) {
    if (tokenAAccount == "So11111111111111111111111111111111111111112") { // Continue if a SOL pair... FOR SIMPLICITY'S SAKE, ONLY TRADING PAIRS WHERE SOL IS THE TOKEN-A
      if (!tradeInProgress) {
        if (!badTrade) {
          console.log("Detection time: " + detectionTime);
          const displayData = [
              { "Token": "IDO", "Account Public Key": poolInfo.id.toBase58() },
              { "Token": "MarketAccount", "Account Public Key": openBookMarketAccount.toBase58() },
              { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
              { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
          ];
          console.table(displayData);

          const executionTime = (Date.now() - detectionTime) / 1000;
          console.log("ExecutionTime: " + executionTime + " seconds");

          tradeInProgress = true;
          tradeCount++;
          console.log("TRADECOUNT OF THIS SESSION: " + tradeCount);
          swapConfig.tokenBAddress = tokenBAccount.toBase58();
          pingCount = 0;
          transactionAttemptCount = 0;
          getPriorityFee();
          swap(poolInfo, "buy", PRIMED_WSOL_ACCOUNT);
        } else { return console.log("~~~ BAD: DETECTED AFTER CONFIRMATION, MOVING ON... ~~~"); }
      }
    } else { return console.log("~~~ NOT A SOL PAIR... MOVING ON... ~~~"); }
  } else { return console.log("~~~ NO PRECREATED TOKENACCOUNT... MOVING ON... ~~~"); }
}


// Performs a token swap on the Raydium protocol. Depending on the configuration, it can execute the swap or simulate it.
async function swap(poolInfo, buyOrSell, primedWSolAccount) {
  const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
  let inTokenAmount;
  let inTokenAddress;
  let outTokenAddress;
  if (pingCount >= 300) {
    console.log("~~~ GIVING UP AFTER 300 PINGS ~~~");
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
        primedWSolAccount
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
          console.log("BUY SUCCESSFUL, WAITING THEN SELLING...");
          return await setTimeout(async () => {
            transactionAttemptCount = 0;
            await sell(poolInfo, primedWSolAccount);
          }, swapConfig.sellDelay);
        }
        if (error) {
          pingCount++;
          pingCount < 5 ? console.log(error) : null;
          console.log("pingCount: [[[ " + pingCount + " ]]]");
          console.log("~~~ POOL NOT LAUNCHED YET, CONTINUE PINGING... ~~~");
          return await setTimeout(async () => {
            await swap(poolInfo, buyOrSell, primedWSolAccount);
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
        await swap(poolInfo, buyOrSell, primedWSolAccount);
      }, swapConfig.retryFrequency);
    } else {

      // Sell all after a delay
      if (buyOrSell == "buy") {
        console.log("!!! BUY SUCCESSFUL, WAITING THEN SELLING... !!!");
        await setTimeout(async () => {
          transactionAttemptCount = 0;
          await sell(poolInfo, primedWSolAccount);
        }, swapConfig.sellDelay);
      } else { // Sell successful! Log SOL amount and continue trading
        console.log("SELL SUCCESSFUL");
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
        primedWSolAccount
      );
      const simRes: any = swapConfig.useVersionedTransaction
        ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
        : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);
      console.log("ComputeUnits needed: " + simRes.value.unitsConsumed + " (" + buyOrSell + ")");
      await success();
    } catch (error) {
      console.log(error);
      return console.log("ERROR WITH SIMULATION");
    }
  }
};


// ============================
// ===== MANUAL UTILITIES =====
// ============================

// Close unused wSOL accounts
async function closeOldWSolAccounts(openBookMarketAccount) {
  try {
    const poolInfo = await getPoolInfo(openBookMarketAccount);
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
    return console.log("~~~ ERROR WITH closeOldWSolAccounts() ~~~");
  }
}


// Close old tokenAccounts to get rent back
async function closeTokenAccounts(openBookMarketAccount) {
  try {
    const poolInfo = await getPoolInfo(openBookMarketAccount);
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
    console.log(accounts.length);
    const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);

    accounts.forEach(async (account, i) => {
      if (account.accountInfo.mint === "So11111111111111111111111111111111111111112" || account.accountInfo.tokenAmount.uiAmount > 0) {
        console.log("WSOL TOKEN ACCOUNT, OR ATA BALANCE IS > 0");
      } else {
        await setTimeout(async () => {
          const tokenAccount = new PublicKey(account.pubkey);
          let tx = new VersionedTransaction(
            new TransactionMessage({
              payerKey: new PublicKey(MY_WALLET),
              recentBlockhash: await getLatestBlockhash().then((res => res.blockhash)),
              instructions: [
                await createCloseAccountInstruction(
                  tokenAccount, // ata
                  new PublicKey(MY_WALLET), // destination
                  new PublicKey(MY_WALLET) // owner
                )
              ],
            }).compileToV0Message()
          );
          tx.sign([Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)))]);

          const serializedTx = tx.serialize();
          const serializedTxBase58 = bs58.encode(serializedTx);
          const closeAtaTxRes = await axios.post(process.env.RPC_URL, {
            jsonrpc: '2.0',
            id: 1,
            method: 'sendTransaction',
            params: [serializedTxBase58],
          });
          const closeAtaTx = closeAtaTxRes.data.result;
          console.log(`CLOSED AN OLD TOKENACCOUNT: https://solscan.io/tx/${closeAtaTx}`);
        }, i * swapConfig.retryFrequency);
      }
    });
  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR WITH closeTokenAccounts() ~~~");
  }
}


// We need a funded wSOL account to make trades; this is run manually
async function seedWSolAccount(poolInfo, solAmount) {
  try {
    const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
    const creationTx = await raydiumSwap.getSwapTransaction(
      swapConfig.tokenBAddress,
      solAmount,
      poolInfo,
      swapConfig.maxLamports,
      swapConfig.useVersionedTransaction,
      swapConfig.direction,
      "seedAccount",
      null
    );
    const creationTxId: any = swapConfig.useVersionedTransaction // Send the transaction to the network and log the transaction ID.
      ? await raydiumSwap.sendVersionedTransaction(creationTx as VersionedTransaction, swapConfig.maxRetries)
      : await raydiumSwap.sendLegacyTransaction(creationTx as Transaction, swapConfig.maxRetries);
    console.log(`SEEDING WSOL ACCOUNT: https://solscan.io/tx/${creationTxId}`);
  } catch (error) {
    console.log(error);
    return console.log("~~~ ERROR SEEDING WSOL ACCOUNT, RETRYING... ~~~");
  }
}


// Used for force-ending the script and re-running it with uncommented code below
async function manualSell(openBookMarketAccount) {
  const poolInfo = await getPoolInfo(openBookMarketAccount);
  swapConfig.tokenBAddress = poolInfo.baseMint;
  await refreshBalance();
  await swap(poolInfo, "sell", PRIMED_WSOL_ACCOUNT);
}

async function manualBuy(openBookMarketAccount) {
  const poolInfo = await getPoolInfo(openBookMarketAccount);
  swapConfig.tokenBAddress = poolInfo.baseMint;
  await swap(poolInfo, "buy", PRIMED_WSOL_ACCOUNT);
}


// Run the script
main(connection, raydium).catch(console.error);
// manualSell("4LxVvm1zdp1FhhHLrgUYvjbVNPtLcBc8hbrHK7xwkvBa");
// manualBuy("4LxVvm1zdp1FhhHLrgUYvjbVNPtLcBc8hbrHK7xwkvBa");
// closeTokenAccounts(new PublicKey("4LxVvm1zdp1FhhHLrgUYvjbVNPtLcBc8hbrHK7xwkvBa"));
