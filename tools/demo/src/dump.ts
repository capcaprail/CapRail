// Real transactions, saved as fixtures for the log parser (T027, `packages/indexer`).
//
// One file per kind of transaction the worker must understand: every US1 event and
// a refusal per reason. What is saved is what the worker sees — the logs, the
// error, the slot, the block time, the addresses and the instructions — not the
// demo's interpretation of them, so the parser is tested against the ledger's own words.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProgramTransaction } from '@caprail/indexer'
import type { Landed } from './send.ts'

// A fixture is a `ProgramTransaction` — loadable by the parser's tests as is — plus
// what names it and the two numbers the demo measured.
export type Fixture = ProgramTransaction & {
  readonly kind: string
  readonly network: string
  readonly fee: number | null
  readonly computeUnitsConsumed: number | null
}

export function toFixture(kind: string, network: string, tx: Landed): Fixture {
  return {
    kind,
    network,
    fee: tx.feeLamports ?? null,
    computeUnitsConsumed: tx.computeUnits ?? null,
    ...tx.transaction,
  }
}

/** Writes `<dir>/<kind>.json`; returns the path. */
export function writeFixture(dir: string, fixture: Fixture): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${fixture.kind}.json`)
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
  return path
}
