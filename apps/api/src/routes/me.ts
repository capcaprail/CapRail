import type { Me } from '@caprail/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'
import type { IndexReader } from '../index/reader.ts'
import { type PlatformSource, withQuote } from '../platform.ts'

export type MeDeps = {
  reader: Pick<IndexReader, 'cabinet'>
  platform: PlatformSource
  now?: () => Date
}

// The investor's cabinet (FR-016), scoped to the session's wallet only: positions
// with the admission the hook would apply now, and the wallet's own open offers.
// Admin and compliance-officer keys get one too — a role in a company is not a
// reason to hide what the same key holds.
export function meRoute(deps: MeDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>().get('/me', async (c) => {
    const { wallet } = c.get('session')
    const [cabinet, platform] = await Promise.all([
      deps.reader.cabinet({ wallet }, wallet, now()),
      deps.platform(),
    ])
    const body: Me = {
      wallet,
      platform,
      positions: cabinet.positions,
      offers: cabinet.offers.map((offer) => withQuote(offer, platform)),
    }
    return c.json(body)
  })
}
