import { buildCreateCompany, buildCreateToken, companyPda, tokenAddresses } from '@caprail/chain'
import type { WalletAddress } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { useQuery } from '@tanstack/react-query'
import { type FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../../auth/SessionProvider.tsx'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Action, Actions, Help, KV, Note, With } from '../../components/Ledger.tsx'
import { short } from '../../format.ts'
import { CheckField, Field, TxStatus } from '../Field.tsx'
import { fromBaseUnits } from '../fields.ts'
import { draftStore, type SetupDraft } from './draft.ts'
import {
  type CompanyFormRaw,
  parseCompanyForm,
  parseTokenForm,
  randomCompanyId,
  type TokenFormRaw,
} from './form.ts'

// "Company → token": two transactions signed by the key that becomes the
// administrator. The company id is chosen here, at random, and is the panel's
// address from then on — it is known before the index has seen the company.

export function CompanySetup() {
  const { session, addMembership } = useSession()
  const navigate = useNavigate()
  const store = useMemo(() => draftStore(window.sessionStorage), [])
  // Under `RequireSession`; the fallback only satisfies the type.
  const admin = session?.wallet ?? ('' as WalletAddress)
  const [draft, setDraft] = useState<SetupDraft | null>(() => store.load(admin))

  const step = draft === null ? 1 : 2
  return (
    <>
      <h1>New company</h1>
      <div className="sub">
        The key signed in now becomes the administrator; a second key is named as the compliance
        officer. Both transactions are paid by the administrator.
      </div>
      <div className="fl">
        <span className={`i ${step === 1 ? 'cur' : ''}`}>1 · Company</span>
        <span className={`i ${step === 2 ? 'cur' : ''}`}>2 · Token and policy</span>
      </div>

      {draft === null ? (
        <CompanyStep
          admin={admin}
          onCreated={(created) => {
            store.save(created)
            addMembership({ companyId: created.companyId, role: 'admin' })
            setDraft(created)
          }}
        />
      ) : (
        <>
          <KV
            empty={false}
            rows={[
              ['Company', draft.name],
              [
                'Company id',
                <With key="id">
                  <span className="mono">{draft.companyId}</span>
                  <Note>
                    PDA {short(companyPda(BigInt(draft.companyId)).toBase58())} · created in{' '}
                    {short(draft.createCompanySignature)}
                  </Note>
                </With>,
              ],
              [
                'Compliance officer',
                <span key="o" className="mono wrap">
                  {draft.complianceOfficer}
                </span>,
              ],
            ]}
          />
          <TokenStep
            admin={admin}
            companyId={draft.companyId}
            onIssued={() => {
              store.clear()
              navigate(`/company/${draft.companyId}`)
            }}
          />
        </>
      )}
    </>
  )
}

function CompanyStep({
  admin,
  onCreated,
}: {
  admin: WalletAddress
  onCreated: (draft: SetupDraft) => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const [raw, setRaw] = useState<CompanyFormRaw>({ name: '', complianceOfficer: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof CompanyFormRaw, string>>>({})
  const busy = tx.state.kind === 'busy'
  const set = <K extends keyof CompanyFormRaw>(key: K, value: CompanyFormRaw[K]) => {
    setRaw({ ...raw, [key]: value })
    setErrors({ ...errors, [key]: undefined })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = parseCompanyForm(raw, admin)
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    const companyId = randomCompanyId()
    const plan = await buildCreateCompany(program, {
      companyId,
      admin: new PublicKey(admin),
      complianceOfficer: new PublicKey(parsed.value.complianceOfficer),
      name: parsed.value.name,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') {
      onCreated({
        admin,
        companyId: companyId.toString(),
        name: parsed.value.name,
        complianceOfficer: parsed.value.complianceOfficer,
        createCompanySignature: outcome.signature,
      })
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <h2>Company</h2>
      <Field
        id="company-name"
        label="Name"
        value={raw.name}
        onChange={(name) => set('name', name)}
        error={errors.name}
        help="up to 32 bytes; stored on chain as is"
        wide
        disabled={busy}
      />
      <Field
        id="company-officer"
        label="Compliance officer"
        value={raw.complianceOfficer}
        onChange={(complianceOfficer) => set('complianceOfficer', complianceOfficer)}
        error={errors.complianceOfficer}
        help="the wallet that will set investor statuses — not this one"
        wide
        mono
        disabled={busy}
      />
      <KV
        empty={false}
        rows={[
          [
            'Administrator',
            <span key="a" className="mono wrap">
              {admin}
            </span>,
          ],
        ]}
      />
      <Actions>
        <Action submit inert={busy}>
          {busy ? 'Creating…' : 'Create company'}
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      <Help>
        One transaction: the company account is created with the two roles. The token comes next.
      </Help>
    </form>
  )
}

const TOKEN_DEFAULTS: TokenFormRaw = {
  name: '',
  symbol: '',
  uri: '',
  decimals: '0',
  totalSupply: '',
  requireAccreditation: true,
}

/** Step two, also reachable on its own for a company that exists without a token. */
export function TokenStep({
  admin,
  companyId,
  onIssued,
}: {
  admin: WalletAddress
  companyId: string
  onIssued: (mint: string) => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const company = useMemo(() => companyPda(BigInt(companyId)), [companyId])
  // `token_count` is the next mint's seed; read from the chain, not the index, so a
  // company created a moment ago works.
  const state = useQuery({
    queryKey: ['chain', 'company', company.toBase58()],
    queryFn: () => program.account.company.fetch(company),
    staleTime: 0,
  })
  const [raw, setRaw] = useState<TokenFormRaw>(TOKEN_DEFAULTS)
  const [errors, setErrors] = useState<Partial<Record<keyof TokenFormRaw, string>>>({})
  const busy = tx.state.kind === 'busy'
  const parsed = parseTokenForm(raw)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed.ok || state.data === undefined) {
      if (!parsed.ok) setErrors(parsed.errors)
      return
    }
    setErrors({})
    const tokenIndex = state.data.tokenCount
    const plan = await buildCreateToken(program, {
      company,
      admin: new PublicKey(admin),
      tokenIndex,
      ...parsed.value,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onIssued(tokenAddresses(company, tokenIndex).mint.toBase58())
  }

  const set = <K extends keyof TokenFormRaw>(key: K, value: TokenFormRaw[K]) => {
    setRaw({ ...raw, [key]: value })
    setErrors({ ...errors, [key]: undefined })
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <h2>Token</h2>
      {state.isError && (
        <div className="line text-stamp">
          cannot read the company from the chain: {state.error.message}
        </div>
      )}
      <Field
        id="token-name"
        label="Name"
        value={raw.name}
        onChange={(v) => set('name', v)}
        error={errors.name}
        help="up to 32 bytes"
        wide
        disabled={busy}
      />
      <Field
        id="token-symbol"
        label="Symbol"
        value={raw.symbol}
        onChange={(v) => set('symbol', v)}
        error={errors.symbol}
        help="up to 10 bytes"
        disabled={busy}
      />
      <Field
        id="token-uri"
        label="Metadata URI"
        value={raw.uri}
        onChange={(v) => set('uri', v)}
        error={errors.uri}
        help="optional; wallets show name and symbol without it"
        wide
        disabled={busy}
      />
      <Field
        id="token-decimals"
        label="Decimals"
        value={raw.decimals}
        onChange={(v) => set('decimals', v)}
        error={errors.decimals}
        help="0 for whole shares; at most 9"
        numeric
        disabled={busy}
      />
      <Field
        id="token-supply"
        label="Total supply"
        value={raw.totalSupply}
        onChange={(v) => set('totalSupply', v)}
        error={errors.totalSupply}
        help={
          parsed.ok
            ? `${fromBaseUnits(parsed.value.totalSupply, parsed.value.decimals)} ${parsed.value.symbol} — issued once, in full, to the treasury`
            : 'issued once, in full, to the treasury; there is no mint-more'
        }
        numeric
        disabled={busy}
      />

      <h2>Policy</h2>
      <CheckField
        id="policy-admission"
        label="Admission required"
        checked={raw.requireAccreditation}
        onChange={(v) => set('requireAccreditation', v)}
        help="a transfer to a wallet without a valid status is refused by the network"
        disabled={busy}
      />
      <CheckField
        id="policy-rofr"
        label="Right of first refusal"
        checked={false}
        onChange={() => undefined}
        help="not available in this version; the program refuses it"
        disabled
      />
      <Actions>
        <Action submit inert={busy || state.data === undefined}>
          {busy ? 'Issuing…' : 'Issue token'}
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      <Help>
        One transaction: the mint with the transfer hook, the treasury, the full supply and the
        policy. The mint authority is revoked in the same transaction.
      </Help>
    </form>
  )
}

/** `/company/:companyId/token` — a second (or first) token for an existing company. */
export function IssueToken() {
  const { companyId = '' } = useParams()
  const { session } = useSession()
  const navigate = useNavigate()
  const admin = session?.wallet ?? ('' as WalletAddress)
  return (
    <>
      <h1>Issue a token</h1>
      <div className="sub">
        Company <span className="mono">{companyId}</span> ·{' '}
        <Link to={`/company/${companyId}`} className="act">
          back to the panel
        </Link>
      </div>
      <TokenStep
        admin={admin}
        companyId={companyId}
        onIssued={() => navigate(`/company/${companyId}`)}
      />
    </>
  )
}
