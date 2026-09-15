import { describe, expect, it } from 'vitest'
import { INVESTOR_TYPES, investorTypeLabel } from './company-api.ts'

describe('investor types', () => {
  it('are distinct u8 codes with 0 meaning "not set"', () => {
    const codes = INVESTOR_TYPES.map((type) => type.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.every((code) => Number.isInteger(code) && code >= 0 && code <= 255)).toBe(true)
    expect(investorTypeLabel(0)).toBe('not set')
  })

  it('names an unknown code rather than hiding it', () => {
    expect(investorTypeLabel(200)).toBe('type 200')
  })
})
