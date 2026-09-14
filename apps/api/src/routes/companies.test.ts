import {
  apiErrorSchema,
  capTableSchema,
  companyViewSchema,
  investorViewSchema,
  journalPageSchema,
  type WalletAddress,
} from '@caprail/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { createSessionTokens } from '../auth/jwt.ts'
import { memoryNonceStore } from '../auth/nonce-store.ts'
import { createFeed } from '../index/feed.ts'
import { memoryIndexReader } from '../index/memory-reader.ts'
import { encodeCursor } from '../index/reader.ts'
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
  const as = async (wallet: WalletAddress, path: string) =>
    app.request(path, {
      headers: { authorization: `Bearer ${await tokens.sign({ wallet, memberships: [] })}` },
    })
  return { app, as, data }
}

describe('company routes — access', () => {
  it('requires a session', async () => {
    const { app, data } = build()
    const res = await app.request(`/companies/${data.companyId}`)
    expect(res.status).toBe(401)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED')
  })

  it('opens the panel to the admin and the compliance officer only', async () => {
    const { as, data } = build()
    for (const path of ['', '/investors', '/cap-table', '/journal']) {
      expect((await as(data.admin, `/companies/${data.companyId}${path}`)).status).toBe(200)
      expect((await as(data.officer, `/companies/${data.companyId}${path}`)).status).toBe(200)
      // An investor of the company has a role, not the panel; a stranger has nothing.
      expect((await as(data.alice, `/companies/${data.companyId}${path}`)).status).toBe(403)
      expect((await as(data.stranger, `/companies/${data.companyId}${path}`)).status).toBe(403)
    }
  })

  it('answers 403, not 404, for a company that is not indexed', async () => {
    const { as, data } = build()
    expect((await as(data.admin, '/companies/1')).status).toBe(403)
  })
})

describe('GET /companies/:id', () => {
  it('returns the company with its tokens and current policy', async () => {
    const { as, data } = build()
    const body = companyViewSchema.parse(
      await (await as(data.admin, `/companies/${data.companyId}`)).json(),
    )
    expect(body).toEqual(data.company)
    expect(body.tokens[0]?.policyVersion).toBe(2)
  })
})

describe('GET /companies/:id/investors', () => {
  it('lists the registry of the company', async () => {
    const { as, data } = build()
    const body = investorViewSchema
      .array()
      .parse(await (await as(data.officer, `/companies/${data.companyId}/investors`)).json())
    expect(body.map((i) => i.wallet).sort()).toEqual([data.alice, data.bob].sort())
    expect(body.every((i) => i.status === 'approved' && i.mint === data.mint)).toBe(true)
  })
})

describe('GET /companies/:id/cap-table', () => {
  it('lists holders by amount with their share and source, the treasury apart', async () => {
    const { as, data } = build()
    const body = capTableSchema.parse(
      await (await as(data.admin, `/companies/${data.companyId}/cap-table`)).json(),
    )
    expect(body.mint).toBe(data.mint)
    expect(body.at).toBe(NOW.toISOString())
    expect(body.totalSupply).toBe('1000000')
    expect(body.treasury).toBe('900000')
    expect(body.holders).toEqual([
      {
        wallet: data.alice,
        amount: '99990',
        pct: 9.99,
        vested: '99990',
        unvested: '0',
        sources: [{ kind: 'distribution', amount: '100000' }],
      },
      { wallet: data.bob, amount: '10', pct: 0, vested: '10', unvested: '0', sources: [] },
    ])
  })

  it('takes ?mint= and answers 404 for a mint the company does not have', async () => {
    const { as, data } = build()
    const ok = await as(data.admin, `/companies/${data.companyId}/cap-table?mint=${data.mint}`)
    expect(ok.status).toBe(200)
    const missing = await as(data.admin, `/companies/${data.companyId}/cap-table?mint=other`)
    expect(missing.status).toBe(404)
  })

  it('answers 404 when the company has no token yet', async () => {
    const data = seed()
    data.company.tokens = []
    const { as } = build(data)
    const res = await as(data.admin, `/companies/${data.companyId}/cap-table`)
    expect(res.status).toBe(404)
    expect(apiErrorSchema.parse(await res.json()).error.message).toMatch(/no token yet/)
  })
})

describe('GET /companies/:id/journal', () => {
  it('pages newest first with an opaque cursor', async () => {
    const { as, data } = build()
    const first = journalPageSchema.parse(
      await (await as(data.admin, `/companies/${data.companyId}/journal?limit=2`)).json(),
    )
    expect(first.items.map((e) => e.id)).toEqual(['3', '2'])
    expect(first.items[0]?.outcome).toBe('rejected')
    expect(first.items[0]?.reasonCode).toBe('NotAccredited')
    expect(first.nextCursor).not.toBeNull()

    const second = journalPageSchema.parse(
      await (
        await as(
          data.admin,
          `/companies/${data.companyId}/journal?limit=2&cursor=${first.nextCursor}`,
        )
      ).json(),
    )
    expect(second.items.map((e) => e.id)).toEqual(['1'])
    expect(second.items[0]?.fromTreasury).toBe(true)
    expect(second.nextCursor).toBeNull()
  })

  it('filters by mint and by time', async () => {
    const { as, data } = build()
    const byMint = journalPageSchema.parse(
      await (await as(data.admin, `/companies/${data.companyId}/journal?mint=other`)).json(),
    )
    expect(byMint.items).toEqual([])
    const window = journalPageSchema.parse(
      await (
        await as(
          data.admin,
          `/companies/${data.companyId}/journal?from=2026-09-14T12:02:00Z&to=2026-09-14T12:02:00Z`,
        )
      ).json(),
    )
    expect(window.items.map((e) => e.id)).toEqual(['2'])
  })

  it('rejects a malformed query and ignores a cursor it cannot read', async () => {
    const { as, data } = build()
    const bad = await as(data.admin, `/companies/${data.companyId}/journal?limit=0`)
    expect(bad.status).toBe(400)
    expect(apiErrorSchema.parse(await bad.json()).error.code).toBe('INVALID_INPUT')
    // A cursor that is not ours pages from the top rather than failing.
    const odd = await as(data.admin, `/companies/${data.companyId}/journal?cursor=zzz`)
    expect(odd.status).toBe(200)
    expect(journalPageSchema.parse(await odd.json()).items).toHaveLength(3)
    // A real cursor before everything gives an empty page.
    const cursor = encodeCursor(new Date('2026-09-14T12:00:00Z'), 0n)
    const empty = await as(data.admin, `/companies/${data.companyId}/journal?cursor=${cursor}`)
    expect(journalPageSchema.parse(await empty.json()).items).toEqual([])
  })
})
