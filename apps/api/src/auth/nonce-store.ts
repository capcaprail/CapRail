import { type Db, schema } from '@caprail/db'
import type { WalletAddress } from '@caprail/shared'
import { and, eq, gt } from 'drizzle-orm'

export type NonceStore = {
  issue: (wallet: WalletAddress, nonce: string, expiresAt: Date) => Promise<void>
  // True exactly once per issued nonce: the row is removed as it is read, so two
  // concurrent verifies with the same nonce cannot both succeed.
  consume: (wallet: WalletAddress, nonce: string, now: Date) => Promise<boolean>
}

// One row per wallet (primary key): a fresh nonce replaces the previous one, so a
// wallet cannot accumulate valid nonces by asking repeatedly.
export function drizzleNonceStore(db: Db): NonceStore {
  const { authNonces } = schema
  return {
    async issue(wallet, nonce, expiresAt) {
      await db
        .insert(authNonces)
        .values({ wallet, nonce, expiresAt })
        .onConflictDoUpdate({ target: authNonces.wallet, set: { nonce, expiresAt } })
    },
    async consume(wallet, nonce, now) {
      const deleted = await db
        .delete(authNonces)
        .where(
          and(
            eq(authNonces.wallet, wallet),
            eq(authNonces.nonce, nonce),
            gt(authNonces.expiresAt, now),
          ),
        )
        .returning({ wallet: authNonces.wallet })
      return deleted.length === 1
    },
  }
}

// Test double with the same single-use semantics; lives here so route tests and a
// future CLI share one implementation instead of each inventing a map.
export function memoryNonceStore(): NonceStore {
  const rows = new Map<WalletAddress, { nonce: string; expiresAt: Date }>()
  return {
    issue(wallet, nonce, expiresAt) {
      rows.set(wallet, { nonce, expiresAt })
      return Promise.resolve()
    },
    consume(wallet, nonce, now) {
      const row = rows.get(wallet)
      if (row === undefined || row.nonce !== nonce || row.expiresAt <= now) {
        return Promise.resolve(false)
      }
      rows.delete(wallet)
      return Promise.resolve(true)
    },
  }
}
