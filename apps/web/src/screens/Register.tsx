import { useState } from 'react'
import {
  Action,
  Actions,
  Cell,
  DoubleRule,
  EmptyRows,
  Help,
  KV,
  Note,
  Row,
  Stamp,
  Table,
  With,
} from '../components/Ledger.tsx'
import { OwnershipStrip } from '../components/OwnershipStrip.tsx'
import { pct, short, vhi } from '../format.ts'
import {
  type Admission,
  capTableTotals,
  company,
  type Investor,
  investors,
  type JournalEntry,
  journal,
  journalCounts,
  type Owner,
  owners,
  stripLabels,
} from '../mockData.ts'

export function Register() {
  return (
    <>
      <h1>{company.name}</h1>
      <div className="sub">
        {company.symbol} · {company.totalIssued.toLocaleString('en-US')} shares issued · policy
        version {company.policy.version} · admission required · as of {company.clock.utc}, slot{' '}
        {company.clock.slot.toLocaleString('en-US')}
      </div>
      <div className="sub muted mt-1">
        Administrator <span className="mono">{short(company.administrator)}</span> · Compliance
        officer <span className="mono">{short(company.complianceOfficer)}</span>
      </div>
      <div className="sub muted mt-0.5">
        Treasury <span className="mono">{short(company.treasury)}</span> · Mint{' '}
        <span className="mono">{short(company.mint)}</span>
      </div>

      <OwnershipStrip owners={owners} labels={stripLabels} />

      <h2>Cap table</h2>
      <CapTable />
      <Help>Hatched means not yet vested.</Help>

      <h2>Policy</h2>
      <KV
        rows={[
          ['Admission required', company.policy.admissionRequired ? 'yes' : 'no'],
          [
            'Right of first refusal',
            <With key="rofr">
              not available in this version
              <Note>
                Enabled in a later release. Until then every offer is open to any admitted buyer.
              </Note>
            </With>,
            { muted: true },
          ],
          ['Refusal window', `${company.policy.refusalWindowDays} days`, { muted: true }],
        ]}
      />
      <Actions>
        <Action inert>Change policy</Action>
      </Actions>
      <Help>A change applies to the next transfer. The token is not reissued.</Help>

      <h2>Register of investors</h2>
      <Help>
        Statuses are set by the compliance officer with the officer's own key. The administrator
        cannot change them.
      </Help>
      <Actions>
        <Action inert>Register an investor</Action>
      </Actions>
      <InvestorTable />
      <Help>
        Jurisdiction and type are reference fields for reports. The network refuses a transfer only
        on admission.
      </Help>

      <h2>Transfer journal</h2>
      <div className="counts">
        {journalCounts.attempts} attempts · {journalCounts.settled} settled ·{' '}
        {journalCounts.refused} refused · {journalCounts.onChain} on chain,{' '}
        {journalCounts.inSimulation} in simulation
      </div>
      <Journal entries={journal} />
      <Help>
        chain — the network refused a transaction that was sent. simulation — a wallet simulated it
        in this app; the network would have refused it, and it was never sent.
      </Help>
    </>
  )
}

function CapTable() {
  return (
    <Table kind="cap">
      <Row kind="hd">
        <Cell>Owner</Cell>
        <Cell>Wallet</Cell>
        <DoubleRule />
        <Cell fig>Shares</Cell>
        <Cell fig>Share</Cell>
        <Cell fig>Vested</Cell>
        <Cell fig>Not yet vested</Cell>
      </Row>
      {owners.map((o) => (
        <OwnerRows key={o.wallet} o={o} />
      ))}
      <Row kind="tot">
        <Cell k>Total</Cell>
        <Cell />
        <DoubleRule />
        <Cell fig label="Shares">
          {vhi(capTableTotals.shares)}
        </Cell>
        <Cell fig label="Share">
          {pct(capTableTotals.sharePct)}
        </Cell>
        <Cell fig label="Vested">
          {vhi(capTableTotals.vested)}
        </Cell>
        <Cell fig label="Not yet vested">
          {vhi(capTableTotals.unvested)}
        </Cell>
      </Row>
      <EmptyRows before={2} after={4} />
    </Table>
  )
}

function OwnerRows({ o }: { o: Owner }) {
  const single = o.sources.length === 1 ? o.sources[0] : undefined
  return (
    <>
      <Row>
        <Cell k>
          {o.label}
          {single && <Note>{single.kind}</Note>}
        </Cell>
        <Cell mono label="Wallet">
          {short(o.wallet)}
        </Cell>
        <DoubleRule />
        <Cell fig label="Shares">
          {vhi(o.shares)}
        </Cell>
        <Cell fig label="Share">
          {pct(o.sharePct)}
        </Cell>
        <Cell fig label="Vested">
          {o.vested === null ? '—' : vhi(o.vested)}
        </Cell>
        {o.unvested === null ? (
          <Cell fig label="Not yet vested">
            —
          </Cell>
        ) : (
          <Cell fig hatch label="Not yet vested">
            {vhi(o.unvested)}
          </Cell>
        )}
      </Row>
      {/* An owner with two sources shows them as indented sub-rows; the owner's row carries the sum. */}
      {o.sources.length > 1 &&
        o.sources.map((s) => (
          <Row key={s.kind} kind="sub">
            <Cell k muted>
              {s.kind}
            </Cell>
            <Cell />
            <DoubleRule />
            <Cell fig label={s.kind}>
              {vhi(s.amount)}
            </Cell>
            <Cell />
            <Cell />
            <Cell />
          </Row>
        ))}
    </>
  )
}

function admissionCell(a: Admission) {
  switch (a.status) {
    case 'approved':
      return 'approved'
    case 'expired':
      return (
        <With>
          expired
          <Note>was approved until {a.wasApprovedUntil}</Note>
        </With>
      )
    case 'revoked':
      return (
        <With>
          revoked
          <Note>on {a.on}</Note>
        </With>
      )
  }
}

function InvestorTable() {
  return (
    <Table kind="inv" className="mt-3">
      <Row kind="hd">
        <Cell>Investor</Cell>
        <Cell>Wallet</Cell>
        <DoubleRule />
        <Cell>Admission</Cell>
        <Cell>Valid until</Cell>
        <Cell>Jurisdiction · type</Cell>
        <Cell>Last change · by</Cell>
        <Cell />
      </Row>
      {investors.map((i: Investor) => (
        <Row key={i.wallet}>
          <Cell k>{i.label}</Cell>
          <Cell mono label="Wallet">
            {short(i.wallet)}
          </Cell>
          <DoubleRule />
          <Cell label="Admission">{admissionCell(i.admission)}</Cell>
          <Cell date label="Valid until">
            {i.validUntil === null ? (
              '—'
            ) : i.validUntilNote ? (
              <With>
                {i.validUntil}
                <Note ink>{i.validUntilNote}</Note>
              </With>
            ) : (
              i.validUntil
            )}
          </Cell>
          <Cell label="Jurisdiction · type">
            {i.jurisdiction} · {i.type}
          </Cell>
          <Cell date label="Last change · by">
            {i.lastChange} · {i.by}
          </Cell>
          <Cell label="">
            <Action inert>Change status</Action>
          </Cell>
        </Row>
      ))}
      <EmptyRows before={2} after={5} />
    </Table>
  )
}

type Filter = 'all' | 'settled' | 'refused'

export function Journal({ entries }: { entries: JournalEntry[] }) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = entries.filter((e) => filter === 'all' || e.outcome.kind === filter)
  const item = (f: Filter, text: string) => (
    <button type="button" className={`i ${filter === f ? 'cur' : ''}`} onClick={() => setFilter(f)}>
      {text}
    </button>
  )
  return (
    <>
      <div className="fl">
        {item('all', 'All')}
        {item('settled', 'Settled')}
        {item('refused', 'Refused')}
      </div>
      <JournalTable entries={shown} />
    </>
  )
}

export function JournalTable({ entries }: { entries: JournalEntry[] }) {
  return (
    <Table kind="jr">
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
      {entries.map((e) => (
        <Row key={`${e.whenUtc}-${e.from}-${e.to}`}>
          <Cell k date>
            {e.whenUtc}
          </Cell>
          <Cell label="From">{e.from}</Cell>
          <Cell label="To">
            {e.toNote ? (
              <With>
                <span className="mono">{e.to}</span>
                <Note>{e.toNote}</Note>
              </With>
            ) : (
              e.to
            )}
          </Cell>
          <DoubleRule />
          <Cell fig label="Amount">
            {vhi(e.amount)}
          </Cell>
          <Cell label="Outcome">
            {e.outcome.kind === 'refused' ? (
              <Stamp reason={e.outcome.reason} />
            ) : (
              <With>
                <span className="muted">settled</span>
                <Note>{e.outcome.detail}</Note>
              </With>
            )}
          </Cell>
          <Cell label="Origin" muted={e.origin === 'simulation'}>
            {e.origin}
          </Cell>
          <Cell label="Signature" mono={e.signature !== null}>
            {e.signature ?? '—'}
          </Cell>
        </Row>
      ))}
      <EmptyRows before={3} after={4} />
    </Table>
  )
}
