import type { Membership, WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { createApiClient } from '../api/client.ts'
import {
  companyMemberships,
  isLive,
  jwtExpiryMs,
  landingFor,
  rolesIn,
  SESSION_STORAGE_KEY,
  type Session,
  sessionStore,
  signIn,
} from './session.ts'

const WALLET = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g' as WalletAddress
const OTHER = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' as WalletAddress
const T0 = Date.parse('2026-09-12T12:00:00Z')

function fakeJwt(claims: Record<string, unknown>): string {
  const b64 = (value: string) => Buffer.from(value).toString('base64url')
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(claims))}.sig`
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

const session = (overrides: Partial<Session> = {}): Session => ({
  token: fakeJwt({ exp: (T0 + 3_600_000) / 1000 }),
  wallet: WALLET,
  memberships: [],
  expiresAt: T0 + 3_600_000,
  ...overrides,
})

describe('jwtExpiryMs', () => {
  it('reads exp from the payload and tolerates garbage', () => {
    expect(jwtExpiryMs(fakeJwt({ exp: 1_700_000_000 }))).toBe(1_700_000_000_000)
    expect(jwtExpiryMs(fakeJwt({ sub: 'x' }))).toBeNull()
    expect(jwtExpiryMs('nope')).toBeNull()
    expect(jwtExpiryMs('a.!!!.c')).toBeNull()
  })
})

describe('sessionStore', () => {
  it('returns the stored session only for the same wallet while it is live', () => {
    const store = sessionStore(memoryStorage())
    store.save(session())
    expect(store.load(WALLET, T0)).toEqual(session())
    expect(store.token(T0)).toBe(session().token)
    expect(store.load(OTHER, T0)).toBeNull()
    // Loading for another wallet also cleared the row: nothing to leak into that account.
    expect(store.load(WALLET, T0)).toBeNull()
  })

  it('drops an expired or malformed session', () => {
    const storage = memoryStorage()
    const store = sessionStore(storage)
    store.save(session())
    expect(store.token(T0 + 3_600_001)).toBeNull()
    expect(store.load(WALLET, T0 + 3_600_001)).toBeNull()
    storage.setItem(SESSION_STORAGE_KEY, '{not json')
    expect(store.load(WALLET, T0)).toBeNull()
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 't' }))
    expect(store.load(WALLET, T0)).toBeNull()
  })

  it('isLive compares against the given clock', () => {
    expect(isLive(session(), T0)).toBe(true)
    expect(isLive(session(), T0 + 3_600_000)).toBe(false)
  })
})

describe('landingFor', () => {
  const admin = (companyId: string): Membership => ({ companyId, role: 'admin' })
  const officer = (companyId: string): Membership => ({ companyId, role: 'compliance_officer' })
  const investor = (companyId: string): Membership => ({ companyId, role: 'investor' })

  it('sends a company role to its panel, several to the chooser, everyone else to the cabinet', () => {
    expect(landingFor([admin('c1')])).toBe('/company/c1')
    expect(landingFor([admin('c1'), officer('c1')])).toBe('/company/c1')
    expect(landingFor([admin('c1'), officer('c2')])).toBe('/company')
    expect(landingFor([investor('c1')])).toBe('/cabinet')
    expect(landingFor([])).toBe('/cabinet')
  })

  it('companyMemberships and rolesIn filter by role and company', () => {
    const all = [admin('c1'), investor('c1'), officer('c2')]
    expect(companyMemberships(all)).toEqual([admin('c1'), officer('c2')])
    expect(rolesIn(session({ memberships: all }), 'c1')).toEqual(['admin', 'investor'])
    expect(rolesIn(session({ memberships: all }), 'c3')).toEqual([])
  })
})

describe('signIn', () => {
  it('asks for a nonce, signs the message verbatim and verifies', async () => {
    const calls: { path: string; body: unknown }[] = []
    const token = fakeJwt({ exp: 1_800_000_000 })
    const fakeFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, body: JSON.parse(String(init?.body)) })
      if (path === '/auth/nonce') {
        return Response.json({ nonce: 'a'.repeat(32), message: `sign me ${WALLET}` })
      }
      return Response.json({ token, memberships: [{ companyId: 'c1', role: 'admin' }] })
    }
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fakeFetch })

    let signed = ''
    const result = await signIn(api, {
      publicKey: WALLET,
      signMessage: (message) => {
        signed = new TextDecoder().decode(message)
        return Promise.resolve(new Uint8Array(64).fill(1))
      },
    })

    expect(signed).toBe(`sign me ${WALLET}`)
    expect(calls[0]).toEqual({ path: '/auth/nonce', body: { wallet: WALLET } })
    expect(calls[1]?.path).toBe('/auth/verify')
    expect(calls[1]?.body).toMatchObject({ wallet: WALLET, nonce: 'a'.repeat(32) })
    expect(result).toEqual({
      token,
      wallet: WALLET,
      memberships: [{ companyId: 'c1', role: 'admin' }],
      expiresAt: 1_800_000_000_000,
    })
  })

  it('surfaces the api error and does not sign when the nonce is refused', async () => {
    const fakeFetch: typeof fetch = async () =>
      Response.json(
        { error: { code: 'RATE_LIMITED', message: 'too many requests' } },
        { status: 429 },
      )
    const api = createApiClient({ baseUrl: 'http://api.test', fetch: fakeFetch })
    let signCalls = 0
    await expect(
      signIn(api, {
        publicKey: WALLET,
        signMessage: () => {
          signCalls += 1
          return Promise.resolve(new Uint8Array(64))
        },
      }),
    ).rejects.toMatchObject({ name: 'ApiError', code: 'RATE_LIMITED', status: 429 })
    expect(signCalls).toBe(0)
  })
})
