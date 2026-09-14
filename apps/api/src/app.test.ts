import { apiErrorSchema } from '@caprail/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from './app.ts'
import { createSessionTokens } from './auth/jwt.ts'
import { memoryNonceStore } from './auth/nonce-store.ts'
import { createFeed } from './index/feed.ts'
import { memoryIndex, memoryIndexReader } from './index/memory-reader.ts'
import { REQUEST_ID_HEADER } from './logger.ts'

const ORIGIN = 'http://localhost:5173'

function build(overrides: Partial<AppDeps> = {}) {
  const reader = memoryIndexReader(memoryIndex())
  return createApp({
    logger: pino({ level: 'silent' }),
    webOrigins: [ORIGIN],
    health: { ping: () => Promise.resolve(), cursor: () => Promise.resolve(null) },
    auth: {
      nonces: memoryNonceStore(),
      tokens: createSessionTokens({ secret: 's'.repeat(32) }),
      memberships: () => Promise.resolve([]),
    },
    reader,
    feed: createFeed({
      source: (id, since) => reader.feed({ companyId: id }, id, since),
      onError: () => {},
    }),
    ...overrides,
  })
}

describe('GET /health', () => {
  it('reports ok with no cursor while nothing is indexed yet', async () => {
    const res = await build().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, cursorSlot: null, lag: null })
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/[0-9a-f-]{36}/)
  })

  it('reports the cursor slot and its age in seconds', async () => {
    const now = () => Date.parse('2026-09-12T12:00:10Z')
    const updatedAt = new Date('2026-09-12T12:00:00Z')
    const app = build({
      health: {
        ping: () => Promise.resolve(),
        cursor: () => Promise.resolve({ slot: 123n, updatedAt }),
        now,
      },
    })
    expect(await (await app.request('/health')).json()).toEqual({
      ok: true,
      cursorSlot: 123,
      lag: 10,
    })
  })

  it('answers 503 ok:false when the database fails or hangs', async () => {
    const failing = build({
      health: {
        ping: () => Promise.reject(new Error('down')),
        cursor: () => Promise.resolve(null),
      },
    })
    expect((await failing.request('/health')).status).toBe(503)

    const hanging = build({
      health: {
        ping: () => new Promise(() => {}),
        cursor: () => Promise.resolve(null),
        timeoutMs: 5,
      },
    })
    const res = await hanging.request('/health')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, cursorSlot: null, lag: null })
  })
})

describe('error format', () => {
  it('answers unknown routes with NOT_FOUND in the shared shape', async () => {
    const res = await build().request('/nope')
    expect(res.status).toBe(404)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('NOT_FOUND')
  })

  it('hides the cause of an unhandled error behind INTERNAL', async () => {
    const app = build()
    app.get('/boom', () => {
      throw new Error('postgres://user:secret@host/db')
    })
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const body = apiErrorSchema.parse(await res.json())
    expect(body.error.code).toBe('INTERNAL')
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})

describe('cors', () => {
  it('allows the configured origin and nothing else', async () => {
    const allowed = await build().request('/health', { headers: { Origin: ORIGIN } })
    expect(allowed.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const other = await build().request('/health', { headers: { Origin: 'https://evil.example' } })
    expect(other.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('rate limit placement', () => {
  it('throttles /auth/* and /attempts but not /health', async () => {
    const app = build({ rateLimit: { limit: 1 } })
    app.get('/attempts', (c) => c.json({}))
    expect((await app.request('/auth/nonce', { method: 'POST' })).status).toBe(400)
    expect((await app.request('/auth/nonce', { method: 'POST' })).status).toBe(429)
    expect((await app.request('/attempts')).status).toBe(429)
    for (let i = 0; i < 3; i += 1) expect((await app.request('/health')).status).toBe(200)
  })
})
