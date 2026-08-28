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

export interface Owner {
  label: string
  wallet: Wallet
  shares: number
  /** Share of total issued, one decimal, given not derived. */
  sharePct: number
  vested: number | null
  unvested: number | null
  sources: Array<{ kind: HoldingSource; amount: number }>
  isTreasury?: boolean
}

export interface Grant {
  holder: string
  total: number
  start: string
  cliff: string
  end: string
  vestedNow: number
}

export type Admission =
  | { status: 'approved' }
  | { status: 'expired'; wasApprovedUntil: string }
  | { status: 'revoked'; on: string }

export interface Investor {
  label: string
  wallet: Wallet
  admission: Admission
  validUntil: string | null
  /** Plain ink note next to the date, e.g. "expires in 33 days". */
  validUntilNote?: string
  jurisdiction: string
  type: string
  lastChange: string
  by: string
}

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

export const owners: Owner[] = [
  {
    label: 'Treasury (Varenholt Instruments)',
    wallet: company.treasury,
    shares: 412_000,
    sharePct: 41.2,
    vested: null,
    unvested: null,
    sources: [{ kind: 'not yet distributed', amount: 412_000 }],
    isTreasury: true,
  },
  {
    label: 'A. Kessel — founder',
    wallet: wallets.kessel,
    shares: 250_000,
    sharePct: 25.0,
    vested: 124_914,
    unvested: 125_086,
    sources: [{ kind: 'grant', amount: 250_000 }],
  },
  {
    label: 'R. Obuya — founder',
    wallet: wallets.obuya,
    shares: 150_000,
    sharePct: 15.0,
    vested: 74_948,
    unvested: 75_052,
    sources: [{ kind: 'grant', amount: 150_000 }],
  },
  {
    label: 'Norrbeck Ventures',
    wallet: wallets.norrbeck,
    shares: 120_000,
    sharePct: 12.0,
    vested: 120_000,
    unvested: null,
    sources: [{ kind: 'distribution', amount: 120_000 }],
  },
  {
    label: 'J. Halloran',
    wallet: wallets.halloran,
    shares: 40_000,
    sharePct: 4.0,
    vested: 40_000,
    unvested: null,
    sources: [
      { kind: 'distribution', amount: 30_000 },
      { kind: 'purchase', amount: 10_000 },
    ],
  },
  {
    label: 'Pellan Family Office',
    wallet: wallets.pellan,
    shares: 20_000,
    sharePct: 2.0,
    vested: 20_000,
    unvested: null,
    sources: [{ kind: 'distribution', amount: 20_000 }],
  },
  {
    label: 'S. Ferrante — employee',
    wallet: wallets.ferrante,
    shares: 8_000,
    sharePct: 0.8,
    vested: 3_200,
    unvested: 4_800,
    sources: [{ kind: 'grant', amount: 8_000 }],
  },
]

export const capTableTotals = {
  shares: 1_000_000,
  sharePct: 100.0,
  vested: 383_062,
  unvested: 204_938,
}

/** Strip labels shown under the bar; narrower segments are listed after it. */
export const stripLabels: Record<string, string> = {
  [company.treasury]: 'Treasury',
  [wallets.kessel]: 'A. Kessel',
  [wallets.obuya]: 'R. Obuya',
  [wallets.norrbeck]: 'Norrbeck Ventures',
  [wallets.halloran]: 'J. Halloran',
  [wallets.pellan]: 'Pellan Family Office',
  [wallets.ferrante]: 'S. Ferrante',
}

export const grants: Grant[] = [
  {
    holder: 'A. Kessel',
    total: 250_000,
    start: '2024-09-12',
    cliff: '2025-09-12',
    end: '2028-09-12',
    vestedNow: 124_914,
  },
  {
    holder: 'R. Obuya',
    total: 150_000,
    start: '2024-09-12',
    cliff: '2025-09-12',
    end: '2028-09-12',
    vestedNow: 74_948,
  },
  {
    holder: 'S. Ferrante',
    total: 8_000,
    start: '2025-11-24',
    cliff: '2026-05-24',
    end: '2027-11-24',
    vestedNow: 3_200,
  },
]

export const investors: Investor[] = [
  {
    label: 'A. Kessel',
    wallet: wallets.kessel,
    admission: { status: 'approved' },
    validUntil: '2027-06-30',
    jurisdiction: 'DE',
    type: 'individual',
    lastChange: '2026-02-10',
    by: 'officer',
  },
  {
    label: 'R. Obuya',
    wallet: wallets.obuya,
    admission: { status: 'approved' },
    validUntil: '2027-06-30',
    jurisdiction: 'KE',
    type: 'individual',
    lastChange: '2026-02-10',
    by: 'officer',
  },
  {
    label: 'Norrbeck Ventures',
    wallet: wallets.norrbeck,
    admission: { status: 'approved' },
    validUntil: '2026-12-31',
    jurisdiction: 'SE',
    type: 'fund',
    lastChange: '2026-02-10',
    by: 'officer',
  },
  {
    label: 'J. Halloran',
    wallet: wallets.halloran,
    admission: { status: 'approved' },
    validUntil: '2026-10-15',
    validUntilNote: 'expires in 33 days',
    jurisdiction: 'IE',
    type: 'individual',
    lastChange: '2026-08-01',
    by: 'officer',
  },
  {
    label: 'Pellan Family Office',
    wallet: wallets.pellan,
    admission: { status: 'approved' },
    validUntil: '2027-03-31',
    jurisdiction: 'CH',
    type: 'family office',
    lastChange: '2026-08-01',
    by: 'officer',
  },
  {
    label: 'S. Ferrante',
    wallet: wallets.ferrante,
    admission: { status: 'approved' },
    validUntil: '2027-06-30',
    jurisdiction: 'IT',
    type: 'individual',
    lastChange: '2025-11-20',
    by: 'officer',
  },
  {
    label: 'L. Anquetil',
    wallet: wallets.anquetil,
    admission: { status: 'expired', wasApprovedUntil: '2026-08-01' },
    validUntil: '2026-08-01',
    jurisdiction: 'FR',
    type: 'individual',
    lastChange: '2025-08-01',
    by: 'officer',
  },
  {
    label: 'T. Wrede',
    wallet: wallets.wrede,
    admission: { status: 'revoked', on: '2026-08-30' },
    validUntil: null,
    jurisdiction: 'NL',
    type: 'individual',
    lastChange: '2026-08-30',
    by: 'officer',
  },
]

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

export const journalCounts = { attempts: 12, settled: 7, refused: 5, onChain: 2, inSimulation: 3 }

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
