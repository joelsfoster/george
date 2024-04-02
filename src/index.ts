import 'dotenv/config';
import RaydiumSwap from './RaydiumSwap';
import { Transaction, VersionedTransaction, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { execSync } from 'child_process';
import axios from 'axios';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Market } from "@raydium-io/raydium-sdk";

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // --> Raydium "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" // --> competitor sniper bot "AupTbxArPau5H97izWurgska1hEvFNrYM1U8Yy9ijrWU"
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(`https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`, {
    wsEndpoint: `wss://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


// ============================
// ===== GLOBAL VARIABLES =====
// ============================

const SLOW_PRIORITY_FEE = .000001 * 1000000000; // 0.000008333 // 0.000012173
const FAST_PRIORITY_FEE = .001 * 1000000000; // 0.000008333 // 0.000012173

const MY_WALLET = "HDaBHzbsGnUS8tS9cPRsMZ5wEKWR12gZWsiK5XfgdFYD";

let swapConfig = {
  executeSwap: true, // Send tx when true, simulate tx when false
  useVersionedTransaction: true,
  tokenAAmount: 0.1, // Swap 0.1 SOL for USDC in this example
  tokenBAmount: 0,
  tokenAAddress: "So11111111111111111111111111111111111111112", // Token to swap for the other, SOL in this case
  tokenBAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC address
  maxLamports: FAST_PRIORITY_FEE, // Micro lamports for priority fee
  direction: "in" as "in" | "out", // Swap direction: 'in' or 'out'
  liquidityFile: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
  maxRetries: 20,
  retryFrequency: 2000,
  tradingOpen: true,
};

let tradeInProgress = false; // prevents concurrent trade sequences, forces 1 token to be traded at a time
let startingSolBalance;

// ============================
// ===== HELPER FUNCTIONS =====
// ============================

// // Testing function for finding how poolInfo is normally formatted (from the Raydium liquidity API endpoint)
// async function fetchMarketAccounts(base, quote) {
//   const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
//   await raydiumSwap.loadPoolKeys('https://api.raydium.io/v2/sdk/liquidity/mainnet.json');
//   const poolInfo = raydiumSwap.findPoolInfoForTokens(base, quote);
//   return console.log(poolInfo);
// }


async function checkSolBalance() {
  try {
    const response = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [
        new PublicKey(MY_WALLET)
      ],
    });

    const balance = response.data.result.value / LAMPORTS_PER_SOL;
    return balance;

  } catch (error) {
    throw new Error(`checkSolBalance Error: ${error}`);
  }
}

// Helper function to see my balance of a token
async function checkWalletBalance(tokenMintAddress) {
  try {
    const response = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
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


// Helper function to get top token holders
async function getTokenBalances(tokenProgramAddress, tokenMintAddress) {
  try {
    const response = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        tokenProgramAddress, // e.g. "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
          "filters": [
            {
              "dataSize": 165
            },
            {
              "memcmp": {
                "offset": 0,
                "bytes": tokenMintAddress
              }
            }
          ]
        }
      ],
    });

    const deserialized_accounts = [];
    response.data.result.forEach((tokenAccount) => {
      if (tokenAccount.account.data.parsed.info.owner == "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1") {
        console.log("RAYDIUM ACCOUNT FOUND"); // don't count the LP pool towards the top holders
      } else {
        if (tokenAccount.account.data.parsed.info.tokenAmount.uiAmount > 0) {
          deserialized_accounts.push(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
        }
      }
    })

    deserialized_accounts.sort((a, b) => a < b ? 1 : -1);
    deserialized_accounts.slice(0, 9);
    console.log("TOKEN HOLDER AMOUNTS: " + deserialized_accounts);
    return deserialized_accounts;

  } catch (error) {
    throw new Error(`getTokenBalances Error: ${error}`);
  }
}


// Helper function to get pool info
async function getPoolData(raydiumIdo, raydiumAuthority) {
  try {

    // First, get liquidity pool info from Raydium
    const idoAccountString = raydiumIdo.toBase58();
    const liquidityResponse = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
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
    const marketResponse = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        "srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX", // OpenBook program ID
        {
          "encoding": "jsonParsed",
          "commitment": "processed",
          "filters": [
            {
              "dataSize": MARKET_STATE_LAYOUT_V3.span
            },
            {
              "memcmp": {
                "offset": MARKET_STATE_LAYOUT_V3.offsetOf("baseMint"),
                "bytes": poolInfo.baseMint.toBase58(),
              },
            },
            {
              "memcmp": {
                "offset": MARKET_STATE_LAYOUT_V3.offsetOf("quoteMint"),
                "bytes": poolInfo.quoteMint.toBase58(),
              },
            },
          ],
        }
      ],
    });

    // The response returns a JSON of data in base64. We convert it into a Buffer of Uint8Array for the Raydium library to decode
    const marketBinaryString = atob(marketResponse.data.result[0].account.data[0]);
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


// Performs a token swap on the Raydium protocol. Depending on the configuration, it can execute the swap or simulate it.
const swap = async (poolInfo, buyOrSell, listingTime) => {
  const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
  let tradingOpenTime = listingTime;
  let inTokenAmount;
  let inTokenAddress;
  let outTokenAddress;
  if (buyOrSell == "buy") {
    inTokenAmount = swapConfig.tokenAAmount;
    inTokenAddress = swapConfig.tokenAAddress;
    outTokenAddress = swapConfig.tokenBAddress;
  } else if (buyOrSell == "sell") {
    inTokenAmount = swapConfig.tokenBAmount;
    inTokenAddress = swapConfig.tokenBAddress;
    outTokenAddress = swapConfig.tokenAAddress;
    swapConfig.retryFrequency = 2000;
    swapConfig.maxLamports = FAST_PRIORITY_FEE;
  } else {
    throw new Error(`swap Error: ${buyOrSell} is not "buy" or "sell"`);
  }
  console.log(`=== IN: ${inTokenAmount} ${inTokenAddress} | OUT: ${outTokenAddress} ===`);
  console.log("- TimeNow: " + Date.now());
  console.log("- SwapStartSpeed: " + ((Date.now() - tradingOpenTime) / 1000) + " seconds after listing");


  // Depending on the configuration, execute or simulate the swap.
  if (swapConfig.executeSwap) {
    let myTokenBalance = 0;
    try {

      // Try to make a trade
      const tx = await raydiumSwap.getSwapTransaction( // Prepare the swap transaction with the given parameters.
        outTokenAddress,
        inTokenAmount,
        poolInfo,
        swapConfig.maxLamports,
        swapConfig.useVersionedTransaction,
        swapConfig.direction
      );
      const txid: any = swapConfig.useVersionedTransaction // Send the transaction to the network and log the transaction ID.
        ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
        : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);
      console.log("- POOL IS OPEN");
      console.log(`- https://solscan.io/tx/${txid}`);
      swapConfig.retryFrequency = 2000;
      swapConfig.maxLamports = FAST_PRIORITY_FEE;
      if (swapConfig.tradingOpen == false) {
        swapConfig.tradingOpen = true;
        tradingOpenTime = Date.now();
      }

    // If a transaction error occurs, its because insufficient funds, or pool not open yet
    } catch (error) {
      if (buyOrSell == "sell") {
        myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
        swapConfig.tokenBAmount = myTokenBalance;
        if (myTokenBalance == 0) {
          console.log("Success: Insufficient funds error, everything sold!");
        } else {
          console.log("Yikes, pool rugged before sale!");
        }
        const newSolBalance = await checkSolBalance();
        const solTradeResult = newSolBalance - startingSolBalance;
        console.log("$$$ TRADE RESULT: " + newSolBalance + " - " + startingSolBalance + " = " + solTradeResult + " SOL $$$");
        console.log("!!! CONTINUING TRADING... !!!");
        tradeInProgress = false;
        return;

      // If a transaction attempt fails with a "buy", it is likely because the pool didn't launch yet, so we continue onward with our attempts
      } else {
        myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
        swapConfig.tokenBAmount = myTokenBalance;
        if (myTokenBalance > 0) { // ...unless we see tokens in our account, in which case it doesn't really matter and we should try to sell
          console.log("TRANSACTION SUCCESSFUL!");
          console.log("- PoolOpenTransactionTime: " + tradingOpenTime);
          console.log("- TimeNow: " + Date.now());
          console.log("- ExecutionSpeed: " + ((Date.now() - tradingOpenTime) / 1000) + " seconds after listing");
          console.log("WAITING 30 SEC THEN SELLING...");
          return await setTimeout(async () => {
            myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
            swapConfig.tokenBAmount = myTokenBalance;
            console.log("=== SELLING ALL TOKENS NOW, AMOUNT: " + myTokenBalance + " ===");
            await swap(poolInfo, "sell", tradingOpenTime);
          }, 30000);
        }
        if (error) {
          console.log("~~~ ERROR RETURNED, POOL NOT LAUNCHED YET, CONTINUE WITH LOW-FEE PING EVERY 5-SEC ~~~");
          swapConfig.retryFrequency = 5000;
          swapConfig.maxLamports = SLOW_PRIORITY_FEE;
          swapConfig.tradingOpen = false;
        }
      }
    }

    // After the transaction, check balances (may not have happened immediately)
    if (swapConfig.tradingOpen == true) {
      myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
      swapConfig.tokenBAmount = myTokenBalance;
      console.log("- myTokenBalance: " + myTokenBalance);
    }

    // Retry if failed
    if ((buyOrSell == "buy" && myTokenBalance == 0) || (buyOrSell == "sell" && myTokenBalance > 0)) {
      console.log("FAILED, DELAYING AND RETRYING...");
      await setTimeout(async () => {
        await swap(poolInfo, buyOrSell, tradingOpenTime);
      }, swapConfig.retryFrequency);
    } else {
      console.log("TRANSACTION SUCCESSFUL!");
      console.log("- PoolOpenTransactionTime: " + tradingOpenTime);
      console.log("- TimeNow: " + Date.now());
      console.log("- ExecutionSpeed: " + ((Date.now() - tradingOpenTime) / 1000) + " seconds after listing");

      // Sell all after 30 sec
      if (buyOrSell == "buy") {
        console.log("WAITING 30 SEC THEN SELLING...");
        await setTimeout(async () => {
          myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
          swapConfig.tokenBAmount = myTokenBalance;
          console.log("=== SELLING ALL TOKENS NOW, AMOUNT: " + myTokenBalance + " ===");
          await swap(poolInfo, "sell", tradingOpenTime);
        }, 30000);
      } else { // Sell successful! Log SOL amount and continue trading
        const newSolBalance = await checkSolBalance();
        const solTradeResult = newSolBalance - startingSolBalance;
        console.log("$$$ TRADE RESULT: " + newSolBalance + " - " + startingSolBalance + " = " + solTradeResult + " SOL $$$");
        console.log("!!! CONTINUING TRADING... !!!");
        tradeInProgress = false;
      }
    }
  } else {
    const tx = await raydiumSwap.getSwapTransaction( // Prepare the swap transaction with the given parameters.
      outTokenAddress,
      inTokenAmount,
      poolInfo,
      swapConfig.maxLamports,
      swapConfig.useVersionedTransaction,
      swapConfig.direction
    );
    const simRes: any = swapConfig.useVersionedTransaction // Simulate the transaction and log the result.
      ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
      : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);
    console.log("Swap simulation successful! Details:");
    console.log(simRes);
    console.log("PoolOpenTransactionTime: " + tradingOpenTime);
    console.log("TimeNow: " + Date.now());
    console.log("ExecutionSpeed: " + ((Date.now() - tradingOpenTime) / 1000) + " seconds after listing");
    tradeInProgress = false;
  }
};


// ==========================
// ===== MAIN APP LOGIC =====
// ==========================

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
    const accounts = tx?.transaction.message.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY).accounts;
    if (!accounts) {
        console.log("No accounts found in the transaction: https://solscan.io/tx/" + txId);
        return;
    }
    const raydiumIdo = accounts[4];
    const raydiumAuthority = accounts[5];
    const tokenAAccount = accounts[9];
    const tokenBAccount = accounts[8];
    const listingTime = tx.blockTime*1000;
    const displayData = [
        { "Token": "IDO", "Account Public Key": raydiumIdo.toBase58() },
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
      const tokenAccount = tokenBAccount;
      swapConfig.tokenBAddress = tokenBAccount.toBase58();

      // Check if mint and freeze authority are revoked
      const tokenDetails = execSync("sudo spl-token display " + tokenAccount.toBase58(), { encoding: 'utf-8' }).toString().split("\n");
      const tokenProgram = tokenDetails[3].split(":")[1].trim();
      const tokenDecimals = Number(tokenDetails[5].split(":")[1].trim());
      const tokenSupply = Number(tokenDetails[4].split(":")[1].trim()) / (10 ** tokenDecimals);
      const mintAuthority = tokenDetails[6].trim();
      const freezeAuthority = tokenDetails[7].trim();
      if (mintAuthority == "Mint authority: (not set)") { console.log("SAFE: MINT AUTH REVOKED") } else { console.log("DANGER: CAN MINT MORE") }
      if (freezeAuthority == "Freeze authority: (not set)") { console.log("SAFE: FREEZE AUTH REVOKED") } else { console.log("DANGER: CAN FREEZE TOKEN") }

      // Verify the top 10 holders hold less than 70% of the total supply, and no single holder has more than 20% of the total supply
      const topTokenHolders = await getTokenBalances(tokenProgram, tokenAccount);
      const topTenHoldersSupply = topTokenHolders[0] + topTokenHolders[1] + topTokenHolders[2] + topTokenHolders[3] + topTokenHolders[4] + topTokenHolders[5] + topTokenHolders[6] + topTokenHolders[7] + topTokenHolders[8] + topTokenHolders[9];
      const highTokenConcentration = topTenHoldersSupply > (tokenSupply * .7);
      const spoofedDistribution = topTokenHolders.length !== new Set(topTokenHolders).size; // Detects duplicate token holder amounts
      const sketchyDistribution = topTokenHolders[1] > 0 && topTokenHolders[2] > 0 && (topTokenHolders[1] + topTokenHolders[2] + topTokenHolders[3] + topTokenHolders[4] + topTokenHolders[5] + topTokenHolders[6] + topTokenHolders[7] + topTokenHolders[8] + topTokenHolders[9]) % 1000 == 0; // Detects if multiple wallets pre-seeded with multiples of 1000
      const topHolderSupply = topTokenHolders[0];
      const singleBigTokenHolder = topHolderSupply > (tokenSupply * .2);
      if (spoofedDistribution || sketchyDistribution) { console.log("DANGER: MULTIPLE PRE-SEEDED ACCOUNTS") }
      if (!highTokenConcentration) { console.log("SAFE: GOOD HOLDER DISTRIBUTION") } else { console.log("DANGER: HIGH TOKEN CONCENTRATION") }
      if (!singleBigTokenHolder) { console.log("SAFE: NO MEGA WHALE") } else { console.log("DANGER: SINGLE TOKEN HOLDER HOLDS HUGE SUPPLY") }
      // [wont do for v1] check for Low liquidity (under $5k)...
      // [wont do for v1] check if LP receipt not burned...

      // If safe, gather the data we need for the swap, then perform the swap
      if (mintAuthority == "Mint authority: (not set)" && freezeAuthority == "Freeze authority: (not set)" && !highTokenConcentration && !singleBigTokenHolder && !spoofedDistribution && !sketchyDistribution) {
        const poolInfo = await getPoolData(raydiumIdo, raydiumAuthority);
        tradeInProgress = true;
        swapConfig.direction = 'in';
        swapConfig.tradingOpen = true;
        startingSolBalance = await checkSolBalance();
        console.log("startingSolBalance: " + startingSolBalance + " SOL");
        swap(poolInfo, "buy", listingTime);
      } else {
        console.log("~~~NOT SAFE, NOT TRADING~~~");
      }
    } else {
      console.log("NOT A SOL PAIR... MOVING ON...");
      return;
    }
}

// Run the script
main(connection, raydium).catch(console.error);




// =========================
// ===== SCRATCH NOTES =====
// =========================

// fetchMarketAccounts("So11111111111111111111111111111111111111112", "3WMr8ncjho5hy3RBL4ZXydTjZcGSi7YxYLHLhq1zKP1F");
// getPoolData(new PublicKey("FzWvfNEpLAbUo2MKC1tGRwSfKnsrmt961reTE2vGtGKg"), new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"));
// testing with https://solscan.io/tx/yRdAehjqcaRB5LrfSKQFF3vrKWeCGviYFiTmw56PAzY2zKoAwYwXLVBpXvQBenX9bKsSYvWz4teMqxgxZbLwaqV (token: 3WMr8ncjho5hy3RBL4ZXydTjZcGSi7YxYLHLhq1zKP1F)
//
// async function testFunction() {
//     const poolInfo = await getPoolData(new PublicKey("8XtEhvzDAHDyBXEJpwtEbf39dBzhh4dvYEDzJSM2LNsM"), new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"));
//     swapConfig.tokenBAddress = "DVFHjutmfpc8f6BVGBY645QuVYpNnsqnUyLpnZYwMoCB";
//     let myTokenBalance = await checkWalletBalance(swapConfig.tokenBAddress);
//     swapConfig.tokenBAmount = myTokenBalance;
//     await swap(poolInfo, "sell", Date.now());
// }
//
// testFunction();

// https://solscan.io/tx/4rATMCLAaBuXjbFJQtctUyhCH2XkNLE3tZF2wr3fKKbj3ZHx3xQ1ZTva7FnSnfBcqvcz7fH1BmdKio7T8u5XcYUp
// ido: 6ytyRrE72DgjBmnr3eaJAv1DFov5CaP5XMBmnXWdXacd
// tokenB: 65zbFrDtB7L4bHxqHbBKL7mcfAPyzTJ4SnjiaiQLHD78



// {
//   id: PublicKey [PublicKey(FzWvfNEpLAbUo2MKC1tGRwSfKnsrmt961reTE2vGtGKg)] {
//     _bn: <BN: debf8f42f610f96f84d6212b23e98b64ffd7c0ef2a19ce6fad36793d396a1c1f>
//   },
//   baseMint: PublicKey [PublicKey(3WMr8ncjho5hy3RBL4ZXydTjZcGSi7YxYLHLhq1zKP1F)] {
//     _bn: <BN: 253cca0c9988f70c8e1952f11500d01663bb7de09f4e6cc161bf8ba621d57786>
//   },
//   quoteMint: PublicKey [PublicKey(So11111111111111111111111111111111111111112)] {
//     _bn: <BN: 69b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001>
//   },
//   lpMint: PublicKey [PublicKey(7WaDBJqAVKd5KGh7BtZm2oqbQpacZQL6VS476NHaTLPX)] {
//     _bn: <BN: 60b984013565f0d3c5ea14c28f8015583d98820be54c264417afcec353680fa6>
//   },
//   baseDecimals: 9,
//   quoteDecimals: 9,
//   lpDecimals: 9,
//   version: 4,
//   programId: PublicKey [PublicKey(675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)] {
//     _bn: <BN: 4bd949c43602c33f207790ed16a3524ca1b9975cf121a2a90cffec7df8b68acd>
//   },
//   authority: PublicKey [PublicKey(5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1)] {
//     _bn: <BN: 4157b0580f31c5fce44a62582dbcf9d78ee75943a084a393b350368d22899308>
//   },
//   openOrders: PublicKey [PublicKey(5ANEPCac2BjPcgj4gkHsAn1UWcjh2f16y3wzF1LhT2j)] {
//     _bn: <BN: 110e9d87d622903fc590d49db68d5297f68229cd0b7930d0489a58fda5fe47c>
//   },
//   targetOrders: PublicKey [PublicKey(9GFLA7XsU215aQdpdDwpBnmZGk7399pvJb16uWDx1SYi)] {
//     _bn: <BN: 7ac5692e5554daf7a1c68639130c0079fbbc67b58d2d67072399b7156a0f3de3>
//   },
//   baseVault: PublicKey [PublicKey(2oZFqasaYPBt3brHdQY3wFsNC3nYdgXVA5WAGWGYjQZx)] {
//     _bn: <BN: 1ac8e03c22e764afe761ff74f2bbf047e0ca9d158b2d13d398b8285465415f53>
//   },
//   quoteVault: PublicKey [PublicKey(FaM45qYPZdRxtTB981jUBJmZKHoJBJSBGJ8T5udqKVRY)] {
//     _bn: <BN: d88e7535b852e15abd9280f2246d9f81260a0766af40b8117b3973e2b001e4cf>
//   },
//   withdrawQueue: PublicKey [PublicKey(11111111111111111111111111111111)] {
//     _bn: <BN: 0>
//   },
//   lpVault: PublicKey [PublicKey(11111111111111111111111111111111)] {
//     _bn: <BN: 0>
//   },
//   marketVersion: 4,
//   marketProgramId: PublicKey [PublicKey(srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX)] {
//     _bn: <BN: d0751a8282da61305fe299c37b998e58471db1135037310f8be1045a60af6ee>
//   },
//   marketId: PublicKey [PublicKey(DEzFMWYY3RSfzREeqP9uvYhWE45KYxr7Ads6XygNGcCB)] {
//     _bn: <BN: b5e186082402b4643d365d3227a09efc7f9f691774b4048aa52c456d2013de7c>
//   },
//   marketAuthority: PublicKey [PublicKey(DBiJL2LWu2QibyazSS3VxdjwgKVL9vbuKFAMHsG3WLTP)] {
//     _bn: <BN: b50abf73e0a6643e6fecf85aa8fbfc90c110f0984718b389e5ea7fe92a785b2e>
//   },
//   marketBaseVault: PublicKey [PublicKey(EUNuoGWjUq7YG9nez87unLfnd8Q9CEkKwPnk9AJYgTTx)] {
//     _bn: <BN: c82b62cd8ca69c4f0d3548896697d12184e712f68ca3b75a6f46bdc6bec26dab>
//   },
//   marketQuoteVault: PublicKey [PublicKey(27CuoYixX3wCf1gN4pcX3Wt4LVA1NGgWLwXWkFvayxFf)] {
//     _bn: <BN: 1072a38ef3c29fe1931b86e75edc21dcac00e29d910e08ba640b25a7ffb03bfe>
//   },
//   marketBids: PublicKey [PublicKey(9JoyaUfEnsT1weeYcju9DCktftxpJ4CDj8WfCiZWSgWf)] {
//     _bn: <BN: 7b6d7c07fdf1d342ae77b21dd960cd980550dc17a6a2e1695505d35d6042dbac>
//   },
//   marketAsks: PublicKey [PublicKey(7oANTVXH16yMPgdoXJNBc2x22H7uECeiWTW5NbGUUDrT)] {
//     _bn: <BN: 64f96ef3a27e4995cb7b14bdd70dda79e3ba2a32536136b90ed8271dd323f72c>
//   },
//   marketEventQueue: PublicKey [PublicKey(AjAB3s7CzVmeeKMfnWeCN8Bg2NVcrSnfDeDANAWa8i2n)] {
//     _bn: <BN: 9085f2d4fa3c35f072bc082d88bb3a8d020131eb5ca2d43bb8bde1de0f08de33>
//   }
// }



// USDC
// swap({
//   id: PublicKey [PublicKey(58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2)] {
//     _bn: <BN: 3d6e472e67a46ea6b4bd0bab9dfd35e2b4c72f1d6d59c2eab95c942573ad22f1>
//   },
//   baseMint: PublicKey [PublicKey(So11111111111111111111111111111111111111112)] {
//     _bn: <BN: 69b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001>
//   },
//   quoteMint: PublicKey [PublicKey(EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)] {
//     _bn: <BN: c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61>
//   },
//   lpMint: PublicKey [PublicKey(8HoQnePLqPj4M7PUDzfw8e3Ymdwgc7NLGnaTUapubyvu)] {
//     _bn: <BN: 6c4f93d858e88ffafea08c43674497e8e6a932c0c83148262a1ae3ccc7829ec6>
//   },
//   baseDecimals: 9,
//   quoteDecimals: 6,
//   lpDecimals: 9,
//   version: 4,
//   programId: PublicKey [PublicKey(675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)] {
//     _bn: <BN: 4bd949c43602c33f207790ed16a3524ca1b9975cf121a2a90cffec7df8b68acd>
//   },
//   authority: PublicKey [PublicKey(5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1)] {
//     _bn: <BN: 4157b0580f31c5fce44a62582dbcf9d78ee75943a084a393b350368d22899308>
//   },
//   openOrders: PublicKey [PublicKey(HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY)] {
//     _bn: <BN: f92f390ff9609e8ad437bb8e4c1f1aa43ac05d24308cca77de8512c5509292d3>
//   },
//   targetOrders: PublicKey [PublicKey(CZza3Ej4Mc58MnxWA385itCC9jCo3L1D7zc3LKy1bZMR)] {
//     _bn: <BN: abe43c7c1e21eaa6f97c8bd355e21bd1279674756c1c8e106c6e712ba116d970>
//   },
//   baseVault: PublicKey [PublicKey(DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz)] {
//     _bn: <BN: b870e12dd379891561d2e9fa8f26431834eb736f2f24fc2a2a4dff1fd5dca4df>
//   },
//   quoteVault: PublicKey [PublicKey(HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz)] {
//     _bn: <BN: f2cbb9b760eddb185706303063ad33d7b57296ea02d4e0335e31ceafa4cc42dd>
//   },
//   withdrawQueue: PublicKey [PublicKey(11111111111111111111111111111111)] {
//     _bn: <BN: 0>
//   },
//   lpVault: PublicKey [PublicKey(11111111111111111111111111111111)] {
//     _bn: <BN: 0>
//   },
//   marketVersion: 4,
//   marketProgramId: PublicKey [PublicKey(srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX)] {
//     _bn: <BN: d0751a8282da61305fe299c37b998e58471db1135037310f8be1045a60af6ee>
//   },
//   marketId: PublicKey [PublicKey(8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6)] {
//     _bn: <BN: 6ac4c3cefa9f19bf54c8dc0f5e4d1ceee5327d26482b29d2b13cbaa43447218d>
//   },
//   marketAuthority: PublicKey [PublicKey(CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7)] {
//     _bn: <BN: aa5a31cb020bb002985ca929908171940fe635cb76e99ce4fb8805428bb8254a>
//   },
//   marketBaseVault: PublicKey [PublicKey(CKxTHwM9fPMRRvZmFnFoqKNd9pQR21c5Aq9bh5h9oghX)] {
//     _bn: <BN: a84bb6466246781d7a9adab8588ba86b2acce51358c844f5444e40640875fd5a>
//   },
//   marketQuoteVault: PublicKey [PublicKey(6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNj5DwAWG97yzMu)] {
//     _bn: <BN: 4c9d997d2ec43bdc0d236269cfb0d08391afd103fd8fbd63453ff58b6e23a920>
//   },
//   marketBids: PublicKey [PublicKey(5jWUncPNBMZJ3sTHKmMLszypVkoRK6bfEQMQUHweeQnh)] {
//     _bn: <BN: 46527949e0a7a659f8aadc86bc53cc7c42469a17765a9bad62b1b05bc868b5ee>
//   },
//   marketAsks: PublicKey [PublicKey(EaXdHx7x3mdGA38j5RSmKYSXMzAFzzUXCLNBEDXDn1d5)] {
//     _bn: <BN: c9beb9b16d18a8273976ef89b7fde84aec9baaca0db173db8fda4ae0de478a34>
//   },
//   marketEventQueue: PublicKey [PublicKey(8CvwxZ9Db6XbLD46NZwwmVDZZRDy7eydFcAGkXKh9axa)] {
//     _bn: <BN: 6b103231c975050cec8da6de40357c9bca60ef9e8f33165a255665652a82533b>
//   },
//   lookupTableAccount: PublicKey [PublicKey(3q8sZGGpPESLxurJjNmr7s7wcKS5RPCCHMagbuHP9U2W)] {
//     _bn: <BN: 2a0c273844ad3e3122eb39b563863f36c7e12b9fff3fd75122cf36bb14e278c3>
//   }
// });
