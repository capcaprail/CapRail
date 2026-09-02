import {
  type Membership,
  membershipSchema,
  type WalletAddress,
  walletAddressSchema,
} from '@caprail/shared'
import { jwtVerify, SignJWT } from 'jose'
import { z } from 'zod'

export const SESSION_TTL_SECONDS = 60 * 60
export const JWT_ISSUER = 'caprail'
const ALG = 'HS256'

export type Session = {
  wallet: WalletAddress
  memberships: Membership[]
}

export type SessionTokens = {
  sign: (session: Session) => Promise<string>
  verify: (token: string) => Promise<Session | null>
}

export type SessionTokenOptions = {
  secret: string
  ttlSeconds?: number
  now?: () => number
}

// The claims are ours, but the snapshot in the token is still parsed on the way
// back: a token minted by an older build with another shape must fail here, not
// deep inside a route.
const claimsSchema = z.object({
  sub: walletAddressSchema,
  memberships: z.array(membershipSchema),
})

// Stateless HS256: one secret, one service, no key rotation story needed for a
// one-hour token (PLAN → API). `now` is injected so expiry is testable without a clock.
export function createSessionTokens(options: SessionTokenOptions): SessionTokens {
  const key = new TextEncoder().encode(options.secret)
  const ttl = options.ttlSeconds ?? SESSION_TTL_SECONDS
  const now = options.now ?? (() => Date.now())

  return {
    sign(session) {
      const issuedAt = Math.floor(now() / 1000)
      return new SignJWT({ memberships: session.memberships })
        .setProtectedHeader({ alg: ALG })
        .setIssuer(JWT_ISSUER)
        .setSubject(session.wallet)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ttl)
        .sign(key)
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: [ALG],
          issuer: JWT_ISSUER,
          currentDate: new Date(now()),
        })
        const claims = claimsSchema.safeParse(payload)
        return claims.success
          ? { wallet: claims.data.sub, memberships: claims.data.memberships }
          : null
      } catch {
        return null
      }
    },
  }
}
