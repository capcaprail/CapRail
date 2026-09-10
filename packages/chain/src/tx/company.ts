import { BN } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import { companyPda } from '../pda.ts'
import type { CaprailProgram } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

// Company-level instructions (FR-003, FR-004). Pure: every address is derived from the
// arguments, nothing is read from the network, and the tests run without a node.

/** The program stores the name as 32 bytes; the limit is in bytes, not characters. */
export const COMPANY_NAME_MAX_BYTES = 32

export type CreateCompanyArgs = {
  /** Chosen by the client; a taken id fails on `init` rather than overwriting. */
  readonly companyId: bigint
  /** The signer becomes the administrator. */
  readonly admin: PublicKey
  readonly complianceOfficer: PublicKey
  readonly name: string
}

export async function buildCreateCompany(
  program: CaprailProgram,
  args: CreateCompanyArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .createCompany({
      companyId: new BN(args.companyId.toString()),
      complianceOfficer: args.complianceOfficer,
      name: args.name,
    })
    .accountsStrict({
      admin: args.admin,
      company: companyPda(args.companyId),
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('create-company', args.admin, [instruction])
}

export type SetRolesArgs = {
  readonly company: PublicKey
  /** The current administrator — the only one who can hand the roles over. */
  readonly admin: PublicKey
  readonly newAdmin: PublicKey
  readonly newComplianceOfficer: PublicKey
}

export async function buildSetRoles(program: CaprailProgram, args: SetRolesArgs): Promise<TxPlan> {
  const instruction = await program.methods
    .setRoles(args.newAdmin, args.newComplianceOfficer)
    .accountsStrict({ admin: args.admin, company: args.company })
    .instruction()

  return toPlan('set-roles', args.admin, [instruction])
}
