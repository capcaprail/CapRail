import type { ReactNode } from 'react'
import type { TxState } from '../chain/hooks.ts'
import { Stamp } from '../components/Ledger.tsx'
import { short } from '../format.ts'

// Form rows in the ledger idiom: a label, a ruled line to write on, a note. The
// error is a plain red note on the same line — no boxes, no icons.

export function Field({
  id,
  label,
  value,
  onChange,
  error,
  help,
  mono,
  wide,
  numeric,
  type = 'text',
  placeholder,
  disabled,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  error?: string | undefined
  help?: ReactNode
  mono?: boolean
  wide?: boolean
  numeric?: boolean
  type?: 'text' | 'date'
  placeholder?: string
  disabled?: boolean
}) {
  const className = ['in', wide && 'txt', mono && 'mono', numeric && 'num']
    .filter(Boolean)
    .join(' ')
  return (
    <div className="in-row">
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={className}
        type={type}
        inputMode={numeric ? 'decimal' : undefined}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error !== undefined}
      />
      {error !== undefined ? (
        <span className="err">{error}</span>
      ) : (
        help !== undefined && <span className="help">{help}</span>
      )}
    </div>
  )
}

export function SelectField<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  error,
  help,
  disabled,
}: {
  id: string
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  error?: string | undefined
  help?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="in-row">
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="in sel"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error !== undefined ? (
        <span className="err">{error}</span>
      ) : (
        help !== undefined && <span className="help">{help}</span>
      )}
    </div>
  )
}

export function CheckField({
  id,
  label,
  checked,
  onChange,
  help,
  disabled,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  help?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="in-row">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <label className={disabled ? 'muted' : ''} htmlFor={id}>
        {label}
      </label>
      {help !== undefined && <span className="help">{help}</span>}
    </div>
  )
}

const PHASE_TEXT = {
  simulating: 'simulating on the node…',
  signing: 'waiting for the wallet to sign…',
  confirming: 'sent — waiting for confirmation…',
} as const

/** What happened to the transaction the form sent — the same line under every form. */
export function TxStatus({ state }: { state: TxState }) {
  if (state.kind === 'idle') return null
  if (state.kind === 'busy') return <div className="line muted">{PHASE_TEXT[state.phase]}</div>
  const { outcome } = state
  switch (outcome.kind) {
    case 'settled':
      return (
        <div className="line">
          settled · slot {outcome.slot.toLocaleString('en-US')} · signature{' '}
          <span className="mono" title={outcome.signature}>
            {short(outcome.signature)}
          </span>
        </div>
      )
    case 'refused':
      return (
        <div className="line">
          <Stamp reason={outcome.reason ?? 'refused by the network'} />
          <span className="muted">
            {' '}
            {outcome.signature === null
              ? '— in simulation; nothing was sent, no fee was paid'
              : `— on chain, signature ${short(outcome.signature)}`}
          </span>
          {outcome.logs.length > 0 && (
            <details className="logs">
              <summary>logs</summary>
              <pre>{outcome.logs.join('\n')}</pre>
            </details>
          )}
        </div>
      )
    case 'failed':
      return <div className="line text-stamp">not sent: {outcome.message}</div>
  }
}
