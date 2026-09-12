import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ata, TOKEN_2022_PROGRAM_ID } from '@caprail/chain'
import type { ProgramTransaction } from '@caprail/indexer'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { type ApplyLog, type ApplyRpc, createApplier, NotIndexedYet } from './apply.ts'
import type {
  AttemptRow,
  CompanyRow,
  HoldingRow,
  IndexStore,
  IndexWriter,
  InvestorRow,
  InvestorStatusEventRow,
  PolicyVersionRow,
  TokenRow,
} from './index-store.ts'

// The US1 story as real transactions (`pnpm demo:us1 -- --dump fixtures/logs`),
// replayed in slot order: what backfill hands the applier.
const DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'logs')

type Fixture = ProgramTransaction & { kind: string }

const fixtures = new Map(
  readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture
      return [fixture.kind, fixture] as const
    }),
)

function fixture(kind: string): Fixture {
  const found = fixtures.get(kind)
  if (found === undefined) throw new Error(`no fixture ${kind}`)
  return structuredClone(found)
}

const story = [...fixtures.values()].sort((a, b) => a.slot - b.slot).map((f) => f.kind)

// What `onLogs` delivers: no block time, no instructions.
function live(tx: ProgramTransaction): ProgramTransaction {
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: null,
    logs: tx.logs,
    failed: tx.failed,
  }
}

// The same semantics as the SQL in `index-store.ts`, on maps: insert-if-absent,
// update-if-newer, one journal row per (signature, event index).
function memoryIndex() {
  const companies = new Map<bigint, CompanyRow>()
  const tokens = new Map<string, TokenRow>()
  const policies = new Map<string, PolicyVersionRow>()
  const investors = new Map<string, InvestorRow>()
  const statusEvents = new Map<string, InvestorStatusEventRow>()
  const attempts: AttemptRow[] = []
  const holdings = new Map<string, HoldingRow>()
  const key = (a: string, b: string | number) => `${a}:${b}`

  const writer: IndexWriter = {
    companyIdOf: (company) =>
      Promise.resolve(
        [...companies.values()].find((row) => row.company === company)?.companyId ?? null,
      ),
    tokenOf: (mint) => {
      const row = tokens.get(mint)
      return Promise.resolve(
        row === undefined ? null : { mint, companyId: row.companyId, treasury: row.treasury },
      )
    },
    walletsOf: (mint) =>
      Promise.resolve([
        ...new Set(
          [...investors.values(), ...holdings.values()]
            .filter((row) => row.mint === mint)
            .map((row) => row.wallet),
        ),
      ]),
    createCompany: (row) => {
      if (!companies.has(row.companyId)) companies.set(row.companyId, row)
      return Promise.resolve()
    },
    createToken: (token, policy, treasury) => {
      if (!tokens.has(token.mint)) tokens.set(token.mint, token)
      const p = key(policy.mint, policy.version)
      if (!policies.has(p)) policies.set(p, policy)
      const h = key(treasury.mint, treasury.wallet)
      if (!holdings.has(h)) holdings.set(h, treasury)
      return Promise.resolve()
    },
    setPolicy: (policy, updatedAt) => {
      const p = key(policy.mint, policy.version)
      if (!policies.has(p)) policies.set(p, policy)
      const token = tokens.get(policy.mint)
      if (token !== undefined && token.policyVersion < policy.version) {
        tokens.set(policy.mint, {
          ...token,
          requireAccreditation: policy.requireAccreditation,
          requireRofr: policy.requireRofr,
          rofrWindowSecs: policy.rofrWindowSecs,
          policyVersion: policy.version,
          updatedAt,
        })
      }
      return Promise.resolve()
    },
    setRoles: (companyId, roles) => {
      const company = companies.get(companyId)
      if (
        company !== undefined &&
        (company.rolesSetAt === null ||
          company.rolesSetAt === undefined ||
          company.rolesSetAt <= roles.setAt)
      ) {
        companies.set(companyId, {
          ...company,
          admin: roles.admin,
          complianceOfficer: roles.complianceOfficer,
          rolesSetAt: roles.setAt,
          updatedAt: roles.setAt,
        })
      }
      return Promise.resolve()
    },
    setInvestorStatus: (event, investor) => {
      const e = key(event.txSignature, event.eventIndex)
      if (!statusEvents.has(e)) statusEvents.set(e, event)
      const i = key(investor.mint, investor.wallet)
      const current = investors.get(i)
      if (current === undefined || current.slot <= investor.slot) investors.set(i, investor)
      return Promise.resolve()
    },
    recordAttempt: (row) => {
      const duplicate = attempts.some(
        (a) => a.txSignature === row.txSignature && a.eventIndex === row.eventIndex,
      )
      if (!duplicate) attempts.push(row)
      return Promise.resolve(!duplicate)
    },
    holding: (mint, wallet) => {
      const row = holdings.get(key(mint, wallet))
      return Promise.resolve(
        row === undefined
          ? null
          : {
              amount: row.amount,
              distributed: row.distributed ?? 0n,
              lastSlot: row.lastSlot,
              verifiedAt: row.verifiedAt ?? null,
            },
      )
    },
    putHolding: (row) => {
      holdings.set(key(row.mint, row.wallet), row)
      return Promise.resolve()
    },
  }
  const store: IndexStore = { write: (fn) => fn(writer) }
  return { store, companies, tokens, policies, investors, statusEvents, attempts, holdings }
}

// Chain reads, scripted: every call is counted so a test can say which path ran.
function scriptedRpc(script: {
  owners?: Record<string, string>
  balances?: Record<string, { amount: bigint; slot: number }>
  transactions?: Record<string, ProgramTransaction | null>
}) {
  const calls = { transaction: [] as string[], owner: [] as string[], balance: [] as string[] }
  const rpc: ApplyRpc = {
    transaction: (signature) => {
      calls.transaction.push(signature)
      return Promise.resolve(script.transactions?.[signature] ?? null)
    },
    tokenAccountOwner: (account) => {
      calls.owner.push(account)
      return Promise.resolve(script.owners?.[account] ?? null)
    },
    tokenAccountBalance: (account) => {
      calls.balance.push(account)
      return Promise.resolve(script.balances?.[account] ?? null)
    },
  }
  return { rpc, calls }
}

function capturedLog() {
  const warnings: string[] = []
  const infos: string[] = []
  const log: ApplyLog = {
    info: (_, message) => {
      infos.push(message)
    },
    warn: (_, message) => {
      warnings.push(message)
    },
  }
  return { log, warnings, infos }
}

const NOW = new Date('2026-09-14T12:00:00Z')

// Parties of the story, read once from the fixtures.
const token = fixture('create-token')
const company = fixture('create-company')
const distribute = fixture('distribute')
const refusedNotAccredited = fixture('transfer-refused-not-accredited')
const refusedExpired = fixture('transfer-refused-expired')

// Token-2022 `TransferChecked`: tag 12, ten bytes of data.
function isTransferChecked(ix: { programId: string; data: string }): boolean {
  const data = Buffer.from(ix.data, 'base64')
  return ix.programId === TOKEN_2022_PROGRAM_ID.toBase58() && data.length === 10 && data[0] === 12
}

function transferAccounts(tx: ProgramTransaction): readonly string[] {
  const ix = tx.instructions?.find(isTransferChecked)
  if (ix === undefined) throw new Error('no transfer_checked in the fixture')
  return ix.accounts
}

const MINT = transferAccounts(refusedNotAccredited)[1] ?? ''
const ALICE_ATA = transferAccounts(refusedNotAccredited)[0] ?? ''
const STRANGER_ATA = transferAccounts(refusedNotAccredited)[2] ?? ''
const EXPIRED_ATA = transferAccounts(refusedExpired)[2] ?? ''
const STRANGER = 'Stranger111111111111111111111111111111111111'
const EXPIRED = 'Expired1111111111111111111111111111111111111'

async function replay(
  kinds: readonly string[],
  overrides: { rpc?: ApplyRpc; index?: ReturnType<typeof memoryIndex> } = {},
) {
  const index = overrides.index ?? memoryIndex()
  const scripted = scriptedRpc({
    owners: { [STRANGER_ATA]: STRANGER, [EXPIRED_ATA]: EXPIRED },
  })
  const { log, warnings, infos } = capturedLog()
  const apply = createApplier({
    store: index.store,
    rpc: overrides.rpc ?? scripted.rpc,
    log,
    now: () => NOW,
  })
  for (const kind of kinds) await apply(fixture(kind))
  return { ...index, apply, calls: scripted.calls, warnings, infos }
}

describe('createApplier on the US1 story', () => {
  it('replays the fixtures in slot order', () => {
    expect(story).toEqual([
      'create-company',
      'create-token',
      'set-policy',
      'set-investor-status',
      'distribute',
      'transfer-allowed',
      'transfer-refused-not-accredited',
      'transfer-refused-expired',
    ])
  })

  it('mirrors the company, the token and the policy history', async () => {
    const { companies, tokens, policies } = await replay(story)
    const [companyRow] = [...companies.values()]
    expect(companyRow?.name).toBe('Demo Corp')
    expect(companyRow?.createdSignature).toBe(company.signature)
    expect(companyRow?.rolesSetAt).toBeUndefined()

    const tokenRow = tokens.get(MINT)
    expect(tokenRow?.companyId).toBe(companyRow?.companyId)
    expect(tokenRow?.totalSupply).toBe(1_000_000n)
    expect(tokenRow?.policyVersion).toBe(2)
    expect(tokenRow?.createdAt).toEqual(new Date((token.blockTime ?? 0) * 1000))

    expect([...policies.values()].map((p) => [p.version, p.setAt === null])).toEqual([
      [1, true],
      [2, false],
    ])
  })

  it('keeps the registry and its audit trail', async () => {
    const { investors, statusEvents } = await replay(story)
    const [investor] = [...investors.values()]
    expect(investor?.status).toBe('approved')
    expect(investor?.jurisdiction).toBe('UA')
    expect(investor?.mint).toBe(MINT)
    expect(statusEvents.size).toBe(1)
    const [event] = [...statusEvents.values()]
    expect(event?.wallet).toBe(investor?.wallet)
    expect(event?.setAt).toEqual(investor?.updatedAt)
  })

  it('journals every transfer the hook saw, with the refusals placed and resolved', async () => {
    const { attempts, calls } = await replay(story)
    expect(attempts.map((a) => [a.outcome, a.reasonCode, a.fromTreasury])).toEqual([
      ['allowed', null, true],
      ['allowed', null, false],
      ['rejected', 'NotAccredited', false],
      ['rejected', 'AccreditationExpired', false],
    ])
    for (const attempt of attempts) {
      expect(attempt.origin).toBe('chain')
      expect(attempt.mint).toBe(MINT)
      expect(attempt.txSignature).toBeTruthy()
      expect(attempt.logs.length).toBeLessThanOrEqual(20)
      expect(attempt.logs.at(-1)).toMatch(/^Program .* (success|failed)/)
    }
    const [, transfer, notAccredited, expired] = attempts
    expect(transfer?.sourceOwner).toBe(notAccredited?.sourceOwner)
    expect(notAccredited?.destOwner).toBe(STRANGER)
    expect(expired?.destOwner).toBe(EXPIRED)
    expect(notAccredited?.amount).toBe(10n)
    expect(notAccredited?.logs.some((line) => line.includes('Error Code: NotAccredited'))).toBe(
      true,
    )
    // Neither refused destination is in the index: both went to the chain, once each.
    expect(calls.owner).toEqual([STRANGER_ATA, EXPIRED_ATA])
    expect(calls.transaction).toEqual([])
    expect(calls.balance).toEqual([])
  })

  it('moves holdings with every allowed transfer, the treasury included', async () => {
    const { holdings, companies } = await replay(story)
    const [companyRow] = [...companies.values()]
    const rows = [...holdings.values()].map((h) => [h.wallet, h.amount, h.distributed])
    expect(rows).toEqual([
      [companyRow?.company, 900_000n, 0n],
      [expect.any(String), 99_990n, 100_000n],
      [expect.any(String), 10n, 0n],
    ])
    expect([...holdings.values()].every((h) => h.verifiedAt === null)).toBe(true)
    const sum = [...holdings.values()].reduce((acc, h) => acc + h.amount, 0n)
    expect(sum).toBe(1_000_000n)
  })

  it('is idempotent: replaying the story changes nothing', async () => {
    const first = await replay(story)
    const before = structuredClone({
      holdings: [...first.holdings.values()],
      attempts: first.attempts,
      investors: [...first.investors.values()],
      tokens: [...first.tokens.values()],
    })
    for (const kind of story) await first.apply(fixture(kind))
    expect([...first.holdings.values()]).toEqual(before.holdings)
    expect(first.attempts).toEqual(before.attempts)
    expect([...first.investors.values()]).toEqual(before.investors)
    expect([...first.tokens.values()]).toEqual(before.tokens)
    expect(first.statusEvents.size).toBe(1)
  })
})

describe('createApplier resolving a refused destination', () => {
  it('matches the ATA of a wallet the index knows before asking the chain', async () => {
    const index = await replay(story.slice(0, 6))
    const bob = [...index.holdings.values()].find((h) => h.amount === 10n)?.wallet ?? ''
    const refused = fixture('transfer-refused-not-accredited')
    const ix = refused.instructions?.find(isTransferChecked)
    if (ix === undefined || refused.instructions === undefined) throw new Error('fixture')
    const accounts = [...ix.accounts]
    accounts[2] = ata(new PublicKey(bob), new PublicKey(MINT)).toBase58()
    refused.instructions = refused.instructions.map((i) => (i === ix ? { ...i, accounts } : i))
    await index.apply(refused)
    expect(index.attempts.at(-1)?.destOwner).toBe(bob)
    expect(index.calls.owner).toEqual([])
  })

  it('remembers what allowed transfers taught about token accounts', async () => {
    const index = await replay(story.slice(0, 6))
    // The refused source is alice's account, already seen as a destination of
    // `distribute` and a source of the allowed transfer.
    expect(ALICE_ATA).toBe(transferAccounts(distribute)[2])
    await index.apply(fixture('transfer-refused-not-accredited'))
    expect(index.calls.owner).toEqual([STRANGER_ATA])
    await index.apply({ ...fixture('transfer-refused-not-accredited'), signature: 'again' })
    // Cached now.
    expect(index.calls.owner).toEqual([STRANGER_ATA])
  })
})

describe('createApplier on the live path', () => {
  it('fetches the transaction once for a refusal seen through onLogs', async () => {
    const index = await replay(story.slice(0, 6))
    const refused = fixture('transfer-refused-not-accredited')
    const scripted = scriptedRpc({
      transactions: { [refused.signature]: refused },
      owners: { [STRANGER_ATA]: STRANGER },
    })
    const apply = createApplier({
      store: index.store,
      rpc: scripted.rpc,
      log: capturedLog().log,
      now: () => NOW,
    })
    await apply(live(refused))
    expect(scripted.calls.transaction).toEqual([refused.signature])
    const row = index.attempts.at(-1)
    expect(row?.reasonCode).toBe('NotAccredited')
    expect(row?.destOwner).toBe(STRANGER)
    expect(row?.blockTime).toEqual(new Date((refused.blockTime ?? 0) * 1000))
  })

  it('fetches the transaction for an allowed transfer too — the journal needs block time', async () => {
    const index = await replay(story.slice(0, 5))
    const allowed = fixture('transfer-allowed')
    const scripted = scriptedRpc({ transactions: { [allowed.signature]: allowed } })
    const apply = createApplier({
      store: index.store,
      rpc: scripted.rpc,
      log: capturedLog().log,
      now: () => NOW,
    })
    await apply(live(allowed))
    expect(scripted.calls.transaction).toEqual([allowed.signature])
    expect(index.attempts.at(-1)?.outcome).toBe('allowed')
    expect(index.holdings.size).toBe(3)
  })

  it('throws when the node does not serve the transaction yet, so backfill retries', async () => {
    const index = await replay(story.slice(0, 6))
    const scripted = scriptedRpc({})
    const apply = createApplier({
      store: index.store,
      rpc: scripted.rpc,
      log: capturedLog().log,
      now: () => NOW,
    })
    await expect(apply(live(fixture('transfer-allowed')))).rejects.toThrow('not served yet')
    expect(index.attempts).toHaveLength(2)
  })

  it('journals nothing for a refusal whose transaction carries no instructions', async () => {
    const index = await replay(story.slice(0, 6))
    const refused = fixture('transfer-refused-not-accredited')
    delete refused.instructions
    const scripted = scriptedRpc({ transactions: { [refused.signature]: refused } })
    const { log, warnings } = capturedLog()
    const apply = createApplier({ store: index.store, rpc: scripted.rpc, log, now: () => NOW })
    await apply(live(refused))
    expect(index.attempts).toHaveLength(2)
    expect(warnings).toEqual(['refusal without a transfer_checked instruction; not journaled'])
  })
})

describe('createApplier reconciling holdings', () => {
  it('reads the chain when the index has no row for the source, then trusts it', async () => {
    const index = await replay(story.slice(0, 5))
    const alice = [...index.holdings.values()].find((h) => h.amount === 100_000n)
    if (alice === undefined) throw new Error('alice has no holding after distribute')
    // The index lost alice: it believes she holds 5 when she is about to send 10.
    index.holdings.set(`${MINT}:${alice.wallet}`, { ...alice, amount: 5n })
    const chainSlot = 1_000
    const scripted = scriptedRpc({
      balances: { [ALICE_ATA]: { amount: 99_990n, slot: chainSlot } },
    })
    const { log, warnings } = capturedLog()
    const apply = createApplier({ store: index.store, rpc: scripted.rpc, log, now: () => NOW })
    await apply(fixture('transfer-allowed'))
    expect(scripted.calls.balance).toEqual([ALICE_ATA])
    expect(warnings).toEqual(['holding reconciled with the chain'])
    const reconciled = index.holdings.get(`${MINT}:${alice.wallet}`)
    expect(reconciled?.amount).toBe(99_990n)
    expect(reconciled?.distributed).toBe(100_000n)
    expect(reconciled?.verifiedAt).toEqual(NOW)
    expect(reconciled?.lastSlot).toBe(BigInt(chainSlot))

    // An older transfer replayed under a fresh signature is already in that balance.
    await apply({ ...fixture('transfer-allowed'), signature: 'older-than-the-read', slot: 900 })
    expect(index.holdings.get(`${MINT}:${alice.wallet}`)?.amount).toBe(99_990n)
    expect(index.attempts).toHaveLength(3)
    // A transfer after the read moves it again.
    await apply({ ...fixture('transfer-allowed'), signature: 'newer-than-the-read', slot: 1_001 })
    expect(index.holdings.get(`${MINT}:${alice.wallet}`)?.amount).toBe(99_980n)
    expect(index.holdings.get(`${MINT}:${alice.wallet}`)?.verifiedAt).toBeNull()
  })
})

describe('createApplier on records ahead of the index', () => {
  it('throws NotIndexedYet for an event on a mint the index has not seen', async () => {
    const { apply, attempts } = await replay(['create-company'])
    await expect(apply(fixture('distribute'))).rejects.toThrow(NotIndexedYet)
    await expect(apply(fixture('set-investor-status'))).rejects.toThrow(NotIndexedYet)
    expect(attempts).toHaveLength(0)
  })

  it('throws NotIndexedYet for a token of a company the index has not seen', async () => {
    const { apply } = await replay([])
    await expect(apply(fixture('create-token'))).rejects.toThrow(NotIndexedYet)
  })

  it('throws NotIndexedYet for an admission refusal on an unknown mint, skips a foreign one', async () => {
    const { apply, attempts, warnings } = await replay(['create-company'])
    await expect(apply(fixture('transfer-refused-not-accredited'))).rejects.toThrow(NotIndexedYet)
    const foreign = fixture('transfer-refused-not-accredited')
    foreign.logs = foreign.logs.map((line) =>
      line.replace(
        'Error Code: NotAccredited. Error Number: 6000',
        'Error Code: TokenConfigMismatch. Error Number: 6006',
      ),
    )
    await apply(foreign)
    expect(attempts).toHaveLength(0)
    expect(warnings).toEqual(['refusal on a mint the index does not know; not journaled'])
  })

  it('logs a program refusal and writes nothing', async () => {
    const { apply, infos, attempts } = await replay(story.slice(0, 2))
    const refused = fixture('set-policy')
    refused.failed = true
    refused.err = { InstructionError: [0, { Custom: 6007 }] }
    refused.logs = [
      'Program As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g invoke [1]',
      'Program log: Instruction: SetPolicy',
      'Program log: AnchorError occurred. Error Code: RofrNotSupported. Error Number: 6007. Error Message: x.',
      'Program As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g failed: custom program error: 0x1777',
    ]
    await apply(refused)
    expect(infos).toEqual(['program refused an instruction'])
    expect(attempts).toHaveLength(0)
  })
})
