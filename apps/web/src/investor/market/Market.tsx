import { buildAcceptOffer } from '@caprail/chain'
import type { MarketOffer, MarketOffers, PlatformView, WalletAddress } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { Link } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.tsx'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { reportAttempt } from '../../company/api.ts'
import { Field, TxStatus } from '../../company/Field.tsx'
import { fromBaseUnits } from '../../company/fields.ts'
import { attemptReportFrom } from '../../company/journal/model.ts'
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
import { formatPayment, pricePerShare } from '../../market/money.ts'
import { takeable } from '../../market/offer.ts'
import { useApi } from '../../providers.tsx'
import { useMarketOffers, useRefreshInvestor } from '../api.ts'
import { parseAcceptForm } from './model.ts'

// The storefront (FR-011, FR-012, FR-013): open offers of other holders that the hook
// would let reach this wallet now — the API filters with the hook's own rule, and the
// hook decides again at transfer time. The fee is shown on every row and again on the
// accept form, computed with the formula the transaction is built with.

export function Market() {
  const market = useMarketOffers()
  const { session } = useSession()
  if (session === null) return null
  if (market.isPending) return <div className="line muted">reading the index…</div>
  if (market.isError) {
    return <div className="line text-stamp">market unavailable: {market.error.message}</div>
  }
  return <MarketView market={market.data} buyer={session.wallet} />
}

function MarketView({ market, buyer }: { market: MarketOffers; buyer: WalletAddress }) {
  const [accepting, setAccepting] = useState<string | null>(null)
  // A filled offer leaves the storefront with the refetch, and its form's status with
  // it; the buyer's receipt is kept here.
  const [notice, setNotice] = useState<string | null>(null)
  const refresh = useRefreshInvestor()
  const { platform, offers } = market

  return (
    <>
      <h1>Market</h1>
      <div className="sub">
        You see only offers you could accept now — admission is checked before the match and again
        by the network at transfer.
      </div>

      {platform === null ? (
        <KV
          rows={[
            [
              'Market',
              'The platform is not configured on this deployment; no offer can be priced.',
              { muted: true },
            ],
          ]}
        />
      ) : (
        <>
          <h2>Offers</h2>
          {notice !== null && <div className="line">{notice}</div>}
          <Table kind="off">
            <Row kind="hd">
              <Cell>Company · token · seller</Cell>
              <Cell>Opened</Cell>
              <DoubleRule />
              <Cell fig>Remaining</Cell>
              <Cell fig>Can be taken</Cell>
              <Cell fig>Price per share</Cell>
              <Cell fig>Total for remaining</Cell>
              <Cell fig>Fee {platform.feeBps} bps</Cell>
              <Cell fig>Seller receives</Cell>
              <Cell />
            </Row>
            {offers.map((offer) => (
              <OfferRow
                key={offer.offer}
                offer={offer}
                platform={platform}
                buyer={buyer}
                open={accepting === offer.offer}
                onToggle={() =>
                  setAccepting((current) => (current === offer.offer ? null : offer.offer))
                }
                onSettled={(receipt) => {
                  // Closed after a trade: the same quantity left in the form would be one
                  // click from buying it again.
                  setAccepting(null)
                  setNotice(receipt)
                  refresh()
                }}
              />
            ))}
            <EmptyRows before={2} after={7} />
          </Table>
          {offers.length === 0 && (
            <Help>
              No open offers you could accept. Offers of tokens whose policy does not admit your
              wallet are not shown.
            </Help>
          )}
          <Help>The fee is deducted from the buyer's payment in the same transaction.</Help>
        </>
      )}

      <Actions className="mt-10">
        <Link to="/cabinet" className="act">
          Offer your shares — from the cabinet
        </Link>
      </Actions>
    </>
  )
}

function OfferRow({
  offer,
  platform,
  buyer,
  open,
  onToggle,
  onSettled,
}: {
  offer: MarketOffer
  platform: PlatformView
  buyer: WalletAddress
  open: boolean
  onToggle: () => void
  onSettled: (receipt: string) => void
}) {
  const { token, quote } = offer
  const { max, reason } = takeable(offer)
  const units = (amount: bigint | string) =>
    `${fromBaseUnits(amount, token.decimals)} ${token.symbol}`
  const pay = (amount: string | undefined) =>
    amount === undefined ? '—' : formatPayment(amount, platform)

  return (
    <>
      <Row>
        <Cell k>
          <With>
            {token.companyName} · {token.symbol}
            <Note>
              seller{' '}
              <span className="mono" title={offer.seller}>
                {short(offer.seller)}
              </span>
            </Note>
          </With>
        </Cell>
        <Cell date label="Opened">
          {utcDate(offer.createdAt)}
        </Cell>
        <DoubleRule />
        <Cell fig label="Remaining">
          {units(offer.remaining)}
        </Cell>
        <Cell fig label="Can be taken">
          {reason === null ? (
            units(max)
          ) : (
            <With>
              {units(max)}
              <Note>{reason}</Note>
            </With>
          )}
        </Cell>
        <Cell fig label="Price per share">
          {formatPayment(pricePerShare(offer.pricePerUnit, token.decimals), platform)}
        </Cell>
        <Cell fig label="Total for remaining">
          {pay(quote?.payment)}
        </Cell>
        <Cell fig label={`Fee ${platform.feeBps} bps`}>
          {pay(quote?.fee)}
        </Cell>
        <Cell fig label="Seller receives">
          {pay(quote?.sellerReceives)}
        </Cell>
        <Cell fig label="">
          {max > 0n && quote !== null && (
            <Action onClick={onToggle}>{open ? 'Close' : 'Accept'}</Action>
          )}
        </Cell>
      </Row>
      {open && (
        <Row kind="form">
          <AcceptForm offer={offer} platform={platform} buyer={buyer} onSettled={onSettled} />
        </Row>
      )}
    </>
  )
}

type Report = { kind: 'none' } | { kind: 'reported' } | { kind: 'failed'; message: string }

function AcceptForm({
  offer,
  platform,
  buyer,
  onSettled,
}: {
  offer: MarketOffer
  platform: PlatformView
  buyer: WalletAddress
  onSettled: (receipt: string) => void
}) {
  const program = useProgram()
  const api = useApi()
  const tx = useTransaction()
  const { token } = offer
  const { max } = takeable(offer)
  const [quantity, setQuantity] = useState(fromBaseUnits(max, token.decimals))
  const [report, setReport] = useState<Report>({ kind: 'none' })
  const busy = tx.state.kind === 'busy'
  const parsed = parseAcceptForm({ quantity }, offer, token.decimals, platform.feeBps)
  const or = (pick: (q: { payment: bigint; fee: bigint; sellerReceives: bigint }) => bigint) =>
    parsed.ok ? formatPayment(pick(parsed.value.quote), platform) : '—'

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed.ok) return
    setReport({ kind: 'none' })
    const plan = await buildAcceptOffer(program, {
      buyer: new PublicKey(buyer),
      offer: {
        mint: new PublicKey(offer.mint),
        seller: new PublicKey(offer.seller),
        offerId: BigInt(offer.offerId),
        pricePerUnit: BigInt(offer.pricePerUnit),
        remaining: BigInt(offer.remaining),
      },
      platform: {
        feeBps: platform.feeBps,
        paymentMint: new PublicKey(platform.paymentMint),
        feeTreasury: new PublicKey(platform.feeTreasury),
        paymentTokenProgram: new PublicKey(platform.paymentTokenProgram),
      },
      amount: parsed.value.amount,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') {
      const { quote } = plan
      onSettled(
        `bought ${fromBaseUnits(quote.amount, token.decimals)} ${token.symbol} of ${token.companyName} ` +
          `for ${formatPayment(quote.payment, platform)}, fee ${formatPayment(quote.fee, platform)} · ` +
          `signature ${short(outcome.signature)}`,
      )
    }
    // A refusal by the hook in our simulation (admission lost since the page loaded) is
    // the company's to see in its journal, as for any transfer. Market refusals
    // (`OfferStale`, `AmountExceedsRemaining`) are not transfer rules and are not reported.
    const refusal = attemptReportFrom(
      {
        mint: offer.mint,
        sourceOwner: offer.seller,
        destOwner: buyer,
        amount: parsed.value.amount,
      },
      outcome,
    )
    if (refusal === null) return
    try {
      await reportAttempt(api, refusal)
      setReport({ kind: 'reported' })
    } catch (cause) {
      setReport({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2">
      <Field
        id={`accept-${offer.offer}`}
        label="Quantity"
        value={quantity}
        onChange={setQuantity}
        error={parsed.ok ? undefined : parsed.errors.quantity}
        help={`${token.symbol}; whole or part, the rest stays open`}
        numeric
        disabled={busy}
      />
      <KV
        empty={false}
        rows={[
          ['You pay', or((q) => q.payment)],
          [`Platform fee ${platform.feeBps} bps`, or((q) => q.fee)],
          ['Seller receives', or((q) => q.sellerReceives)],
        ]}
      />
      <Help ink>
        Shares and payment move in one transaction. Either both happen or neither does. The fee
        above is the one the network deducts.
      </Help>
      <Actions>
        <Action submit inert={busy || !parsed.ok}>
          {busy ? 'Sending…' : 'Accept'}
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      {report.kind === 'reported' && (
        <div className="line muted">recorded in the company's journal as a simulation</div>
      )}
      {report.kind === 'failed' && (
        <div className="line text-stamp">not recorded in the journal: {report.message}</div>
      )}
    </form>
  )
}
