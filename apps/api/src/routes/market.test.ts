import {
  apiErrorSchema,
  companyOffersSchema,
  marketOffersSchema,
  meSchema,
  type PlatformView,
  type WalletAddress,
} from '@caprail/shared'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { type AppDeps, createApp } from '../app.ts'
import { createSessionTokens } from '../auth/jwt.ts'
import { memoryNonceStore } from '../auth/nonce-store.ts'
import { createFeed } from '../index/feed.ts'
import { memoryIndexReader } from '../index/memory-reader.ts'
import { type MarketSeed, marketSeed, PAYMENT_MINT } from '../index/test-seed.ts'

const NOW = new Date('2026-09-14T12:30:00.000Z')

const PLATFORM: PlatformView = {
  feeBps: 100,
  paymentMint: PAYMENT_MINT,
  feeTreasury: 'FeeTreasury11111111111111111111111111111111',
  paymentTokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  paymentDecimals: 6,
  paymentSymbol: 'dUSD',
}

function build(data: MarketSeed = marketSeed(), overrides: Partial<AppDeps> = {}) {
  const reader = memoryIndexReader(data.index)
  const tokens = createSessionTokens({ secret: 's'.repeat(32) })
  const app = createApp({
    logger: pino({ level: 'silent' }),
    webOrigins: ['http://localhost:5173'],
    health: { ping: () => Promise.resolve(), cursor: () => Promise.resolve(null) },
    auth: { nonces: memoryNonceStore(), tokens, memberships: reader.membershipsOf },
    reader,
    platform: () => Promise.resolve(PLATFORM),
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
  const market = async (wallet: WalletAddress, query = '') =>
    marketOffersSchema.parse(await (await as(wallet, `/market/offers${query}`)).json())
  const me = async (wallet: WalletAddress) => meSchema.parse(await (await as(wallet, '/me')).json())
  return { app, as, market, me, data }
}

describe('market routes — access', () => {
  it('require a session, and nothing more', async () => {
    const { app, as, data } = build()
    for (const path of ['/market/offers', '/me']) {
      const res = await app.request(path)
      expect(res.status, path).toBe(401)
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe('UNAUTHORIZED')
      // A wallet in no registry and with no role still gets an answer.
      expect((await as(data.stranger, path)).status, path).toBe(200)
    }
  })

  it('keep the company book behind a panel role', async () => {
    const { as, data } = build()
    const path = `/companies/${data.companyId}/offers`
    expect((await as(data.admin, path)).status).toBe(200)
    expect((await as(data.officer, path)).status).toBe(200)
    expect((await as(data.alice, path)).status).toBe(403)
    expect((await as(data.stranger, path)).status).toBe(403)
  })
})

describe('GET /market/offers', () => {
  it('shows an admitted investor the open offers of others, with the fee before accepting', async () => {
    const { market, data } = build()
    const body = await market(data.bob)
    expect(body.platform).toEqual(PLATFORM)
    // Bob is approved for DEMO, and OPEN admits anyone.
    expect(body.offers.map((o) => o.offer)).toEqual([data.offers.erinOpen, data.offers.aliceOpen])
    const offer = body.offers.find((o) => o.offer === data.offers.aliceOpen)
    expect(offer?.token).toEqual({
      companyName: 'Demo Corp',
      name: 'Demo Corp Shares',
      symbol: 'DEMO',
      decimals: 0,
    })
    // The whole remaining — 60 of 100 — at 1.5 each, 1 % to the platform.
    expect(offer?.quote).toEqual({
      amount: '60',
      payment: '90000000',
      fee: '900000',
      sellerReceives: '89100000',
    })
    // The worker's reading travels along: only 40 can be taken right now.
    expect(offer).toMatchObject({ available: '40', staleReason: 'balance_short' })
  })

  it('hides offers from wallets the hook would refuse, and each seller’s own', async () => {
    const { market, data } = build()
    // No record, an expired approval, a revoked one: FR-011 — they do not see it at all.
    for (const wallet of [data.stranger, data.carol, data.dave, data.admin]) {
      const offers = (await market(wallet)).offers.map((o) => o.offer)
      expect(offers, wallet).not.toContain(data.offers.aliceOpen)
    }
    // Alice is admitted, but the open offer on DEMO is hers.
    expect((await market(data.alice)).offers.map((o) => o.offer)).toEqual([data.offers.erinOpen])
  })

  it('shows an offer on a token whose policy admits anyone to any wallet', async () => {
    const { market, data } = build()
    for (const wallet of [data.stranger, data.carol, data.dave, data.admin, data.bob]) {
      expect(
        (await market(wallet)).offers.map((o) => o.offer),
        wallet,
      ).toContain(data.offers.erinOpen)
    }
    expect((await market(data.erin)).offers).toEqual([])
  })

  it('never lists a closed offer', async () => {
    const { market, data } = build()
    const all = [data.alice, data.bob, data.stranger, data.erin]
    for (const wallet of all) {
      for (const offer of (await market(wallet)).offers) expect(offer.status).toBe('open')
    }
  })

  it('narrows by mint', async () => {
    const { market, data } = build()
    expect((await market(data.bob, `?mint=${data.openMint}`)).offers.map((o) => o.offer)).toEqual([
      data.offers.erinOpen,
    ])
    expect((await market(data.bob, `?mint=${data.mint}`)).offers.map((o) => o.offer)).toEqual([
      data.offers.aliceOpen,
    ])
  })

  it('follows the clock: an approval that lapses takes the offer off the storefront', async () => {
    const data = marketSeed()
    const bob = data.index.investors.find((i) => i.wallet === data.bob)
    if (bob === undefined) throw new Error('seed without bob')
    bob.expiresAt = NOW.toISOString()
    const { market } = build(data)
    // `expires_at > now`, strictly — at the very second it expires, the hook refuses.
    expect((await market(data.bob)).offers.map((o) => o.offer)).toEqual([data.offers.erinOpen])
    const later = build(data, { now: () => new Date(NOW.getTime() - 1000) })
    expect((await later.market(data.bob)).offers.map((o) => o.offer)).toContain(
      data.offers.aliceOpen,
    )
  })

  it('answers without quotes before the platform is initialised', async () => {
    const { market, data } = build(marketSeed(), { platform: () => Promise.resolve(null) })
    const body = await market(data.bob)
    expect(body.platform).toBeNull()
    expect(body.offers.length).toBe(2)
    expect(body.offers.every((o) => o.quote === null)).toBe(true)
  })

  it('fails rather than quote without the fee when the chain cannot be read', async () => {
    const { as, data } = build(marketSeed(), {
      platform: () => Promise.reject(new Error('rpc down')),
    })
    const res = await as(data.bob, '/market/offers')
    expect(res.status).toBe(500)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INTERNAL')
  })
})

describe('GET /companies/:id/offers', () => {
  it('lists the company’s book in every status, quoting only what is open', async () => {
    const { as, data } = build()
    const body = companyOffersSchema.parse(
      await (await as(data.admin, `/companies/${data.companyId}/offers`)).json(),
    )
    expect(body.platform).toEqual(PLATFORM)
    expect(body.offers.map((o) => [o.offer, o.status])).toEqual([
      [data.offers.aliceOpen, 'open'],
      [data.offers.bobCancelled, 'cancelled'],
      [data.offers.aliceFilled, 'filled'],
    ])
    expect(body.offers.map((o) => o.quote === null)).toEqual([false, true, true])
    // Another company's offers are not in this book, though the admin keys are the same.
    expect(body.offers.map((o) => o.offer)).not.toContain(data.offers.erinOpen)
  })

  it('filters by status and mint, and refuses an unknown status', async () => {
    const { as, data } = build()
    const path = `/companies/${data.companyId}/offers`
    const parse = async (query: string) =>
      companyOffersSchema.parse(await (await as(data.officer, `${path}${query}`)).json())
    expect((await parse('?status=cancelled')).offers.map((o) => o.offer)).toEqual([
      data.offers.bobCancelled,
    ])
    expect((await parse(`?mint=${data.openMint}`)).offers).toEqual([])
    const res = await as(data.officer, `${path}?status=stale`)
    expect(res.status).toBe(400)
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_INPUT')
  })
})

describe('GET /me', () => {
  it('shows a holder their position, admission and own open offers', async () => {
    const { me, data } = build()
    const body = await me(data.alice)
    expect(body.wallet).toBe(data.alice)
    expect(body.platform).toEqual(PLATFORM)
    expect(body.positions).toEqual([
      {
        companyId: data.companyId,
        token: {
          mint: data.mint,
          companyName: 'Demo Corp',
          name: 'Demo Corp Shares',
          symbol: 'DEMO',
          decimals: 0,
        },
        policy: { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 },
        amount: '99990',
        vested: '99990',
        unvested: '0',
        registry: {
          status: 'approved',
          expiresAt: '2027-09-14T12:00:00.000Z',
          jurisdiction: 'UA',
          investorType: 1,
        },
        admission: { admitted: true, reason: null },
      },
    ])
    // The filled offer is history; the open one carries its quote.
    expect(body.offers.map((o) => o.offer)).toEqual([data.offers.aliceOpen])
    expect(body.offers[0]?.quote?.fee).toBe('900000')
  })

  it('names why the hook would refuse a registered wallet now', async () => {
    const { me, data } = build()
    const carol = await me(data.carol)
    expect(carol.positions.map((p) => [p.amount, p.admission])).toEqual([
      ['0', { admitted: false, reason: 'AccreditationExpired' }],
    ])
    const dave = await me(data.dave)
    expect(dave.positions[0]?.registry?.status).toBe('revoked')
    expect(dave.positions[0]?.admission).toEqual({ admitted: false, reason: 'NotAccredited' })
  })

  it('shows a holding without a record, where the policy asks for none', async () => {
    const { me, data } = build()
    const body = await me(data.erin)
    expect(body.positions).toHaveLength(1)
    expect(body.positions[0]).toMatchObject({
      companyId: data.openCompanyId,
      amount: '700',
      registry: null,
      admission: { admitted: true, reason: null },
    })
    expect(body.offers.map((o) => o.offer)).toEqual([data.offers.erinOpen])
  })

  it('is empty for a wallet the index does not know', async () => {
    const { me, data } = build()
    const body = await me(data.stranger)
    expect(body.positions).toEqual([])
    expect(body.offers).toEqual([])
  })
})
