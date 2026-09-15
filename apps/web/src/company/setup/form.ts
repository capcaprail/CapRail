import {
  COMPANY_NAME_MAX_BYTES,
  DECIMALS_MAX,
  TOKEN_NAME_MAX_BYTES,
  TOKEN_SYMBOL_MAX_BYTES,
  TOKEN_URI_MAX_BYTES,
  type TransferPolicyInput,
} from '@caprail/chain'
import type { WalletAddress } from '@caprail/shared'
import { amountField, type Parsed, textBytes, walletField } from '../fields.ts'

// The two steps of "company → token": what the admin types, checked the way the
// program checks it, before the wallet is asked.

export type CompanyFormRaw = { name: string; complianceOfficer: string }
export type CompanyFormValue = { name: string; complianceOfficer: WalletAddress }
export type CompanyFormField = keyof CompanyFormRaw

export function parseCompanyForm(
  raw: CompanyFormRaw,
  admin: WalletAddress,
): Parsed<CompanyFormValue, CompanyFormField> {
  const errors: Partial<Record<CompanyFormField, string>> = {}
  const name = textBytes(raw.name, COMPANY_NAME_MAX_BYTES)
  if ('error' in name) errors.name = name.error
  const officer = walletField(raw.complianceOfficer)
  if ('error' in officer) errors.complianceOfficer = officer.error
  // FR-004: two roles, two keys. The program refuses the same key with `InvalidRoles`.
  else if (officer.value === admin) {
    errors.complianceOfficer = 'must differ from the administrator key'
  }
  if ('error' in name || 'error' in officer || errors.complianceOfficer !== undefined) {
    return { ok: false, errors }
  }
  return { ok: true, value: { name: name.value, complianceOfficer: officer.value } }
}

export type TokenFormRaw = {
  name: string
  symbol: string
  uri: string
  decimals: string
  totalSupply: string
  requireAccreditation: boolean
}
export type TokenFormValue = {
  name: string
  symbol: string
  uri: string
  decimals: number
  totalSupply: bigint
  policy: TransferPolicyInput
}
export type TokenFormField = keyof TokenFormRaw

export function parseDecimals(raw: string): { value: number } | { error: string } {
  const text = raw.trim()
  if (!/^\d{1,2}$/.test(text)) return { error: `0 to ${DECIMALS_MAX}` }
  const value = Number(text)
  return value > DECIMALS_MAX ? { error: `0 to ${DECIMALS_MAX}` } : { value }
}

export function parseTokenForm(raw: TokenFormRaw): Parsed<TokenFormValue, TokenFormField> {
  const errors: Partial<Record<TokenFormField, string>> = {}
  const name = textBytes(raw.name, TOKEN_NAME_MAX_BYTES)
  if ('error' in name) errors.name = name.error
  const symbol = textBytes(raw.symbol, TOKEN_SYMBOL_MAX_BYTES)
  if ('error' in symbol) errors.symbol = symbol.error
  const uri = textBytes(raw.uri, TOKEN_URI_MAX_BYTES, { required: false })
  if ('error' in uri) errors.uri = uri.error
  const decimals = parseDecimals(raw.decimals)
  if ('error' in decimals) errors.decimals = decimals.error
  // The supply is typed in whole tokens; the program stores base units.
  const supply =
    'error' in decimals ? { error: 'decimals first' } : amountField(raw.totalSupply, decimals.value)
  if ('error' in supply) errors.totalSupply = supply.error

  if (
    'error' in name ||
    'error' in symbol ||
    'error' in uri ||
    'error' in decimals ||
    'error' in supply
  ) {
    return { ok: false, errors }
  }
  return {
    ok: true,
    value: {
      name: name.value,
      symbol: symbol.value,
      uri: uri.value,
      decimals: decimals.value,
      totalSupply: supply.value,
      // ROFR is refused by the program until M4; the form has no way to ask for it.
      policy: {
        requireAccreditation: raw.requireAccreditation,
        requireRofr: false,
        rofrWindowSecs: 0,
      },
    },
  }
}

// A random u64: chosen by the client (`create_company` takes it as an argument), and
// two companies of one admin must not collide on `init`.
export function randomCompanyId(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return new DataView(bytes.buffer).getBigUint64(0, true)
}
