import type { OfferRecord, PlatformView } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { cachedPlatform, quoteOf } from './platform.ts'

const PLATFORM: PlatformView = {
  feeBps: 100,
  paymentMint: 'DemoUsdc1111111111111111111111111111111111111',
  feeTreasury: 'FeeTreasury11111111111111111111111111111111',
  paymentTokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  paymentDecimals: 6,
  paymentSymbol: 'dUSD',
}

const offer = (patch: Partial<OfferRecord> = {}): OfferRecord => ({
  offer: 'Offer111111111111111111111111111111111111111',
  mint: 'Mint1111111111111111111111111111111111111111',
  companyId: '1',
  seller: 'Seller11111111111111111111111111111111111111' as OfferRecord['seller'],
  offerId: '1',
  amount: '100',
  remaining: '60',
  pricePerUnit: '1500000',
  paymentMint: PLATFORM.paymentMint,
  rofrUntil: null,
  status: 'open',
  createdAt: '2026-09-30T12:00:00.000Z',
  closedAt: null,
  available: '60',
  staleReason: null,
  checkedAt: null,
  ...patch,
})

describe('cachedPlatform', () => {
  it('reads the chain once the config is found', async () => {
    let reads = 0
    const platform = cachedPlatform(() => {
      reads += 1
      return Promise.resolve(PLATFORM)
    })
    expect(await platform()).toEqual(PLATFORM)
    expect(await platform()).toEqual(PLATFORM)
    expect(reads).toBe(1)
  })

  it('asks again while the platform is not initialised, and after a failed read', async () => {
    const answers: (() => Promise<PlatformView | null>)[] = [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('429')),
      () => Promise.resolve(PLATFORM),
    ]
    let reads = 0
    const platform = cachedPlatform(() => {
      const answer = answers[reads]
      reads += 1
      if (answer === undefined) throw new Error('read after the config was found')
      return answer()
    })
    expect(await platform()).toBeNull()
    await expect(platform()).rejects.toThrow('429')
    expect(await platform()).toEqual(PLATFORM)
    expect(await platform()).toEqual(PLATFORM)
    expect(reads).toBe(3)
  })

  it('lets concurrent callers share one read', async () => {
    let reads = 0
    let release: (value: PlatformView) => void = () => {}
    const platform = cachedPlatform(() => {
      reads += 1
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const pending = Promise.all([platform(), platform(), platform()])
    release(PLATFORM)
    expect(await pending).toEqual([PLATFORM, PLATFORM, PLATFORM])
    expect(reads).toBe(1)
  })
})

describe('quoteOf', () => {
  it('prices the whole remaining and takes the fee from the payment', () => {
    // 60 × 1.5 (6 decimals) = 90; 1 % of it goes to the platform.
    expect(quoteOf(offer(), PLATFORM)).toEqual({
      amount: '60',
      payment: '90000000',
      fee: '900000',
      sellerReceives: '89100000',
    })
  })

  it('rounds the fee down, as `fee_for` does on chain', () => {
    // 1 % of 99 is 0.99 — the platform takes nothing rather than more than its share.
    expect(quoteOf(offer({ remaining: '33', pricePerUnit: '3' }), PLATFORM)).toMatchObject({
      payment: '99',
      fee: '0',
      sellerReceives: '99',
    })
    expect(
      quoteOf(offer({ remaining: '1', pricePerUnit: '199' }), { ...PLATFORM, feeBps: 50 })?.fee,
    ).toBe('0')
    expect(
      quoteOf(offer({ remaining: '1', pricePerUnit: '200' }), { ...PLATFORM, feeBps: 50 })?.fee,
    ).toBe('1')
  })

  it('keeps u64 payments exact', () => {
    const max = 2n ** 64n - 1n
    const quote = quoteOf(
      offer({ amount: max.toString(), remaining: max.toString(), pricePerUnit: '1' }),
      { ...PLATFORM, feeBps: 1_000 },
    )
    expect(quote?.payment).toBe(max.toString())
    expect(quote?.fee).toBe((max / 10n).toString())
    expect(BigInt(quote?.sellerReceives ?? 0) + BigInt(quote?.fee ?? 0)).toBe(max)
  })

  it('quotes nothing it cannot stand behind', () => {
    expect(quoteOf(offer(), null)).toBeNull()
    expect(quoteOf(offer({ status: 'cancelled', available: null }), PLATFORM)).toBeNull()
    expect(
      quoteOf(offer({ status: 'filled', remaining: '0', available: null }), PLATFORM),
    ).toBeNull()
    expect(
      quoteOf(offer({ paymentMint: 'OtherUsdc111111111111111111111111111' }), PLATFORM),
    ).toBeNull()
  })
})
