import type { Holder, TokenView } from '@caprail/shared'
import { Cell, DoubleRule, EmptyRows, Help, Note, Row, Table } from '../../components/Ledger.tsx'
import { OwnershipStrip } from '../../components/OwnershipStrip.tsx'
import { short, utcDateTime } from '../../format.ts'
import { useCapTable } from '../api.ts'
import {
  amountWithSymbol,
  capTableTotals,
  holdersByAmount,
  percent,
  percentOf,
  stripSegments,
} from './model.ts'

// The cap table of one token (FR-007), read from the index and refetched by the
// feed after every settled transfer. Vesting columns are all-vested until grants
// arrive (US3); the columns are here so the table does not change shape then.

export function CapTableSection({ companyId, token }: { companyId: string; token: TokenView }) {
  const table = useCapTable(companyId, token.mint)

  if (table.isPending) return <div className="line muted">reading the index…</div>
  if (table.isError) return <div className="line text-stamp">{table.error.message}</div>

  const data = table.data
  const totals = capTableTotals(data)
  const holders = holdersByAmount(data.holders)
  return (
    <>
      <OwnershipStrip segments={stripSegments(data, token)} />
      <Table kind="cap" className="mt-3">
        <Row kind="hd">
          <Cell>Wallet</Cell>
          <DoubleRule />
          <Cell fig>Held</Cell>
          <Cell fig>Share</Cell>
          <Cell fig>Vested</Cell>
          <Cell fig>Not yet vested</Cell>
          <Cell>Source</Cell>
        </Row>
        <Row>
          <Cell k muted>
            Treasury
            <Note>
              <span className="mono" title={token.treasury}>
                {short(token.treasury)}
              </span>
            </Note>
          </Cell>
          <DoubleRule />
          <Cell fig muted label="Held">
            {amountWithSymbol(data.treasury, token)}
          </Cell>
          <Cell fig muted label="Share">
            {percent(percentOf(data.treasury, data.totalSupply))}
          </Cell>
          <Cell fig muted label="Vested">
            —
          </Cell>
          <Cell fig muted label="Not yet vested">
            —
          </Cell>
          <Cell muted label="Source">
            not yet distributed
          </Cell>
        </Row>
        {holders.map((holder) => (
          <HolderRows key={holder.wallet} holder={holder} token={token} />
        ))}
        <Row kind="tot">
          <Cell k>Held by investors</Cell>
          <DoubleRule />
          <Cell fig label="Held">
            {amountWithSymbol(totals.held, token)}
          </Cell>
          <Cell fig label="Share">
            {percent(totals.pct)}
          </Cell>
          <Cell fig label="Vested">
            {amountWithSymbol(totals.vested, token)}
          </Cell>
          <Cell fig label="Not yet vested">
            {amountWithSymbol(totals.unvested, token)}
          </Cell>
          <Cell />
        </Row>
        <EmptyRows before={1} after={5} count={holders.length === 0 ? 2 : 1} />
      </Table>
      <Help>
        {amountWithSymbol(data.totalSupply, token)} issued · as of {utcDateTime(data.at)} · shares
        are of the issue, the treasury included. Hatched would mean not yet vested.
      </Help>
    </>
  )
}

function HolderRows({ holder, token }: { holder: Holder; token: TokenView }) {
  const unvested = BigInt(holder.unvested)
  const single = holder.sources.length === 1 ? holder.sources[0] : undefined
  return (
    <>
      <Row>
        <Cell k mono>
          <span title={holder.wallet}>{short(holder.wallet)}</span>
        </Cell>
        <DoubleRule />
        <Cell fig label="Held">
          {amountWithSymbol(holder.amount, token)}
        </Cell>
        <Cell fig label="Share">
          {percent(holder.pct)}
        </Cell>
        <Cell fig label="Vested">
          {amountWithSymbol(holder.vested, token)}
        </Cell>
        {unvested === 0n ? (
          <Cell fig label="Not yet vested">
            —
          </Cell>
        ) : (
          <Cell fig hatch label="Not yet vested">
            {amountWithSymbol(holder.unvested, token)}
          </Cell>
        )}
        <Cell label="Source">
          {single !== undefined ? single.kind : `${holder.sources.length} sources`}
        </Cell>
      </Row>
      {/* Two or more sources: indented sub-rows, the holder's row carries the sum. */}
      {holder.sources.length > 1 &&
        holder.sources.map((source) => (
          <Row key={source.kind} kind="sub">
            <Cell k muted>
              {source.kind}
            </Cell>
            <DoubleRule />
            <Cell fig muted label={source.kind}>
              {amountWithSymbol(source.amount, token)}
            </Cell>
            <Cell />
            <Cell />
            <Cell />
            <Cell />
          </Row>
        ))}
    </>
  )
}
