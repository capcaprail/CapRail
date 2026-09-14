import type { CompanyView, InvestorView, JournalEntry, WalletAddress } from '@caprail/shared'
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
