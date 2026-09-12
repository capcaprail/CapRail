import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Fixture } from './dump.ts'
import { reasonFromLogs } from './send.ts'

// The fixtures are real transactions the demo dumped (`--dump fixtures/logs`); the
// log parser (T027) grows on them. This test keeps them honest: every refused one
// names a reason, every allowed one carries exactly one event and no reason.
// Read with `fs` — the directory is outside `rootDir`.
const DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'logs')

const fixtures = (): Fixture[] =>
  readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture)

describe('reasonFromLogs', () => {
  it('names the CaprailError variant and its number from the Anchor line', () => {
    expect(
      reasonFromLogs([
        'Program log: Instruction: Execute',
        'Program log: AnchorError thrown in programs/caprail-hook/src/execute.rs:1. Error Code: NotAccredited. Error Number: 6000. Error Message: recipient is not an accredited investor of this company.',
      ]),
    ).toEqual({ reason: 'NotAccredited', code: 6000 })
  })

  it('is undefined without one', () => {
    expect(reasonFromLogs(['Program log: Instruction: Execute'])).toBeUndefined()
  })
})

describe('fixtures/logs', () => {
  it('has every US1 kind', () => {
    expect(
      fixtures()
        .map((f) => f.kind)
        .sort(),
    ).toEqual([
      'create-company',
      'create-token',
      'distribute',
      'set-investor-status',
      'set-policy',
      'transfer-allowed',
      'transfer-refused-expired',
      'transfer-refused-not-accredited',
    ])
  })

  it('refused ones name a reason that matches their error code; allowed ones carry one event', () => {
    for (const fixture of fixtures()) {
      const parsed = reasonFromLogs(fixture.logs)
      const events = fixture.logs.filter((line) => line.startsWith('Program data: '))
      if (fixture.kind.startsWith('transfer-refused')) {
        expect(fixture.err, fixture.kind).not.toBeNull()
        expect(parsed?.reason, fixture.kind).toBe(
          fixture.kind === 'transfer-refused-expired' ? 'AccreditationExpired' : 'NotAccredited',
        )
        expect(JSON.stringify(fixture.err), fixture.kind).toContain(`"Custom":${parsed?.code}`)
        expect(events, fixture.kind).toHaveLength(0)
      } else {
        expect(fixture.err, fixture.kind).toBeNull()
        expect(parsed, fixture.kind).toBeUndefined()
        expect(events, fixture.kind).toHaveLength(1)
      }
    }
  })
})
