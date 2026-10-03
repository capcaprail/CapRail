import type { JournalEntry, JournalTrade, PlatformView, WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { attemptReportFrom, journalCounts, tradeLine, trimLogs } from './model.ts'

const PAY = 'Pay1111111111111111111111111111111111111111'
// 600 shares at 1.25 dUSD with a 100 bps fee, as `demo:us2` trades them.
const TRADE: JournalTrade = {
  offer: 'Offer1111111111111111111111111111111111111',
  offerId: '7',
  pricePerUnit: '1250000',
  paymentMint: PAY,
  payment: '750000000',
  fee: '7500000',
  sellerReceives: '742500000',
}

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
  const entry = (
    outcome: JournalEntry['outcome'],
    origin: JournalEntry['origin'],
    trade: JournalTrade | null = null,
  ) => ({ outcome, origin, trade }) as JournalEntry

  it('tallies settled, refused, and where the refusals came from', () => {
    expect(
      journalCounts([
        entry('allowed', 'chain'),
        entry('rejected', 'chain'),
        entry('rejected', 'simulation'),
        entry('rejected', 'simulation'),
      ]),
    ).toEqual({
      attempts: 4,
      settled: 1,
      refused: 3,
      refusedOnChain: 1,
      refusedInSimulation: 2,
      trades: 0,
      fees: 0n,
    })
    expect(journalCounts([])).toEqual({
      attempts: 0,
      settled: 0,
      refused: 0,
      refusedOnChain: 0,
      refusedInSimulation: 0,
      trades: 0,
      fees: 0n,
    })
  })

  it('counts the trades among the settled and adds up their fees', () => {
    const counts = journalCounts([
      entry('allowed', 'chain', TRADE),
      entry('allowed', 'chain'),
      entry('allowed', 'chain', { ...TRADE, fee: '2500' }),
    ])
    expect(counts.settled).toBe(3)
    expect(counts.trades).toBe(2)
    expect(counts.fees).toBe(7_502_500n)
  })
})

describe('tradeLine', () => {
  const platform: PlatformView = {
    feeBps: 100,
    paymentMint: PAY,
    feeTreasury: 'Treasury111111111111111111111111111111111111',
    paymentTokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    paymentDecimals: 6,
    paymentSymbol: 'dUSD',
  }

  it('names the price per share and the money in the platform currency', () => {
    expect(tradeLine(TRADE, { decimals: 0 }, platform)).toEqual({
      price: '1.25 dUSD per share',
      paid: '750 dUSD',
      fee: '7.5 dUSD',
      sellerReceives: '742.5 dUSD',
    })
    // 2 decimals: one unit is a hundredth of a share.
    expect(tradeLine({ ...TRADE, pricePerUnit: '12500' }, { decimals: 2 }, platform).price).toBe(
      '1.25 dUSD per share',
    )
  })

  it('waits for the platform instead of flashing base units while it is read', () => {
    expect(tradeLine(TRADE, { decimals: 0 }, undefined)).toEqual({
      price: '… per share',
      paid: '…',
      fee: '…',
      sellerReceives: '…',
    })
  })

  it('falls back to base units rather than guess the currency', () => {
    expect(tradeLine(TRADE, { decimals: 0 }, null).fee).toBe('7500000 base units')
    expect(tradeLine({ ...TRADE, paymentMint: 'Other' }, { decimals: 0 }, platform).paid).toBe(
      '750000000 base units',
    )
    expect(tradeLine(TRADE, undefined, platform).price).toBe('1.25 dUSD per unit')
  })
})
