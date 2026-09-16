import type { CompanyView, InvestorView, JournalEntry, WalletAddress } from '@caprail/shared'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { companyKeys, type JournalPages } from './api.ts'
import {
  applyFeedEvent,
  applyPolicy,
  parseFeedFrame,
  prependEntry,
  upsertInvestor,
} from './feed.ts'

const MINT = 'Mint111111111111111111111111111111111111111'
const ALICE = 'A1ice11111111111111111111111111111111111111' as WalletAddress
const BOB = 'Bob1111111111111111111111111111111111111111' as WalletAddress

const entry = (id: string, outcome: JournalEntry['outcome'] = 'allowed'): JournalEntry => ({
  id,
  mint: MINT,
  sourceOwner: ALICE,
  destOwner: BOB,
  amount: '10',
  outcome,
  reasonCode: outcome === 'rejected' ? 'NotAccredited' : null,
  origin: 'chain',
  fromTreasury: false,
  policyVersion: 1,
  txSignature: null,
  slot: 5,
  blockTime: '2026-09-14T10:00:00.000Z',
  logs: [],
})

const pages = (...ids: string[][]): JournalPages => ({
  pages: ids.map((page, i) => ({
    items: page.map((id) => entry(id)),
    nextCursor: i === ids.length - 1 ? null : `c${i}`,
  })),
  pageParams: ids.map((_, i) => (i === 0 ? null : `c${i - 1}`)),
})

const investor = (
  wallet: WalletAddress,
  updatedAt: string,
  status: InvestorView['status'],
): InvestorView => ({
  mint: MINT,
  wallet,
  status,
  expiresAt: '2027-01-01T00:00:00.000Z',
  jurisdiction: 'DE',
  investorType: 1,
  updatedAt,
  updatedBy: BOB,
})

describe('prependEntry', () => {
  it('puts a new entry first, skips one already loaded, leaves nothing to patch alone', () => {
    const loaded = pages(['3', '2'], ['1'])
    expect(prependEntry(loaded, entry('4'))?.pages[0]?.items.map((e) => e.id)).toEqual([
      '4',
      '3',
      '2',
    ])
    expect(prependEntry(loaded, entry('1'))).toBe(loaded)
    expect(prependEntry(undefined, entry('1'))).toBeUndefined()
  })
})

describe('upsertInvestor', () => {
  it('adds an unknown wallet, replaces a known one, keeps a newer row', () => {
    const list = [investor(ALICE, '2026-09-14T10:00:00Z', 'approved')]
    expect(upsertInvestor(list, investor(BOB, '2026-09-14T10:01:00Z', 'approved'))).toHaveLength(2)
    expect(
      upsertInvestor(list, investor(ALICE, '2026-09-14T10:02:00Z', 'revoked'))?.[0]?.status,
    ).toBe('revoked')
    expect(upsertInvestor(list, investor(ALICE, '2026-09-14T09:00:00Z', 'revoked'))).toBe(list)
  })
})

describe('applyPolicy', () => {
  it('patches the token at a newer version only', () => {
    const view = {
      companyId: '1',
      company: 'C',
      name: 'Demo',
      admin: ALICE,
      complianceOfficer: BOB,
      rolesSetAt: null,
      tokens: [
        {
          mint: MINT,
          treasury: 'T',
          name: 'Demo',
          symbol: 'DEMO',
          decimals: 0,
          totalSupply: '100',
          policy: { requireAccreditation: false, requireRofr: false, rofrWindowSecs: 0 },
          policyVersion: 2,
          createdAt: null,
        },
      ],
    } satisfies CompanyView
    const on = { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 }
    const newer = applyPolicy(view, {
      kind: 'policy',
      mint: MINT,
      policy: on,
      policyVersion: 3,
      setAt: null,
    })
    expect(newer?.tokens[0]?.policy.requireAccreditation).toBe(true)
    expect(newer?.tokens[0]?.policyVersion).toBe(3)
    const older = applyPolicy(view, {
      kind: 'policy',
      mint: MINT,
      policy: on,
      policyVersion: 1,
      setAt: null,
    })
    expect(older?.tokens[0]?.policyVersion).toBe(2)
  })
})

describe('parseFeedFrame', () => {
  it('ignores ready, ping and anything that is not a feed event', () => {
    expect(parseFeedFrame({ event: 'ready', data: '{}', id: null })).toBeNull()
    expect(parseFeedFrame({ event: 'ping', data: '', id: null })).toBeNull()
    expect(parseFeedFrame({ event: 'attempt', data: 'not json', id: null })).toBeNull()
    expect(parseFeedFrame({ event: 'attempt', data: '{"kind":"attempt"}', id: null })).toBeNull()
    expect(
      parseFeedFrame({
        event: 'attempt',
        data: JSON.stringify({ kind: 'attempt', entry: entry('9') }),
        id: null,
      })?.kind,
    ).toBe('attempt')
  })
})

describe('applyFeedEvent', () => {
  it('prepends the attempt to the journal cache and refetches the cap table when allowed', () => {
    const client = new QueryClient()
    client.setQueryData(companyKeys.journal('1'), pages(['1']))
    client.setQueryData(companyKeys.capTable('1', MINT), { at: 'old' })
    applyFeedEvent(client, '1', { kind: 'attempt', entry: entry('2', 'rejected') })
    expect(client.getQueryState(companyKeys.capTable('1', MINT))?.isInvalidated).toBe(false)
    applyFeedEvent(client, '1', { kind: 'attempt', entry: entry('3') })
    expect(
      client.getQueryData<JournalPages>(companyKeys.journal('1'))?.pages[0]?.items.map((e) => e.id),
    ).toEqual(['3', '2', '1'])
    expect(client.getQueryState(companyKeys.capTable('1', MINT))?.isInvalidated).toBe(true)
  })
})
