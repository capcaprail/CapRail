import type { FeedEvent } from '@caprail/shared'
import type { FeedBatch, FeedMarks } from './reader.ts'

export const FEED_INTERVAL_MS = 1_000

export type FeedSource = (companyId: string, since: FeedMarks | null) => Promise<FeedBatch>

export type FeedListener = (event: FeedEvent) => void

export type Feed = {
  // Starts polling the company when its first listener arrives, stops with the
  // last one. Returns the unsubscribe.
  subscribe: (companyId: string, listener: FeedListener) => () => void
  // For tests and shutdown: companies currently being polled.
  active: () => string[]
}

export type FeedOptions = {
  source: FeedSource
  intervalMs?: number
  onError: (err: unknown, companyId: string) => void
}

type Watch = {
  listeners: Set<FeedListener>
  marks: FeedMarks | null
  timer: ReturnType<typeof setInterval>
  polling: boolean
}

// The worker and the API are separate services on a pooled connection, which rules
// out LISTEN/NOTIFY (pgbouncer in transaction mode drops it) and in-process events.
// So the feed polls: one timer per company, shared by every stream of that company,
// so N open panels cost one query per tick, not N. What has been delivered is the
// source's business: it hands back the marks to continue from.
export function createFeed(options: FeedOptions): Feed {
  const intervalMs = options.intervalMs ?? FEED_INTERVAL_MS
  const watches = new Map<string, Watch>()

  async function poll(companyId: string, watch: Watch): Promise<void> {
    // A slow query must not pile up ticks behind itself.
    if (watch.polling) return
    watch.polling = true
    try {
      const batch = await options.source(companyId, watch.marks)
      for (const event of batch.events) {
        for (const listener of watch.listeners) listener(event)
      }
      watch.marks = batch.marks
    } catch (err) {
      options.onError(err, companyId)
    } finally {
      watch.polling = false
    }
  }

  return {
    subscribe(companyId, listener) {
      let watch = watches.get(companyId)
      if (watch === undefined) {
        const created: Watch = {
          listeners: new Set(),
          marks: null,
          polling: false,
          timer: setInterval(() => void poll(companyId, created), intervalMs),
        }
        watches.set(companyId, created)
        watch = created
        // The first poll takes the marks: a stream starts from now.
        void poll(companyId, created)
      }
      watch.listeners.add(listener)
      return () => {
        const current = watches.get(companyId)
        if (current === undefined) return
        current.listeners.delete(listener)
        if (current.listeners.size === 0) {
          clearInterval(current.timer)
          watches.delete(companyId)
        }
      }
    },
    active: () => [...watches.keys()],
  }
}
