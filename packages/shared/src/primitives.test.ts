import { describe, expect, it } from 'vitest'
import { decodeBase58, isOnCurve, isWalletAddress, walletAddressSchema } from './primitives.ts'

const PROGRAM_ID = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g'
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
const SYSTEM_PROGRAM = '11111111111111111111111111111111'
const PDA_COMPANY = 'a8a4KNjnNoSsDvYuKAuFptgt471FtC3UsrYT3sT5Mm4'
const PDA_TREASURY = '5J6MoHaXWKpTB2AghnG3CzuQz6J1QaYLsePj8zFMYbA2'

describe('decodeBase58', () => {
  it('decodes a 44-char key to 32 bytes', () => {
    const bytes = decodeBase58(PROGRAM_ID)
    expect(bytes?.length).toBe(32)
  })

  it('keeps leading zero bytes for leading ones', () => {
    const bytes = decodeBase58(SYSTEM_PROGRAM)
    expect(bytes).toEqual(new Uint8Array(32))
  })

  it('returns null on characters outside the alphabet', () => {
    expect(decodeBase58('0OIl')).toBeNull()
    expect(decodeBase58('')).toBeNull()
  })
})

describe('isOnCurve', () => {
  it('accepts keypair-derived keys', () => {
    for (const key of [PROGRAM_ID, ATA_PROGRAM, SYSTEM_PROGRAM]) {
      const bytes = decodeBase58(key)
      expect(bytes).not.toBeNull()
      expect(isOnCurve(bytes as Uint8Array)).toBe(true)
    }
  })

  it('rejects program-derived addresses', () => {
    for (const key of [PDA_COMPANY, PDA_TREASURY]) {
      const bytes = decodeBase58(key)
      expect(bytes).not.toBeNull()
      expect(isOnCurve(bytes as Uint8Array)).toBe(false)
    }
  })

  it('rejects y >= p and wrong length', () => {
    const tooBig = new Uint8Array(32).fill(0xff)
    tooBig[31] = 0x7f
    expect(isOnCurve(tooBig)).toBe(false)
    expect(isOnCurve(new Uint8Array(31))).toBe(false)
  })
})

describe('walletAddressSchema', () => {
  it('parses an on-curve base58 key', () => {
    expect(walletAddressSchema.parse(PROGRAM_ID)).toBe(PROGRAM_ID)
    expect(isWalletAddress(ATA_PROGRAM)).toBe(true)
  })

  it('rejects a PDA — not a wallet', () => {
    expect(walletAddressSchema.safeParse(PDA_COMPANY).success).toBe(false)
    expect(isWalletAddress(PDA_TREASURY)).toBe(false)
  })

  it('rejects malformed input without throwing', () => {
    for (const bad of [
      '',
      'not-base58-0OIl',
      PROGRAM_ID.slice(0, 20),
      `${PROGRAM_ID}1`,
      42,
      null,
    ]) {
      expect(walletAddressSchema.safeParse(bad).success).toBe(false)
      expect(isWalletAddress(bad)).toBe(false)
    }
  })
})
