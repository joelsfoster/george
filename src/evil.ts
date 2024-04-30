import { createMint, getMint, getOrCreateAssociatedTokenAccount, getAccount, mintTo } from '@solana/spl-token';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';
import { percentAmount, generateSigner, signerIdentity, createSignerFromKeypair } from '@metaplex-foundation/umi'
import { TokenStandard, createAndMint } from '@metaplex-foundation/mpl-token-metadata'
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCandyMachine } from "@metaplex-foundation/mpl-candy-machine";

const SESSION_HASH = 'QNDEMO' + Math.ceil(Math.random() * 1e9); // Random unique identifier for your session
const connection = new Connection(process.env.RPC_URL, {
    wsEndpoint: process.env.WS_URL,
    httpHeaders: {"x-session-hash": SESSION_HASH},
    commitment: "confirmed"
});


// =============================
// ===== MINTING UTILITIES =====
// =============================

const payer = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)));
const mintAuthority = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)));
const freezeAuthority = Keypair.fromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)));

// Mint a new token, create an ATA for me, and deposit all the minted tokens in my ATA
const mintNewToken = async (tokenName, tokenSymbol, tokenUri) => { // "Adler", "ADLER", null
  const umi = createUmi(process.env.RPC_URL);
  const userWallet = umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(bs58.decode(process.env.WALLET_PRIVATE_KEY)));
  const userWalletSigner = createSignerFromKeypair(umi, userWallet);

  const mint = generateSigner(umi);
  umi.use(signerIdentity(userWalletSigner));
  umi.use(mplCandyMachine())

  const metadata = {
      name: tokenName,
      symbol: tokenSymbol,
      uri: tokenUri,
  };

  createAndMint(umi, {
      mint,
      authority: umi.identity,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadata.uri,
      sellerFeeBasisPoints: percentAmount(0),
      decimals: 9,
      amount: 1000000_000000000, // use the right amount of decimals!
      tokenOwner: userWallet.publicKey,
      tokenStandard: TokenStandard.Fungible,
      }).sendAndConfirm(umi).then(() => {
      console.log("MINT SUCCESSFUL: " + mint.publicKey); // 4qjjafRozeX5iCHgVqSQPb4Qz25BsxSryoKPWZLdMXzV
  });
}


// Get total supply for a given token
const getSupply = async (mintAddress) => { // "4qjjafRozeX5iCHgVqSQPb4Qz25BsxSryoKPWZLdMXzV"
  const mintInfo = await getMint(
    connection,
    new PublicKey(mintAddress)
  );
  console.log(mintInfo);
  console.log("TOTAL SUPPLY: " + (Number(mintInfo.supply) / (10 ** mintInfo.decimals)));
}


// Find my ATA for a given token
const getOrCreateAta = async (mintAddress) => { // "4qjjafRozeX5iCHgVqSQPb4Qz25BsxSryoKPWZLdMXzV"
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    payer,
    new PublicKey(mintAddress),
    payer.publicKey
  );
  console.log("MY ATA ADDRESS: " + tokenAccount.address.toBase58()); // F81bPLLNvaYo7RakAjYDu2CfseCdLVHPtfNChfeq4Lv3
}


// Issue new tokens for an already-minted token, good for inflating supply to a burn address if necessary
const issueNewTokens = async (mintAddress, recipientAddress, amount, decimals) => { // "4qjjafRozeX5iCHgVqSQPb4Qz25BsxSryoKPWZLdMXzV", "HD252auFv5vH6oLePaPGBoA7ZcgbmmqKp8bHcYJ4azkr", 100, 9
  await mintTo(
    connection,
    payer,
    new PublicKey(mintAddress),
    new PublicKey(recipientAddress), // "1nc1nerator11111111111111111111111111111111"
    mintAuthority,
    amount * (10 ** decimals)
  );
  console.log("ISSUED " + amount + " TOKENS!");
  await getSupply(mintAddress);
  await getOrCreateAta(mintAddress);
}


// ==================================
// ===== AMM CREATION UTILITIES =====
// ==================================
