import { feedEventSchema } from '@caprail/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.ts'
import { createSessionTokens } from '../auth/jwt.ts'
import { memoryNonceStore } from '../auth/nonce-store.ts'
import { createFeed } from '../index/feed.ts'
import { memoryIndexReader } from '../index/memory-reader.ts'
import { seed } from '../index/test-seed.ts'

type Frame = { event: string; data: string }

// A blank line ends an SSE frame.
const FRAME_END = '\n\n'

// Reads SSE frames off the response, `count` non-ping frames at a time.
function frames(res: Response) {
  const reader = res.body?.getReader()
  if (reader === undefined) throw new Error('no body')
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    next: async (count: number): Promise<Frame[]> => {
      const out: Frame[] = []
      while (out.length < count) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end = buffer.indexOf(FRAME_END)
        while (end >= 0) {
          const raw = buffer.slice(0, end)
          buffer = buffer.slice(end + FRAME_END.length)
          const event = /^event: (.*)$/m.exec(raw)?.[1] ?? ''
          const data = /^data: (.*)$/m.exec(raw)?.[1] ?? ''
          if (event !== 'ping') out.push({ event, data })
          end = buffer.indexOf(FRAME_END)
        }
      }
      return out
    },
    close: () => reader.cancel().catch(() => undefined),
  }
}

function build(heartbeatMs = 10_000) {
  const data = seed()
  const reader = memoryIndexReader(data.index)
  const tokens = createSessionTokens({ secret: 's'.repeat(32) })
  const feed = createFeed({
    source: (id, since) => reader.feed({ companyId: id }, id, since),
    intervalMs: 5,
    onError: () => {},
  })
  const app = createApp({
    logger: pino({ level: 'silent' }),
    webOrigins: ['http://localhost:5173'],
    health: { ping: () => Promise.resolve(), cursor: () => Promise.resolve(null) },
    auth: { nonces: memoryNonceStore(), tokens, memberships: reader.membershipsOf },
    reader,
    feed,
    heartbeatMs,
  })
  const open = async (wallet: typeof data.admin) => {
    const control = new AbortController()
    const res = await app.request(`/companies/${data.companyId}/events`, {
      headers: { authorization: `Bearer ${await tokens.sign({ wallet, memberships: [] })}` },
      signal: control.signal,
    })
    return { res, control }
  }
  return { app, data, reader, feed, open }
}

describe('GET /companies/:id/events', () => {
  it('is a panel route: session and role required', async () => {
    const { app, data, open } = build()
    expect((await app.request(`/companies/${data.companyId}/events`)).status).toBe(401)
    const { res, control } = await open(data.alice)
    expect(res.status).toBe(403)
    control.abort()
  })

  it('says ready, then streams what lands after the connection, and lets go on abort', async () => {
    const { data, reader, feed, open } = build()
    const { res, control } = await open(data.admin)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)

    const stream = frames(res)
    const [ready] = await stream.next(1)
    expect(ready).toEqual({ event: 'ready', data: '{}' })
    expect(feed.active()).toEqual([data.companyId])

    await new Promise((resolve) => setTimeout(resolve, 12))
    await reader.reportAttempt(
      { companyId: data.companyId },
      {
        mint: data.mint,
        sourceOwner: data.alice,
        destOwner: data.stranger,
        amount: '5',
        reasonCode: 'AccreditationExpired',
        logs: ['x'],
      },
      data.alice,
      new Date(),
    )
    const [frame] = await stream.next(1)
    expect(frame?.event).toBe('attempt')
    const parsed = feedEventSchema.parse(JSON.parse(frame?.data ?? ''))
    if (parsed.kind !== 'attempt') throw new Error('expected an attempt')
    expect(parsed.entry.reasonCode).toBe('AccreditationExpired')
    expect(parsed.entry.origin).toBe('simulation')

    // Closing the connection unsubscribes the last listener: the poller is gone.
    control.abort()
    await stream.close()
    await new Promise((resolve) => setTimeout(resolve, 12))
    expect(feed.active()).toEqual([])
  })
})
