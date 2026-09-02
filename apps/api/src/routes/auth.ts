import { randomBytes } from 'node:crypto'
import {
  type AuthNonceResponse,
  type AuthVerifyResponse,
  authNonceRequestSchema,
  authVerifyRequestSchema,
  decodeBase58,
  type Membership,
  NONCE_BYTES,
  signInMessage,
  type WalletAddress,
} from '@caprail/shared'
import { Hono } from 'hono'
import type { SessionTokens } from '../auth/jwt.ts'
import type { NonceStore } from '../auth/nonce-store.ts'
import { verifyEd25519 } from '../auth/signature.ts'
import type { AppEnv } from '../env.ts'
import { fail } from '../middleware/errors.ts'
import { validate } from '../middleware/validate.ts'

export const NONCE_TTL_MS = 5 * 60_000

export type MembershipSource = (wallet: WalletAddress) => Promise<Membership[]>

export type AuthDeps = {
  nonces: NonceStore
  tokens: SessionTokens
  // Roles come from the index at sign-in time; the token carries that snapshot and
  // company routes re-check it (PLAN → Безпека).
  memberships: MembershipSource
  now?: () => number
  nonceTtlMs?: number
}

export function authRoute(deps: AuthDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => Date.now())
  const ttl = deps.nonceTtlMs ?? NONCE_TTL_MS

  return new Hono<AppEnv>()
    .post('/auth/nonce', validate('json', authNonceRequestSchema), async (c) => {
      const { wallet } = c.req.valid('json')
      const nonce = randomBytes(NONCE_BYTES).toString('hex')
      await deps.nonces.issue(wallet, nonce, new Date(now() + ttl))
      const body: AuthNonceResponse = { nonce, message: signInMessage(wallet, nonce) }
      return c.json(body)
    })
    .post('/auth/verify', validate('json', authVerifyRequestSchema), async (c) => {
      const { wallet, signature, nonce } = c.req.valid('json')
      // Both decodes passed the schema; the fallbacks only satisfy the types.
      const publicKey = decodeBase58(wallet) ?? new Uint8Array()
      const signatureBytes = decodeBase58(signature) ?? new Uint8Array()
      const message = new TextEncoder().encode(signInMessage(wallet, nonce))

      // Signature before nonce: a bad signature must not burn the nonce, or a typo in
      // a wallet's signing path would force a second round trip for nothing.
      if (!verifyEd25519(message, signatureBytes, publicKey)) {
        c.get('logger').warn({ wallet }, 'sign-in signature mismatch')
        return fail(c, 'UNAUTHORIZED', 'signature does not match the wallet')
      }
      if (!(await deps.nonces.consume(wallet, nonce, new Date(now())))) {
        c.get('logger').warn({ wallet }, 'sign-in nonce rejected')
        return fail(c, 'UNAUTHORIZED', 'nonce is unknown, already used or expired')
      }

      const memberships = await deps.memberships(wallet)
      const token = await deps.tokens.sign({ wallet, memberships })
      c.get('logger').info({ wallet, memberships: memberships.length }, 'signed in')
      const body: AuthVerifyResponse = { token, memberships }
      return c.json(body)
    })
}
