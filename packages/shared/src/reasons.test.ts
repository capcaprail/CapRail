import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isRejectionReason, REJECTION_REASONS, rejectionReasonSchema } from './reasons.ts'

describe('rejection reasons', () => {
  it('lists exactly the four FR-006 reasons', () => {
    expect([...REJECTION_REASONS]).toEqual([
      'NotAccredited',
      'AccreditationExpired',
      'Unvested',
      'RofrWindowOpen',
    ])
  })

  it('accepts a listed reason', () => {
    expect(rejectionReasonSchema.parse('Unvested')).toBe('Unvested')
    expect(isRejectionReason('NotAccredited')).toBe(true)
  })

  it('rejects anything else, including case variants', () => {
    for (const bad of ['notAccredited', 'NOT_ACCREDITED', '', 'Custom', 7, undefined]) {
      expect(rejectionReasonSchema.safeParse(bad).success).toBe(false)
      expect(isRejectionReason(bad)).toBe(false)
    }
  })
})

// The IDL is vendored TS, not JSON; the value block after `IDL: Caprail = ` is plain JSON.
function idlErrorNames(): string[] {
  const idlPath = join(dirname(fileURLToPath(import.meta.url)), '../../chain/src/idl/caprail.ts')
  const source = readFileSync(idlPath, 'utf8')
  const marker = 'export const IDL: Caprail = '
  const start = source.indexOf(marker)
  expect(start).toBeGreaterThan(-1)
  const idl = z
    .object({ errors: z.array(z.object({ name: z.string() })).optional() })
    .parse(JSON.parse(source.slice(start + marker.length)))
  return (idl.errors ?? []).map((e) => e.name)
}

describe('rejection reasons vs program IDL', () => {
  // The vendored type camelCases names (`notAccredited`); the chain logs the Rust variant
  // (`Error Code: NotAccredited`), which is what the shared list must match — hence
  // the case-insensitive comparison.
  it('the shared reasons are the first four error codes of the program, in order', () => {
    const names = idlErrorNames().map((name) => name.toLowerCase())
    expect(names.slice(0, REJECTION_REASONS.length)).toEqual(
      REJECTION_REASONS.map((reason) => reason.toLowerCase()),
    )
  })
})
