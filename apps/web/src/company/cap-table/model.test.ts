import type { CapTable, TokenView, WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { capTableTotals, holdersByAmount, percent, percentOf, stripSegments } from './model.ts'

const ALICE = 'A1ice11111111111111111111111111111111111111' as WalletAddress
const BOB = 'Bob1111111111111111111111111111111111111111' as WalletAddress

const token: TokenView = {
  mint: 'Mint',
  treasury: 'Tre',
  name: 'Demo',
  symbol: 'DEMO',
  decimals: 2,
  totalSupply: '100000000',
  policy: { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 },
  policyVersion: 1,
  createdAt: null,
}

const table: CapTable = {
  mint: 'Mint',
  at: '2026-09-14T10:00:00.000Z',
  totalSupply: '100000000',
  treasury: '89999000',
  holders: [
    {
      wallet: BOB,
      amount: '1000',
      pct: 0,
      vested: '1000',
      unvested: '0',
      sources: [{ kind: 'distribution', amount: '1000' }],
    },
    {
      wallet: ALICE,
      amount: '10000000',
      pct: 10,
      vested: '7500000',
      unvested: '2500000',
      sources: [
        { kind: 'distribution', amount: '5000000' },
        { kind: 'grant', amount: '5000000' },
      ],
    },
  ],
}

describe('percentOf', () => {
  it('is exact on u64 strings, two decimals, and zero on an empty whole', () => {
    expect(percentOf('1', '3')).toBe(33.33)
    expect(percentOf('18446744073709551615', '18446744073709551615')).toBe(100)
    expect(percentOf('5', '0')).toBe(0)
    expect(percent(0.5)).toBe('0.50 %')
  })
})

describe('capTableTotals', () => {
  it('sums the holders, not the treasury', () => {
    expect(capTableTotals(table)).toEqual({
      held: 10001000n,
      vested: 7501000n,
      unvested: 2500000n,
      pct: 10,
    })
  })
})

describe('stripSegments', () => {
  it('puts the treasury first, then holders by amount, hatching the unvested part', () => {
    const segments = stripSegments(table, token)
    expect(segments.map((segment) => segment.key)).toEqual(['treasury', ALICE, BOB])
    expect(segments[0]).toMatchObject({ treasury: true, sharePct: 89.99, unvestedPct: null })
    expect(segments[0]?.tip).toBe('Treasury · 899,990 DEMO · 89.99 % · not yet distributed')
    expect(segments[1]).toMatchObject({ sharePct: 10, unvestedPct: 25 })
    expect(segments[1]?.tip).toBe(
      'A1ic…1111 · 100,000 DEMO · 10.00 % · of which 25,000 DEMO not yet vested',
    )
    expect(segments[2]).toMatchObject({ unvestedPct: null, label: 'Bob1…1111' })
    expect(holdersByAmount(table.holders).map((holder) => holder.wallet)).toEqual([ALICE, BOB])
  })
})
