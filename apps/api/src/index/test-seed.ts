import type {
  CompanyView,
  InvestorView,
  JournalEntry,
  OfferRecord,
  WalletAddress,
} from '@caprail/shared'
import { testWallet } from '../auth/test-wallet.ts'
import { type MemoryIndex, memoryIndex } from './memory-reader.ts'

// One company with one token, two investors and a short journal — the shape of
// the US1 demo, as the memory reader serves it.
export type Seed = {
  index: MemoryIndex
  companyId: string
  company: CompanyView
  mint: string
  admin: WalletAddress
  officer: WalletAddress
  alice: WalletAddress
  bob: WalletAddress
  stranger: WalletAddress
}

export const T0 = '2026-09-14T12:00:00.000Z'

export function seed(): Seed {
  const [admin, officer, alice, bob, stranger] = [
    testWallet().address,
    testWallet().address,
    testWallet().address,
    testWallet().address,
    testWallet().address,
  ]
  const companyId = '5344674037973196068'
  const companyPda = '7NZT47ZAgvR8P8B74Ku3M8jjqh721sxGexeLUL1Lkd71'
  const mint = 'CSVHYHQZ7tH1KERjxDTqbUYZfoS4NaPk7ZjFfR8sNeyz'
  const policy = { requireAccreditation: true, requireRofr: false, rofrWindowSecs: 0 }
  const company: CompanyView = {
    companyId,
    company: companyPda,
    name: 'Demo Corp',
    admin,
    complianceOfficer: officer,
    rolesSetAt: null,
    tokens: [
      {
        mint,
        treasury: 'CimuA63WJTb672dPru4UYWHqDqHAFF1BtkhGeBaooLDR',
        name: 'Demo Corp Shares',
        symbol: 'DEMO',
        decimals: 0,
        totalSupply: '1000000',
        policy,
        policyVersion: 2,
        createdAt: T0,
      },
    ],
  }
  const investor = (wallet: WalletAddress, status: InvestorView['status']): InvestorView => ({
    mint,
    wallet,
    status,
    expiresAt: '2027-09-14T12:00:00.000Z',
    jurisdiction: 'UA',
    investorType: 1,
    updatedAt: T0,
    updatedBy: officer,
  })
  const attempt = (
    id: number,
    minute: number,
    entry: Partial<JournalEntry>,
  ): MemoryIndex['attempts'][number] => ({
    id: String(id),
    companyId,
    mint,
    sourceOwner: alice,
    destOwner: bob,
    amount: '10',
    outcome: 'allowed',
    reasonCode: null,
    origin: 'chain',
    fromTreasury: false,
    policyVersion: 2,
    txSignature: `sig${id}`,
    slot: 40 + id,
    blockTime: `2026-09-14T12:${String(minute).padStart(2, '0')}:00.000Z`,
    logs: ['Program log: Instruction: TransferChecked'],
    reportedBy: null,
    ...entry,
  })
  const index = memoryIndex({
    companies: [company],
    investors: [investor(alice, 'approved'), investor(bob, 'approved')],
    holdings: [
      { mint, wallet: companyPda, amount: 900_000n, distributed: 0n },
      { mint, wallet: alice, amount: 99_990n, distributed: 100_000n },
      { mint, wallet: bob, amount: 10n, distributed: 0n },
    ],
    attempts: [
      attempt(1, 1, {
        sourceOwner: companyPda,
        destOwner: alice,
        amount: '100000',
        fromTreasury: true,
      }),
      attempt(2, 2, {}),
      attempt(3, 3, {
        destOwner: stranger,
        outcome: 'rejected',
        reasonCode: 'NotAccredited',
        policyVersion: null,
      }),
    ],
    statusEvents: [
      { id: 1n, companyId, investor: investor(alice, 'approved') },
      { id: 2n, companyId, investor: investor(bob, 'approved') },
    ],
    policyVersions: [
      { companyId, mint, version: 1, slot: 41n, policy, setAt: null },
      { companyId, mint, version: 2, slot: 42n, policy, setAt: T0 },
    ],
  })
  return { index, companyId, company, mint, admin, officer, alice, bob, stranger }
}

// The US2 market on top of `seed()`: offers on the accredited token, and a second
// company whose policy admits anyone. Registry edge cases around the hook's check:
// carol's approval has expired, dave's was revoked; erin holds the open token with
// no record at all.
export type MarketSeed = Seed & {
  carol: WalletAddress
  dave: WalletAddress
  erin: WalletAddress
  openCompanyId: string
  openMint: string
  offers: { aliceOpen: string; aliceFilled: string; bobCancelled: string; erinOpen: string }
}

export const PAYMENT_MINT = 'DemoUsdc1111111111111111111111111111111111111'

export function marketSeed(): MarketSeed {
  const base = seed()
  const [carol, dave, erin] = [testWallet().address, testWallet().address, testWallet().address]
  const openCompanyId = '42'
  const openMint = 'Open1111111111111111111111111111111111111111'
  const openCompany: CompanyView = {
    companyId: openCompanyId,
    company: 'OpenCorpPda11111111111111111111111111111111',
    name: 'Open Corp',
    admin: base.admin,
    complianceOfficer: base.officer,
    rolesSetAt: null,
    tokens: [
      {
        mint: openMint,
        treasury: 'OpenTreasury1111111111111111111111111111111',
        name: 'Open Corp Shares',
        symbol: 'OPEN',
        decimals: 2,
        totalSupply: '500000',
        policy: { requireAccreditation: false, requireRofr: false, rofrWindowSecs: 0 },
        policyVersion: 1,
        createdAt: T0,
      },
    ],
  }
  const record = (
    wallet: WalletAddress,
    status: InvestorView['status'],
    expiresAt: string,
  ): InvestorView => ({
    mint: base.mint,
    wallet,
    status,
    expiresAt,
    jurisdiction: null,
    investorType: 0,
    updatedAt: T0,
    updatedBy: base.officer,
  })
  const offer = (
    name: string,
    patch: Partial<OfferRecord> & Pick<OfferRecord, 'seller'>,
  ): OfferRecord => ({
    offer: name,
    mint: base.mint,
    companyId: base.companyId,
    offerId: '1',
    amount: '100',
    remaining: '100',
    pricePerUnit: '1500000',
    paymentMint: PAYMENT_MINT,
    rofrUntil: null,
    status: 'open',
    createdAt: T0,
    closedAt: null,
    available: '100',
    staleReason: null,
    checkedAt: null,
    ...patch,
  })
  const offers = {
    erinOpen: 'OfferErinOpen11111111111111111111111111111',
    aliceOpen: 'OfferAliceOpen1111111111111111111111111111',
    bobCancelled: 'OfferBobCancelled111111111111111111111111',
    aliceFilled: 'OfferAliceFilled11111111111111111111111111',
  }
  base.index.companies.push(openCompany)
  base.index.investors.push(
    record(carol, 'approved', '2026-09-14T12:00:00.000Z'),
    record(dave, 'revoked', '2027-09-14T12:00:00.000Z'),
  )
  base.index.holdings.push({ mint: openMint, wallet: erin, amount: 700n, distributed: 700n })
  base.index.offers.push(
    offer(offers.erinOpen, {
      seller: erin,
      mint: openMint,
      companyId: openCompanyId,
      amount: '500',
      remaining: '500',
      pricePerUnit: '10000',
      available: '500',
    }),
    // Partly taken, and the seller has since spent some of what is still offered.
    offer(offers.aliceOpen, {
      seller: base.alice,
      offerId: '2',
      remaining: '60',
      available: '40',
      staleReason: 'balance_short',
      checkedAt: '2026-09-14T12:29:50.000Z',
    }),
    offer(offers.bobCancelled, {
      seller: base.bob,
      status: 'cancelled',
      remaining: '100',
      available: null,
      closedAt: '2026-09-14T12:10:00.000Z',
    }),
    offer(offers.aliceFilled, {
      seller: base.alice,
      status: 'filled',
      remaining: '0',
      available: null,
      closedAt: '2026-09-14T12:05:00.000Z',
    }),
  )
  return { ...base, carol, dave, erin, openCompanyId, openMint, offers }
}
