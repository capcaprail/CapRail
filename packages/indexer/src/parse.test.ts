import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOOK_PROGRAM_ID, PROGRAM_ID } from '@caprail/chain'
import { describe, expect, it } from 'vitest'
import type { ProgramTransaction } from './index.ts'
import { type IndexedEvent, parseTransaction } from './parse.ts'

// Real transactions dumped by `pnpm demo:us1 -- --dump fixtures/logs` on localnet:
// one per event kind and one refusal per reason. Read with `fs` — outside `rootDir`.
const DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'logs')

type Fixture = ProgramTransaction & { kind: string }

const fixtures = new Map(
  readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture
      return [fixture.kind, fixture] as const
    }),
)

function fixture(kind: string): Fixture {
  const found = fixtures.get(kind)
  if (found === undefined) throw new Error(`no fixture ${kind}`)
  return found
}

function only<K extends IndexedEvent['kind']>(
  kind: string,
  eventKind: K,
): Extract<IndexedEvent, { kind: K }> {
  const parsed = parseTransaction(fixture(kind))
  expect(parsed.failed, kind).toBe(false)
  expect(parsed.rejection, kind).toBeNull()
  expect(parsed.failure, kind).toBeNull()
  expect(parsed.events, kind).toHaveLength(1)
  const event = parsed.events[0]
  if (event?.kind !== eventKind)
    throw new Error(`${kind}: expected ${eventKind}, got ${event?.kind}`)
  expect(event.eventIndex).toBe(0)
  return event as Extract<IndexedEvent, { kind: K }>
}

describe('parseTransaction on the US1 fixtures', () => {
  const company = only('create-company', 'CompanyCreated')
  const token = only('create-token', 'TokenCreated')
  const policy = only('set-policy', 'PolicySet')
  const status = only('set-investor-status', 'InvestorStatusSet')
  const distribute = only('distribute', 'TransferAllowed')
  const transfer = only('transfer-allowed', 'TransferAllowed')

  it('reads every field of the six events, and they tell one story', () => {
    expect(company.name).toBe('Demo Corp')
    expect(company.companyId).toBeGreaterThan(0n)
    expect(company.admin).not.toBe(company.complianceOfficer)

    expect(token.company).toBe(company.company)
    expect(token.decimals).toBe(0)
    expect(token.totalSupply).toBe(1_000_000n)
    expect(token.policy).toEqual({
      requireAccreditation: true,
      requireRofr: false,
      rofrWindowSecs: 0,
    })
    expect(token.policyVersion).toBe(1)

    expect(policy.mint).toBe(token.mint)
    expect(policy.policyVersion).toBe(2)
    expect(policy.setAt).toBeGreaterThan(1_700_000_000)

    expect(status.mint).toBe(token.mint)
    expect(status.status).toBe('approved')
    expect(status.jurisdiction).toBe('UA')
    expect(status.investorType).toBe(1)
    expect(status.expiresAt).toBeGreaterThan(status.updatedAt)
    expect(status.updatedBy).toBe(company.complianceOfficer)

    // `distribute` is treasury → investor, signed by the Company PDA.
    expect(distribute.mint).toBe(token.mint)
    expect(distribute.source).toBe(token.treasury)
    expect(distribute.sourceOwner).toBe(company.company)
    expect(distribute.fromTreasury).toBe(true)
    expect(distribute.policyVersion).toBe(2)

    // The investor-to-investor transfer went out from the account distribute filled.
    expect(transfer.source).toBe(distribute.destination)
    expect(transfer.sourceOwner).toBe(distribute.destinationOwner)
    expect(transfer.fromTreasury).toBe(false)
    expect(transfer.amount).toBeGreaterThan(0n)
  })

  it('names the reason and the parties of a refused transfer', () => {
    for (const [kind, reason, number] of [
      ['transfer-refused-not-accredited', 'NotAccredited', 6000],
      ['transfer-refused-expired', 'AccreditationExpired', 6001],
    ] as const) {
      const parsed = parseTransaction(fixture(kind))
      expect(parsed.failed, kind).toBe(true)
      expect(parsed.events, kind).toEqual([])
      expect(parsed.failure, kind).toBeNull()
      expect(parsed.rejection?.reason, kind).toBe(reason)
      expect(parsed.rejection?.errorNumber, kind).toBe(number)
      expect(JSON.stringify(fixture(kind).err), kind).toContain(`"Custom":${number}`)
      // Same sender and source account as the allowed transfer — alice, refused
      // towards a wallet outside the registry.
      const refused = parsed.rejection?.transfer
      expect(refused?.mint, kind).toBe(token.mint)
      expect(refused?.source, kind).toBe(transfer.source)
      expect(refused?.sourceOwner, kind).toBe(transfer.sourceOwner)
      expect(refused?.destination, kind).not.toBe(transfer.destination)
      expect(refused?.amount, kind).toBeGreaterThan(0n)
      expect(refused?.decimals, kind).toBe(token.decimals)
    }
  })

  it('leaves the transfer empty when the transaction came without instructions (onLogs)', () => {
    const {
      instructions: _dropped,
      accountKeys: _keys,
      ...fromLogs
    } = fixture('transfer-refused-not-accredited')
    const parsed = parseTransaction(fromLogs)
    expect(parsed.rejection?.reason).toBe('NotAccredited')
    expect(parsed.rejection?.transfer).toBeNull()
  })

  it('drops the events of a failed transaction — they were rolled back', () => {
    const parsed = parseTransaction({
      ...fixture('transfer-allowed'),
      failed: true,
      err: { InstructionError: [0, { Custom: 1 }] },
    })
    expect(parsed.events).toEqual([])
    expect(parsed.rejection).toBeNull()
  })
})

const sig = 'sig'
const base = { signature: sig, slot: 1, blockTime: null, failed: true } as const
const CAPRAIL = PROGRAM_ID.toBase58()
const HOOK = HOOK_PROGRAM_ID.toBase58()

describe('parseTransaction on hand-made logs', () => {
  it('reports an error of the program itself as a failure, not a rejection', () => {
    const parsed = parseTransaction({
      ...base,
      err: { InstructionError: [0, { Custom: 6010 }] },
      logs: [
        `Program ${CAPRAIL} invoke [1]`,
        'Program log: Instruction: SetPolicy',
        'Program log: AnchorError thrown in programs/caprail/src/instructions/set_policy.rs:1. Error Code: RofrNotSupported. Error Number: 6010. Error Message: x.',
        `Program ${CAPRAIL} consumed 5000 of 200000 compute units`,
        `Program ${CAPRAIL} failed: custom program error: 0x177a`,
      ],
    })
    expect(parsed.rejection).toBeNull()
    expect(parsed.failure).toEqual({ program: CAPRAIL, code: 'RofrNotSupported', number: 6010 })
  })

  it('attributes the error to the hook only when the hook frame logged it', () => {
    const line =
      'Program log: AnchorError thrown in programs/caprail-hook/src/execute.rs:1. Error Code: NotAccredited. Error Number: 6000. Error Message: x.'
    const nested = parseTransaction({
      ...base,
      err: { InstructionError: [0, { Custom: 6000 }] },
      logs: [
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]',
        `Program ${HOOK} invoke [2]`,
        line,
        `Program ${HOOK} failed: custom program error: 0x1770`,
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1770',
      ],
    })
    expect(nested.rejection?.reason).toBe('NotAccredited')
    const elsewhere = parseTransaction({
      ...base,
      err: { InstructionError: [0, { Custom: 6000 }] },
      logs: [`Program ${CAPRAIL} invoke [1]`, line, `Program ${CAPRAIL} failed: x`],
    })
    expect(elsewhere.rejection).toBeNull()
    expect(elsewhere.failure?.program).toBe(CAPRAIL)
  })

  it('numbers events by their place among all Program data lines, skipping foreign ones', () => {
    const ours = fixture('set-policy').logs.find((l) => l.startsWith('Program data: '))
    if (ours === undefined) throw new Error('fixture without event')
    const parsed = parseTransaction({
      ...base,
      failed: false,
      logs: [
        'Program Foreign1111111111111111111111111111111111 invoke [1]',
        `Program data: ${Buffer.from('not one of ours, twelve bytes').toString('base64')}`,
        'Program Foreign1111111111111111111111111111111111 success',
        `Program ${CAPRAIL} invoke [1]`,
        ours,
        `Program ${CAPRAIL} success`,
      ],
    })
    expect(parsed.events.map((e) => [e.kind, e.eventIndex])).toEqual([['PolicySet', 1]])
  })

  it('ignores a failed transaction that has no Anchor error line', () => {
    const parsed = parseTransaction({
      ...base,
      err: { InstructionError: [0, 'InsufficientFunds'] },
      logs: [
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [1]',
        'Program log: Error: insufficient funds',
        'Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: custom program error: 0x1',
      ],
    })
    expect(parsed).toMatchObject({ events: [], rejection: null, failure: null })
  })
})
