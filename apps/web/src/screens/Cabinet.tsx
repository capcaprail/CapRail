import { Link } from 'react-router-dom'
import {
  Action,
  Actions,
  Cell,
  DoubleRule,
  EmptyRows,
  Help,
  KV,
  Row,
  Table,
} from '../components/Ledger.tsx'
import { dusd, pct, short, vhi } from '../format.ts'
import { company, journal, me } from '../mockData.ts'
import { JournalTable } from './Register.tsx'

export function Cabinet() {
  const mine = journal.filter((e) => e.from === me.label || e.to === me.label)
  const vestedShare = (me.vested / me.holding.shares) * 100
  return (
    <>
      <div className="proto">Prototype — mock data until the market (US2); not this network.</div>
      <h1>{me.label}</h1>
      <div className="sub">
        <span className="mono">{short(me.wallet)}</span> · admitted until {me.admittedUntil} ·{' '}
        {company.name}
      </div>

      <h2>Holding</h2>
      <KV
        empty={false}
        rows={[
          [
            'Shares',
            `${vhi(me.holding.shares)} · ${pct(me.holding.sharePct)} of ${company.name} · source: ${me.holding.source}`,
          ],
        ]}
      />
      <div className="bar">
        <div className="v" style={{ flex: `${vestedShare} 0 0` }} />
        <div className="hatch" style={{ flex: `${100 - vestedShare} 0 0` }} />
      </div>
      <div className="lbl mt-1.5">
        {vhi(me.vested)} vested · {vhi(me.unvested)} not yet vested · transferable now{' '}
        {vhi(me.transferableNow)}
      </div>

      <h2>Vesting</h2>
      <KV
        rows={[
          ['Grant', vhi(me.grant.total)],
          ['Started', me.grant.start],
          ['Cliff', `${me.grant.cliff} · ${me.grant.cliffNote}`],
          ['Fully vested', `${me.grant.end} · ${me.grant.endNote}`],
        ]}
      />
      <Help>
        Vesting is linear and read from the network's clock. What has not vested cannot be
        transferred, and the network refuses the attempt.
      </Help>

      <h2>Admission</h2>
      <KV
        rows={[
          ['Status', 'approved'],
          ['Valid until', `${me.admittedUntil} · ${me.admittedUntilNote}`],
        ]}
      />
      <Help>Set by the company's compliance officer.</Help>

      <h2>My offers</h2>
      <Table kind="my">
        <Row kind="hd">
          <Cell>Offer</Cell>
          <DoubleRule />
          <Cell fig>Remaining</Cell>
          <Cell fig>Open since</Cell>
          <Cell fig>Fee</Cell>
          <Cell />
        </Row>
        <Row>
          <Cell k>
            Sell {vhi(me.openOffer.shares)} at {dusd(me.openOffer.priceCents)}
          </Cell>
          <DoubleRule />
          <Cell fig label="Remaining">
            {vhi(me.openOffer.remaining)}
          </Cell>
          <Cell fig label="Open since">
            {me.openOffer.openSince}
          </Cell>
          <Cell fig label="Fee">
            {company.feeBps} bps on acceptance
          </Cell>
          <Cell label="">
            <Action red>Cancel offer</Action>
          </Cell>
        </Row>
        <EmptyRows before={1} after={4} />
      </Table>
      <Help>
        An offer does not move your shares. They stay in your wallet until a buyer accepts.
      </Help>

      <h2>My attempts</h2>
      <JournalTable entries={mine.map((e) => ({ ...e, from: you(e.from), to: you(e.to) }))} />

      <Actions className="mt-7">
        <Link to="/market" className="act">
          Go to the market
        </Link>
      </Actions>
    </>
  )
}

const you = (name: string): string => (name === me.label ? `${name} (you)` : name)
