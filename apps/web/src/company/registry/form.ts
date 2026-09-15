import { INVESTOR_TYPES, type InvestorStatus, type WalletAddress } from '@caprail/shared'
import { amountField, type Parsed, walletField } from '../fields.ts'

// Registry forms: a status the officer sets, a distribution the admin sends.

export type StatusFormRaw = {
  wallet: string
  status: InvestorStatus
  /** `YYYY-MM-DD`, as a date input gives it. */
  validUntil: string
  jurisdiction: string
  investorType: string
}
export type StatusFormValue = {
  wallet: WalletAddress
  status: InvestorStatus
  expiresAt: bigint
  jurisdiction: string
  investorType: number
}
export type StatusFormField = keyof StatusFormRaw

/** The last second of that calendar day, UTC — admission is valid through the date shown. */
export function endOfDayUtc(date: string): bigint | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const ms = Date.parse(`${date}T23:59:59Z`)
  return Number.isNaN(ms) ? null : BigInt(Math.floor(ms / 1000))
}

export function jurisdictionField(raw: string): { value: string } | { error: string } {
  const value = raw.trim().toUpperCase()
  if (value === '') return { value }
  return /^[A-Z]{2}$/.test(value) ? { value } : { error: 'two letters (ISO 3166-1), or empty' }
}

export function investorTypeField(raw: string): { value: number } | { error: string } {
  const value = Number(raw)
  return INVESTOR_TYPES.some((type) => type.code === value) ? { value } : { error: 'unknown type' }
}

export function parseStatusForm(
  raw: StatusFormRaw,
  nowSeconds: number,
): Parsed<StatusFormValue, StatusFormField> {
  const errors: Partial<Record<StatusFormField, string>> = {}
  const wallet = walletField(raw.wallet)
  if ('error' in wallet) errors.wallet = wallet.error
  const jurisdiction = jurisdictionField(raw.jurisdiction)
  if ('error' in jurisdiction) errors.jurisdiction = jurisdiction.error
  const investorType = investorTypeField(raw.investorType)
  if ('error' in investorType) errors.investorType = investorType.error

  // The hook requires `expires_at > now` for an approval; for `none` and `revoked` the
  // date is informational and may be left empty (stored as 0).
  let expiresAt = 0n
  if (raw.validUntil.trim() !== '') {
    const parsed = endOfDayUtc(raw.validUntil.trim())
    if (parsed === null) errors.validUntil = 'a date as YYYY-MM-DD'
    else expiresAt = parsed
  }
  if (raw.status === 'approved') {
    if (raw.validUntil.trim() === '') errors.validUntil = 'required for an approval'
    else if (errors.validUntil === undefined && expiresAt <= BigInt(nowSeconds)) {
      errors.validUntil = 'must be in the future'
    }
  }

  if (
    'error' in wallet ||
    'error' in jurisdiction ||
    'error' in investorType ||
    errors.validUntil !== undefined
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      wallet: wallet.value,
      status: raw.status,
      expiresAt,
      jurisdiction: jurisdiction.value,
      investorType: investorType.value,
    },
  }
}

export type DistributeFormRaw = { amount: string }

export function parseDistributeForm(
  raw: DistributeFormRaw,
  decimals: number,
): Parsed<{ amount: bigint }, 'amount'> {
  const amount = amountField(raw.amount, decimals)
  if ('error' in amount) return { ok: false, errors: { amount: amount.error } }
  return { ok: true, value: { amount: amount.value } }
}
