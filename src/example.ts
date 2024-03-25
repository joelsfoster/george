import { Connection, PublicKey } from "@solana/web3.js";
import { LIQUIDITY_STATE_LAYOUT_V4 } from "@raydium-io/raydium-sdk";

// Establish connection
const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const RAYDIUM_PUBLIC_KEY = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const raydiumAddress = new PublicKey(RAYDIUM_PUBLIC_KEY);
const connection = new Connection(`https://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`, {
    wsEndpoint: `wss://frosty-little-smoke.solana-mainnet.quiknode.pro/73dd488f4f17e21f5d57bf14098b87a2de4e7d81/`,
    httpHeaders: {"x-session-hash": SESSION_HASH}
});


// Helper function to get pool info
async function getPoolData(connection, raydiumIdoAccount) {
  try {
    const idoPoolInfo = await connection.getAccountInfo(raydiumIdoAccount);
    if (!idoPoolInfo) {
      console.log("No pool info found for IDO: " + raydiumIdoAccount.toBase58());
      return;
    }
    const poolInfo = LIQUIDITY_STATE_LAYOUT_V4.decode(idoPoolInfo.data);
    return poolInfo;
  } catch (error) {
    throw new Error(`Error: ${error}`);
  }
}


// Monitor logs and proceed if new LP found
async function main(connection, raydiumAddress) {
    console.log("Monitoring logs for program:", raydiumAddress.toString());
    connection.onLogs(
        raydiumAddress,
        ({ logs, err, signature }) => {
            if (err) return;

            if (logs && logs.some(log => log.includes("initialize2"))) {
                console.log("=== New LP Found ===");
                fetchRaydiumAccounts(signature, connection);
            }
        },
        "confirmed"
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

    const raydiumIdoAccount = accounts[4];
    const tokenAAccount = accounts[9];
    const tokenBAccount = accounts[8];
    const displayData = [
        { "Token": "IDO", "Account Public Key": raydiumIdoAccount.toBase58() },
        { "Token": "A", "Account Public Key": tokenAAccount.toBase58() },
        { "Token": "B", "Account Public Key": tokenBAccount.toBase58() }
    ];

    // Print details when a new LP is found
    console.log("Transaction: https://solscan.io/tx/" + txId);
    console.table(displayData);

    // Get pool info from the IDO
    const poolInfo = await getPoolData(connection, raydiumIdoAccount);
    console.log(poolInfo);
}


main(connection, raydiumAddress).catch(console.error);
