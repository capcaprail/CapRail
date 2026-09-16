// The measurements of the M1 table (TASKS.md), taken on a live network.
//
// Not a test but a measurement: the tests prove the code does what it says; these
// numbers are what the milestone table quotes. Every attempt here is a real
// transaction — refused ones included, which is why every send skips preflight.
//
// Amounts vary per attempt (1, 2, 3, …): two transfers with the same accounts, the
// same amount and the same blockhash are the same transaction, and the node would
// report the second as "already processed" — a duplicate, not a second refusal.
import type { Keypair, PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext, mapConcurrent, waitChainTimePast } from './context.ts'
import {
  createTokenAccount,
  type Log,
  setStatus,
  type Token,
  tokenBalance,
  transfer,
  transferRefused,
} from './scenarios/us1.ts'
import { PassedThrough, type Refused, type Sent, TransactionRefused } from './send.ts'

/** In flight at once. Locally the node keeps up; a public node gets the paced fetch too. */
const CONCURRENCY = { local: 8, remote: 2 } as const

/** One kind of non-admission, as in the mollusk set of T021: each has its own reason. */
export type Kind = 'no-record' | 'status-none' | 'revoked' | 'expired'

export const KINDS: readonly Kind[] = ['no-record', 'status-none', 'revoked', 'expired']

export type Admission = {
  readonly attempts: number
  readonly refused: number
  /** Attempts that went through — the SC-001 failures, by signature. */
  readonly passed: readonly string[]
  /** Refusals by reason from the logs; `unknown` for a refusal without an Anchor line. */
  readonly byReason: Readonly<Record<string, number>>
  /** Per kind: how many refused, and the first refusal in full — a fixture for the log parser. */
  readonly byKind: Readonly<Record<Kind, { refused: number; sample: Refused | undefined }>>
  /** Every refusal with the wallet it was addressed to — what the panel must show (SC-004). */
  readonly refusals: readonly { readonly recipient: string; readonly refused: Refused }[]
  /** Token balances did not move: recipients stayed at 0, the sender at what it had. */
  readonly balancesUnchanged: boolean
  readonly feeLamports: readonly number[]
}

export type Allowed = {
  readonly attempts: number
  readonly passed: number
  readonly refused: readonly string[]
  readonly feeLamports: readonly number[]
  /** `getBalance` of the sender before and after — the fees are all it paid. */
  readonly senderLamportsDelta: number
  /** Every transfer that went through — what the cap table must reflect (SC-003). */
  readonly landed: readonly Sent[]
}

/** One status change and the next transfer after it. */
export type Propagation = {
  readonly change: 'revoke' | 'approve'
  readonly statusSlot: number
  readonly transferSlot: number
  readonly transferBlockTime: number | undefined
  readonly slots: number
  /** `blockTime` difference — the chain's own clock, whole seconds. */
  readonly chainSeconds: number | undefined
  /** Wall clock between the status confirmation and the transfer verdict — includes polling. */
  readonly wallMs: number
  readonly verdict: 'refused' | 'passed'
  readonly reason: string | undefined
  readonly signature: string
}

export type Measurements = {
  readonly admission: Admission
  readonly allowed: Allowed
  readonly propagation: readonly Propagation[]
  /** Seconds per slot on this network during the run — every slot-based number depends on it. */
  readonly secondsPerSlot: number | undefined
}

const count = (values: readonly (string | undefined)[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const value of values) {
    const key = value ?? 'unknown'
    out[key] = (out[key] ?? 0) + 1
  }
  return out
}

/**
 * The four kinds of non-admission, prepared on chain. Each recipient gets a token
 * account (anyone can create one — that is not admission) and a registry state.
 */
async function prepareKinds(
  ctx: DemoContext,
  token: Token,
  log: Log,
): Promise<Record<Kind, PublicKey>> {
  const { keys, connection } = ctx
  const now = BigInt(await chainTime(connection))
  const recipients: Record<Kind, PublicKey> = {
    'no-record': keys.stranger.publicKey,
    'status-none': keys.pending.publicKey,
    revoked: keys.revoked.publicKey,
    expired: keys.expired.publicKey,
  }
  for (const wallet of Object.values(recipients)) await createTokenAccount(ctx, token, wallet)

  await setStatus(ctx, token, recipients['status-none'], 'none', 0n)
  await setStatus(ctx, token, recipients.revoked, 'approved', now + 3600n)
  await setStatus(ctx, token, recipients.revoked, 'revoked', now + 3600n)
  // The program refuses an expiry already in the past; so: admit for a few seconds
  // and let the chain clock pass it. The clock is read right before the transaction,
  // with room for its confirmation — a value computed earlier had already expired by
  // the time it landed. Strict comparison in the hook, so "past" is `>`.
  const soon = BigInt(await chainTime(connection)) + 8n
  await setStatus(ctx, token, recipients.expired, 'approved', soon)
  log('  waiting for the chain clock to pass the short expiry…')
  await waitChainTimePast(connection, Number(soon))
  return recipients
}

/** SC-001: `perKind × 4` transfers to non-admitted recipients; every one must be refused. */
export async function measureAdmission(
  ctx: DemoContext,
  token: Token,
  sender: Keypair,
  perKind: number,
  log: Log,
): Promise<Admission> {
  const recipients = await prepareKinds(ctx, token, log)
  const senderBefore = await tokenBalance(ctx, token, sender.publicKey)

  const attempts = KINDS.flatMap((kind) =>
    Array.from({ length: perKind }, (_, i) => ({ kind, amount: BigInt(i + 1) })),
  )
  const outcomes = await mapConcurrent(
    attempts,
    ctx.local ? CONCURRENCY.local : CONCURRENCY.remote,
    async ({
      kind,
      amount,
    }): Promise<{ kind: Kind; refused: Refused | undefined; passed: Sent | undefined }> => {
      try {
        return {
          kind,
          refused: await transferRefused(ctx, token, sender, recipients[kind], amount),
          passed: undefined,
        }
      } catch (error) {
        if (error instanceof PassedThrough) return { kind, refused: undefined, passed: error.sent }
        throw error
      }
    },
  )

  const refused = outcomes.filter((o) => o.refused !== undefined)
  const byKind = Object.fromEntries(
    KINDS.map((kind) => {
      const ofKind = refused.filter((o) => o.kind === kind)
      return [kind, { refused: ofKind.length, sample: ofKind[0]?.refused }]
    }),
  ) as Record<Kind, { refused: number; sample: Refused | undefined }>

  const senderAfter = await tokenBalance(ctx, token, sender.publicKey)
  const recipientBalances = await Promise.all(
    Object.values(recipients).map((wallet) => tokenBalance(ctx, token, wallet)),
  )

  return {
    attempts: attempts.length,
    refused: refused.length,
    passed: outcomes.flatMap((o) => (o.passed ? [o.passed.signature] : [])),
    byReason: count(refused.map((o) => o.refused?.reason)),
    byKind,
    refusals: refused.flatMap((o) =>
      o.refused === undefined
        ? []
        : [{ recipient: recipients[o.kind].toBase58(), refused: o.refused }],
    ),
    balancesUnchanged: senderAfter === senderBefore && recipientBalances.every((b) => b === 0n),
    feeLamports: refused.flatMap((o) =>
      o.refused?.feeLamports === undefined ? [] : [o.refused.feeLamports],
    ),
  }
}

/** SC-002 and SC-010: `total` transfers between two admitted investors, each fee recorded. */
export async function measureAllowed(
  ctx: DemoContext,
  token: Token,
  sender: Keypair,
  recipient: PublicKey,
  total: number,
): Promise<Allowed> {
  const { connection } = ctx
  const lamportsBefore = await connection.getBalance(sender.publicKey, 'confirmed')
  const attempts = Array.from({ length: total }, (_, i) => BigInt(i + 1))
  const outcomes = await mapConcurrent(
    attempts,
    ctx.local ? CONCURRENCY.local : CONCURRENCY.remote,
    async (amount): Promise<{ sent: Sent | undefined; refused: string | undefined }> => {
      try {
        return { sent: await transfer(ctx, token, sender, recipient, amount), refused: undefined }
      } catch (error) {
        if (error instanceof TransactionRefused) {
          return { sent: undefined, refused: error.detail.signature }
        }
        throw error
      }
    },
  )
  const lamportsAfter = await connection.getBalance(sender.publicKey, 'confirmed')
  const sent = outcomes.flatMap((o) => (o.sent ? [o.sent] : []))
  return {
    attempts: total,
    passed: sent.length,
    refused: outcomes.flatMap((o) => (o.refused === undefined ? [] : [o.refused])),
    feeLamports: sent.flatMap((s) => (s.feeLamports === undefined ? [] : [s.feeLamports])),
    senderLamportsDelta: lamportsBefore - lamportsAfter,
    landed: sent,
  }
}

/**
 * SC-011: a status change takes effect on the very next transfer. Measured in slots
 * between the status transaction and the transfer's verdict, with `blockTime` as
 * the chain's own seconds; the wall clock is reported too, but it includes the
 * client's confirmation polling and is the larger, less honest number.
 */
export async function measurePropagation(
  ctx: DemoContext,
  token: Token,
  sender: Keypair,
  recipient: PublicKey,
): Promise<Propagation[]> {
  const now = BigInt(await chainTime(ctx.connection))
  const steps: { change: Propagation['change']; expect: Propagation['verdict'] }[] = [
    { change: 'revoke', expect: 'refused' },
    { change: 'approve', expect: 'passed' },
  ]
  const out: Propagation[] = []
  for (const step of steps) {
    const status = await setStatus(
      ctx,
      token,
      recipient,
      step.change === 'revoke' ? 'revoked' : 'approved',
      now + 3600n,
    )
    const started = Date.now()
    let landed: Sent | Refused
    let verdict: Propagation['verdict']
    if (step.expect === 'refused') {
      landed = await transferRefused(ctx, token, sender, recipient, 1n)
      verdict = 'refused'
    } else {
      landed = await transfer(ctx, token, sender, recipient, 1n)
      verdict = 'passed'
    }
    const wallMs = Date.now() - started
    out.push({
      change: step.change,
      statusSlot: status.slot,
      transferSlot: landed.slot,
      transferBlockTime: landed.blockTime,
      slots: landed.slot - status.slot,
      chainSeconds:
        status.blockTime === undefined || landed.blockTime === undefined
          ? undefined
          : landed.blockTime - status.blockTime,
      wallMs,
      verdict,
      reason: 'reason' in landed ? landed.reason : undefined,
      signature: landed.signature,
    })
  }
  return out
}

type Point = { readonly slot: number; readonly blockTime: number | undefined }

/** Seconds per slot from the first and last transaction of the run: measured, not assumed. */
export function secondsPerSlot(first: Point, last: Point): number | undefined {
  if (first.blockTime === undefined || last.blockTime === undefined) return undefined
  const slots = last.slot - first.slot
  return slots > 0 ? (last.blockTime - first.blockTime) / slots : undefined
}
