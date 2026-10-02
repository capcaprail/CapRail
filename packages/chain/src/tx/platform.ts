import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackMint } from '@solana/spl-token'
import type { PublicKey } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import { platformPda } from '../pda.ts'
import type { CaprailProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

// The platform's one-time configuration (FR-013): the fee, the stablecoin offers are
// priced in, and the account the fee lands in. The panel never builds this instruction —
// `authority` is the single key of the product that lives outside a wallet, and the
// instruction is sent once, from `tools/demo init-platform`.

// Limits of `init_platform` (`programs/caprail/src/state/platform_config.rs`).
export const BPS_DENOMINATOR = 10_000
export const FEE_BPS_MAX = 1_000

export type InitPlatformArgs = {
  /** Signs, pays, and stays the platform's authority; lives offline. */
  readonly authority: PublicKey
  readonly paymentMint: PublicKey
  /** A token account of `paymentMint` — the account itself, not its owner. */
  readonly feeTreasury: PublicKey
  readonly feeBps: number
}

/**
 * The fee the platform keeps from a payment, rounded down — the same formula as
 * `PlatformConfig::fee_for`, in the same direction. Both sides see this number before
 * they accept, and the chain must then charge exactly it.
 */
export function platformFee(feeBps: number, payment: bigint): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > FEE_BPS_MAX) {
    throw new RangeError(`fee must be 0..=${FEE_BPS_MAX} basis points: ${feeBps}`)
  }
  return (payment * BigInt(feeBps)) / BigInt(BPS_DENOMINATOR)
}

export async function buildInitPlatform(
  program: CaprailProgram,
  args: InitPlatformArgs,
): Promise<TxPlan> {
  // Rejected here rather than by the chain: this transaction is sent once, by hand.
  platformFee(args.feeBps, 0n)

  const instruction = await program.methods
    .initPlatform(args.feeBps)
    .accountsStrict({
      authority: args.authority,
      platform: platformPda(),
      paymentMint: args.paymentMint,
      feeTreasury: args.feeTreasury,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('init-platform', args.authority, [instruction])
}

/** `PlatformConfig` plus what its payment mint says about itself. */
export type PlatformState = {
  readonly feeBps: number
  readonly paymentMint: PublicKey
  readonly feeTreasury: PublicKey
  /** The owner of the payment mint: Token-2022 or the classic token program. */
  readonly paymentTokenProgram: PublicKey
  readonly paymentDecimals: number
}

/**
 * The platform as the chain has it, or null before `init_platform`. Nothing here can
 * change after it is found — the config has no update instruction and a mint keeps its
 * owner and decimals — so callers may keep the answer for the life of the process.
 */
export async function fetchPlatform(program: CaprailProgram): Promise<PlatformState | null> {
  const config = await program.account.platformConfig.fetchNullable(platformPda())
  if (config === null) return null
  const connection = program.provider.connection
  const info = await connection.getAccountInfo(config.paymentMint)
  // `init_platform` checked the mint; a config pointing at nothing is a broken
  // deployment, and amounts without decimals would be wrong by orders of magnitude.
  if (info === null) {
    throw new Error(`payment mint ${config.paymentMint.toBase58()} does not exist`)
  }
  // `unpackMint` checks the owner against the program it is given, so passing the
  // account's own owner would check nothing.
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`payment mint ${config.paymentMint.toBase58()} is not owned by a token program`)
  }
  const mint = unpackMint(config.paymentMint, info, info.owner)
  return {
    feeBps: config.feeBps,
    paymentMint: config.paymentMint,
    feeTreasury: config.feeTreasury,
    paymentTokenProgram: info.owner,
    paymentDecimals: mint.decimals,
  }
}
