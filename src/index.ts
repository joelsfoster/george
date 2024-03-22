import RaydiumSwap from './RaydiumSwap';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import 'dotenv/config';
import { swapConfig } from './swapConfig'; // Import the configuration
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { execSync } from 'child_process';
import axios from 'axios';

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // --> Raydium "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" // --> competitor sniper bot "AupTbxArPau5H97izWurgska1hEvFNrYM1U8Yy9ijrWU"
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(`https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`, {
    wsEndpoint: `wss://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


/**
 * Performs a token swap on the Raydium protocol.
 * Depending on the configuration, it can execute the swap or simulate it.
 */
const swap = async () => {
  /**
   * The RaydiumSwap instance for handling swaps.
   */
  const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
  console.log(`Raydium swap initialized`);
  console.log(`Swapping ${swapConfig.tokenAAmount} of ${swapConfig.tokenAAddress} for ${swapConfig.tokenBAddress}...`)

  /**
   * Load pool keys from the Raydium API to enable finding pool information.
   */
  await raydiumSwap.loadPoolKeys(swapConfig.liquidityFile);
  console.log(`Loaded pool keys`);

  /**
   * Find pool information for the given token pair.
   */
  const poolInfo = raydiumSwap.findPoolInfoForTokens(swapConfig.tokenAAddress, swapConfig.tokenBAddress);
  console.log('Found pool info');

  /**
   * Prepare the swap transaction with the given parameters.
   */
  const tx = await raydiumSwap.getSwapTransaction(
    swapConfig.tokenBAddress,
    swapConfig.tokenAAmount,
    poolInfo,
    swapConfig.maxLamports,
    swapConfig.useVersionedTransaction,
    swapConfig.direction
  );

  /**
   * Depending on the configuration, execute or simulate the swap.
   */
  if (swapConfig.executeSwap) {
    /**
     * Send the transaction to the network and log the transaction ID.
     */
    const txid = swapConfig.useVersionedTransaction
      ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
      : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);

    console.log(`https://solscan.io/tx/${txid}`);

  } else {
    /**
     * Simulate the transaction and log the result.
     */
    const simRes = swapConfig.useVersionedTransaction
      ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
      : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);

    console.log(simRes);
  }
};


// Helper function to get top token holders
async function getTokenBalances(tokenProgramAddress, tokenMintAddress) {
  try {
    const startTime = performance.now();

    const response = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
      jsonrpc: '2.0',
      id: 1,
      method: 'getProgramAccounts',
      params: [
        tokenProgramAddress, // e.g. "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        {
          "encoding": "jsonParsed",
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
        deserialized_accounts.push(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
      }
    })

    deserialized_accounts.sort((a, b) => a < b ? 1 : -1);
    deserialized_accounts.slice(0, 9);
    console.log("TOKEN HOLDER AMOUNTS: " + deserialized_accounts);
    return deserialized_accounts;

  } catch (error) {
    throw new Error(`Error: ${error}`);
  }
}


// Monitor logs and proceed if new LP found
async function main(connection, programAddress) {
    console.log("Monitoring logs for program:", programAddress.toString());
    connection.onLogs(
        programAddress,
        ({ logs, err, signature }) => {
            if (err) return;

            if (logs && logs.some(log => log.includes("initialize2"))) {
                console.log("=== New LP Found ===");
                fetchRaydiumAccounts(signature, connection);
            }
        },
        "confirmed" // "processed" is faster but sometimes too fast and we throw the "account not found error below"
    );
}

// Parse transaction and filter data
async function fetchRaydiumAccounts(txId, connection) {
    const tx = await connection.getParsedTransaction(
        txId,
        {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

    // Get token accounts of the two tokens in the LP
    const accounts = tx?.transaction.message.instructions.find(ix => ix.programId.toBase58() === RAYDIUM_PUBLIC_KEY).accounts;
    if (!accounts) {
        console.log("No accounts found in the transaction: https://solscan.io/tx/" + txId);
        return;
    }
    const tokenAIndex = 8;
    const tokenBIndex = 9;
    const tokenAAccount = accounts[tokenAIndex];
    const tokenBAccount = accounts[tokenBIndex];
    const displayData = [
        { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
        { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
    ];

    // Log details when a new LP is found
    console.log("TransactionTime: " + tx.blockTime*1000);
    console.log("TimeNow: " + Date.now());
    console.log("DetectionSpeed: " + ((Date.now() - tx.blockTime*1000) / 1000) + " seconds after listing");
    console.log("Transaction: https://solscan.io/tx/" + txId);
    console.table(displayData);

    // Continue if a SOL pair...
    if (tokenAAccount == "So11111111111111111111111111111111111111112" || tokenBAccount == "So11111111111111111111111111111111111111112") {

      const tokenAccount = tokenAAccount == "So11111111111111111111111111111111111111112" ? tokenBAccount : tokenAAccount;

      // Check if mint and freeze authority are revoked
      const tokenDetails = execSync("sudo spl-token display " + tokenAccount.toBase58(), { encoding: 'utf-8' }).toString().split("\n");
      const tokenProgram = tokenDetails[3].split(":")[1].trim();
      const tokenDecimals = Number(tokenDetails[5].split(":")[1].trim());
      const tokenSupply = Number(tokenDetails[4].split(":")[1].trim()) / (10 ** tokenDecimals);
      const mintAuthority = tokenDetails[6].trim();
      const freezeAuthority = tokenDetails[7].trim();
      console.log(tokenDetails);
      if (mintAuthority == "Mint authority: (not set)") { console.log("SAFE: MINT AUTH REVOKED") } else { console.log("DANGER: CAN MINT MORE") }
      if (freezeAuthority == "Freeze authority: (not set)") { console.log("SAFE: FREEZE AUTH REVOKED") } else { console.log("DANGER: CAN FREEZE TOKEN") }

      // Verify the top 10 holders hold less than 70% of the total supply, and no single holder has more than 20% of the total supply
      const topTokenHolders = await getTokenBalances(tokenProgram, tokenAccount);
      const topTenHoldersSupply = topTokenHolders[0] + topTokenHolders[1] + topTokenHolders[2] + topTokenHolders[3] + topTokenHolders[4] + topTokenHolders[5] + topTokenHolders[6] + topTokenHolders[7] + topTokenHolders[8] + topTokenHolders[9];
      const highTokenConcentration = topTenHoldersSupply > (tokenSupply * .7);
      const topHolderSupply = topTokenHolders[0];
      const singleBigTokenHolder = topHolderSupply > (tokenSupply * .2);
      if (!highTokenConcentration) { console.log("SAFE: BROAD HOLDER DISTRIBUTION") } else { console.log("DANGER: HIGH TOKEN CONCENTRATION IN TOP 10 HOLDERS") }
      if (!singleBigTokenHolder) { console.log("SAFE: NO MEGA WHALE") } else { console.log("DANGER: SINGLE TOKEN HOLDER HOLDS HUGE SUPPLY") }

      // todo: make a basic SOL<>USDC swap on raydium, then swap back
      // then, ill know what data gets used
      // ill be able to reference this for the analogous data for the memecoin pool


      // [wont do for v1] mega whale or concentrated distribution
      // [wont do for v1] check for Low liquidity (under $5k)...
      // [wont do for v1] check if LP receipt not burned...

      // this works if i indeed keep catching them within 3 seconds of listing!
      // buy with .01 SOL...
      // sell 30 seconds later...
      // [later] split sells into 4 25% sells every 15 seconds

    } else {
      console.log("NOT A SOL PAIR... MOVING ON...");
      return;
    }
}



main(connection, raydium).catch(console.error);

// swap();
