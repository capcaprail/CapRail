import {
  type AuthNonceResponse,
  apiErrorSchema,
  authNonceResponseSchema,
  authVerifyResponseSchema,
  type Membership,
  signInMessage,
  type WalletAddress,
} from '@caprail/shared'
import { Hono } from 'hono'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createSessionTokens } from '../auth/jwt.ts'
import { memoryNonceStore } from '../auth/nonce-store.ts'
import { testWallet } from '../auth/test-wallet.ts'
import type { AppEnv } from '../env.ts'
import { requestLogger } from '../logger.ts'
import { type AuthDeps, authRoute, NONCE_TTL_MS } from './auth.ts'

const T0 = Date.parse('2026-09-12T12:00:00Z')
const PDA = 'a8a4KNjnNoSsDvYuKAuFptgt471FtC3UsrYT3sT5Mm4'

function build(overrides: Partial<AuthDeps> = {}) {
  const clock = { now: T0 }
  const tokens = createSessionTokens({ secret: 's'.repeat(32), now: () => clock.now })
  const app = new Hono<AppEnv>().use('*', requestLogger(pino({ level: 'silent' }))).route(
    '/',
    authRoute({
      nonces: memoryNonceStore(),
      tokens,
      memberships: () => Promise.resolve([]),
      now: () => clock.now,
      ...overrides,
    }),
  )
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const nonce = async (wallet: WalletAddress): Promise<AuthNonceResponse> =>
    authNonceResponseSchema.parse(await (await post('/auth/nonce', { wallet })).json())
  return { app, post, nonce, tokens, clock }
}

describe('POST /auth/nonce', () => {
  it('issues a fresh nonce and the message to sign', async () => {
    const wallet = testWallet()
    const { nonce } = build()
    const first = await nonce(wallet.address)
    expect(first.message).toBe(signInMessage(wallet.address, first.nonce))
    const second = await nonce(wallet.address)
    expect(second.nonce).not.toBe(first.nonce)
  })

  it('refuses a PDA, a malformed wallet and a missing body in the shared shape', async () => {
    const { post } = build()
    for (const body of [{ wallet: PDA }, { wallet: 'nope' }, {}]) {
      const res = await post('/auth/nonce', body)
      expect(res.status).toBe(400)
      const error = apiErrorSchema.parse(await res.json()).error
      expect(error.code).toBe('INVALID_INPUT')
      expect(error.details).toEqual({ issues: [{ path: 'wallet', message: expect.any(String) }] })
    }
  })
})

describe('POST /auth/verify', () => {
  it('signs in with a signature over the issued message and returns memberships', async () => {
    const wallet = testWallet()
    const memberships: Membership[] = [{ companyId: 'c1', role: 'admin' }]
    const { post, nonce, tokens } = build({ memberships: () => Promise.resolve(memberships) })
    const issued = await nonce(wallet.address)
    const res = await post('/auth/verify', {
      wallet: wallet.address,
      nonce: issued.nonce,
      signature: wallet.signMessage(issued.message),
    })
    expect(res.status).toBe(200)
    const body = authVerifyResponseSchema.parse(await res.json())
    expect(body.memberships).toEqual(memberships)
    expect(await tokens.verify(body.token)).toEqual({ wallet: wallet.address, memberships })
  })

  it('is single-use: the same nonce does not sign in twice', async () => {
    const wallet = testWallet()
    const { post, nonce } = build()
    const issued = await nonce(wallet.address)
    const body = {
      wallet: wallet.address,
      nonce: issued.nonce,
      signature: wallet.signMessage(issued.message),
    }
    expect((await post('/auth/verify', body)).status).toBe(200)
    const replay = await post('/auth/verify', body)
    expect(replay.status).toBe(401)
    expect(apiErrorSchema.parse(await replay.json()).error.message).toMatch(/nonce/)
  })

  it('refuses a nonce older than five minutes', async () => {
    const wallet = testWallet()
    const { post, nonce, clock } = build()
    const issued = await nonce(wallet.address)
    clock.now = T0 + NONCE_TTL_MS + 1
    const res = await post('/auth/verify', {
      wallet: wallet.address,
      nonce: issued.nonce,
      signature: wallet.signMessage(issued.message),
    })
    expect(res.status).toBe(401)
  })

  it('refuses a signature from another wallet and keeps the nonce for the right one', async () => {
    const wallet = testWallet()
    const intruder = testWallet()
    const { post, nonce } = build()
    const issued = await nonce(wallet.address)
    const wrong = await post('/auth/verify', {
      wallet: wallet.address,
      nonce: issued.nonce,
      signature: intruder.signMessage(issued.message),
    })
    expect(wrong.status).toBe(401)
    expect(apiErrorSchema.parse(await wrong.json()).error.message).toMatch(/signature/)
    const right = await post('/auth/verify', {
      wallet: wallet.address,
      nonce: issued.nonce,
      signature: wallet.signMessage(issued.message),
    })
    expect(right.status).toBe(200)
  })

  it('refuses a nonce issued to another wallet even under a valid own signature', async () => {
    const wallet = testWallet()
    const other = testWallet()
    const { post, nonce } = build()
    const issued = await nonce(wallet.address)
    const res = await post('/auth/verify', {
      wallet: other.address,
      nonce: issued.nonce,
      signature: other.signMessage(signInMessage(other.address, issued.nonce)),
    })
    expect(res.status).toBe(401)
  })

  it('validates the body before touching keys', async () => {
    const wallet = testWallet()
    const { post } = build()
    const res = await post('/auth/verify', {
      wallet: wallet.address,
      nonce: 'short',
      signature: 'xyz',
    })
    expect(res.status).toBe(400)
    const issues = apiErrorSchema.parse(await res.json()).error.details?.issues
    expect(issues).toEqual([
      { path: 'signature', message: expect.any(String) },
      { path: 'nonce', message: expect.any(String) },
    ])
  })
})
