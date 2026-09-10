// Real transactions, saved as fixtures for the log parser (T027, `packages/indexer`).
//
// One file per kind of transaction the worker must understand: every US1 event and
// a refusal per reason. What is saved is what the worker sees — the logs, the
// error, the slot, the block time and the message's addresses — not the demo's
// interpretation of them, so the parser is tested against the ledger's own words.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Landed } from './send.ts'

export type Fixture = {
  readonly kind: string
  readonly network: string
  readonly signature: string
  readonly slot: number
  readonly blockTime: number | null
  readonly err: unknown
  readonly fee: number | null
  readonly computeUnitsConsumed: number | null
  readonly accountKeys: readonly string[]
  readonly logMessages: readonly string[]
}

export function toFixture(kind: string, network: string, tx: Landed & { err?: unknown }): Fixture {
  return {
    kind,
    network,
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    err: tx.err ?? null,
    fee: tx.feeLamports ?? null,
    computeUnitsConsumed: tx.computeUnits ?? null,
    accountKeys: tx.accountKeys,
    logMessages: tx.logs,
  }
}

/** Writes `<dir>/<kind>.json`; returns the path. */
export function writeFixture(dir: string, fixture: Fixture): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${fixture.kind}.json`)
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
  return path
}
