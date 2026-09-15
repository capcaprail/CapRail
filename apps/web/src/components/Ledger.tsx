import type { ReactNode } from 'react'

// Ruled-ledger primitives. Class names come from index.css (carried over from the M0 canvas):
// a row is a grid, `dr` is the double vertical rule, a cell with `data-l` stacks into a
// label ‖ figure pair below 600px.

const cx = (...parts: Array<string | false | undefined>): string => parts.filter(Boolean).join(' ')

export function Table({
  kind,
  className,
  children,
  ...rest
}: {
  kind?: 'cap' | 'inv' | 'jr' | 'off' | 'my' | 'kv' | 'reg' | 'tok'
  className?: string
  children: ReactNode
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div className={cx('tb', kind, className)} {...rest}>
      {children}
    </div>
  )
}

export function Row({
  kind,
  className,
  children,
}: {
  /** `form`: a row that spans the table — a form opened under an entry. */
  kind?: 'hd' | 'sub' | 'tot' | 'empty' | 'form'
  className?: string
  children: ReactNode
}) {
  return <div className={cx('tr', kind, className)}>{children}</div>
}

export function Cell({
  label,
  fig,
  date,
  k,
  hatch,
  mono,
  muted,
  children,
}: {
  /** Mobile label for the stacked pair; empty string = figure without a label. */
  label?: string
  /** Right-aligned 15px figure. */
  fig?: boolean
  /** 15px tabular figure kept left-aligned (dates, timestamps). */
  date?: boolean
  /** Key cell: the row's own name, stays a plain line on mobile. */
  k?: boolean
  hatch?: boolean
  mono?: boolean
  muted?: boolean
  children?: ReactNode
}) {
  const className = cx(
    'c',
    fig && 'f',
    date && 'fig',
    k && 'k',
    hatch && 'hatch',
    mono && 'mono',
    muted && 'muted',
  )
  // Hatched figures sit on a scrap of ground colour so the digits stay legible.
  const body = hatch ? (
    <span>
      <span>{children}</span>
    </span>
  ) : (
    children
  )
  return label === undefined ? (
    <div className={className}>{body}</div>
  ) : (
    <div className={className} data-l={label}>
      {body}
    </div>
  )
}

export function DoubleRule() {
  return <div className="dr" />
}

/** The paper continues: ruled empty rows after the last entry, double rule included. */
export function EmptyRows({
  before,
  after,
  count = 3,
}: {
  before: number
  after: number
  count?: number
}) {
  const ids = Array.from({ length: count }, (_, i) => `e${i}`)
  const cells = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => `${prefix}${i}`).map((id) => <Cell key={id} />)
  return (
    <>
      {ids.map((id) => (
        <Row key={id} kind="empty">
          {cells(before, 'b')}
          <DoubleRule />
          {cells(after, 'a')}
        </Row>
      ))}
    </>
  )
}

export function Note({ children, ink }: { children: ReactNode; ink?: boolean }) {
  return <span className={cx('note', ink && 'text-ink')}>{children}</span>
}

/** Groups a value and its note so they stay one grid item on mobile. */
export function With({ children }: { children: ReactNode }) {
  return <span className="w">{children}</span>
}

/** The refusal stamp — the only rotated element and the only bordered box in the product. */
export function Stamp({ reason }: { reason: string }) {
  return (
    <span className="stamp">
      <b>Refused</b>
      <i>{reason}</i>
    </span>
  )
}

export function Action({
  inert,
  red,
  submit,
  onClick,
  children,
}: {
  inert?: boolean
  red?: boolean
  /** The form's submit — Enter in a field triggers it too. */
  submit?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <button
      type={submit ? 'submit' : 'button'}
      className={cx('act', inert && 'inert', red && 'red')}
      onClick={onClick}
      disabled={inert}
    >
      {children}
    </button>
  )
}

export function Actions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('acts', className)}>{children}</div>
}

export function Help({ children, ink }: { children: ReactNode; ink?: boolean }) {
  return <div className={cx('help', ink && 'text-ink')}>{children}</div>
}

/** Two-column ledger block: label ‖ value. */
export function KV({
  rows,
  empty = true,
}: {
  rows: Array<[string, ReactNode, { muted?: boolean }?]>
  empty?: boolean
}) {
  return (
    <Table kind="kv">
      {rows.map(([label, value, opts]) => (
        <Row key={label}>
          <Cell k muted={opts?.muted === true}>
            {label}
          </Cell>
          <DoubleRule />
          <Cell fig muted={opts?.muted === true}>
            {value}
          </Cell>
        </Row>
      ))}
      {empty && <EmptyRows before={1} after={1} count={1} />}
    </Table>
  )
}
