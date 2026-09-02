import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'

export const HEALTH_TIMEOUT_MS = 2_000

export type IndexerCursor = { slot: bigint; updatedAt: Date }

export type HealthDeps = {
  ping: () => Promise<void>
  cursor: () => Promise<IndexerCursor | null>
  now?: () => number
  timeoutMs?: number
}

// A dependency that hangs is, for a healthcheck, the same as one that failed —
// without a cap the probe hangs as long as the database does and Railway sees a
// timeout instead of `ok: false`.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`dependency did not answer in ${ms} ms`)), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

// `ok` is reachability of the database — what the Railway probe and the keep-alive
// ask. `cursorSlot`/`lag` describe the indexer: null until the worker has written a
// cursor, which is "nothing indexed yet", not "fresh".
export function healthRoute(deps: HealthDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => Date.now())
  const timeoutMs = deps.timeoutMs ?? HEALTH_TIMEOUT_MS

  return new Hono<AppEnv>().get('/health', async (c) => {
    let ok = true
    let cursor: IndexerCursor | null = null
    try {
      await withTimeout(deps.ping(), timeoutMs)
      cursor = await withTimeout(deps.cursor(), timeoutMs)
    } catch (err) {
      ok = false
      c.get('logger')?.error({ err }, 'health check failed')
    }
    const lag =
      cursor === null ? null : Math.max(0, Math.round((now() - cursor.updatedAt.getTime()) / 1000))
    return c.json(
      { ok, cursorSlot: cursor === null ? null : Number(cursor.slot), lag },
      ok ? 200 : 503,
    )
  })
}
