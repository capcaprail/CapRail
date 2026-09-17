// M0: every figure on screen is a constant from the M0 brief in docs/. Nothing here is
// computed at runtime — vested amounts were worked out once at the mock clock and frozen.

export type Wallet = string

export interface Company {
  name: string
  seat: string
  id: number
  tokenName: string
  symbol: string
  decimals: number
  totalIssued: number
  mint: Wallet
  administrator: Wallet
  complianceOfficer: Wallet
  treasury: Wallet
  policy: Policy
  paymentSymbol: string
  feeBps: number
  /** Pretend "now" — never the real clock. */
  clock: { utc: string; slot: number }
}

export interface Policy {
  version: number
  setOn: string
  admissionRequired: boolean
  /** Not available before M4; rendered inert. */
  rofrAvailable: boolean
  refusalWindowDays: number
}

export type HoldingSource = 'not yet distributed' | 'grant' | 'distribution' | 'purchase'

export type JournalOrigin = 'chain' | 'simulation'

export type JournalOutcome =
  | { kind: 'settled'; detail: string }
  | { kind: 'refused'; reason: string }

export interface JournalEntry {
  whenUtc: string
  from: string
  to: string
  /** Set when `to` is a wallet outside the register. */
  toNote?: string
  amount: number
  outcome: JournalOutcome
  origin: JournalOrigin
  signature: string | null
}

export interface Offer {
  seller: string
  isMine: boolean
  opened: string
  offered: number
  remaining: number
  /** Price per share in payment-token cents. */
  priceCents: number
  totalCents: number
  feeCents: number
  sellerReceivesCents: number
  note?: string
}

export const company: Company = {
  name: 'Varenholt Instruments',
  seat: 'Rotterdam',
  id: 1,
  tokenName: 'Varenholt Instruments Ordinary Shares',
  symbol: 'VHI',
  decimals: 0,
  totalIssued: 1_000_000,
  mint: 'Vhi4MintDemo7wRq2kP9nTz5xLb8cMd3fSg6hJv4yUcE',
  administrator: 'Vhi2AdminDemo8rNq3wK6tPz5xMb9cLd4fSg7hJv2yUa',
  complianceOfficer: 'Vhi3officerDemo5pQw8kR2nTz7xLb4cMd9fSg6hJv3y',
  treasury: 'Vhi1TreasuryDemo4kQ9pW2mR7sXb5nLc8dFg3hJt6yU',
  policy: {
    version: 3,
    setOn: '2026-07-01',
    admissionRequired: true,
    rofrAvailable: false,
    refusalWindowDays: 30,
  },
  paymentSymbol: 'dUSD',
  feeBps: 50,
  clock: { utc: '2026-09-12 10:00 UTC', slot: 371_204_118 },
}

export const wallets = {
  kessel: 'Vhi5KesseDemo3qRw9kP2nTz6xLb7cMd4fSg8hJv5yUa',
  obuya: 'Vhi6obuyaDemo2pQw8kR9nTz4xLb3cMd7fSg5hJv6yUb',
  norrbeck: 'Vhi7NorrbeckDemo9qRw4kP7nTz2xLb6cMd8fSg3hJv7',
  halloran: 'Vhi8Ha11oranDemo6pQw3kR8nTz9xLb2cMd5fSg4hJv8',
  pellan: 'Vhi9Pe11anDemo5qRw7kP4nTz8xLb9cMd2fSg6hJv9yU',
  ferrante: 'VhiAFerranteDemo4pQw6kR3nTz7xLb5cMd9fSg2hJvA',
  anquetil: 'VhiBAnqueti1Demo3qRw8kP5nTz2xLb7cMd4fSg9hJvB',
  wrede: 'VhiCWredeDemo7pQw2kR6nTz9xLb4cMd8fSg3hJv1yUC',
} as const

export const journal: JournalEntry[] = [
  {
    whenUtc: '2026-09-12 09:41',
    from: 'Norrbeck Ventures',
    to: '9vWq…Rt2e',
    toNote: 'not in register',
    amount: 5_000,
    outcome: { kind: 'refused', reason: 'recipient not admitted' },
    origin: 'chain',
    signature: '5xFq…9kTe',
  },
  {
    whenUtc: '2026-09-12 09:12',
    from: 'S. Ferrante',
    to: 'J. Halloran',
    amount: 6_000,
    outcome: { kind: 'refused', reason: 'not yet vested — 3,200 VHI transferable' },
    origin: 'simulation',
    signature: null,
  },
  {
    whenUtc: '2026-09-11 16:20',
    from: 'Norrbeck Ventures',
    to: 'J. Halloran',
    amount: 10_000,
    outcome: {
      kind: 'settled',
      detail: 'purchase · 4.20 dUSD per share · 42,000.00 dUSD · fee 210.00 dUSD',
    },
    origin: 'chain',
    signature: '3nHc…b7Qa',
  },
  {
    whenUtc: '2026-09-10 11:05',
    from: 'Treasury',
    to: 'T. Wrede',
    amount: 15_000,
    outcome: { kind: 'refused', reason: 'recipient not admitted — revoked 2026-08-30' },
    origin: 'chain',
    signature: '8kLm…2vXd',
  },
  {
    whenUtc: '2026-09-09 14:30',
    from: 'Treasury',
    to: 'L. Anquetil',
    amount: 15_000,
    outcome: { kind: 'refused', reason: 'admission expired 2026-08-01' },
    origin: 'simulation',
    signature: null,
  },
  {
    whenUtc: '2026-08-18 10:12',
    from: 'Treasury',
    to: 'Pellan Family Office',
    amount: 20_000,
    outcome: { kind: 'settled', detail: 'distribution' },
    origin: 'chain',
    signature: '2pRt…6wNe',
  },
  {
    whenUtc: '2026-08-18 10:09',
    from: 'Treasury',
    to: 'J. Halloran',
    amount: 30_000,
    outcome: { kind: 'settled', detail: 'distribution' },
    origin: 'chain',
    signature: '7cVb…4mKs',
  },
  {
    whenUtc: '2026-08-18 10:05',
    from: 'Treasury',
    to: 'Norrbeck Ventures',
    amount: 130_000,
    outcome: { kind: 'settled', detail: 'distribution' },
    origin: 'chain',
    signature: '4dGh…8pLq',
  },
  {
    whenUtc: '2026-08-18 09:58',
    from: 'Treasury',
    to: '6tYu…Mn3z',
    toNote: 'not in register',
    amount: 10_000,
    outcome: { kind: 'refused', reason: 'recipient not admitted' },
    origin: 'simulation',
    signature: null,
  },
  {
    whenUtc: '2025-11-24 09:00',
    from: 'Treasury',
    to: 'S. Ferrante',
    amount: 8_000,
    outcome: { kind: 'settled', detail: 'grant' },
    origin: 'chain',
    signature: '9wQe…1rTy',
  },
  {
    whenUtc: '2024-09-12 09:00',
    from: 'Treasury',
    to: 'R. Obuya',
    amount: 150_000,
    outcome: { kind: 'settled', detail: 'grant' },
    origin: 'chain',
    signature: '1zXc…5vBn',
  },
  {
    whenUtc: '2024-09-12 09:00',
    from: 'Treasury',
    to: 'A. Kessel',
    amount: 250_000,
    outcome: { kind: 'settled', detail: 'grant' },
    origin: 'chain',
    signature: '6yUi…3oPa',
  },
]

/** The signed-in investor for the cabinet and the market. */
export const me = {
  label: 'S. Ferrante',
  wallet: wallets.ferrante,
  admittedUntil: '2027-06-30',
  admittedUntilNote: 'in 291 days',
  holding: { shares: 8_000, sharePct: 0.8, source: 'grant' as HoldingSource },
  vested: 3_200,
  unvested: 4_800,
  transferableNow: 3_200,
  grant: {
    total: 8_000,
    start: '2025-11-24',
    cliff: '2026-05-24',
    cliffNote: 'passed',
    end: '2027-11-24',
    endNote: 'in 438 days',
  },
  openOffer: { shares: 2_000, priceCents: 460, remaining: 2_000, openSince: '2026-09-11 18:02' },
}

export const offers: Offer[] = [
  {
    seller: 'S. Ferrante (you)',
    isMine: true,
    opened: '2026-09-11 18:02',
    offered: 2_000,
    remaining: 2_000,
    priceCents: 460,
    totalCents: 920_000,
    feeCents: 4_600,
    sellerReceivesCents: 915_400,
  },
  {
    seller: 'J. Halloran',
    isMine: false,
    opened: '2026-09-11 17:40',
    offered: 5_000,
    remaining: 5_000,
    priceCents: 450,
    totalCents: 2_250_000,
    feeCents: 11_250,
    sellerReceivesCents: 2_238_750,
  },
  {
    seller: 'Norrbeck Ventures',
    isMine: false,
    opened: '2026-09-08 12:15',
    offered: 20_000,
    remaining: 10_000,
    priceCents: 420,
    totalCents: 4_200_000,
    feeCents: 21_000,
    sellerReceivesCents: 4_179_000,
    note: '10,000 VHI already sold to J. Halloran on 2026-09-11',
  },
]
