import 'dotenv/config';
import RaydiumSwap from './RaydiumSwap';
import { Transaction, VersionedTransaction, Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { execSync } from 'child_process';
import axios from 'axios';
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"; // --> Raydium "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8" // --> competitor sniper bot "AupTbxArPau5H97izWurgska1hEvFNrYM1U8Yy9ijrWU"
const raydium = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(`https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`, {
    wsEndpoint: `wss://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


// Global variable
let swapConfig = {
  executeSwap: true, // Send tx when true, simulate tx when false
  useVersionedTransaction: true,
  tokenAAmount: 0.001, // Swap 0.01 SOL for USDT in this example
  tokenAAddress: "So11111111111111111111111111111111111111112", // Token to swap for the other, SOL in this case
  tokenBAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC address
  maxLamports: 1000000, // Micro lamports for priority fee
  direction: "in" as "in" | "out", // Swap direction: 'in' or 'out'
  liquidityFile: "https://api.raydium.io/v2/sdk/liquidity/mainnet.json",
  maxRetries: 20,
};

let tradePlaced = false; // <-- TEMPORARY FOR TESTING!!!


// ====================================
// === Start of out-of-the-box code ===
// ====================================

// Performs a token swap on the Raydium protocol. Depending on the configuration, it can execute the swap or simulate it.
const swap = async (poolInfo) => {

  if (tradePlaced) { // <-- TEMPORARY FOR TESTING!!!
    console.log("NOT PLACING TRADE, DUE TO TESTING");
  } else {
    tradePlaced = true;

    const simRes = swapConfig.useVersionedTransaction
      ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
      : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);

    console.log(simRes);

    // The RaydiumSwap instance for handling swaps.
    const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY);
    console.log(`Raydium swap initialized`);
    console.log(`Swapping ${swapConfig.tokenAAmount} of ${swapConfig.tokenAAddress} for ${swapConfig.tokenBAddress}...`)

    // Prepare the swap transaction with the given parameters.
    const tx = await raydiumSwap.getSwapTransaction(
      swapConfig.tokenBAddress,
      swapConfig.tokenAAmount,
      poolInfo,
      swapConfig.maxLamports,
      swapConfig.useVersionedTransaction,
      swapConfig.direction
    );


    // // Depending on the configuration, execute or simulate the swap.
    if (swapConfig.executeSwap) {
      // Send the transaction to the network and log the transaction ID.
      const txid = swapConfig.useVersionedTransaction
        ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction, swapConfig.maxRetries)
        : await raydiumSwap.sendLegacyTransaction(tx as Transaction, swapConfig.maxRetries);
      console.log(`https://solscan.io/tx/${txid}`);
    } else {
      // Simulate the transaction and log the result.
      const simRes = swapConfig.useVersionedTransaction
        ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
        : await raydiumSwap.simulateLegacyTransaction(tx as Transaction);
      console.log(simRes);
    }
  }
};


// ==================================
// === End of out-of-the-box code ===
// ==================================

// Helper function to get pool info
async function getPoolData(idoAccountString) {
  try {
    // const idoPoolInfo = await connection.getAccountInfo(new PublicKey(idoAccountString));
    // if (!idoPoolInfo) {
    //   console.log("No pool info found for IDO: " + idoAccountString);
    //   return;
    // }
    // const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(idoPoolInfo.data);
    // console.log(idoPoolInfo);
    // return poolInfo;

    const response = await axios.post("https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/", {
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [
        idoAccountString,
        {
          "encoding": "jsonParsed",
          "commitment": "confirmed"
        }
      ],
    });

    const binaryString = atob(response.data.result.value.data[0]);
    const uint8Array = Uint8Array.from(binaryString, (char) => char.charCodeAt(0));
    const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(Buffer.from(uint8Array));
    return poolInfo;

  } catch (error) {
    throw new Error(`Error: ${error}`);
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

            if (!tradePlaced && logs && logs.some(log => log.includes("initialize2"))) { // <----- TEMPORARY CHECK FOR tradePlaced!!!!!! // <-- TEMPORARY FOR TESTING!!!
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

    const raydiumIdoIdAccount = accounts[4];
    const tokenAAccount = accounts[9];
    const tokenBAccount = accounts[8];
    const displayData = [
        { "Token": "IDO", "Account Public Key": raydiumIdoIdAccount.toBase58() },
        { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
        { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
    ];

    // Log details when a new LP is found
    console.log("TransactionTime: " + tx.blockTime*1000);
    console.log("TimeNow: " + Date.now());
    console.log("DetectionSpeed: " + ((Date.now() - tx.blockTime*1000) / 1000) + " seconds after listing");
    console.log("Transaction: https://solscan.io/tx/" + txId);
    console.table(displayData);

    // Get pool info from the IDO
    const poolInfo = await getPoolData(raydiumIdoIdAccount.toBase58());

    // Continue if a SOL pair... FOR SIMPLICITY'S SAKE, ONLY TRADING PAIRS WHERE SOL IS THE TOKEN-A
    if (tokenAAccount == "So11111111111111111111111111111111111111112") {

      const tokenAccount = tokenBAccount;
      swapConfig.tokenBAddress = tokenBAccount;

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

      swap(poolInfo);

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





//
// {
//   id: PublicKey [PublicKey(BYEFi2Bquys5FT91XriudrH2kqZx2gYaUEQ6ypUogJQ4)] {
//     _bn: <BN: 9c94dc369606dc3098ff9ef8e04ef436dbcf64b2210aea908cf3f700470a6a35>
//   },
//   baseMint: PublicKey [PublicKey(HKgonhHkRSCtQWzCtQgFNsu8TEcf3oWau8xH87Si3LuB)] {
//     _bn: <BN: f28474778f1f194ca52583b762ac1f60f66cc949b956a5f9a0539e9143970efe>
//   },
//   quoteMint: PublicKey [PublicKey(So11111111111111111111111111111111111111112)] {
//     _bn: <BN: 69b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001>
//   },
//   lpMint: PublicKey [PublicKey(GhqWe5ZgZAZv6SpB5ajzsf6Xs8yWKzbd1v6TC6XnJVDX)] {
//     _bn: <BN: e9556349df6bb7ccfeacfdf3efe911e8e8bb2fba58bba75ce72c07f9503c46be>
//   },
//   baseDecimals: 6,
//   quoteDecimals: 9,
//   lpDecimals: 6,
//   version: 4,
//   programId: PublicKey [PublicKey(675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8)] {
//     _bn: <BN: 4bd949c43602c33f207790ed16a3524ca1b9975cf121a2a90cffec7df8b68acd>
//   },
//   authority: PublicKey [PublicKey(5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1)] {
//     _bn: <BN: 4157b0580f31c5fce44a62582dbcf9d78ee75943a084a393b350368d22899308>
//   },
//   openOrders: PublicKey [PublicKey(BVAZAZSnsxaYFWRKrQ2BuGUJxmk7boG1bYVqYw3N5gsq)] {
//     _bn: <BN: 9bcbef6fcbeb0f594487fbd0c94ccae4879924df08018f0c1d39ec895d63dd30>
//   },
//   targetOrders: PublicKey [PublicKey(42BtD4tph5pKkwWYAeHTEaxYiLNWBZQaTozC6MBb1uP4)] {
//     _bn: <BN: 2ce0f26951bda6ddc58b536723f1e33960090f0cac905d954472949527c4232f>
//   },
//   baseVault: PublicKey [PublicKey(FiGHbjwnhjcCYcF2a4KngLaRj8zw9sTV7SVUMdzWAWPw)] {
//     _bn: <BN: da95b6dbb969a0cc471c9a13caefe1361328fd5940634e5342322cbfefc0531e>
//   },
//   quoteVault: PublicKey [PublicKey(DVpoas1ibW9omBq7DvzWApDaeVz5nF59985kkeVDtKdq)] {
//     _bn: <BN: b9ae8e96a9a3d5261c17ca1d64e25cddb084ae8709cdb071097ad0bec0319ed8>
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
//   marketId: PublicKey [PublicKey(HxMEbmzdy3rUwvJH42b2NR8wqH7xyWy73zz26Tgwy1FK)] {
//     _bn: <BN: fbe8d08411a1b4b8396f9fc7edd2201ee0afe04747d4b9ebeb6299f19c34debe>
//   },
//   marketAuthority: PublicKey [PublicKey(2cxQ4FqfQR7jvFDFMEAJMaGqawRU7gTRZfXtiSRRra6a)] {
//     _bn: <BN: 1811a746789c6649f684d5887ddde8e7238e23e6a963a6bc6b28b3c594ef16cf>
//   },
//   marketBaseVault: PublicKey [PublicKey(4XX8AwAn9NReRfBipoebxCBt8jXwuMy7ufjneP7qfhPy)] {
//     _bn: <BN: 34648bc43586be81057ef2963305b960fe2cb729b57103c95fd12e62e58e0084>
//   },
//   marketQuoteVault: PublicKey [PublicKey(FnpvRnkKznjeqzsuV9ceCNA5aSddN3b4fgNbu8R5SgfB)] {
//     _bn: <BN: dbc0f0214853141530b43268abde77cb5d346ba6048dbedd3f5f137d7324a00a>
//   },
//   marketBids: PublicKey [PublicKey(7xudwbqcW6oA2iBomv6X2zvxQ35215LsmAhEgJ6ckzgQ)] {
//     _bn: <BN: 677895333c043cbb71853c4c4ccc07b3f61496b7f91336185c0067836e0c14b9>
//   },
//   marketAsks: PublicKey [PublicKey(5WzzPFZqDqafnc3XFsF9xJv6mLok4FPJRbAa9cR6NaHT)] {
//     _bn: <BN: 431e28f3419e20fa5f686fdb10ef47e072e3894b9e43961b13df301df65194b6>
//   },
//   marketEventQueue: PublicKey [PublicKey(D5U7nM5nMWTgBFANKSLhgnBUh6qgaw2Ux391vmSNjLgK)] {
//     _bn: <BN: b3713a416ebb746635df35388a24d898dc20fc533b395ae14488a1eeb1aa5b94>
//   }
// }
