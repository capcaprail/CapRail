import { ROLES, type Role, type WalletAddress } from '@caprail/shared'
import type { MiddlewareHandler } from 'hono'
import type { SessionTokens } from '../auth/jwt.ts'
import type { AppEnv } from '../env.ts'
import { fail } from './errors.ts'

const BEARER = /^Bearer\s+(\S+)$/i

export function requireSession(tokens: SessionTokens): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const match = BEARER.exec(c.req.header('authorization') ?? '')
    const session = match?.[1] === undefined ? null : await tokens.verify(match[1])
    if (session === null) return fail(c, 'UNAUTHORIZED', 'a valid bearer token is required')
    c.set('session', session)
    await next()
  }
}

export type CompanyRoleSource = (companyId: string, wallet: WalletAddress) => Promise<Role[]>

// The token's memberships are a snapshot from sign-in; the index is asked again on
// every company request so `set_roles` on chain takes effect without waiting for
// the token to expire (PLAN → Безпека). Mount behind `requireSession` on
// `/companies/:id/*`.
export function requireCompanyRole(
  rolesOf: CompanyRoleSource,
  allowed: readonly Role[] = ROLES,
): MiddlewareHandler<AppEnv, '/companies/:id/*'> {
  return async (c, next) => {
    const companyId = c.req.param('id')
    const roles = await rolesOf(companyId, c.get('session').wallet)
    const granted = roles.filter((role) => allowed.includes(role))
    if (granted.length === 0) return fail(c, 'FORBIDDEN', 'no role in this company')
    c.set('companyRoles', granted)
    await next()
  }
}
