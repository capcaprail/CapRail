import {
  authNonceResponseSchema,
  authVerifyResponseSchema,
  encodeBase58,
  type Membership,
  membershipSchema,
  type Role,
  type WalletAddress,
  walletAddressSchema,
} from '@caprail/shared'
import { z } from 'zod'
import type { ApiClient } from '../api/client.ts'

export const sessionSchema = z.object({
  token: z.string().min(1),
  wallet: walletAddressSchema,
  memberships: z.array(membershipSchema),
  // Milliseconds since the epoch, taken from the token's `exp`.
  expiresAt: z.number().int().positive(),
})

export type Session = z.infer<typeof sessionSchema>

// Only `exp` is read; the rest of the payload is the API's business, and the
// signature is not checked here — the API checks it on every request.
const jwtClaimsSchema = z.object({ exp: z.number().int().positive() })

export function jwtExpiryMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = jwtClaimsSchema.safeParse(JSON.parse(json))
    return claims.success ? claims.data.exp * 1000 : null
  } catch {
    return null
  }
}

export function isLive(session: Session, now: number = Date.now()): boolean {
  return session.expiresAt > now
}

export type SigningWallet = {
  publicKey: WalletAddress
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
}

// Nonce → wallet signs the message the API gave → verify. The message is signed
// verbatim: the API rebuilds it from (wallet, nonce), so any client-side
// rewording would be a different message and a refused signature.
export async function signIn(api: ApiClient, wallet: SigningWallet): Promise<Session> {
  const { nonce, message } = await api.request('POST', '/auth/nonce', authNonceResponseSchema, {
    wallet: wallet.publicKey,
  })
  const signature = await wallet.signMessage(new TextEncoder().encode(message))
  const { token, memberships } = await api.request(
    'POST',
    '/auth/verify',
    authVerifyResponseSchema,
    { wallet: wallet.publicKey, nonce, signature: encodeBase58(signature) },
  )
  const expiresAt = jwtExpiryMs(token)
  if (expiresAt === null) throw new Error('api returned a token without an expiry')
  return { token, wallet: wallet.publicKey, memberships, expiresAt }
}

// ── Storage ─────────────────────────────────────────────────────────────────

export const SESSION_STORAGE_KEY = 'caprail.session'

export type SessionStore = {
  load: (wallet: WalletAddress, now?: number) => Session | null
  // The bearer for outgoing requests, read at call time so a client built before
  // sign-in sends the token afterwards without being rebuilt.
  token: (now?: number) => string | null
  save: (session: Session) => void
  clear: () => void
}

// A session belongs to one wallet: switching accounts in the wallet must never
// keep the previous account's token, so `load` takes the wallet it is for.
export function sessionStore(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
): SessionStore {
  const read = (): Session | null => {
    try {
      const raw = storage.getItem(SESSION_STORAGE_KEY)
      if (raw === null) return null
      const parsed = sessionSchema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
  const clear = (): void => {
    try {
      storage.removeItem(SESSION_STORAGE_KEY)
    } catch {
      // Nothing to clear.
    }
  }
  return {
    load(wallet, now = Date.now()) {
      const session = read()
      if (session === null || session.wallet !== wallet || !isLive(session, now)) {
        clear()
        return null
      }
      return session
    },
    token(now = Date.now()) {
      const session = read()
      return session !== null && isLive(session, now) ? session.token : null
    },
    save(session) {
      try {
        storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
      } catch {
        // Private mode or a full quota: the session still lives in memory for this tab.
      }
    },
    clear,
  }
}

// ── Roles → routes ───────────────────────────────────────────────────────────

export const COMPANY_ROLES: readonly Role[] = ['admin', 'compliance_officer']

export function companyMemberships(memberships: readonly Membership[]): Membership[] {
  return memberships.filter((membership) => COMPANY_ROLES.includes(membership.role))
}

// Where a wallet lands after sign-in (FR-017): an admin or officer opens their
// company panel — one company straight away, several via a chooser; anyone else
// is an investor and gets the cabinet, even with no holdings yet.
export function landingFor(memberships: readonly Membership[]): string {
  const companies = [...new Set(companyMemberships(memberships).map((m) => m.companyId))]
  if (companies.length === 1) return `/company/${companies[0]}`
  if (companies.length > 1) return '/company'
  return '/cabinet'
}

export function rolesIn(session: Session, companyId: string): Role[] {
  return session.memberships
    .filter((membership) => membership.companyId === companyId)
    .map((membership) => membership.role)
}
