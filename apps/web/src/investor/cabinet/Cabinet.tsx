import { buildCancelOffer, buildCreateOffer } from '@caprail/chain'
import type { Me, OfferView, PlatformView, Position } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Field, TxStatus } from '../../company/Field.tsx'
import { fromBaseUnits } from '../../company/fields.ts'
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
  With,
} from '../../components/Ledger.tsx'
import { short, utcDate } from '../../format.ts'
import { formatPayment, paymentLabel, pricePerShare } from '../../market/money.ts'
import { takeable } from '../../market/offer.ts'
import { useMe, useRefreshInvestor } from '../api.ts'
import { openOfferOf, parseOfferForm, randomOfferId } from './model.ts'

// The investor's cabinet (FR-016): what the wallet holds, where it stands with each
// company's registry, and its own open offers. Vesting arrives with US3 — until then
// everything held is transferable, and the cabinet does not draw a schedule it lacks.

export function Cabinet() {
  const me = useMe()
  if (me.isPending) return <div className="line muted">reading the index…</div>
  if (me.isError)
    return <div className="line text-stamp">cabinet unavailable: {me.error.message}</div>
  return <CabinetView me={me.data} />
}

function CabinetView({ me }: { me: Me }) {
  const [offering, setOffering] = useState<string | null>(null)
  // A cancelled offer leaves the list with the refetch, and its row's status with it.
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = useRefreshInvestor()
  const tokenOf = (mint: string) => me.positions.find((p) => p.token.mint === mint)?.token ?? null

  return (
    <>
      <h1>Cabinet</h1>
      <div className="sub">
        <span className="mono" title={me.wallet}>
          {short(me.wallet)}
        </span>{' '}
        · holdings and admission as the index has them; the network decides at transfer time
      </div>

      <h2>Holdings</h2>
      <Table kind="pos">
        <Row kind="hd">
          <Cell>Company · token</Cell>
          <DoubleRule />
          <Cell fig>Held</Cell>
          <Cell>Admission</Cell>
          <Cell>Valid until</Cell>
          <Cell />
        </Row>
        {me.positions.map((position) => (
          <PositionRow
            key={position.token.mint}
            position={position}
            wallet={me.wallet}
            platform={me.platform}
            openOffer={openOfferOf(position.token.mint, me.offers)}
            offering={offering === position.token.mint}
            onOffer={() => {
              setNotice(null)
              setOffering((current) =>
                current === position.token.mint ? null : position.token.mint,
              )
            }}
            // The form stays open: its status line is the seller's receipt, and the row
            // turns to "offer open" once the index has the offer.
            onSettled={refresh}
          />
        ))}
        <EmptyRows before={1} after={4} />
      </Table>
      {me.positions.length === 0 && (
        <Help>
          No holdings and no registry record yet. A company's compliance officer registers your
          wallet; shares arrive by distribution or by buying on the market.
        </Help>
      )}
      <Help>
        Admission is checked on the receiving side: it decides whether you can buy or receive, not
        whether you can sell.
      </Help>

      <h2>My open offers</h2>
      {notice !== null && <div className="line">{notice}</div>}
      <Table kind="my">
        <Row kind="hd">
          <Cell>Offer</Cell>
          <DoubleRule />
          <Cell fig>Remaining</Cell>
          <Cell fig>Price per share</Cell>
          <Cell fig>Total for remaining</Cell>
          <Cell fig>Fee</Cell>
          <Cell fig>You receive</Cell>
          <Cell />
        </Row>
        {me.offers.map((offer) => (
          <MyOfferRow
            key={offer.offer}
            offer={offer}
            token={tokenOf(offer.mint)}
            platform={me.platform}
            wallet={me.wallet}
            onSettled={(signature) => {
              setNotice(`offer cancelled · signature ${short(signature)}`)
              refresh()
            }}
          />
        ))}
        <EmptyRows before={1} after={6} />
      </Table>
      <Help>
        An offer does not move your shares. They stay in your wallet, delegated to the offer, until
        a buyer accepts; cancelling withdraws the delegation.
      </Help>

      <Actions className="mt-7">
        <Link to="/market" className="act">
          Go to the market
        </Link>
      </Actions>
    </>
  )
}

function AdmissionCell({ position }: { position: Position }) {
  const { admission, registry, policy } = position
  if (!policy.requireAccreditation) {
    return <Cell label="Admission">open — the policy admits any wallet</Cell>
  }
  if (admission.admitted) return <Cell label="Admission">{registry?.status ?? 'approved'}</Cell>
  return (
    <Cell label="Admission">
      <With>
        <span className="text-stamp">not admitted</span>
        <Note>
          {admission.reason === 'AccreditationExpired'
            ? 'expired'
            : (registry?.status ?? 'no record')}
        </Note>
      </With>
    </Cell>
  )
}

function PositionRow({
  position,
  wallet,
  platform,
  openOffer,
  offering,
  onOffer,
  onSettled,
}: {
  position: Position
  wallet: string
  platform: PlatformView | null
  openOffer: OfferView | null
  offering: boolean
  onOffer: () => void
  onSettled: () => void
}) {
  const { token } = position
  const held = BigInt(position.amount)
  return (
    <>
      <Row>
        <Cell k>
          <With>
            {token.companyName} · {token.symbol}
            <Note>{token.name}</Note>
          </With>
        </Cell>
        <DoubleRule />
        <Cell fig label="Held">
          {fromBaseUnits(held, token.decimals)} {token.symbol}
        </Cell>
        <AdmissionCell position={position} />
        <Cell date label="Valid until">
          {position.registry === null ? '—' : utcDate(position.registry.expiresAt)}
        </Cell>
        <Cell label="">
          {offering ? (
            <Action onClick={onOffer}>Close</Action>
          ) : openOffer !== null ? (
            <span className="muted">offer open</span>
          ) : (
            held > 0n && platform !== null && <Action onClick={onOffer}>Offer for sale</Action>
          )}
        </Cell>
      </Row>
      {offering && platform !== null && (
        <Row kind="form">
          <OfferForm
            position={position}
            platform={platform}
            wallet={wallet}
            onSettled={onSettled}
          />
        </Row>
      )}
    </>
  )
}

function OfferForm({
  position,
  platform,
  wallet,
  onSettled,
}: {
  position: Position
  platform: PlatformView
  wallet: string
  onSettled: () => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const [input, setInput] = useState({ amount: '', price: '' })
  const [shown, setShown] = useState(false)
  // Drawn once per form: a retry after a failed send reuses it, a refused `init` on a
  // taken id is the program's answer, not a silent second offer.
  const [offerId] = useState(randomOfferId)
  const busy = tx.state.kind === 'busy'
  // One offer per form: the account now has its delegate, a second post would be refused.
  const posted = tx.state.kind === 'done' && tx.state.outcome.kind === 'settled'
  const { token } = position
  const parsed = parseOfferForm(input, position, platform)
  const errors = shown && !parsed.ok ? parsed.errors : {}
  const or = (pick: (q: { payment: bigint; fee: bigint; sellerReceives: bigint }) => bigint) =>
    parsed.ok ? formatPayment(pick(parsed.value.quote), platform) : '—'

  async function submit(event: FormEvent) {
    event.preventDefault()
    setShown(true)
    if (!parsed.ok) return
    const plan = await buildCreateOffer(program, {
      seller: new PublicKey(wallet),
      mint: new PublicKey(token.mint),
      offerId,
      amount: parsed.value.amount,
      pricePerUnit: parsed.value.pricePerUnit,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled()
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2">
      <Field
        id={`offer-amount-${token.mint}`}
        label="Quantity"
        value={input.amount}
        onChange={(amount) => setInput((i) => ({ ...i, amount }))}
        error={errors.amount}
        help={`${token.symbol}; you hold ${fromBaseUnits(position.amount, token.decimals)}`}
        numeric
        disabled={busy || posted}
      />
      <Field
        id={`offer-price-${token.mint}`}
        label="Price per share"
        value={input.price}
        onChange={(price) => setInput((i) => ({ ...i, price }))}
        error={errors.price}
        help={paymentLabel(platform)}
        numeric
        disabled={busy || posted}
      />
      <KV
        empty={false}
        rows={[
          ['Buyer of the whole offer pays', or((q) => q.payment)],
          [`Platform fee ${platform.feeBps} bps`, or((q) => q.fee)],
          ['You receive', or((q) => q.sellerReceives)],
        ]}
      />
      <Actions>
        <Action submit inert={busy || posted}>
          {busy ? 'Sending…' : posted ? 'Posted' : 'Post offer'}
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      <Help>
        Posting delegates the quantity to the offer; a buyer can take it whole or in part, and the
        fee is deducted from the buyer's payment in the same transaction.
      </Help>
    </form>
  )
}

function MyOfferRow({
  offer,
  token,
  platform,
  wallet,
  onSettled,
}: {
  offer: OfferView
  token: Position['token'] | null
  platform: PlatformView | null
  wallet: string
  onSettled: (signature: string) => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const busy = tx.state.kind === 'busy'
  const decimals = token?.decimals ?? 0
  const units = token === null ? 'units' : token.symbol
  const pay = (amount: string | undefined) =>
    amount === undefined || platform === null ? '—' : formatPayment(amount, platform)
  const { reason } = takeable(offer)

  async function cancel() {
    const plan = await buildCancelOffer(program, {
      seller: new PublicKey(wallet),
      mint: new PublicKey(offer.mint),
      offerId: BigInt(offer.offerId),
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled(outcome.signature)
  }

  return (
    <>
      <Row>
        <Cell k>
          <With>
            {token === null ? short(offer.mint) : `${token.companyName} · ${token.symbol}`}
            <Note>
              opened {utcDate(offer.createdAt)} · of {fromBaseUnits(offer.amount, decimals)} {units}
              {reason !== null && ` · ${reason}`}
            </Note>
          </With>
        </Cell>
        <DoubleRule />
        <Cell fig label="Remaining">
          {fromBaseUnits(offer.remaining, decimals)} {units}
        </Cell>
        <Cell fig label="Price per share">
          {platform === null
            ? '—'
            : formatPayment(pricePerShare(offer.pricePerUnit, decimals), platform)}
        </Cell>
        <Cell fig label="Total for remaining">
          {pay(offer.quote?.payment)}
        </Cell>
        <Cell fig label="Fee">
          {pay(offer.quote?.fee)}
        </Cell>
        <Cell fig label="You receive">
          {pay(offer.quote?.sellerReceives)}
        </Cell>
        <Cell label="">
          <Action red inert={busy} onClick={() => void cancel()}>
            {busy ? 'Cancelling…' : 'Cancel offer'}
          </Action>
        </Cell>
      </Row>
      {tx.state.kind !== 'idle' && (
        <Row kind="form">
          <TxStatus state={tx.state} />
        </Row>
      )}
    </>
  )
}
