import type { CompanyOffers, OfferView, PlatformView, TokenView } from '@caprail/shared'
import type { UseQueryResult } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Cell,
  DoubleRule,
  EmptyRows,
  Help,
  Note,
  Row,
  Table,
  With,
} from '../../components/Ledger.tsx'
import { short, utcDateTime } from '../../format.ts'
import { formatPayment, pricePerShare } from '../../market/money.ts'
import { fromBaseUnits } from '../fields.ts'
import { BOOK_FILTERS, type BookFilter, bookCounts, filterBook, offerState } from './model.ts'

// The offers holders put up on this mint (FR-011, FR-013): every status, newest first,
// live through the feed. An open offer the seller's account can no longer back in
// full is marked stale with the reason and what can still be taken — delegation is
// not escrow, and the panel says so rather than showing a sale that cannot happen.

export function OffersSection({
  token,
  book,
}: {
  token: TokenView
  book: UseQueryResult<CompanyOffers, Error>
}) {
  const [filter, setFilter] = useState<BookFilter>('all')
  const all = (book.data?.offers ?? []).filter((offer) => offer.mint === token.mint)
  const shown = filterBook(all, filter)
  const counts = bookCounts(all)
  const platform = book.data?.platform ?? null
  const units = (amount: bigint | string) =>
    `${fromBaseUnits(amount, token.decimals)} ${token.symbol}`

  return (
    <>
      <div className="fl">
        {BOOK_FILTERS.map((option) => (
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
        {book.isPending ? (
          <span className="muted">reading the index…</span>
        ) : book.isError ? (
          <span className="text-stamp">{book.error.message}</span>
        ) : (
          <>
            {counts.offers} {counts.offers === 1 ? 'offer' : 'offers'} · {counts.open} open
            {counts.stale > 0 && <>, of which {counts.stale} stale</>} · {counts.filled} filled ·{' '}
            {counts.cancelled} cancelled
            {counts.open > 0 && (
              <>
                {' '}
                · {units(counts.onOffer)} on offer
                {counts.takeableNow < counts.onOffer && (
                  <>, {units(counts.takeableNow)} takeable now</>
                )}
              </>
            )}
          </>
        )}
      </div>
      <Table kind="book">
        <Row kind="hd">
          <Cell>Posted (UTC)</Cell>
          <Cell>Seller</Cell>
          <DoubleRule />
          <Cell fig>Offered</Cell>
          <Cell fig>Remaining</Cell>
          <Cell fig>Price per share</Cell>
          <Cell fig>Total for remaining</Cell>
          <Cell fig>{platform === null ? 'Fee' : `Fee ${platform.feeBps} bps`}</Cell>
          <Cell>Status</Cell>
        </Row>
        {shown.map((offer) => (
          <OfferRow key={offer.offer} offer={offer} token={token} platform={platform} />
        ))}
        <EmptyRows before={2} after={6} count={shown.length === 0 ? 3 : 2} />
      </Table>
      {book.isSuccess && all.length === 0 && <Help>No holder has offered this token yet.</Help>}
      <Help>
        The fee is the platform's, deducted from the buyer's payment in the same transaction; the
        seller receives the rest. An offer is not escrow — the seller keeps the shares and delegates
        them. Stale: the seller's account no longer backs the whole remainder, and the network would
        refuse the excess.
      </Help>
    </>
  )
}

function OfferRow({
  offer,
  token,
  platform,
}: {
  offer: OfferView
  token: TokenView
  platform: PlatformView | null
}) {
  const units = (amount: bigint | string) =>
    `${fromBaseUnits(amount, token.decimals)} ${token.symbol}`
  const pay = (amount: bigint | string | undefined) =>
    amount === undefined || platform === null ? '—' : formatPayment(amount, platform)
  const state = offerState(offer)
  return (
    <Row className={state.kind}>
      <Cell k date>
        {utcDateTime(offer.createdAt)}
      </Cell>
      <Cell label="Seller" mono>
        <span title={offer.seller}>{short(offer.seller)}</span>
      </Cell>
      <DoubleRule />
      <Cell fig label="Offered">
        {units(offer.amount)}
      </Cell>
      <Cell fig label="Remaining">
        {units(offer.remaining)}
      </Cell>
      <Cell fig label="Price per share">
        {platform === null
          ? `${pricePerShare(offer.pricePerUnit, token.decimals)} base units of ${short(offer.paymentMint)}`
          : pay(pricePerShare(offer.pricePerUnit, token.decimals))}
      </Cell>
      <Cell fig label="Total for remaining">
        {pay(offer.quote?.payment)}
      </Cell>
      <Cell fig label={platform === null ? 'Fee' : `Fee ${platform.feeBps} bps`}>
        {pay(offer.quote?.fee)}
      </Cell>
      <Cell label="Status">
        <StateMark state={state} units={units} />
      </Cell>
    </Row>
  )
}

function StateMark({
  state,
  units,
}: {
  state: ReturnType<typeof offerState>
  units: (amount: bigint) => string
}) {
  switch (state.kind) {
    case 'open':
      return <span>open</span>
    case 'stale':
      return (
        <With>
          <span className="text-stamp">stale</span>
          <Note>
            {state.reason}; {units(state.max)} can be taken now
            {state.checkedAt !== null && <> · read {utcDateTime(state.checkedAt)}</>}
          </Note>
        </With>
      )
    case 'filled':
    case 'cancelled':
      return (
        <With>
          <span className="muted">{state.kind}</span>
          {state.at !== null && <Note>{utcDateTime(state.at)}</Note>}
        </With>
      )
  }
}
