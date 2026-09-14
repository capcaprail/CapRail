import { type AttemptReport, apiErrorSchema, attemptReportResponseSchema } from '@caprail/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { createSessionTokens } from '../auth/jwt.ts'
import { memoryNonceStore } from '../auth/nonce-store.ts'
import { createFeed } from '../index/feed.ts'
import { memoryIndexReader } from '../index/memory-reader.ts'
import { type Seed, seed } from '../index/test-seed.ts'

const NOW = new Date('2026-09-14T12:30:00.000Z')

function build(data: Seed = seed(), overrides: Partial<AppDeps> = {}) {
  const reader = memoryIndexReader(data.index)
  const tokens = createSessionTokens({ secret: 's'.repeat(32) })
  const app = createApp({
    logger: pino({ level: 'silent' }),
    webOrigins: ['http://localhost:5173'],
    health: { ping: () => Promise.resolve(), cursor: () => Promise.resolve(null) },
    auth: { nonces: memoryNonceStore(), tokens, memberships: reader.membershipsOf },
    reader,
    feed: createFeed({
      source: (id, since) => reader.feed({ companyId: id }, id, since),
      onError: () => {},
    }),
    now: () => NOW,
    ...overrides,
  })
  const post = async (body: unknown, wallet?: Seed['alice']) =>
    app.request('/attempts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(wallet === undefined
          ? {}
          : { authorization: `Bearer ${await tokens.sign({ wallet, memberships: [] })}` }),
      },
      body: JSON.stringify(body),
    })
  return { app, post, data }
}

function report(data: Seed, overrides: Partial<AttemptReport> = {}): AttemptReport {
  return {
    mint: data.mint,
    sourceOwner: data.alice,
    destOwner: data.stranger,
    amount: '10',
    reasonCode: 'NotAccredited',
    logs: ['Program log: AnchorError occurred. Error Code: NotAccredited. Error Number: 6000.'],
    ...overrides,
  }
}

describe('POST /attempts', () => {
  it('records a refused simulation for the reporter and answers its id', async () => {
    const { post, data } = build()
    const res = await post(report(data), data.alice)
    expect(res.status).toBe(201)
    const { id } = attemptReportResponseSchema.parse(await res.json())
    const row = data.index.attempts.find((a) => a.id === id)
    expect(row).toMatchObject({
      origin: 'simulation',
      outcome: 'rejected',
      reasonCode: 'NotAccredited',
      sourceOwner: data.alice,
      destOwner: data.stranger,
      amount: '10',
      txSignature: null,
      blockTime: NOW.toISOString(),
      reportedBy: data.alice,
    })
  })

  it('requires a session and validates the body', async () => {
    const { post, data } = build()
    expect((await post(report(data))).status).toBe(401)
    const bad = await post(report(data, { reasonCode: 'Nope' as 'NotAccredited' }), data.alice)
    expect(bad.status).toBe(400)
    expect(apiErrorSchema.parse(await bad.json()).error.details).toMatchObject({
      issues: [{ path: 'reasonCode' }],
    })
    const tooMany = await post(
      report(data, { logs: Array.from({ length: 21 }, () => 'x') }),
      data.alice,
    )
    expect(tooMany.status).toBe(400)
  })

  it('answers 404 for a mint the reporter cannot see', async () => {
    const { post, data } = build()
    const unknown = await post(report(data, { mint: 'NoSuchMint' }), data.alice)
    expect(unknown.status).toBe(404)
    // A wallet with no role and no registry entry sees no mint at all.
    const stranger = await post(report(data), data.stranger)
    expect(stranger.status).toBe(404)
    expect(data.index.attempts).toHaveLength(3)
  })

  it('is rate limited like the auth routes', async () => {
    const { post, data } = build(seed(), { rateLimit: { limit: 2 } })
    expect((await post(report(data), data.alice)).status).toBe(201)
    expect((await post(report(data), data.alice)).status).toBe(201)
    expect((await post(report(data), data.alice)).status).toBe(429)
  })
})
