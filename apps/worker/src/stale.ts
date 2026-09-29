import { ata } from '@caprail/chain'
import type { OfferStaleReason } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'

// An offer is a delegation, not escrow (PLAN → risk 6): the seller can revoke it,
// spend the shares or have the account frozen, and none of that passes through our
// program. So the index reads the seller's token account itself, at most this long
// after the last reading — the 30 s cache of the plan is `checked_at`.
export const STALE_TTL_MS = 30_000
// `getMultipleAccounts` takes at most 100 keys; one call per sweep.
export const SWEEP_BATCH = 100

// The fields of a token account `accept_offer` looks at.
export type TokenAccountState = {
  amount: bigint
  delegate: string | null
  delegatedAmount: bigint
  frozen: boolean
}

export type StaleRpc = {
  // In the order asked, null where the account does not exist; `slot` is the slot
  // the whole batch was read at.
  tokenAccounts: (
    accounts: readonly string[],
  ) => Promise<{ slot: number; accounts: (TokenAccountState | null)[] }>
}

export type OpenOffer = {
  offer: string
  mint: string
  seller: string
  remaining: bigint
}

export type Reading = {
  available: bigint
  staleReason: OfferStaleReason | null
  checkedAt: Date
  checkedSlot: bigint
}

export type OfferBook = {
  // Open offers never read or read before `before`, least recently read first.
  due: (before: Date, limit: number) => Promise<OpenOffer[]>
  // Written only if the offer is still open with the `remaining` the reading was
  // judged against, and nothing touched it after `checkedSlot` — otherwise the
  // reading is older than what the index knows. true when written.
  record: (offer: OpenOffer, reading: Reading) => Promise<boolean>
}

// How much of `remaining` the seller's account can deliver, and why not all of it.
// The same conditions `accept_offer` checks before moving anything (`OfferStale`),
// plus the two Token-2022 would refuse on by itself.
export function assess(
  offer: Pick<OpenOffer, 'offer' | 'remaining'>,
  account: TokenAccountState | null,
): { available: bigint; staleReason: OfferStaleReason | null } {
  if (account === null) return { available: 0n, staleReason: 'account_missing' }
  if (account.frozen) return { available: 0n, staleReason: 'frozen' }
  if (account.delegate !== offer.offer) return { available: 0n, staleReason: 'not_delegated' }
  const min = (a: bigint, b: bigint) => (a < b ? a : b)
  const available = min(offer.remaining, min(account.delegatedAmount, account.amount))
  if (available === offer.remaining) return { available, staleReason: null }
  return {
    available,
    staleReason: account.delegatedAmount < offer.remaining ? 'delegation_short' : 'balance_short',
  }
}

export type SweepResult = { due: number; written: number; discarded: number }

export type StaleSweepDeps = {
  book: OfferBook
  rpc: StaleRpc
  now?: () => Date
  ttlMs?: number
}

// One pass: the offers whose reading has expired, one batched read, one write each.
// Run it often — an offer created or touched a moment ago is due at once, the rest
// every `ttlMs`, and a pass with nothing due costs no RPC call.
export function createStaleSweep(deps: StaleSweepDeps): () => Promise<SweepResult> {
  const now = deps.now ?? (() => new Date())
  const ttlMs = deps.ttlMs ?? STALE_TTL_MS
  return async () => {
    const started = now()
    const due = await deps.book.due(new Date(started.getTime() - ttlMs), SWEEP_BATCH)
    if (due.length === 0) return { due: 0, written: 0, discarded: 0 }
    // The offer's account is the seller's ATA: `create_offer` accepts no other.
    const accounts = due.map((o) => ata(new PublicKey(o.seller), new PublicKey(o.mint)).toBase58())
    const read = await deps.rpc.tokenAccounts(accounts)
    let written = 0
    for (const [i, offer] of due.entries()) {
      const reading = {
        ...assess(offer, read.accounts[i] ?? null),
        checkedAt: started,
        checkedSlot: BigInt(read.slot),
      }
      if (await deps.book.record(offer, reading)) written += 1
    }
    return { due: due.length, written, discarded: due.length - written }
  }
}
