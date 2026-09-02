import { z } from 'zod'
import { decodeBase58, type WalletAddress, walletAddressSchema } from './primitives.ts'

// Roles are the program's, not the panel's: `admin` and `compliance_officer` are the
// two keys `Company` stores, `investor` is a wallet with an `InvestorRecord`.
export const ROLES = ['admin', 'compliance_officer', 'investor'] as const
export const roleSchema = z.enum(ROLES)
export type Role = z.infer<typeof roleSchema>

export const membershipSchema = z.object({
  companyId: z.string().min(1),
  role: roleSchema,
})
export type Membership = z.infer<typeof membershipSchema>

// 16 random bytes as hex: enough entropy for a five-minute single-use value, and
// short enough to stay readable in the wallet's signing prompt.
export const NONCE_BYTES = 16
export const nonceSchema = z.string().regex(/^[0-9a-f]{32}$/, 'expected a 32-char hex nonce')

const ED25519_SIGNATURE_BYTES = 64

export function isSignature(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const bytes = decodeBase58(value)
  return bytes !== null && bytes.length === ED25519_SIGNATURE_BYTES
}

export const signatureSchema = z.custom<string>(isSignature, {
  message: 'expected a base58 ed25519 signature of 64 bytes',
})

export const authNonceRequestSchema = z.object({ wallet: walletAddressSchema })
export type AuthNonceRequest = z.infer<typeof authNonceRequestSchema>

export const authNonceResponseSchema = z.object({ nonce: nonceSchema, message: z.string() })
export type AuthNonceResponse = z.infer<typeof authNonceResponseSchema>

export const authVerifyRequestSchema = z.object({
  wallet: walletAddressSchema,
  signature: signatureSchema,
  nonce: nonceSchema,
})
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>

export const authVerifyResponseSchema = z.object({
  token: z.string().min(1),
  memberships: z.array(membershipSchema),
})
export type AuthVerifyResponse = z.infer<typeof authVerifyResponseSchema>

// The text the wallet signs. Deterministic in (wallet, nonce) so the API rebuilds it
// on verify instead of storing it; the expiry lives in the nonce row, not in the text.
// Naming the wallet inside binds the signature to the address that asked for the nonce.
export function signInMessage(wallet: WalletAddress, nonce: string): string {
  return `CapRail sign-in\n\nWallet: ${wallet}\nNonce: ${nonce}`
}
