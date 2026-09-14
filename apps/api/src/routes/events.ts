import type { FeedEvent } from '@caprail/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppEnv } from '../env.ts'
import type { Feed } from '../index/feed.ts'

// Proxies (Railway's included) close an idle response; a comment-sized event keeps
// the connection alive and costs the panel nothing.
export const HEARTBEAT_MS = 15_000

export type EventsDeps = {
  feed: Feed
  heartbeatMs?: number
}

// SSE `/companies/:id/events`: `event:` is the record's `kind` (`attempt`, `status`,
// `policy`), `data:` the JSON of a `FeedEvent`. The stream starts from the moment
// of connection; the panel loads the page first and listens for what follows.
// Mounted behind the same middleware as the other company routes.
export function eventsRoute(deps: EventsDeps): Hono<AppEnv> {
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS

  return new Hono<AppEnv>().get('/companies/:id/events', (c) =>
    streamSSE(c, async (stream) => {
      const companyId = c.req.param('id')
      const queue: FeedEvent[] = []
      let wake: (() => void) | null = null
      const notify = () => {
        wake?.()
        wake = null
      }
      const unsubscribe = deps.feed.subscribe(companyId, (event) => {
        queue.push(event)
        notify()
      })
      const heartbeat = setInterval(notify, heartbeatMs)
      stream.onAbort(() => {
        unsubscribe()
        clearInterval(heartbeat)
        notify()
      })
      await stream.writeSSE({ event: 'ready', data: '{}' })

      while (!stream.aborted && !stream.closed) {
        const event = queue.shift()
        if (event !== undefined) {
          await stream.writeSSE({ event: event.kind, data: JSON.stringify(event) })
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        if (queue.length === 0 && !stream.aborted) {
          await stream.writeSSE({ event: 'ping', data: '' })
        }
      }
    }),
  )
}
