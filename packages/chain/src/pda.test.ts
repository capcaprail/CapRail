import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  ata,
  companyPda,
  extraAccountMetaListPda,
  grantPda,
  investorRecordPda,
  mintPda,
  tokenConfigPda,
  transferPermitPda,
  treasuryAta,
  u32Le,
  u64Le,
} from './pda.ts'
import { HOOK_PROGRAM_ID, PROGRAM_ID } from './program.ts'
import { loadHookFixture } from './test/hook-fixture.ts'

// The fixture is written by the program's own derivations (Rust test
// `the_vendored_fixture_is_the_program_list_and_its_addresses`); this file proves the
// TypeScript side derives the same addresses from the same inputs.
const sample = loadHookFixture()

describe('seeds are little-endian and exactly as wide as the Rust field', () => {
  it('u64', () => {
    expect([...u64Le(7n)]).toEqual([7, 0, 0, 0, 0, 0, 0, 0])
    expect([...u64Le(0xffff_ffff_ffff_ffffn)]).toEqual(Array(8).fill(0xff))
    expect(() => u64Le(-1n)).toThrow(RangeError)
    expect(() => u64Le(1n << 64n)).toThrow(RangeError)
  })

  it('u32', () => {
    expect([...u32Le(1)]).toEqual([1, 0, 0, 0])
    expect(() => u32Le(-1)).toThrow(RangeError)
    expect(() => u32Le(1.5)).toThrow(RangeError)
    expect(() => u32Le(2 ** 32)).toThrow(RangeError)
  })
})

describe('addresses match the program for the fixture inputs', () => {
  const company = companyPda(sample.companyId)
  const mint = mintPda(company, sample.tokenIndex)
  const { sender, recipient } = sample

  it('company and mint', () => {
    expect(company.equals(sample.company)).toBe(true)
    expect(mint.equals(sample.mint)).toBe(true)
  })

  it('token config, treasury and the hook list', () => {
    expect(tokenConfigPda(mint).equals(sample.tokenConfig)).toBe(true)
    expect(treasuryAta(company, mint).equals(sample.treasury)).toBe(true)
    expect(extraAccountMetaListPda(mint).equals(sample.extraAccountMetaList)).toBe(true)
  })

  it('token accounts of both parties', () => {
    expect(ata(sender, mint).equals(sample.source)).toBe(true)
    expect(ata(recipient, mint).equals(sample.destination)).toBe(true)
  })

  it('the record of the recipient, the grant of the sender, the permit of the source', () => {
    expect(investorRecordPda(mint, recipient).equals(sample.investorRecord)).toBe(true)
    expect(grantPda(mint, sender).equals(sample.grant)).toBe(true)
    expect(transferPermitPda(ata(sender, mint)).equals(sample.transferPermit)).toBe(true)
  })

  it('state PDAs live under caprail, the list under the hook', () => {
    expect(PublicKey.isOnCurve(company.toBytes())).toBe(false)
    expect(PublicKey.isOnCurve(extraAccountMetaListPda(mint).toBytes())).toBe(false)
    expect(
      PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('extra-account-metas'), mint.toBytes()],
        HOOK_PROGRAM_ID,
      )[0].equals(extraAccountMetaListPda(mint)),
    ).toBe(true)
    expect(
      PublicKey.findProgramAddressSync(
        [new TextEncoder().encode('token'), mint.toBytes()],
        PROGRAM_ID,
      )[0].equals(tokenConfigPda(mint)),
    ).toBe(true)
  })

  it('a different token index is a different mint', () => {
    expect(mintPda(company, 1).equals(mint)).toBe(false)
  })
})
