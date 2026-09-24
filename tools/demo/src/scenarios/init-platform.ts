// The platform's one-time setup (T035): the fee, the stablecoin offers are priced in,
// and the account the fee lands in.
//
// This is the one command of the product that is not driven by a browser wallet: the
// `authority` key signs it and then stays offline. It is sent once per deployed program
// — `init_platform` uses `init`, so a second run is refused by the chain, and this
// command refuses before it builds the transaction.
//
// Without `--payment-mint` it also issues the demo stablecoin: a Token-2022 mint with 6
// decimals, like USDC. Its mint authority is the same offline key, so whoever holds the
// key can top a demo buyer up later; the devnet USDC faucet is not something a demo can
// depend on.
import { buildInitPlatform, FEE_BPS_MAX, platformFee, platformPda, toPlan } from '@caprail/chain'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { type DemoContext, fund, loadKeypair } from '../context.ts'
import { submit, submitPlan } from '../send.ts'
import type { Log } from './us1.ts'

/** The demo stablecoin: 6 decimals, like USDC — prices in the panel read as dollars. */
export const USD_DECIMALS = 6

/** 1 % of the payment. The customer's number; the program caps it at 10 %. */
const DEFAULT_FEE_BPS = 100
const DEFAULT_MINT_AMOUNT = 1_000_000n

/** SOL the authority gets locally: a mint, two token accounts and the config. */
const LOCAL_TOPUP_SOL = 2

export type InitPlatformOptions = {
  /** The offline key: signs, pays, stays the platform's authority. */
  readonly authority: string
  readonly feeBps: number
  /** An existing stablecoin (devnet USDC, say) instead of issuing the demo one. */
  readonly paymentMint: PublicKey | undefined
  /** Whose token account collects the fee; the authority by default. */
  readonly feeTreasuryOwner: PublicKey | undefined
  /** A wallet to top up with demo stablecoin in the same run. */
  readonly mintTo: PublicKey | undefined
  /** Whole stablecoins, not base units. */
  readonly mintAmount: bigint
}

/** The payment side of the platform: which mint, under which token program. */
type Payment = {
  readonly mint: PublicKey
  readonly tokenProgram: PublicKey
  readonly decimals: number
}

function address(value: string | undefined, flag: string): PublicKey | undefined {
  if (value === undefined) return undefined
  try {
    return new PublicKey(value)
  } catch {
    throw new Error(`${flag}: not an address — ${value}`)
  }
}

export function parseInitPlatformArgs(argv: readonly string[]): InitPlatformOptions {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const authority = value('--authority')
  if (authority === undefined) {
    throw new Error('init-platform needs --authority <keypair.json> — the key that stays offline')
  }
  const feeBps = Number(value('--fee-bps') ?? DEFAULT_FEE_BPS)
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    throw new Error(`--fee-bps must be an integer 0..=${FEE_BPS_MAX}`)
  }
  const mintAmount = BigInt(value('--mint-amount') ?? DEFAULT_MINT_AMOUNT)
  if (mintAmount <= 0n) throw new Error('--mint-amount must be positive')
  const paymentMint = address(value('--payment-mint'), '--payment-mint')
  const mintTo = address(value('--mint-to'), '--mint-to')
  if (paymentMint !== undefined && mintTo !== undefined) {
    throw new Error('--mint-to only works with the demo stablecoin: this demo is not its issuer')
  }
  return {
    authority,
    feeBps,
    paymentMint,
    feeTreasuryOwner: address(value('--fee-treasury-owner'), '--fee-treasury-owner'),
    mintTo,
    mintAmount,
  }
}

/** What the chain already says about the platform, or nothing at all. */
async function existingPlatform(ctx: DemoContext): Promise<
  | {
      readonly authority: PublicKey
      readonly paymentMint: PublicKey
      readonly feeTreasury: PublicKey
      readonly feeBps: number
    }
  | undefined
> {
  const config = await ctx.program.account.platformConfig.fetchNullable(platformPda())
  return config === null ? undefined : config
}

/**
 * The demo stablecoin. A plain Token-2022 mint: no metadata, and deliberately no
 * extensions at all — `init_platform` refuses a payment mint that does not transfer the
 * exact amount, and a wallet showing "unknown token" is a smaller price than a mint the
 * platform cannot be configured with.
 */
async function issueStablecoin(ctx: DemoContext, authority: Keypair, log: Log): Promise<Payment> {
  const mint = Keypair.generate()
  const space = getMintLen([])
  const lamports = await ctx.connection.getMinimumBalanceForRentExemption(space)
  await submit(
    ctx.connection,
    authority.publicKey,
    [
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mint.publicKey,
        space,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        USD_DECIMALS,
        authority.publicKey,
        // No freeze authority: the demo stablecoin freezes nobody, and the rule of the
        // capital token belongs to the hook, not to the money.
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [authority, mint],
  )
  log(`  issued the demo stablecoin ${mint.publicKey.toBase58()} — ${USD_DECIMALS} decimals`)
  return { mint: mint.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: USD_DECIMALS }
}

/**
 * An existing stablecoin is read, not taken on trust: the token program is whichever
 * one owns it (real stablecoins are mostly on the classic one), and a wrong address
 * here would be a platform that cannot be reconfigured.
 */
async function readStablecoin(ctx: DemoContext, mint: PublicKey, log: Log): Promise<Payment> {
  const info = await ctx.connection.getAccountInfo(mint, 'confirmed')
  if (info === null) throw new Error(`--payment-mint: no account at ${mint.toBase58()}`)
  const state = await getMint(ctx.connection, mint, 'confirmed', info.owner)
  log(
    `  payment mint ${mint.toBase58()} — ${state.decimals} decimals, token program ${info.owner.toBase58()}`,
  )
  return { mint, tokenProgram: info.owner, decimals: state.decimals }
}

/** `amount` whole stablecoins in base units. */
const units = (amount: bigint, decimals: number): bigint => amount * 10n ** BigInt(decimals)

export async function runInitPlatform(
  ctx: DemoContext,
  options: InitPlatformOptions,
  log: Log,
): Promise<boolean> {
  const authority = loadKeypair(options.authority)
  log(`authority ${authority.publicKey.toBase58()} — the key that signs this once`)

  const already = await existingPlatform(ctx)
  if (already !== undefined) {
    log('')
    log(`the platform is already initialized at ${platformPda().toBase58()}:`)
    log(`  authority     ${already.authority.toBase58()}`)
    log(`  payment mint  ${already.paymentMint.toBase58()}`)
    log(`  fee treasury  ${already.feeTreasury.toBase58()}`)
    log(`  fee           ${already.feeBps} bps`)
    log('init_platform runs once per deployed program; nothing was sent.')
    return false
  }

  if (ctx.local && (await ctx.connection.getBalance(authority.publicKey, 'confirmed')) === 0) {
    await fund(ctx.connection, authority.publicKey, LOCAL_TOPUP_SOL, undefined)
  }

  const payment =
    options.paymentMint === undefined
      ? await issueStablecoin(ctx, authority, log)
      : await readStablecoin(ctx, options.paymentMint, log)

  const feeTreasuryOwner = options.feeTreasuryOwner ?? authority.publicKey
  const feeTreasury = getAssociatedTokenAddressSync(
    payment.mint,
    feeTreasuryOwner,
    true,
    payment.tokenProgram,
  )
  const plan = await buildInitPlatform(ctx.program, {
    authority: authority.publicKey,
    paymentMint: payment.mint,
    feeTreasury,
    feeBps: options.feeBps,
  })
  // The fee account is created in the same transaction as the config that names it:
  // `init_platform` takes an existing token account, and a config pointing at an
  // account nobody created would be a platform that cannot collect.
  const sent = await submitPlan(
    ctx.connection,
    toPlan('init-platform', authority.publicKey, [
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        feeTreasury,
        feeTreasuryOwner,
        payment.mint,
        payment.tokenProgram,
      ),
      ...plan.instructions,
    ]),
    [authority],
  )

  if (options.mintTo !== undefined) {
    const recipient = getAssociatedTokenAddressSync(
      payment.mint,
      options.mintTo,
      true,
      payment.tokenProgram,
    )
    await submit(
      ctx.connection,
      authority.publicKey,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          authority.publicKey,
          recipient,
          options.mintTo,
          payment.mint,
          payment.tokenProgram,
        ),
        createMintToInstruction(
          payment.mint,
          recipient,
          authority.publicKey,
          units(options.mintAmount, payment.decimals),
          [],
          payment.tokenProgram,
        ),
      ],
      [authority],
    )
    log(`  minted ${options.mintAmount} demo stablecoins to ${options.mintTo.toBase58()}`)
  }

  const sample = units(1_000n, payment.decimals)
  log('')
  log('── platform ──')
  log(`  config        ${platformPda().toBase58()}`)
  log(`  authority     ${authority.publicKey.toBase58()}`)
  log(`  payment mint  ${payment.mint.toBase58()}`)
  log(`  fee treasury  ${feeTreasury.toBase58()} (owner ${feeTreasuryOwner.toBase58()})`)
  log(
    `  fee           ${options.feeBps} bps — ${platformFee(options.feeBps, sample)} of ${sample} base units, a trade of 1000`,
  )
  log(`  signature     ${sent.signature}`)
  if (options.paymentMint === undefined) {
    log('keep the authority key: it is also the mint authority of the demo stablecoin.')
  }
  return true
}
