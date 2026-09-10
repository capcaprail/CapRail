import { BN } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import { investorRecordPda, tokenConfigPda } from '../pda.ts'
import type { CaprailProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

// The investor registry (FR-002). The compliance officer sets a status with their own
// key; the record is created on first use and rewritten afterwards.

export const INVESTOR_STATUSES = ['none', 'approved', 'revoked'] as const

export type InvestorStatus = (typeof INVESTOR_STATUSES)[number]

export type SetInvestorStatusArgs = {
  readonly company: PublicKey
  readonly mint: PublicKey
  readonly complianceOfficer: PublicKey
  readonly wallet: PublicKey
  readonly status: InvestorStatus
  /** Unix seconds. The hook requires `expiresAt > now`; for `none`/`revoked` it is informational. */
  readonly expiresAt: bigint
  /** ISO 3166-1 alpha-2, or an empty string for "not set" (stored as two zero bytes). */
  readonly jurisdiction: string
  readonly investorType: number
}

// Two bytes exactly: the program rejects anything else, and it is better rejected here,
// before the wallet is asked to sign.
export function jurisdictionBytes(code: string): number[] {
  if (code === '') return [0, 0]
  const bytes = new TextEncoder().encode(code)
  if (bytes.length !== 2) throw new RangeError(`jurisdiction must be an alpha-2 code: ${code}`)
  return [...bytes]
}

// Anchor's enum encoding: the variant name as the single key of an object.
const STATUS_VARIANT = {
  none: { none: {} },
  approved: { approved: {} },
  revoked: { revoked: {} },
} as const

export async function buildSetInvestorStatus(
  program: CaprailProgram,
  args: SetInvestorStatusArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setInvestorStatus({
      wallet: args.wallet,
      status: STATUS_VARIANT[args.status],
      expiresAt: new BN(args.expiresAt.toString()),
      jurisdiction: jurisdictionBytes(args.jurisdiction),
      investorType: args.investorType,
    })
    .accountsStrict({
      complianceOfficer: args.complianceOfficer,
      company: args.company,
      tokenConfig: tokenConfigPda(args.mint),
      investorRecord: investorRecordPda(args.mint, args.wallet),
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('set-investor-status', args.complianceOfficer, [instruction])
}
