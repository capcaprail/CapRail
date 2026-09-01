import type { ProgramTransaction, TransactionHandler } from '@caprail/indexer'
import type { Cursor, CursorStore } from './cursor.ts'

export const RECENT_CAPACITY = 2_000

export type Pipeline = {
  // Queues a transaction; the subscription callback cannot await, so errors are
  // reported through `onError` rather than thrown.
  push: (tx: ProgramTransaction) => void
  // Same as push but awaits handling; used by backfill, which runs in sequence.
  handle: TransactionHandler
  cursor: () => Cursor | null
  drain: () => Promise<void>
}

export type PipelineDeps = {
  apply: TransactionHandler
  store: CursorStore
  initial: Cursor | null
  onError: (err: unknown, tx: ProgramTransaction) => void
}

// One transaction at a time, in arrival order: the subscription and the periodic
// backfill both feed this, and a transaction seen by both is applied once. The
// recent-set is the in-process guard; across restarts the tables' unique signature
// columns hold the line.
export function createPipeline(deps: PipelineDeps): Pipeline {
  const recent = new Set<string>()
  let cursor = deps.initial
  let chain: Promise<void> = Promise.resolve()

  function remember(signature: string): boolean {
    if (recent.has(signature)) return false
    recent.add(signature)
    if (recent.size > RECENT_CAPACITY) {
      const oldest = recent.values().next().value
      if (oldest !== undefined) recent.delete(oldest)
    }
    return true
  }

  async function apply(tx: ProgramTransaction): Promise<void> {
    if (!remember(tx.signature)) return
    try {
      await deps.apply(tx)
    } catch (err) {
      // Forgotten on failure so the next backfill pass retries it instead of
      // treating it as done.
      recent.delete(tx.signature)
      throw err
    }
    // The cursor only moves forward: a backfilled old transaction arriving after a
    // live one must not drag `until` back and replay the gap forever.
    if (cursor === null || tx.slot >= cursor.slot) {
      cursor = { signature: tx.signature, slot: tx.slot }
      await deps.store.save(cursor)
    }
  }

  const handle: TransactionHandler = (tx) => {
    const next = chain.then(() => apply(tx))
    chain = next.catch((err: unknown) => deps.onError(err, tx))
    return next
  }

  return {
    handle,
    push: (tx) => {
      handle(tx).catch(() => undefined)
    },
    cursor: () => cursor,
    drain: () => chain,
  }
}
