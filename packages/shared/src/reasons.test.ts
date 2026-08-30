import { describe, expect, it } from 'vitest'
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
