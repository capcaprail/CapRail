import type { WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { createSessionTokens, SESSION_TTL_SECONDS } from './jwt.ts'

const WALLET = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g' as WalletAddress
const SECRET = 'k'.repeat(32)
const T0 = Date.parse('2026-09-12T12:00:00Z')
const session = { wallet: WALLET, memberships: [{ companyId: 'c1', role: 'admin' as const }] }

describe('session tokens', () => {
  it('round-trips wallet and memberships', async () => {
    const tokens = createSessionTokens({ secret: SECRET, now: () => T0 })
    const token = await tokens.sign(session)
    expect(await tokens.verify(token)).toEqual(session)
  })

  it('expires after one hour, not before', async () => {
    let now = T0
    const tokens = createSessionTokens({ secret: SECRET, now: () => now })
    const token = await tokens.sign(session)
    now = T0 + (SESSION_TTL_SECONDS - 1) * 1000
    expect(await tokens.verify(token)).not.toBeNull()
    now = T0 + (SESSION_TTL_SECONDS + 1) * 1000
    expect(await tokens.verify(token)).toBeNull()
  })

  it('rejects another secret, a tampered payload and garbage', async () => {
    const tokens = createSessionTokens({ secret: SECRET, now: () => T0 })
    const other = createSessionTokens({ secret: 'z'.repeat(32), now: () => T0 })
    const token = await tokens.sign(session)
    expect(await other.verify(token)).toBeNull()

    const [header, payload, signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        sub: 'x',
      }),
    ).toString('base64url')
    expect(await tokens.verify(`${header}.${forged}.${signature}`)).toBeNull()
    expect(await tokens.verify('not.a.jwt')).toBeNull()
    expect(await tokens.verify('')).toBeNull()
  })
})
