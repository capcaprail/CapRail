import { describe, expect, it } from 'vitest'
import { formatPayment, paymentLabel, pricePerShare, pricePerUnitField } from './money.ts'

const DUSD = {
  paymentMint: 'DemoUsdc1111111111111111111111111111111111111',
  paymentDecimals: 6,
  paymentSymbol: 'dUSD',
}
const UNLABELLED = { ...DUSD, paymentSymbol: null }

describe('payment amounts', () => {
  it('labels by the deployment symbol, or by the mint address — never a guessed ticker', () => {
    expect(paymentLabel(DUSD)).toBe('dUSD')
    expect(paymentLabel(UNLABELLED)).toBe('Demo…1111')
    expect(formatPayment(12_500_000n, DUSD)).toBe('12.5 dUSD')
    expect(formatPayment('1000000000', DUSD)).toBe('1,000 dUSD')
  })

  it('a share price converts exactly to price_per_unit and back', () => {
    // Shares without decimals: the unit is the share.
    expect(pricePerUnitField('12.50', 0, DUSD)).toEqual({ value: 12_500_000n })
    // Two decimals: a unit is a hundredth of a share.
    expect(pricePerUnitField('12.50', 2, DUSD)).toEqual({ value: 125_000n })
    expect(pricePerShare(125_000n, 2)).toBe(12_500_000n)
    expect(pricePerShare('12500000', 0)).toBe(12_500_000n)
  })

  it('refuses a price it would have to round, naming the step', () => {
    expect(pricePerUnitField('0.000001', 2, DUSD)).toEqual({
      error: 'in steps of 0.0001 dUSD per share',
    })
    expect(pricePerUnitField('1.0000001', 0, DUSD)).toEqual({
      error: 'a number with at most 6 decimals',
    })
    expect(pricePerUnitField('0', 0, DUSD)).toEqual({ error: 'must be positive' })
    expect(pricePerUnitField(' ', 0, DUSD)).toEqual({ error: 'required' })
    expect(pricePerUnitField('-1', 0, DUSD)).toHaveProperty('error')
  })
})
