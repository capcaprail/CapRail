import type { WalletAddress } from '@caprail/shared'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fromBaseUnits, textBytes, toBaseUnits } from './fields.ts'
import { policyChanged, policyInput } from './policy/form.ts'
import { endOfDayUtc, parseDistributeForm, parseStatusForm } from './registry/form.ts'
import { draftStore, SETUP_DRAFT_KEY } from './setup/draft.ts'
import { parseCompanyForm, parseTokenForm, randomCompanyId } from './setup/form.ts'

const admin = Keypair.generate().publicKey.toBase58() as WalletAddress
const officer = Keypair.generate().publicKey.toBase58() as WalletAddress

describe('fields', () => {
  it('measures bytes, not characters', () => {
    expect(textBytes('Демо', 8)).toEqual({ value: 'Демо' })
    expect(textBytes('Демо!', 8)).toEqual({ error: '9 bytes; at most 8' })
    expect(textBytes('  ', 8)).toEqual({ error: 'required' })
    expect(textBytes('', 8, { required: false })).toEqual({ value: '' })
  })

  it('converts whole tokens to base units and back', () => {
    expect(toBaseUnits('1,000,000', 0)).toBe(1_000_000n)
    expect(toBaseUnits('12.5', 2)).toBe(1250n)
    expect(toBaseUnits('12.5', 0)).toBeNull()
    expect(toBaseUnits('abc', 0)).toBeNull()
    expect(fromBaseUnits(1250n, 2)).toBe('12.5')
    expect(fromBaseUnits('1000000', 0)).toBe('1,000,000')
    expect(fromBaseUnits(5n, 3)).toBe('0.005')
  })
})

describe('parseCompanyForm', () => {
  it('accepts a name within 32 bytes and an officer that is another wallet', () => {
    expect(parseCompanyForm({ name: ' Demo Corp ', complianceOfficer: officer }, admin)).toEqual({
      ok: true,
      value: { name: 'Demo Corp', complianceOfficer: officer },
    })
  })

  it('refuses the admin as its own officer and a PDA as an officer', () => {
    expect(parseCompanyForm({ name: 'x', complianceOfficer: admin }, admin)).toMatchObject({
      ok: false,
      errors: { complianceOfficer: 'must differ from the administrator key' },
    })
    expect(parseCompanyForm({ name: '', complianceOfficer: 'not-a-key' }, admin)).toMatchObject({
      ok: false,
      errors: { name: 'required', complianceOfficer: 'not a wallet address' },
    })
  })
})

describe('parseTokenForm', () => {
  const raw = {
    name: 'Demo Corp Shares',
    symbol: 'DEMO',
    uri: '',
    decimals: '0',
    totalSupply: '1,000,000',
    requireAccreditation: true,
  }

  it('turns the typed supply into base units and pins ROFR off', () => {
    expect(parseTokenForm(raw)).toEqual({
      ok: true,
      value: {
        name: 'Demo Corp Shares',
        symbol: 'DEMO',
        uri: '',
        decimals: 0,
        totalSupply: 1_000_000n,
        policy: { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 },
      },
    })
    expect(parseTokenForm({ ...raw, decimals: '2', totalSupply: '10.5' })).toMatchObject({
      ok: true,
      value: { decimals: 2, totalSupply: 1050n },
    })
  })

  it('names every bad field at once', () => {
    expect(
      parseTokenForm({
        ...raw,
        symbol: 'TOOLONGSYMBOL',
        decimals: '10',
        totalSupply: '0',
      }),
    ).toMatchObject({
      ok: false,
      errors: { symbol: '13 bytes; at most 10', decimals: '0 to 9', totalSupply: 'decimals first' },
    })
    expect(parseTokenForm({ ...raw, totalSupply: '0' })).toMatchObject({
      ok: false,
      errors: { totalSupply: 'must be positive' },
    })
  })
})

describe('randomCompanyId', () => {
  it('is a u64 and differs between calls', () => {
    const a = randomCompanyId()
    const b = randomCompanyId()
    expect(a >= 0n && a <= 0xffff_ffff_ffff_ffffn).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('draftStore', () => {
  const memory = () => {
    const map = new Map<string, string>()
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      map,
    }
  }
  const draft = {
    admin,
    companyId: '42',
    name: 'Demo',
    complianceOfficer: officer,
    createCompanySignature: 'sig',
  }

  it('round-trips a draft for its admin only', () => {
    const storage = memory()
    const store = draftStore(storage)
    store.save(draft)
    expect(store.load(admin)).toEqual(draft)
    expect(store.load(officer)).toBeNull()
    store.clear()
    expect(storage.map.has(SETUP_DRAFT_KEY)).toBe(false)
  })

  it('ignores garbage', () => {
    const storage = memory()
    storage.setItem(SETUP_DRAFT_KEY, '{"companyId": 1}')
    expect(draftStore(storage).load(admin)).toBeNull()
  })
})

describe('policy form', () => {
  it('only admission is live; a same policy is no change', () => {
    const current = { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 }
    expect(policyInput({ requireAccreditation: false })).toEqual({
      requireAccreditation: false,
      requireRofr: false,
      rofrWindowSecs: 0,
    })
    expect(policyChanged(current, policyInput({ requireAccreditation: true }))).toBe(false)
    expect(policyChanged(current, policyInput({ requireAccreditation: false }))).toBe(true)
  })
})

describe('parseStatusForm', () => {
  const now = Math.floor(Date.parse('2026-09-14T12:00:00Z') / 1000)
  const raw = {
    wallet: officer,
    status: 'approved' as const,
    validUntil: '2027-06-30',
    jurisdiction: 'ua',
    investorType: '1',
  }

  it('an approval carries the end of its last day, UTC', () => {
    expect(endOfDayUtc('2027-06-30')).toBe(BigInt(Date.parse('2027-06-30T23:59:59Z') / 1000))
    expect(parseStatusForm(raw, now)).toEqual({
      ok: true,
      value: {
        wallet: officer,
        status: 'approved',
        expiresAt: BigInt(Date.parse('2027-06-30T23:59:59Z') / 1000),
        jurisdiction: 'UA',
        investorType: 1,
      },
    })
  })

  it('an approval needs a future date; a revocation needs none', () => {
    expect(parseStatusForm({ ...raw, validUntil: '' }, now)).toMatchObject({
      ok: false,
      errors: { validUntil: 'required for an approval' },
    })
    expect(parseStatusForm({ ...raw, validUntil: '2026-09-13' }, now)).toMatchObject({
      ok: false,
      errors: { validUntil: 'must be in the future' },
    })
    expect(parseStatusForm({ ...raw, status: 'revoked', validUntil: '' }, now)).toMatchObject({
      ok: true,
      value: { status: 'revoked', expiresAt: 0n },
    })
  })

  it('checks the reference fields the program checks', () => {
    expect(
      parseStatusForm({ ...raw, jurisdiction: 'UKR', investorType: '9', wallet: 'x' }, now),
    ).toMatchObject({
      ok: false,
      errors: {
        wallet: 'not a wallet address',
        jurisdiction: 'two letters (ISO 3166-1), or empty',
        investorType: 'unknown type',
      },
    })
    expect(parseStatusForm({ ...raw, jurisdiction: '' }, now)).toMatchObject({
      ok: true,
      value: { jurisdiction: '' },
    })
  })
})

describe('parseDistributeForm', () => {
  it('reads the amount in the token decimals', () => {
    expect(parseDistributeForm({ amount: '100,000' }, 0)).toEqual({
      ok: true,
      value: { amount: 100_000n },
    })
    expect(parseDistributeForm({ amount: '1.5' }, 0)).toEqual({
      ok: false,
      errors: { amount: 'a whole number' },
    })
  })
})
