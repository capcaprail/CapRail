import type { JournalEntry, WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { attemptReportFrom, journalCounts, trimLogs } from './model.ts'

const ADMIN = 'A1ice11111111111111111111111111111111111111' as WalletAddress
const BOB = 'Bob1111111111111111111111111111111111111111' as WalletAddress
const transfer = { mint: 'Mint', sourceOwner: ADMIN, destOwner: BOB, amount: 100n } as const

const REFUSAL = [
  'Program log: Instruction: Execute',
  'Program log: AnchorError occurred. Error Code: AccreditationExpired. Error Number: 6001. Error Message: expired.',
]

describe('attemptReportFrom', () => {
  it('reports a simulation refusal for a hook reason, with the amount as a decimal string', () => {
    expect(
      attemptReportFrom(transfer, {
        kind: 'refused',
        reason: 'AccreditationExpired',
        logs: REFUSAL,
        signature: null,
      }),
    ).toEqual({
      mint: 'Mint',
      sourceOwner: ADMIN,
      destOwner: BOB,
      amount: '100',
      reasonCode: 'AccreditationExpired',
      logs: REFUSAL,
    })
  })

  it('reports nothing for a settled plan, a chain refusal, or a reason that is not the hook’s', () => {
    expect(attemptReportFrom(transfer, { kind: 'settled', signature: 's', slot: 1 })).toBeNull()
    expect(
      attemptReportFrom(transfer, {
        kind: 'refused',
        reason: 'NotAccredited',
        logs: REFUSAL,
        signature: 'sent',
      }),
    ).toBeNull()
    expect(
      attemptReportFrom(transfer, {
        kind: 'refused',
        reason: 'ConstraintSeeds',
        logs: [],
        signature: null,
      }),
    ).toBeNull()
    expect(
      attemptReportFrom(transfer, { kind: 'refused', reason: null, logs: [], signature: null }),
    ).toBeNull()
    expect(attemptReportFrom(transfer, { kind: 'failed', message: 'declined' })).toBeNull()
  })
})

describe('trimLogs', () => {
  it('keeps the tail of the logs and bounds the line length', () => {
    const logs = Array.from({ length: 25 }, (_, i) => `line ${i}`)
    const trimmed = trimLogs([...logs, 'x'.repeat(1_200)])
    expect(trimmed).toHaveLength(20)
    expect(trimmed[0]).toBe('line 6')
    expect(trimmed[19]).toHaveLength(1_000)
  })
})

describe('journalCounts', () => {
  it('tallies settled, refused, and where the refusals came from', () => {
    const entry = (outcome: JournalEntry['outcome'], origin: JournalEntry['origin']) =>
      ({ outcome, origin }) as JournalEntry
    expect(
      journalCounts([
        entry('allowed', 'chain'),
        entry('rejected', 'chain'),
        entry('rejected', 'simulation'),
        entry('rejected', 'simulation'),
      ]),
    ).toEqual({ attempts: 4, settled: 1, refused: 3, refusedOnChain: 1, refusedInSimulation: 2 })
    expect(journalCounts([])).toEqual({
      attempts: 0,
      settled: 0,
      refused: 0,
      refusedOnChain: 0,
      refusedInSimulation: 0,
    })
  })
})
