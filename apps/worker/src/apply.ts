import { ata } from '@caprail/chain'
import {
  type CompanyCreated,
  type IndexedEvent,
  type InvestorStatusSet,
  type PolicySet,
  type ProgramTransaction,
  parseTransaction,
  type RolesSet,
  type TokenCreated,
  type TransactionHandler,
  type TransferAllowed,
  type TransferRejected,
} from '@caprail/indexer'
import { isRejectionReason } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import type { Holding, HoldingRow, IndexStore, IndexWriter, TokenRef } from './index-store.ts'

// The chain reads the applier needs beyond what the transaction carries. Each is
// one RPC call, scripted in tests.
export type ApplyRpc = {
  // The full transaction: instructions for a refusal's parties, block time for the
  // journal — neither arrives through `onLogs`.
  transaction: (signature: string) => Promise<ProgramTransaction | null>
  // Owner of a token account (null when the account does not exist).
  tokenAccountOwner: (account: string) => Promise<string | null>
  // Balance of a token account at the RPC's current confirmed slot.
  tokenAccountBalance: (account: string) => Promise<{ amount: bigint; slot: number } | null>
}

export type ApplyLog = {
  info: (fields: Record<string, unknown>, message: string) => void
  warn: (fields: Record<string, unknown>, message: string) => void
}

export type ApplierDeps = {
  store: IndexStore
  rpc: ApplyRpc
  log: ApplyLog
  now?: () => Date
}

// The journal keeps the tail: for a refusal it holds the hook's `Error Code:` line
// and the frame that failed, for an allowed transfer the `Program data:` of
// `TransferAllowed`. The schema bounds the column at this many lines.
export const JOURNAL_LOG_LINES = 20

// A record that refers to a company or mint the index has not seen. Thrown, not
// skipped: the pipeline forgets the signature and the next backfill pass replays
// history in chain order, where `CompanyCreated`/`TokenCreated` come first. This
// only happens when a live transaction outruns the backfill of an older one.
export class NotIndexedYet extends Error {
  constructor(what: string, key: string) {
    super(`${what} ${key} is not in the index yet`)
    this.name = 'NotIndexedYet'
  }
}

const unix = (seconds: number): Date => new Date(seconds * 1000)

// One transaction as every writer below sees it.
type Ctx = {
  signature: string
  slot: bigint
  blockTime: Date
  logs: string[]
}

// A row reconciled with the chain at `last_slot` already counts every transfer up
// to that slot; a delta from one of those would be applied twice.
function covered(known: Holding | null, ctx: Ctx): boolean {
  return known !== null && known.verifiedAt !== null && known.lastSlot >= ctx.slot
}

// Only what `getTransaction` adds: instructions for a failed transaction, block
// time for any. A transaction from backfill already has both and costs nothing.
function needsFetch(tx: ProgramTransaction): boolean {
  return tx.blockTime === null || (tx.failed && tx.instructions === undefined)
}

export function createApplier(deps: ApplierDeps): TransactionHandler {
  const now = deps.now ?? (() => new Date())
  // Memory of the chain the index has already confirmed; refilled from the store
  // on a miss, so a restart costs one lookup per mint, not correctness. What a
  // transaction teaches is remembered only once its writes are committed.
  const companyIds = new Map<string, bigint>()
  const tokens = new Map<string, TokenRef>()
  // Token account → owner, from events (both parties of every allowed transfer,
  // the treasury of every token) and from `getAccountInfo` answers. Owners of
  // Token-2022 ATAs are immutable, so an entry never goes stale.
  const owners = new Map<string, string>()

  async function complete(tx: ProgramTransaction): Promise<ProgramTransaction> {
    if (!needsFetch(tx)) return tx
    const fetched = await deps.rpc.transaction(tx.signature)
    // Listed by the subscription but not yet served at `confirmed` by this node:
    // the same retry path as an unknown mint.
    if (fetched === null) throw new Error(`transaction ${tx.signature} is not served yet`)
    return fetched
  }

  async function companyIdOf(index: IndexWriter, company: string): Promise<bigint> {
    const cached = companyIds.get(company)
    if (cached !== undefined) return cached
    const found = await index.companyIdOf(company)
    if (found === null) throw new NotIndexedYet('company', company)
    companyIds.set(company, found)
    return found
  }

  async function tokenOf(index: IndexWriter, mint: string): Promise<TokenRef | null> {
    const cached = tokens.get(mint)
    if (cached !== undefined) return cached
    const found = await index.tokenOf(mint)
    if (found !== null) tokens.set(mint, found)
    return found
  }

  async function knownTokenOf(index: IndexWriter, mint: string): Promise<TokenRef> {
    const found = await tokenOf(index, mint)
    if (found === null) throw new NotIndexedYet('mint', mint)
    return found
  }

  // Cache, then the ATAs of every wallet the index already ties to the mint (a
  // registered investor refused for an expired admission, say), then the chain.
  // null: the account does not exist — a transfer to a missing account fails
  // before the hook runs, so a refusal never lands here, but the column is nullable.
  async function destinationOwner(
    index: IndexWriter,
    mint: string,
    account: string,
  ): Promise<string | null> {
    const cached = owners.get(account)
    if (cached !== undefined) return cached
    const mintKey = new PublicKey(mint)
    for (const wallet of await index.walletsOf(mint)) {
      if (ata(new PublicKey(wallet), mintKey).toBase58() === account) {
        owners.set(account, wallet)
        return wallet
      }
    }
    const owner = await deps.rpc.tokenAccountOwner(account)
    if (owner !== null) owners.set(account, owner)
    return owner
  }

  async function applyCompanyCreated(
    index: IndexWriter,
    ctx: Ctx,
    event: CompanyCreated,
  ): Promise<() => void> {
    await index.createCompany({
      companyId: event.companyId,
      company: event.company,
      admin: event.admin,
      complianceOfficer: event.complianceOfficer,
      name: event.name,
      createdSignature: ctx.signature,
      createdSlot: ctx.slot,
      updatedAt: ctx.blockTime,
    })
    return () => companyIds.set(event.company, event.companyId)
  }

  async function applyTokenCreated(
    index: IndexWriter,
    ctx: Ctx,
    event: TokenCreated,
  ): Promise<() => void> {
    const companyId = await companyIdOf(index, event.company)
    const policy = event.policy
    await index.createToken(
      {
        mint: event.mint,
        companyId,
        treasury: event.treasury,
        name: event.name,
        symbol: event.symbol,
        decimals: event.decimals,
        totalSupply: event.totalSupply,
        requireAccreditation: policy.requireAccreditation,
        requireRofr: policy.requireRofr,
        rofrWindowSecs: policy.rofrWindowSecs,
        policyVersion: event.policyVersion,
        createdSignature: ctx.signature,
        createdSlot: ctx.slot,
        createdAt: ctx.blockTime,
        updatedAt: ctx.blockTime,
      },
      {
        mint: event.mint,
        version: event.policyVersion,
        companyId,
        requireAccreditation: policy.requireAccreditation,
        requireRofr: policy.requireRofr,
        rofrWindowSecs: policy.rofrWindowSecs,
        // `TokenCreated` has no clock of its own; block time is the only one.
        setAt: null,
        txSignature: ctx.signature,
        slot: ctx.slot,
        blockTime: ctx.blockTime,
      },
      // The whole issue sits in the treasury until `distribute` moves it; the
      // treasury is a holder like any other, and its wallet is the `Company` PDA.
      {
        mint: event.mint,
        wallet: event.company,
        companyId,
        amount: event.totalSupply,
        distributed: 0n,
        lastSignature: ctx.signature,
        lastSlot: ctx.slot,
        updatedAt: ctx.blockTime,
        verifiedAt: null,
      },
    )
    return () => {
      tokens.set(event.mint, { mint: event.mint, companyId, treasury: event.treasury })
      owners.set(event.treasury, event.company)
    }
  }

  async function applyPolicySet(index: IndexWriter, ctx: Ctx, event: PolicySet): Promise<void> {
    const token = await knownTokenOf(index, event.mint)
    const setAt = unix(event.setAt)
    await index.setPolicy(
      {
        mint: event.mint,
        version: event.policyVersion,
        companyId: token.companyId,
        requireAccreditation: event.policy.requireAccreditation,
        requireRofr: event.policy.requireRofr,
        rofrWindowSecs: event.policy.rofrWindowSecs,
        setAt,
        txSignature: ctx.signature,
        slot: ctx.slot,
        blockTime: ctx.blockTime,
      },
      setAt,
    )
  }

  async function applyRolesSet(index: IndexWriter, event: RolesSet): Promise<void> {
    const companyId = await companyIdOf(index, event.company)
    await index.setRoles(companyId, {
      admin: event.admin,
      complianceOfficer: event.complianceOfficer,
      setAt: unix(event.setAt),
    })
  }

  async function applyInvestorStatusSet(
    index: IndexWriter,
    ctx: Ctx,
    event: InvestorStatusSet & { eventIndex: number },
  ): Promise<void> {
    const token = await knownTokenOf(index, event.mint)
    const record = {
      mint: event.mint,
      wallet: event.wallet,
      companyId: token.companyId,
      status: event.status,
      expiresAt: unix(event.expiresAt),
      jurisdiction: event.jurisdiction,
      investorType: event.investorType,
    }
    await index.setInvestorStatus(
      {
        ...record,
        setAt: unix(event.updatedAt),
        setBy: event.updatedBy,
        txSignature: ctx.signature,
        eventIndex: event.eventIndex,
        slot: ctx.slot,
        blockTime: ctx.blockTime,
      },
      {
        ...record,
        updatedAt: unix(event.updatedAt),
        updatedBy: event.updatedBy,
        txSignature: ctx.signature,
        slot: ctx.slot,
      },
    )
  }

  // The source after the transfer: the index's number minus the amount, or — when
  // the index has no row or too small a number for a transfer that did happen —
  // the chain's balance, read after the transfer. A verified row's `last_slot` is
  // the slot of that read. null: nothing to write, the row already covers this slot.
  async function sourceHolding(
    index: IndexWriter,
    token: TokenRef,
    ctx: Ctx,
    event: TransferAllowed,
  ): Promise<HoldingRow | null> {
    const known = await index.holding(event.mint, event.sourceOwner)
    if (covered(known, ctx)) return null
    const row = {
      mint: event.mint,
      wallet: event.sourceOwner,
      companyId: token.companyId,
      lastSignature: ctx.signature,
      updatedAt: ctx.blockTime,
    }
    if (known !== null && known.amount >= event.amount) {
      return {
        ...row,
        amount: known.amount - event.amount,
        distributed: known.distributed,
        lastSlot: ctx.slot,
        verifiedAt: null,
      }
    }
    const balance = await deps.rpc.tokenAccountBalance(event.source)
    if (balance === null) throw new Error(`token account ${event.source} has no balance`)
    deps.log.warn(
      {
        signature: ctx.signature,
        mint: event.mint,
        wallet: event.sourceOwner,
        indexed: known?.amount.toString() ?? null,
        transfer: event.amount.toString(),
        chain: balance.amount.toString(),
      },
      'holding reconciled with the chain',
    )
    return {
      ...row,
      amount: balance.amount,
      distributed: known?.distributed ?? 0n,
      lastSlot: BigInt(balance.slot),
      verifiedAt: now(),
    }
  }

  async function destinationHolding(
    index: IndexWriter,
    token: TokenRef,
    ctx: Ctx,
    event: TransferAllowed,
  ): Promise<HoldingRow | null> {
    const known = await index.holding(event.mint, event.destinationOwner)
    if (covered(known, ctx)) return null
    return {
      mint: event.mint,
      wallet: event.destinationOwner,
      companyId: token.companyId,
      amount: (known?.amount ?? 0n) + event.amount,
      distributed: (known?.distributed ?? 0n) + (event.fromTreasury ? event.amount : 0n),
      lastSignature: ctx.signature,
      lastSlot: ctx.slot,
      updatedAt: ctx.blockTime,
      verifiedAt: null,
    }
  }

  async function applyTransferAllowed(
    index: IndexWriter,
    ctx: Ctx,
    event: TransferAllowed & { eventIndex: number },
  ): Promise<() => void> {
    const token = await knownTokenOf(index, event.mint)
    const learned = () => {
      owners.set(event.source, event.sourceOwner)
      owners.set(event.destination, event.destinationOwner)
    }
    const inserted = await index.recordAttempt({
      mint: event.mint,
      companyId: token.companyId,
      sourceOwner: event.sourceOwner,
      destOwner: event.destinationOwner,
      amount: event.amount,
      outcome: 'allowed',
      reasonCode: null,
      origin: 'chain',
      fromTreasury: event.fromTreasury,
      policyVersion: event.policyVersion,
      txSignature: ctx.signature,
      eventIndex: event.eventIndex,
      slot: ctx.slot,
      blockTime: ctx.blockTime,
      logs: ctx.logs,
      reportedBy: null,
    })
    // A journal row already there means the balances already moved.
    if (!inserted) return learned
    for (const side of [sourceHolding, destinationHolding]) {
      const row = await side(index, token, ctx, event)
      if (row !== null) await index.putHolding(row)
    }
    return learned
  }

  async function applyRejection(
    index: IndexWriter,
    ctx: Ctx,
    rejection: TransferRejected,
  ): Promise<void> {
    const transfer = rejection.transfer
    if (transfer === null) {
      deps.log.warn(
        { signature: ctx.signature, reason: rejection.reason },
        'refusal without a transfer_checked instruction; not journaled',
      )
      return
    }
    const token = await tokenOf(index, transfer.mint)
    if (token === null) {
      // An admission reason means the hook got past `TokenConfig ↔ mint`, so the
      // mint is ours and merely not indexed yet. Anything else (`TokenConfigMismatch`
      // from a foreign mint that points its hook at us) is not a journal row.
      if (isRejectionReason(rejection.reason)) throw new NotIndexedYet('mint', transfer.mint)
      deps.log.warn(
        { signature: ctx.signature, mint: transfer.mint, reason: rejection.reason },
        'refusal on a mint the index does not know; not journaled',
      )
      return
    }
    await index.recordAttempt({
      mint: transfer.mint,
      companyId: token.companyId,
      sourceOwner: transfer.sourceOwner,
      destOwner: await destinationOwner(index, transfer.mint, transfer.destination),
      amount: transfer.amount,
      outcome: 'rejected',
      reasonCode: rejection.reason,
      origin: 'chain',
      fromTreasury: transfer.source === token.treasury,
      policyVersion: null,
      txSignature: ctx.signature,
      eventIndex: 0,
      slot: ctx.slot,
      blockTime: ctx.blockTime,
      logs: ctx.logs,
      reportedBy: null,
    })
  }

  async function applyEvent(
    index: IndexWriter,
    ctx: Ctx,
    event: IndexedEvent,
  ): Promise<(() => void) | undefined> {
    switch (event.kind) {
      case 'CompanyCreated':
        return applyCompanyCreated(index, ctx, event)
      case 'TokenCreated':
        return applyTokenCreated(index, ctx, event)
      case 'PolicySet':
        return applyPolicySet(index, ctx, event).then(() => undefined)
      case 'RolesSet':
        return applyRolesSet(index, event).then(() => undefined)
      case 'InvestorStatusSet':
        return applyInvestorStatusSet(index, ctx, event).then(() => undefined)
      case 'TransferAllowed':
        return applyTransferAllowed(index, ctx, event)
    }
  }

  return async (raw) => {
    const tx = await complete(raw)
    const parsed = parseTransaction(tx)
    if (parsed.failure !== null) {
      deps.log.info(
        { signature: tx.signature, ...parsed.failure },
        'program refused an instruction',
      )
    }
    if (parsed.events.length === 0 && parsed.rejection === null) return
    // Journal rows are ordered by block time (SC-003/SC-004 are measured from it),
    // so a wall-clock stand-in would be a lie; the next backfill pass gets a fresh
    // `getTransaction`.
    if (tx.blockTime === null) throw new Error(`transaction ${tx.signature} has no block time`)
    const ctx: Ctx = {
      signature: tx.signature,
      slot: BigInt(tx.slot),
      blockTime: unix(tx.blockTime),
      logs: tx.logs.slice(-JOURNAL_LOG_LINES),
    }
    const learned = await deps.store.write(async (index) => {
      const lessons: (() => void)[] = []
      for (const event of parsed.events) {
        const lesson = await applyEvent(index, ctx, event)
        if (lesson !== undefined) lessons.push(lesson)
      }
      if (parsed.rejection !== null) await applyRejection(index, ctx, parsed.rejection)
      return lessons
    })
    for (const lesson of learned) lesson()
  }
}
