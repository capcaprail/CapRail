import { describe, expect, it } from 'vitest'
import { admission, admissionSchema } from './market.ts'
import { REJECTION_REASONS } from './reasons.ts'

const NOW = new Date('2026-09-30T12:00:00.000Z')
const accredited = { requireAccreditation: true }
const open = { requireAccreditation: false }
const record = (status: 'none' | 'approved' | 'revoked', expiresAt: string) => ({
  status,
  expiresAt,
})

describe('admission — the hook check 2, mirrored', () => {
  it('admits anyone, with or without a record, when the policy does not require accreditation', () => {
    expect(admission(open, null, NOW)).toEqual({ admitted: true, reason: null })
    // The hook does not read the record at all then — a revoked one does not matter.
    expect(admission(open, record('revoked', '2020-01-01T00:00:00.000Z'), NOW)).toEqual({
      admitted: true,
      reason: null,
    })
  })

  it('refuses a wallet without a record, or with one that is not approved', () => {
    expect(admission(accredited, null, NOW)).toEqual({ admitted: false, reason: 'NotAccredited' })
    for (const status of ['none', 'revoked'] as const) {
      expect(admission(accredited, record(status, '2030-01-01T00:00:00.000Z'), NOW)).toEqual({
        admitted: false,
        reason: 'NotAccredited',
      })
    }
  })

  it('compares expiry strictly, as `expires_at > now` on chain', () => {
    const at = (offsetSecs: number) => new Date(NOW.getTime() + offsetSecs * 1000).toISOString()
    expect(admission(accredited, record('approved', at(1)), NOW).admitted).toBe(true)
    expect(admission(accredited, record('approved', at(0)), NOW)).toEqual({
      admitted: false,
      reason: 'AccreditationExpired',
    })
    expect(admission(accredited, record('approved', at(-1)), NOW).reason).toBe(
      'AccreditationExpired',
    )
    // Within the last second before expiry the chain (unix seconds, floored) still
    // admits; so does the mirror.
    expect(
      admission(accredited, record('approved', at(1)), new Date(NOW.getTime() + 999)).admitted,
    ).toBe(true)
  })

  it('names refusals with the program’s own error variants', () => {
    for (const reason of admissionSchema.shape.reason.unwrap().options) {
      expect(REJECTION_REASONS).toContain(reason)
    }
  })
})
