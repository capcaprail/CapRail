import type { WalletAddress } from '@caprail/shared'
import { Hono } from 'hono'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { createSessionTokens } from '../auth/jwt.ts'
import type { AppEnv } from '../env.ts'
import { requestLogger } from '../logger.ts'
import { type CompanyRoleSource, requireCompanyRole, requireSession } from './auth.ts'

const WALLET = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g' as WalletAddress
const T0 = Date.parse('2026-09-12T12:00:00Z')

function build(rolesOf: CompanyRoleSource = () => Promise.resolve([])) {
  const clock = { now: T0 }
  const tokens = createSessionTokens({ secret: 's'.repeat(32), now: () => clock.now })
  const app = new Hono<AppEnv>()
    .use('*', requestLogger(pino({ level: 'silent' })))
    .use('/me', requireSession(tokens))
    .get('/me', (c) => c.json(c.get('session')))
    .use('/companies/:id/*', requireSession(tokens))
    .use('/companies/:id/*', requireCompanyRole(rolesOf))
    .get('/companies/:id/cap-table', (c) => c.json(c.get('companyRoles')))
    .use('/companies/:id/roles', requireCompanyRole(rolesOf, ['admin']))
    .get('/companies/:id/roles', (c) => c.json(c.get('companyRoles')))
  const get = (path: string, token?: string) =>
    app.request(path, token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } })
  return { app, get, tokens, clock }
}

describe('requireSession', () => {
  it('lets a valid bearer through and exposes the session', async () => {
    const { get, tokens } = build()
    const token = await tokens.sign({ wallet: WALLET, memberships: [] })
    const res = await get('/me', token)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ wallet: WALLET, memberships: [] })
  })

  it('answers 401 without a header, with another scheme, or with an expired token', async () => {
    const { get, app, tokens, clock } = build()
    expect((await get('/me')).status).toBe(401)
    const token = await tokens.sign({ wallet: WALLET, memberships: [] })
    const basic = await app.request('/me', { headers: { authorization: `Basic ${token}` } })
    expect(basic.status).toBe(401)
    clock.now = T0 + 2 * 60 * 60_000
    expect((await get('/me', token)).status).toBe(401)
  })
})

describe('requireCompanyRole', () => {
  it('asks the index for the wallet and company on every request, not the token', async () => {
    const asked: [string, WalletAddress][] = []
    const { get, tokens } = build((companyId, wallet) => {
      asked.push([companyId, wallet])
      return Promise.resolve(companyId === 'c1' ? ['compliance_officer'] : [])
    })
    // The token claims admin of c2; the index says otherwise, and the index wins.
    const token = await tokens.sign({
      wallet: WALLET,
      memberships: [{ companyId: 'c2', role: 'admin' }],
    })
    const c1 = await get('/companies/c1/cap-table', token)
    expect(c1.status).toBe(200)
    expect(await c1.json()).toEqual(['compliance_officer'])
    expect((await get('/companies/c2/cap-table', token)).status).toBe(403)
    expect(asked).toEqual([
      ['c1', WALLET],
      ['c2', WALLET],
    ])
  })

  it('narrows to the allowed roles when a route names them', async () => {
    const { get, tokens } = build(() => Promise.resolve(['compliance_officer', 'investor']))
    const token = await tokens.sign({ wallet: WALLET, memberships: [] })
    expect((await get('/companies/c1/cap-table', token)).status).toBe(200)
    expect((await get('/companies/c1/roles', token)).status).toBe(403)
  })

  it('never reaches the index without a session', async () => {
    let asked = 0
    const { get } = build(() => {
      asked += 1
      return Promise.resolve(['admin'])
    })
    expect((await get('/companies/c1/cap-table')).status).toBe(401)
    expect(asked).toBe(0)
  })
})
