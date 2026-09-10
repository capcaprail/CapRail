// The US1 story, as the milestone demo tells it (TASKS.md → M1 "what we show"):
// a company → a token → two admitted investors → the distribution passes → a
// third-party wallet sends to a stranger, without preflight → the network refuses,
// with the reason in the logs.
//
// "Third-party wallet" means the tooling, not the sender: the transfer is a plain
// Token-2022 `transfer_checked` built by `@solana/spl-token` the way any wallet
// builds it, with the hook's accounts resolved from the chain. The sender is an
// admitted investor who holds tokens; the recipient is the stranger.
import {
  ata,
  buildCreateCompany,
  buildCreateToken,
  buildDistribute,
  buildSetInvestorStatus,
  buildSetPolicy,
  buildTransfer,
  companyPda,
  type InvestorStatus,
  TOKEN_2022_PROGRAM_ID,
  type TransferPolicyInput,
  tokenAddresses,
} from '@caprail/chain'
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext, fund } from '../context.ts'
import { expectRefusal, type Refused, type Sent, submit, submitPlan } from '../send.ts'

export type Token = {
  readonly company: PublicKey
  readonly mint: PublicKey
  readonly decimals: number
}

/** Every transaction of the story, by name — the dump for T027 reads them from here. */
export type Us1Transactions = {
  readonly createCompany: Sent
  readonly createToken: Sent
  readonly setPolicy: Sent
  readonly setInvestorStatus: Sent
  readonly distribute: Sent
  readonly transferAllowed: Sent
  readonly transferRefused: Refused
}

export type Us1Result = {
  readonly token: Token
  readonly transactions: Us1Transactions
}

export const POLICY: TransferPolicyInput = {
  requireAccreditation: true,
  // Refused by the program until M4; the demo sets what the program accepts.
  requireRofr: false,
  rofrWindowSecs: 0,
}

export const DECIMALS = 0
export const TOTAL_SUPPLY = 1_000_000n
export const ALICE_SHARE = 100_000n
export const BOB_SHARE = 50_000n
const ONE_YEAR = 365n * 24n * 3600n

export type Log = (line: string) => void

/** SOL each key gets. Generous locally; from a wallet on devnet, this is the budget. */
const SOL = { admin: 5, officer: 0.5, investor: 0.5 } as const

export async function fundKeys(
  ctx: DemoContext,
  payer: Keypair | undefined,
  log: Log,
): Promise<void> {
  const { keys, connection } = ctx
  const plan: [Keypair, number][] = [
    [keys.admin, SOL.admin],
    [keys.complianceOfficer, SOL.officer],
    [keys.alice, SOL.investor],
    [keys.bob, SOL.investor],
  ]
  for (const [key, sol] of plan) {
    const ok = await fund(connection, key.publicKey, sol, payer)
    if (!ok) log(`  airdrop to ${key.publicKey.toBase58()} failed — continuing on what it has`)
  }
}

export async function setStatus(
  ctx: DemoContext,
  token: Token,
  wallet: PublicKey,
  status: InvestorStatus,
  expiresAt: bigint,
): Promise<Sent> {
  const officer = ctx.keys.complianceOfficer
  const plan = await buildSetInvestorStatus(ctx.program, {
    company: token.company,
    mint: token.mint,
    complianceOfficer: officer.publicKey,
    wallet,
    status,
    expiresAt,
    jurisdiction: 'UA',
    investorType: 1,
  })
  return await submitPlan(ctx.connection, plan, [officer])
}

/**
 * A token account for `owner`, paid by the admin. Anyone can create anyone's ATA;
 * having one is not admission — which is exactly what the refused transfers show.
 */
export async function createTokenAccount(
  ctx: DemoContext,
  token: Token,
  owner: PublicKey,
): Promise<Sent> {
  const admin = ctx.keys.admin
  const instruction = createAssociatedTokenAccountIdempotentInstruction(
    admin.publicKey,
    ata(owner, token.mint),
    owner,
    token.mint,
    TOKEN_2022_PROGRAM_ID,
  )
  return await submit(ctx.connection, admin.publicKey, [instruction], [admin])
}

/** Wallet → wallet through the hook, as a third-party wallet would build it. */
export async function transfer(
  ctx: DemoContext,
  token: Token,
  owner: Keypair,
  recipient: PublicKey,
  amount: bigint,
): Promise<Sent> {
  const plan = await buildTransfer(ctx.connection, {
    mint: token.mint,
    owner: owner.publicKey,
    recipient,
    amount,
    decimals: token.decimals,
  })
  return await submitPlan(ctx.connection, plan, [owner])
}

export async function transferRefused(
  ctx: DemoContext,
  token: Token,
  owner: Keypair,
  recipient: PublicKey,
  amount: bigint,
): Promise<Refused> {
  const plan = await buildTransfer(ctx.connection, {
    mint: token.mint,
    owner: owner.publicKey,
    recipient,
    amount,
    decimals: token.decimals,
  })
  return await expectRefusal(ctx.connection, plan, [owner])
}

export async function tokenBalance(
  ctx: DemoContext,
  token: Token,
  owner: PublicKey,
): Promise<bigint> {
  const balance = await ctx.connection.getTokenAccountBalance(ata(owner, token.mint), 'confirmed')
  return BigInt(balance.value.amount)
}

// A random u64: two runs against the same ledger must not collide on `init`.
function randomCompanyId(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return new DataView(bytes.buffer).getBigUint64(0, true)
}

export async function runUs1(ctx: DemoContext, log: Log): Promise<Us1Result> {
  const { keys, program, connection } = ctx
  const admin = keys.admin

  const companyId = randomCompanyId()
  const company = companyPda(companyId)
  log(`company ${company.toBase58()} (id ${companyId})`)
  const createCompany = await submitPlan(
    connection,
    await buildCreateCompany(program, {
      companyId,
      admin: admin.publicKey,
      complianceOfficer: keys.complianceOfficer.publicKey,
      name: 'Demo Corp',
    }),
    [admin],
  )
  log(`  create_company ${createCompany.signature}`)

  const addresses = tokenAddresses(company, 0)
  const token: Token = { company, mint: addresses.mint, decimals: DECIMALS }
  const createToken = await submitPlan(
    connection,
    await buildCreateToken(program, {
      company,
      admin: admin.publicKey,
      tokenIndex: 0,
      name: 'Demo Corp Shares',
      symbol: 'DEMO',
      uri: '',
      decimals: DECIMALS,
      totalSupply: TOTAL_SUPPLY,
      policy: POLICY,
    }),
    [admin],
  )
  log(`  create_token   ${createToken.signature} — mint ${token.mint.toBase58()}`)
  const state = await program.account.company.fetch(company)
  if (state.tokenCount !== 1) throw new Error(`token_count after create_token: ${state.tokenCount}`)

  // The same policy again: version 2 of the same rule. The story does not need it; the
  // log parser (T027) needs a real `PolicySet` transaction.
  const setPolicy = await submitPlan(
    connection,
    await buildSetPolicy(program, {
      company,
      mint: token.mint,
      admin: admin.publicKey,
      policy: POLICY,
    }),
    [admin],
  )
  log(`  set_policy     ${setPolicy.signature}`)

  const expiresAt = BigInt(await chainTime(connection)) + ONE_YEAR
  const setInvestorStatus = await setStatus(ctx, token, keys.alice.publicKey, 'approved', expiresAt)
  await setStatus(ctx, token, keys.bob.publicKey, 'approved', expiresAt)
  log(`  set_investor_status ×2 (alice, bob approved) ${setInvestorStatus.signature}`)

  const distribute = await submitPlan(
    connection,
    await buildDistribute(program, {
      company,
      mint: token.mint,
      admin: admin.publicKey,
      investor: keys.alice.publicKey,
      amount: ALICE_SHARE,
    }),
    [admin],
  )
  await submitPlan(
    connection,
    await buildDistribute(program, {
      company,
      mint: token.mint,
      admin: admin.publicKey,
      investor: keys.bob.publicKey,
      amount: BOB_SHARE,
    }),
    [admin],
  )
  log(`  distribute ×2  ${distribute.signature} (alice ${ALICE_SHARE}, bob ${BOB_SHARE})`)

  const transferAllowed = await transfer(ctx, token, keys.alice, keys.bob.publicKey, 10n)
  log(`  transfer alice → bob 10: passed ${transferAllowed.signature}`)

  await createTokenAccount(ctx, token, keys.stranger.publicKey)
  const refused = await transferRefused(ctx, token, keys.alice, keys.stranger.publicKey, 10n)
  log(
    `  transfer alice → stranger 10, skipPreflight: refused on chain — ${refused.reason} ${refused.signature}`,
  )

  const alice = await tokenBalance(ctx, token, keys.alice.publicKey)
  const bob = await tokenBalance(ctx, token, keys.bob.publicKey)
  const stranger = await tokenBalance(ctx, token, keys.stranger.publicKey)
  if (alice !== ALICE_SHARE - 10n || bob !== BOB_SHARE + 10n || stranger !== 0n) {
    throw new Error(`balances after the story: alice ${alice}, bob ${bob}, stranger ${stranger}`)
  }
  log(`  balances: alice ${alice}, bob ${bob}, stranger ${stranger}`)

  return {
    token,
    transactions: {
      createCompany,
      createToken,
      setPolicy,
      setInvestorStatus,
      distribute,
      transferAllowed,
      transferRefused: refused,
    },
  }
}
