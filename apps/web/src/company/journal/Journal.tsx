import type { JournalEntry, TokenView } from '@caprail/shared'
import { useState } from 'react'
import {
  Action,
  Actions,
  Cell,
  DoubleRule,
  EmptyRows,
  Help,
  Note,
  Row,
  Stamp,
  Table,
  With,
} from '../../components/Ledger.tsx'
import { short, utcDateTime } from '../../format.ts'
import { useJournal } from '../api.ts'
import { fromBaseUnits } from '../fields.ts'
import { JOURNAL_FILTERS, type JournalFilter, journalCounts } from './model.ts'

// The transfer journal of the company (FR-008): every attempt the hook saw — settled
// or refused, on chain or in the panel's simulation — newest first, live through the
// feed. Company-wide: a company with two tokens reads one journal, the symbol on
// each amount.

export function JournalSection({ companyId, tokens }: { companyId: string; tokens: TokenView[] }) {
  const journal = useJournal(companyId)
  const [filter, setFilter] = useState<JournalFilter>('all')
  const entries = journal.data?.pages.flatMap((page) => page.items) ?? []
  const counts = journalCounts(entries)
  const byMint = new Map(tokens.map((token) => [token.mint, token]))

  return (
    <>
      <div className="fl">
        {JOURNAL_FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`i ${filter === option.value ? 'cur' : ''}`}
            onClick={() => setFilter(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="counts">
        {journal.isPending ? (
          <span className="muted">reading the index…</span>
        ) : journal.isError ? (
          <span className="text-stamp">{journal.error.message}</span>
        ) : (
          <>
            {counts.attempts} {counts.attempts === 1 ? 'attempt' : 'attempts'}
            {journal.hasNextPage && ' loaded'} · {counts.settled} settled · {counts.refused} refused
            {counts.refused > 0 && (
              <>
                , of which {counts.refusedOnChain} on chain and {counts.refusedInSimulation} in
                simulation
              </>
            )}
          </>
        )}
      </div>
      <Table kind="jr" data-f={filter}>
        <Row kind="hd">
          <Cell>When (UTC)</Cell>
          <Cell>From</Cell>
          <Cell>To</Cell>
          <DoubleRule />
          <Cell fig>Amount</Cell>
          <Cell>Outcome</Cell>
          <Cell>Origin</Cell>
          <Cell>Signature</Cell>
        </Row>
        {entries.map((entry) => (
          <EntryRow key={entry.id} entry={entry} token={byMint.get(entry.mint)} />
        ))}
        <EmptyRows before={3} after={4} count={entries.length === 0 ? 3 : 2} />
      </Table>
      {journal.hasNextPage && (
        <Actions>
          <Action inert={journal.isFetchingNextPage} onClick={() => void journal.fetchNextPage()}>
            {journal.isFetchingNextPage ? 'Loading…' : 'Load older'}
          </Action>
        </Actions>
      )}
      <Help>
        chain — the network saw the transaction: settled, or refused by the hook after it was sent.
        simulation — this app simulated the transfer before asking the wallet to sign; the network
        would have refused it, and it was never sent.
      </Help>
    </>
  )
}

function party(owner: string | null, treasury: boolean) {
  if (owner === null) return <span className="muted">—</span>
  const wallet = (
    <span className="mono" title={owner}>
      {short(owner)}
    </span>
  )
  return treasury ? (
    <With>
      {wallet}
      <Note>treasury</Note>
    </With>
  ) : (
    wallet
  )
}

function EntryRow({ entry, token }: { entry: JournalEntry; token: TokenView | undefined }) {
  const refused = entry.outcome === 'rejected'
  const amount =
    entry.amount === null
      ? '—'
      : token === undefined
        ? `${entry.amount} base units`
        : `${fromBaseUnits(entry.amount, token.decimals)} ${token.symbol}`
  return (
    <Row className={refused ? 'ref' : 'set'}>
      <Cell k date>
        {utcDateTime(entry.blockTime)}
      </Cell>
      <Cell label="From">{party(entry.sourceOwner, entry.fromTreasury)}</Cell>
      <Cell label="To">{party(entry.destOwner, false)}</Cell>
      <DoubleRule />
      <Cell fig label="Amount">
        {amount}
      </Cell>
      <Cell label="Outcome">
        {refused ? (
          <With>
            <Stamp reason={entry.reasonCode ?? 'refused'} />
            {entry.logs.length > 0 && (
              <details className="logs">
                <summary>logs</summary>
                <pre>{entry.logs.join('\n')}</pre>
              </details>
            )}
          </With>
        ) : (
          <With>
            <span className="muted">settled</span>
            {entry.policyVersion !== null && <Note>policy version {entry.policyVersion}</Note>}
          </With>
        )}
      </Cell>
      <Cell label="Origin" muted={entry.origin === 'simulation'}>
        {entry.origin === 'simulation' ? (
          <With>
            simulation
            <Note>never sent</Note>
          </With>
        ) : (
          'chain'
        )}
      </Cell>
      <Cell label="Signature" mono={entry.txSignature !== null}>
        {entry.txSignature === null ? (
          '—'
        ) : (
          <span title={entry.txSignature}>{short(entry.txSignature)}</span>
        )}
      </Cell>
    </Row>
  )
}
