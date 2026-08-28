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
  Table,
} from '../components/Ledger.tsx'
import { dusd, feeFor, parseCents, parseWhole, vhi } from '../format.ts'
import { company, me, type Offer, offers } from '../mockData.ts'

type Viewer = 'admitted' | 'unregistered'

export function Market() {
  const [viewer, setViewer] = useState<Viewer>('admitted')
  const [accepting, setAccepting] = useState<Offer | null>(null)
  const [posting, setPosting] = useState(false)

  const pick = (v: Viewer) => {
    setViewer(v)
    setAccepting(null)
  }
  const switchItem = (v: Viewer, text: string) => (
    <button type="button" className={`i ${viewer === v ? 'cur' : ''}`} onClick={() => pick(v)}>
      {text}
    </button>
  )

  return (
    <>
      <h1>
        Market · {company.name} · {company.symbol}
      </h1>
      <div className="sub">
        Viewing as {me.label} · admitted until {me.admittedUntil} · you see only offers you could
        accept now
      </div>
      <div className="fl mt-2.5">
        <span className="muted">View as:</span>
        {switchItem('admitted', 'admitted investor')}
        {switchItem('unregistered', 'not registered wallet')}
      </div>

      <h2>Offers</h2>
      {viewer === 'admitted' ? (
        <>
          <OfferTable onAccept={setAccepting} />
          <Help>The fee is deducted from the buyer's payment in the same transaction.</Help>
        </>
      ) : (
        <KV
          rows={[
            [
              'Offers',
              "No offers are shown to a wallet that is not in the company's register.",
              { muted: true },
            ],
          ]}
        />
      )}

      {accepting && <AcceptBlock offer={accepting} onClose={() => setAccepting(null)} />}

      <Actions className="mt-10">
        <Action onClick={() => setPosting((p) => !p)}>Post an offer</Action>
      </Actions>
      {posting && <PostBlock onClose={() => setPosting(false)} />}
    </>
  )
}

function OfferTable({ onAccept }: { onAccept: (o: Offer) => void }) {
  return (
    <Table kind="off">
      <Row kind="hd">
        <Cell>Seller</Cell>
        <Cell>Opened</Cell>
        <DoubleRule />
        <Cell fig>Offered</Cell>
        <Cell fig>Remaining</Cell>
        <Cell fig>Price per share</Cell>
        <Cell fig>Total for remaining</Cell>
        <Cell fig>Fee {company.feeBps} bps</Cell>
        <Cell fig>Seller receives</Cell>
        <Cell />
      </Row>
      {offers.map((o) => (
        <Row key={o.seller}>
          <Cell k>
            {o.seller}
            {o.note && <Note>{o.note}</Note>}
          </Cell>
          <Cell date label="Opened">
            {o.opened}
          </Cell>
          <DoubleRule />
          <Cell fig label="Offered">
            {vhi(o.offered)}
          </Cell>
          <Cell fig label="Remaining">
            {vhi(o.remaining)}
          </Cell>
          <Cell fig label="Price per share">
            {dusd(o.priceCents)}
          </Cell>
          <Cell fig label="Total for remaining">
            {dusd(o.totalCents)}
          </Cell>
          <Cell fig label={`Fee ${company.feeBps} bps`}>
            {dusd(o.feeCents)}
          </Cell>
          <Cell fig label="Seller receives">
            {dusd(o.sellerReceivesCents)}
          </Cell>
          <Cell fig label="">
            {o.isMine ? (
              <Action red>Cancel offer</Action>
            ) : (
              <Action onClick={() => onAccept(o)}>Accept</Action>
            )}
          </Cell>
        </Row>
      ))}
      <EmptyRows before={2} after={7} />
    </Table>
  )
}

// The one piece of arithmetic in the prototype: the fee is visible before acceptance.
function AcceptBlock({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const [raw, setRaw] = useState(offer.remaining.toLocaleString('en-US'))
  const qty = parseWhole(raw)
  const pay = qty * offer.priceCents
  const fee = feeFor(pay, company.feeBps)
  const or = (cents: number) => (qty ? dusd(cents) : '—')
  return (
    <>
      <h2>
        Accept · {offer.seller} · {vhi(offer.remaining)} at {dusd(offer.priceCents)}
      </h2>
      <div className="in-row">
        <label className="lbl" htmlFor="accept-qty">
          Quantity
        </label>
        <input
          id="accept-qty"
          className="in"
          type="text"
          inputMode="numeric"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
        />
        <span className="fig">{company.symbol}</span>
        <span className="help">whole or part; the rest stays open</span>
      </div>
      <KV
        empty={false}
        rows={[
          ['Price', `${dusd(offer.priceCents)} per share`],
          ['You pay', or(pay)],
          [`Platform fee ${company.feeBps} bps`, or(fee)],
          ['Seller receives', or(pay - fee)],
        ]}
      />
      <Help ink>
        Shares and payment move in one transaction. Either both happen or neither does.
      </Help>
      <Actions>
        <Action onClick={onClose}>Accept</Action>
        <Action onClick={onClose}>Close</Action>
      </Actions>
    </>
  )
}

function PostBlock({ onClose }: { onClose: () => void }) {
  const [rawQty, setRawQty] = useState('')
  const [rawPrice, setRawPrice] = useState('')
  const qty = parseWhole(rawQty)
  const price = parseCents(rawPrice)
  const total = qty * price
  const fee = feeFor(total, company.feeBps)
  const or = (cents: number) => (qty && price ? dusd(cents) : '—')
  return (
    <>
      <div className="in-row">
        <label className="lbl" htmlFor="post-qty">
          Quantity
        </label>
        <input
          id="post-qty"
          className="in"
          type="text"
          inputMode="numeric"
          value={rawQty}
          onChange={(e) => setRawQty(e.target.value)}
        />
        <span className="fig">{company.symbol}</span>
        <span className="help">
          you can offer up to {vhi(me.transferableNow)} — what has vested
        </span>
      </div>
      <div className="in-row">
        <label className="lbl" htmlFor="post-price">
          Price per share
        </label>
        <input
          id="post-price"
          className="in"
          type="text"
          inputMode="decimal"
          value={rawPrice}
          onChange={(e) => setRawPrice(e.target.value)}
        />
        <span className="fig">{company.paymentSymbol}</span>
      </div>
      {qty > me.transferableNow && (
        <div className="line">
          Above the vested amount. The network would refuse the transfer at acceptance.
        </div>
      )}
      <div className="mt-3">
        <KV
          empty={false}
          rows={[
            ['Buyer pays', or(total)],
            [`Platform fee ${company.feeBps} bps`, or(fee)],
            ['You receive', or(total - fee)],
          ]}
        />
      </div>
      <Help>
        An offer does not move your shares. They stay in your wallet until a buyer accepts.
      </Help>
      <Actions>
        <Action onClick={onClose}>Post</Action>
      </Actions>
    </>
  )
}
