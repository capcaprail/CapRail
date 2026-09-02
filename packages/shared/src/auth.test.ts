import { describe, expect, it } from 'vitest'
import {
  authNonceRequestSchema,
  authVerifyRequestSchema,
  authVerifyResponseSchema,
  membershipSchema,
  nonceSchema,
  signatureSchema,
  signInMessage,
} from './auth.ts'
import { encodeBase58, type WalletAddress } from './primitives.ts'

const WALLET = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g' as WalletAddress
const PDA = 'a8a4KNjnNoSsDvYuKAuFptgt471FtC3UsrYT3sT5Mm4'
const NONCE = '0123456789abcdef0123456789abcdef'
const SIGNATURE = encodeBase58(new Uint8Array(64).fill(7))

describe('auth schemas', () => {
  it('accept a wallet on the curve and refuse a PDA or garbage', () => {
    expect(authNonceRequestSchema.safeParse({ wallet: WALLET }).success).toBe(true)
    expect(authNonceRequestSchema.safeParse({ wallet: PDA }).success).toBe(false)
    expect(authNonceRequestSchema.safeParse({ wallet: 'x' }).success).toBe(false)
    expect(authNonceRequestSchema.safeParse({}).success).toBe(false)
  })

  it('require a 32-char hex nonce', () => {
    expect(nonceSchema.safeParse(NONCE).success).toBe(true)
    expect(nonceSchema.safeParse(NONCE.toUpperCase()).success).toBe(false)
    expect(nonceSchema.safeParse(NONCE.slice(1)).success).toBe(false)
  })

  it('require a base58 signature of exactly 64 bytes', () => {
    expect(signatureSchema.safeParse(SIGNATURE).success).toBe(true)
    expect(signatureSchema.safeParse(encodeBase58(new Uint8Array(63))).success).toBe(false)
    expect(signatureSchema.safeParse('0OIl').success).toBe(false)
    expect(signatureSchema.safeParse(42).success).toBe(false)
  })

  it('validate the verify request as a whole', () => {
    const ok = authVerifyRequestSchema.safeParse({
      wallet: WALLET,
      signature: SIGNATURE,
      nonce: NONCE,
    })
    expect(ok.success).toBe(true)
    expect(
      authVerifyRequestSchema.safeParse({ wallet: WALLET, signature: SIGNATURE }).success,
    ).toBe(false)
  })

  it('limit roles to the three the program knows', () => {
    expect(membershipSchema.safeParse({ companyId: 'c', role: 'admin' }).success).toBe(true)
    expect(membershipSchema.safeParse({ companyId: 'c', role: 'owner' }).success).toBe(false)
    expect(membershipSchema.safeParse({ companyId: '', role: 'investor' }).success).toBe(false)
    expect(authVerifyResponseSchema.safeParse({ token: 't', memberships: [] }).success).toBe(true)
    expect(authVerifyResponseSchema.safeParse({ token: '', memberships: [] }).success).toBe(false)
  })
})

describe('signInMessage', () => {
  it('names the wallet and the nonce and is deterministic', () => {
    const message = signInMessage(WALLET, NONCE)
    expect(message).toContain(`Wallet: ${WALLET}`)
    expect(message).toContain(`Nonce: ${NONCE}`)
    expect(message).toBe(signInMessage(WALLET, NONCE))
    expect(message).not.toBe(signInMessage(WALLET, NONCE.replace('0', '1')))
  })
})
