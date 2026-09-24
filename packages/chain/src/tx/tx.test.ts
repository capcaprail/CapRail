import { BN, BorshInstructionCoder } from '@anchor-lang/core'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import {
  type AccountInfo,
  Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { ata, extraAccountMetaListPda, platformPda, tokenConfigPda } from '../pda.ts'
import { createCaprailProgram, HOOK_PROGRAM_ID, PROGRAM_ID } from '../program.ts'
import { loadHookFixture } from '../test/hook-fixture.ts'
import { buildCreateCompany, buildSetRoles } from './company.ts'
import { buildSetInvestorStatus, jurisdictionBytes } from './investors.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, type TxPlan, transactionBytes } from './plan.ts'
import { buildInitPlatform, FEE_BPS_MAX, platformFee } from './platform.ts'
import {
  buildCreateToken,
  buildSetPolicy,
  TOKEN_NAME_MAX_BYTES,
  TOKEN_SYMBOL_MAX_BYTES,
  TOKEN_URI_MAX_BYTES,
  tokenAddresses,
} from './token.ts'
import { buildDistribute, buildTransfer, expectedTransferTail, hookAccounts } from './transfer.ts'

// No builder here talks to the node: `Program` needs a provider only to send, which this
// package never does. The one path that reads accounts (`buildTransfer`) gets a fake
// connection serving the fixture.
const program = createCaprailProgram(new Connection('http://127.0.0.1:8899'))
const fixture = loadHookFixture()

const ADMIN = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const OFFICER = new PublicKey('SysvarRent111111111111111111111111111111111')
const BLOCKHASH = '11111111111111111111111111111111'

const POLICY = { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 }

function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

/**
 * Round trip through the coder. The Anchor coder writes 0 for a field that is missing
 * from the object it is given — the bytes are valid, the meaning is not — so every
 * builder is decoded back and compared field by field.
 */
function decode(instruction: TransactionInstruction): { name: string; data: unknown } {
  const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data)
  if (decoded === null) throw new Error('instruction data does not decode')
  return { name: decoded.name, data: plain(decoded.data) }
}

// Decoded values in a comparable form: `BN` and `PublicKey` compare by content, not by
// their internal word arrays (a decoded BN carries trailing zero words).
function plain(value: unknown): unknown {
  // `bn.js` ships no types here, so `instanceof BN` does not narrow; `String()` takes unknown.
  if (value instanceof BN) return String(value)
  if (value instanceof PublicKey) return value.toBase58()
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]),
    )
  }
  return value
}

/** The instruction's accounts against the IDL: same count, same signer/writable flags. */
function expectAccountsAsDeclared(instruction: TransactionInstruction, name: string) {
  const declared = program.idl.instructions.find((i) => i.name === name)?.accounts
  if (declared === undefined) throw new Error(`${name}: not in the IDL`)
  expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
  expect(instruction.keys.map((k) => [k.isSigner, k.isWritable])).toEqual(
    declared.map((a) => [
      Boolean('signer' in a && a.signer),
      Boolean('writable' in a && a.writable),
    ]),
  )
}

const keyAt = (instruction: TransactionInstruction, index: number): PublicKey => {
  const meta = instruction.keys[index]
  if (meta === undefined) throw new Error(`no account at ${index}`)
  return meta.pubkey
}

describe('initPlatform', () => {
  const PAYMENT_MINT = new PublicKey('SysvarS1otHashes111111111111111111111111111')
  const FEE_TREASURY = new PublicKey('SysvarS1otHistory11111111111111111111111111')
  const args = {
    authority: ADMIN,
    paymentMint: PAYMENT_MINT,
    feeTreasury: FEE_TREASURY,
    feeBps: 100,
  }

  it('carries the fee as a bare u16 and addresses the one platform PDA', async () => {
    const plan = await buildInitPlatform(program, args)
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'initPlatform')
    expect(decode(instruction)).toEqual({ name: 'initPlatform', data: { feeBps: 100 } })
    expect(keyAt(instruction, 0).equals(ADMIN)).toBe(true)
    expect(keyAt(instruction, 1).equals(platformPda())).toBe(true)
    expect(keyAt(instruction, 2).equals(PAYMENT_MINT)).toBe(true)
    expect(keyAt(instruction, 3).equals(FEE_TREASURY)).toBe(true)
    // The offline authority is the only signer: no server co-signs this one.
    expect(plan.signers).toEqual([ADMIN])
  })

  it('refuses a fee the program would refuse, before the key is asked to sign', async () => {
    await expect(buildInitPlatform(program, { ...args, feeBps: FEE_BPS_MAX + 1 })).rejects.toThrow(
      RangeError,
    )
    await expect(buildInitPlatform(program, { ...args, feeBps: -1 })).rejects.toThrow(RangeError)
    await expect(buildInitPlatform(program, { ...args, feeBps: 1.5 })).rejects.toThrow(RangeError)
  })

  // The same numbers as `programs/caprail/tests/market_state.rs`: the panel shows this
  // figure before the buyer accepts, and the chain then charges exactly it (FR-013).
  it('computes the fee like the program does — down, never above the nominal share', () => {
    expect(platformFee(100, 1_000_000n)).toBe(10_000n)
    expect(platformFee(100, 99n)).toBe(0n)
    expect(platformFee(0, 18_446_744_073_709_551_615n)).toBe(0n)
    expect(platformFee(FEE_BPS_MAX, 18_446_744_073_709_551_615n)).toBe(1_844_674_407_370_955_161n)
    // Parts of a partial fill never add up to more than the fee of the whole.
    const whole = platformFee(250, 100_000_000n)
    const parts = [150, 150, 100]
      .map((amount) => platformFee(250, BigInt(amount) * 250_000n))
      .reduce((a, b) => a + b, 0n)
    expect(parts).toBeLessThanOrEqual(whole)
  })
})

describe('createCompany', () => {
  const args = {
    companyId: fixture.companyId,
    admin: ADMIN,
    complianceOfficer: OFFICER,
    name: 'Acme',
  }

  it('encodes the arguments and decodes them back unchanged', async () => {
    const instruction = only(await buildCreateCompany(program, args))
    const { name, data } = decode(instruction)
    expect(name).toBe('createCompany')
    expect(data).toEqual({
      args: { companyId: '7', complianceOfficer: OFFICER.toBase58(), name: 'Acme' },
    })
  })

  it('addresses the company PDA the program will create, and the admin signs', async () => {
    const plan = await buildCreateCompany(program, args)
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'createCompany')
    expect(keyAt(instruction, 0).equals(ADMIN)).toBe(true)
    expect(keyAt(instruction, 1).equals(fixture.company)).toBe(true)
    expect(keyAt(instruction, 2).equals(SystemProgram.programId)).toBe(true)
    expect(plan.signers).toEqual([ADMIN])
    expect(plan.feePayer.equals(ADMIN)).toBe(true)
  })
})

describe('setRoles', () => {
  it('carries both new keys as positional arguments', async () => {
    const newAdmin = PublicKey.unique()
    const newOfficer = PublicKey.unique()
    const plan = await buildSetRoles(program, {
      company: fixture.company,
      admin: ADMIN,
      newAdmin,
      newComplianceOfficer: newOfficer,
    })
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'setRoles')
    expect(decode(instruction)).toEqual({
      name: 'setRoles',
      data: { admin: newAdmin.toBase58(), complianceOfficer: newOfficer.toBase58() },
    })
    expect(plan.signers).toEqual([ADMIN])
  })
})

describe('createToken', () => {
  const args = {
    company: fixture.company,
    admin: ADMIN,
    tokenIndex: fixture.tokenIndex,
    name: 'Acme Series A',
    symbol: 'ACME',
    uri: '',
    decimals: 0,
    totalSupply: 1_000_000n,
    policy: POLICY,
  }

  it('round-trips every argument, the policy included', async () => {
    const instruction = only(await buildCreateToken(program, args))
    expect(decode(instruction)).toEqual({
      name: 'createToken',
      data: {
        args: {
          name: 'Acme Series A',
          symbol: 'ACME',
          uri: '',
          decimals: 0,
          totalSupply: '1000000',
          policy: POLICY,
        },
      },
    })
  })

  it('derives mint, config, treasury and the hook list the way the program does', async () => {
    const instruction = only(await buildCreateToken(program, args))
    expectAccountsAsDeclared(instruction, 'createToken')
    const addresses = tokenAddresses(fixture.company, fixture.tokenIndex)
    expect(addresses.mint.equals(fixture.mint)).toBe(true)
    expect(addresses.tokenConfig.equals(fixture.tokenConfig)).toBe(true)
    expect(addresses.treasury.equals(fixture.treasury)).toBe(true)
    expect(addresses.extraAccountMetaList.equals(fixture.extraAccountMetaList)).toBe(true)
    expect(keyAt(instruction, 2).equals(fixture.mint)).toBe(true)
    expect(keyAt(instruction, 5).equals(fixture.extraAccountMetaList)).toBe(true)
    expect(keyAt(instruction, 6).equals(HOOK_PROGRAM_ID)).toBe(true)
    expect(keyAt(instruction, 7).equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
  })

  it('fits the transaction budget with the longest allowed metadata', async () => {
    const plan = await buildCreateToken(program, {
      ...args,
      name: 'x'.repeat(TOKEN_NAME_MAX_BYTES),
      symbol: 'y'.repeat(TOKEN_SYMBOL_MAX_BYTES),
      uri: 'z'.repeat(TOKEN_URI_MAX_BYTES),
    })
    const transaction = compileTransaction(plan, BLOCKHASH)
    expect(transactionBytes(transaction)).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
    expect(transaction.version).toBe(0)
  })
})

describe('setPolicy', () => {
  it('sends the policy as a struct and addresses the config of the mint', async () => {
    const plan = await buildSetPolicy(program, {
      company: fixture.company,
      mint: fixture.mint,
      admin: ADMIN,
      policy: { ...POLICY, requireAccreditation: false },
    })
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'setPolicy')
    expect(decode(instruction)).toEqual({
      name: 'setPolicy',
      data: { policy: { ...POLICY, requireAccreditation: false } },
    })
    expect(keyAt(instruction, 2).equals(fixture.tokenConfig)).toBe(true)
  })
})

describe('setInvestorStatus', () => {
  const args = {
    company: fixture.company,
    mint: fixture.mint,
    complianceOfficer: OFFICER,
    wallet: fixture.recipient,
    status: 'approved' as const,
    expiresAt: 1_900_000_000n,
    jurisdiction: 'UA',
    investorType: 1,
  }

  it('encodes the enum, the i64 and the two-byte jurisdiction, and decodes them back', async () => {
    const instruction = only(await buildSetInvestorStatus(program, args))
    expect(decode(instruction)).toEqual({
      name: 'setInvestorStatus',
      data: {
        args: {
          wallet: fixture.recipient.toBase58(),
          status: { approved: {} },
          expiresAt: '1900000000',
          jurisdiction: [85, 65],
          investorType: 1,
        },
      },
    })
  })

  it('the officer signs, the record is the one the hook will read for this wallet', async () => {
    const plan = await buildSetInvestorStatus(program, args)
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'setInvestorStatus')
    expect(plan.signers).toEqual([OFFICER])
    expect(keyAt(instruction, 3).equals(fixture.investorRecord)).toBe(true)
  })

  it('an unset jurisdiction is two zero bytes; anything but two bytes is refused here', () => {
    expect(jurisdictionBytes('')).toEqual([0, 0])
    expect(jurisdictionBytes('UA')).toEqual([85, 65])
    expect(() => jurisdictionBytes('UKR')).toThrow(RangeError)
    expect(() => jurisdictionBytes('U')).toThrow(RangeError)
  })
})

describe('distribute', () => {
  const args = {
    company: fixture.company,
    mint: fixture.mint,
    admin: ADMIN,
    investor: fixture.recipient,
    amount: 2_500n,
  }

  it('round-trips the amount', async () => {
    const instruction = only(await buildDistribute(program, args))
    expect(decode(instruction)).toEqual({ name: 'distribute', data: { amount: '2500' } })
  })

  it('passes the hook tail explicitly — the same accounts the on-chain list resolves to', async () => {
    const plan = await buildDistribute(program, args)
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'distribute')
    expect(plan.signers).toEqual([ADMIN])
    expect(keyAt(instruction, 4).equals(fixture.treasury)).toBe(true)
    expect(keyAt(instruction, 6).equals(fixture.destination)).toBe(true)
    expect(keyAt(instruction, 7).equals(fixture.extraAccountMetaList)).toBe(true)
    expect(keyAt(instruction, 8).equals(PROGRAM_ID)).toBe(true)
    expect(keyAt(instruction, 9).equals(fixture.investorRecord)).toBe(true)
    // The grant is the sender's — the treasury has none, but the address is still derived
    // from the company; the permit is keyed by the treasury account.
    const hook = hookAccounts(fixture.mint, fixture.company, fixture.recipient)
    expect(keyAt(instruction, 10).equals(hook.grant)).toBe(true)
    expect(keyAt(instruction, 11).equals(hook.transferPermit)).toBe(true)
    expect(keyAt(instruction, 12).equals(HOOK_PROGRAM_ID)).toBe(true)
  })
})

describe('transfer through the hook', () => {
  // What a wallet would find on-chain: the list the program wrote, and two token accounts
  // whose `owner` field (bytes 32..64) the list's seeds read.
  const tokenAccount = (owner: PublicKey): AccountInfo<Buffer> => {
    const data = Buffer.alloc(165)
    fixture.mint.toBuffer().copy(data, 0)
    owner.toBuffer().copy(data, 32)
    return { data, owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }
  }
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [
      fixture.extraAccountMetaList.toBase58(),
      {
        data: Buffer.from(fixture.list),
        owner: HOOK_PROGRAM_ID,
        lamports: 1,
        executable: false,
      },
    ],
    [fixture.source.toBase58(), tokenAccount(fixture.sender)],
    [fixture.destination.toBase58(), tokenAccount(fixture.recipient)],
  ])
  const reads: string[] = []
  const connection = {
    getAccountInfo: async (key: PublicKey) => {
      reads.push(key.toBase58())
      return accounts.get(key.toBase58()) ?? null
    },
  } as unknown as Connection

  const args = {
    mint: fixture.mint,
    owner: fixture.sender,
    recipient: fixture.recipient,
    amount: 10n,
    decimals: 0,
  }

  it('resolves the tail from the on-chain list to exactly the offline derivation', async () => {
    const plan = await buildTransfer(connection, args)
    const instruction = only(plan)
    expect(instruction.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(plan.signers).toEqual([fixture.sender])

    const [source, mint, destination, owner, ...tail] = instruction.keys
    expect(source?.pubkey.equals(fixture.source)).toBe(true)
    expect(mint?.pubkey.equals(fixture.mint)).toBe(true)
    expect(destination?.pubkey.equals(fixture.destination)).toBe(true)
    expect(owner?.pubkey.equals(fixture.sender)).toBe(true)
    expect(owner?.isSigner).toBe(true)

    const expected = expectedTransferTail(fixture.mint, fixture.sender, fixture.recipient)
    expect(tail.map((k) => k.pubkey.toBase58())).toEqual(expected.map((k) => k.pubkey.toBase58()))
    expect(tail.every((k) => !k.isSigner && !k.isWritable)).toBe(true)
    expect(tail.map((k) => k.pubkey.toBase58())).toEqual(
      [
        PROGRAM_ID,
        fixture.tokenConfig,
        fixture.investorRecord,
        fixture.grant,
        fixture.transferPermit,
        HOOK_PROGRAM_ID,
        fixture.extraAccountMetaList,
      ].map((k) => k.toBase58()),
    )
  })

  it('reads only the list and the two token accounts', async () => {
    reads.length = 0
    await buildTransfer(connection, args)
    expect(new Set(reads)).toEqual(
      new Set(
        [fixture.extraAccountMetaList, fixture.source, fixture.destination].map((k) =>
          k.toBase58(),
        ),
      ),
    )
  })

  it('refuses a mint without a list instead of sending a bare transfer', async () => {
    const empty = { getAccountInfo: async () => null } as unknown as Connection
    await expect(buildTransfer(empty, args)).rejects.toThrow(/no ExtraAccountMetaList/)
  })

  it('offline and on-chain tails agree for another pair of wallets too', () => {
    const sender = PublicKey.unique()
    const recipient = PublicKey.unique()
    const hook = hookAccounts(fixture.mint, sender, recipient)
    expect(hook.tokenConfig.equals(tokenConfigPda(fixture.mint))).toBe(true)
    expect(
      hook.transferPermit.equals(hookAccounts(fixture.mint, sender, ADMIN).transferPermit),
    ).toBe(true)
    expect(
      hook.investorRecord.equals(hookAccounts(fixture.mint, ADMIN, recipient).investorRecord),
    ).toBe(true)
    expect(ata(sender, fixture.mint).equals(ata(recipient, fixture.mint))).toBe(false)
    expect(extraAccountMetaListPda(fixture.mint).equals(fixture.extraAccountMetaList)).toBe(true)
  })

  it('fits the transaction budget', async () => {
    const plan = await buildTransfer(connection, args)
    expect(transactionBytes(compileTransaction(plan, BLOCKHASH))).toBeLessThanOrEqual(
      MAX_TRANSACTION_BYTES,
    )
  })
})
