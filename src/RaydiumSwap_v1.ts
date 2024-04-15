import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction, TransactionMessage } from '@solana/web3.js'
import {
  Liquidity,
  LiquidityPoolKeys,
  jsonInfo2PoolKeys,
  LiquidityPoolJsonInfo,
  TokenAccount,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
  Percent,
  SPL_ACCOUNT_LAYOUT,
} from '@raydium-io/raydium-sdk'
import { Wallet } from '@coral-xyz/anchor'
import bs58 from 'bs58'

/**
 * Class representing a Raydium Swap operation.
 */
class RaydiumSwap {
  allPoolKeysJson: LiquidityPoolJsonInfo[]
  connection: Connection
  wallet: Wallet

    /**
   * Create a RaydiumSwap instance.
   * @param {string} RPC_URL - The RPC URL for connecting to the Solana blockchain.
   * @param {string} WALLET_PRIVATE_KEY - The private key of the wallet in base58 format.
   */
  constructor(RPC_URL: string, WALLET_PRIVATE_KEY: string) {
    this.connection = new Connection(RPC_URL
      , { commitment: 'confirmed' })
    this.wallet = new Wallet(Keypair.fromSecretKey(Uint8Array.from(bs58.decode(WALLET_PRIVATE_KEY))))
  }

   /**
   * Loads all the pool keys available from a JSON configuration file.
   * @async
   * @returns {Promise<void>}
   */
  async loadPoolKeys(liquidityFile: string) {
    const liquidityJsonResp = await fetch(liquidityFile);
    if (!liquidityJsonResp.ok) return console.log("ERROR GETTING LIQUIDITY FILE")
    const liquidityJson = (await liquidityJsonResp.json()) as { official: any; unOfficial: any }
    const allPoolKeysJson = [...(liquidityJson?.official ?? []), ...(liquidityJson?.unOfficial ?? [])]

    this.allPoolKeysJson = allPoolKeysJson
  }

    /**
   * Finds pool information for the given token pair.
   * @param {string} mintA - The mint address of the first token.
   * @param {string} mintB - The mint address of the second token.
   * @returns {LiquidityPoolKeys | null} The liquidity pool keys if found, otherwise null.
   */
  findPoolInfoForTokens(mintA: string, mintB: string) {
    const poolData = this.allPoolKeysJson.find(
      (i) => (i.baseMint === mintA && i.quoteMint === mintB) || (i.baseMint === mintB && i.quoteMint === mintA)
    )

    if (!poolData) return null

    return jsonInfo2PoolKeys(poolData) as LiquidityPoolKeys
  }

    /**
   * Retrieves token accounts owned by the wallet.
   * @async
   * @returns {Promise<TokenAccount[]>} An array of token accounts.
   */
  async getOwnerTokenAccounts() {
    const walletTokenAccount = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    })

    return walletTokenAccount.value.map((i) => ({
      pubkey: i.pubkey,
      programId: i.account.owner,
      accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
    }))
  }

    /**
   * Builds a swap transaction.
   * @async
   * @param {string} toToken - The mint address of the token to receive.
   * @param {number} amount - The amount of the token to swap.
   * @param {LiquidityPoolKeys} poolKeys - The liquidity pool keys.
   * @param {number} [maxLamports=100000] - The maximum lamports to use for transaction fees.
   * @param {boolean} [useVersionedTransaction=true] - Whether to use a versioned transaction.
   * @param {'in' | 'out'} [fixedSide='in'] - The fixed side of the swap ('in' or 'out').
   * @returns {Promise<Transaction | VersionedTransaction>} The constructed swap transaction.
   */
  async getSwapTransaction(
    toToken: string,
    amount: number,
    poolKeys: LiquidityPoolKeys,
    maxLamports: number = 100000,
    useVersionedTransaction = true,
    fixedSide: 'in' | 'out' = 'in',
    command,
    primedTokenAccount,
  ): Promise<Transaction | VersionedTransaction> {
    const directionIn = poolKeys.quoteMint.toString() == toToken
    const { minAmountOut, amountIn } = await this.calcAmountOut(poolKeys, amount, directionIn)
    // console.log("minAmountOut: " + minAmountOut.numerator.toNumber() + " / " + minAmountOut.denominator.toNumber());
    // console.log("amountIn: " + amountIn.numerator.toNumber() + " / " + amountIn.denominator.toNumber());
    const userTokenAccounts = await this.getOwnerTokenAccounts()
    const swapTransaction = await Liquidity.makeSwapInstructionSimple({
      connection: this.connection,
      makeTxVersion: useVersionedTransaction ? 0 : 1,
      poolKeys: {
        ...poolKeys,
      },
      userKeys: {
        tokenAccounts: userTokenAccounts,
        owner: this.wallet.publicKey,
      },
      amountIn: amountIn,
      amountOut: minAmountOut,
      fixedSide: fixedSide,
      config: {
        bypassAssociatedCheck: false,
      },
      computeBudgetConfig: {
        microLamports: maxLamports,
      },
    })

    // Precreate tokenAccount only does instructions 1, 2, and 3. (compute, create tokenAccount, initialize tokenAccount)
    // Buy only does instructions 1, 4, and 5. (compute, create memecoin tokenAccount, raydium swap)
    // Sell only does instruction 1 and 5 (which is instruction 4 for a sell because the memecoin tokenAccount already exists). (compute, raydium swap)
    // CloseAccount only does instruction 6. (close account)
    // const computeBudgetInstruction = (command == "buy" || command == "sell") && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(0, 1) : null; // instruction 1
    // const buyRaydiumInstructions = command == "buy" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(3, 5) : null; // instructions 4 and 5
    // const sellRaydiumInstructions = command == "sell" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(3, 4) : null; // instruction 5
    // const closeAccountInstructions = command == "closeAccount" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(5, 6) : null; // instruction 6
    // const createAccountInstructions = command == "precreateAccount" ? swapTransaction.innerTransactions[0].instructions.slice(0, 3) : null; // instructions 1, 2, and 3
    // const instructionsArray = command == "precreateAccount" ? createAccountInstructions : command == "buy" && primedTokenAccount ? computeBudgetInstruction.concat(buyRaydiumInstructions) : command == "sell" && primedTokenAccount ? computeBudgetInstruction.concat(sellRaydiumInstructions) : command == "closeAccount" && primedTokenAccount ? closeAccountInstructions : swapTransaction.innerTransactions[0].instructions;

    // Trying the above without instruction 1 (compute budget)
    const buyRaydiumInstructions = command == "buy" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(3, 5) : null; // instructions 4 and 5
    const sellRaydiumInstructions = command == "sell" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(3, 4) : null; // instruction 5
    const closeAccountInstructions = command == "closeAccount" && primedTokenAccount ? swapTransaction.innerTransactions[0].instructions.slice(5, 6) : null; // instruction 6
    const createAccountInstructions = command == "precreateAccount" ? swapTransaction.innerTransactions[0].instructions.slice(1, 3) : null; // instructions 2 and 3
    const instructionsArray = command == "precreateAccount" ? createAccountInstructions : command == "buy" && primedTokenAccount ? buyRaydiumInstructions : command == "sell" && primedTokenAccount ? sellRaydiumInstructions : command == "closeAccount" && primedTokenAccount ? closeAccountInstructions : swapTransaction.innerTransactions[0].instructions;

    if (command == "buy" && primedTokenAccount) {
      instructionsArray[1].keys[15].pubkey = primedTokenAccount; // replace the primedTokenAccount in instruction 5 as "Source Account"
    }
    if (command == "sell" && primedTokenAccount) {
      instructionsArray[0].keys[16].pubkey = primedTokenAccount; // replace the primedTokenAccount in instruction 5 as "Destination Account"
    }
    if (command == "closeAccount" && primedTokenAccount) {
      instructionsArray[0].keys[0].pubkey = primedTokenAccount; // replace the primedTokenAccount in instruction 6
    }

    const recentBlockhashForSwap = await this.connection.getLatestBlockhash()
    const instructions = instructionsArray.filter(Boolean)

    if (useVersionedTransaction) {
      const versionedTransaction = new VersionedTransaction(
        new TransactionMessage({
          payerKey: this.wallet.publicKey,
          recentBlockhash: recentBlockhashForSwap.blockhash,
          instructions: instructions,
        }).compileToV0Message()
      )

      versionedTransaction.sign([this.wallet.payer])

      return versionedTransaction
    }

    const legacyTransaction = new Transaction({
      blockhash: recentBlockhashForSwap.blockhash,
      lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
      feePayer: this.wallet.publicKey,
    })

    legacyTransaction.add(...instructions)

    return legacyTransaction
  }

    /**
   * Sends a legacy transaction.
   * @async
   * @param {Transaction} tx - The transaction to send.
   * @returns {Promise<string>} The transaction ID.
   */
  async sendLegacyTransaction(tx: Transaction, maxRetries?: number) {
    const txid = await this.connection.sendTransaction(tx, [this.wallet.payer], {
      skipPreflight: false,
      maxRetries: maxRetries,
    })

    return txid
  }

    /**
   * Sends a versioned transaction.
   * @async
   * @param {VersionedTransaction} tx - The versioned transaction to send.
   * @returns {Promise<string>} The transaction ID.
   */
  async sendVersionedTransaction(tx: VersionedTransaction, maxRetries?: number) {
    const txid = await this.connection.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: maxRetries,
    })

    return txid
  }

 /**
   * Simulates a versioned transaction.
   * @async
   * @param {VersionedTransaction} tx - The versioned transaction to simulate.
   * @returns {Promise<any>} The simulation result.
   */
  async simulateLegacyTransaction(tx: Transaction) {
    const txid = await this.connection.simulateTransaction(tx, [this.wallet.payer])

    return txid
  }

    /**
   * Simulates a versioned transaction.
   * @async
   * @param {VersionedTransaction} tx - The versioned transaction to simulate.
   * @returns {Promise<any>} The simulation result.
   */
  async simulateVersionedTransaction(tx: VersionedTransaction) {
    const txid = await this.connection.simulateTransaction(tx)

    return txid
  }

    /**
   * Gets a token account by owner and mint address.
   * @param {PublicKey} mint - The mint address of the token.
   * @returns {TokenAccount} The token account.
   */
  getTokenAccountByOwnerAndMint(mint: PublicKey) {
    return {
      programId: TOKEN_PROGRAM_ID,
      pubkey: PublicKey.default,
      accountInfo: {
        mint: mint,
        amount: 0,
      },
    } as unknown as TokenAccount
  }

    /**
   * Calculates the amount out for a swap.
   * @async
   * @param {LiquidityPoolKeys} poolKeys - The liquidity pool keys.
   * @param {number} rawAmountIn - The raw amount of the input token.
   * @param {boolean} swapInDirection - The direction of the swap (true for in, false for out).
   * @returns {Promise<Object>} The swap calculation result.
   */
  async calcAmountOut(poolKeys: LiquidityPoolKeys, rawAmountIn: number, swapInDirection: boolean) {
    const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys })

    let currencyInMint = poolKeys.baseMint
    let currencyInDecimals = poolInfo.baseDecimals
    let currencyOutMint = poolKeys.quoteMint
    let currencyOutDecimals = poolInfo.quoteDecimals

    if (!swapInDirection) {
      currencyInMint = poolKeys.quoteMint
      currencyInDecimals = poolInfo.quoteDecimals
      currencyOutMint = poolKeys.baseMint
      currencyOutDecimals = poolInfo.baseDecimals
    }

    const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals)
    const amountIn = new TokenAmount(currencyIn, rawAmountIn, false)
    const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals)
    const slippage = new Percent(90, 100) // 90% slippage

    const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut,
      slippage,
    })

    return {
      amountIn,
      amountOut,
      minAmountOut,
      currentPrice,
      executionPrice,
      priceImpact,
      fee,
    }
  }
}

export default RaydiumSwap