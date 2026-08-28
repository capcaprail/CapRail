import { useLayoutEffect, useRef, useState } from 'react'
import { pct, vhi } from '../format.ts'
import type { Owner } from '../mockData.ts'

// The one visual idea: the whole company as a 28px bar. Treasury first as empty paper,
// each owner a solid segment, the not-yet-vested part hatched. Segments whose label does
// not fit are listed under the bar instead — measured, not guessed, so 1280 and 375 differ.

export function OwnershipStrip({
  owners,
  labels,
}: {
  owners: Owner[]
  labels: Record<string, string>
}) {
  const labelRow = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useLayoutEffect(() => {
    const row = labelRow.current
    if (!row) return
    const measure = () => {
      const next = new Set<string>()
      for (const box of row.querySelectorAll<HTMLElement>('[data-wallet]')) {
        const text = box.firstElementChild
        if (text instanceof HTMLElement && text.scrollWidth > box.clientWidth) {
          next.add(box.dataset.wallet ?? '')
        }
      }
      setHidden((prev) => (sameSet(prev, next) ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  const listed = owners.filter((o) => hidden.has(o.wallet))

  return (
    <div className="mt-7">
      <div className="strip">
        {owners.map((o, i) => (
          <div
            key={o.wallet}
            className={['seg', o.isTreasury && 'tre', i >= owners.length - 3 && 'r']
              .filter(Boolean)
              .join(' ')}
            style={{ flex: `${o.sharePct} 0 0` }}
          >
            {o.unvested !== null && (
              <div className="un hatch" style={{ width: `${(o.unvested / o.shares) * 100}%` }} />
            )}
            <div className="tip">{tooltip(o, labels)}</div>
          </div>
        ))}
      </div>
      <div className="strip-l" ref={labelRow}>
        {owners.map((o) => (
          <div
            key={o.wallet}
            className="lb"
            data-wallet={o.wallet}
            style={{ flex: `${o.sharePct} 0 0` }}
          >
            <span style={{ visibility: hidden.has(o.wallet) ? 'hidden' : 'visible' }}>
              {labels[o.wallet]} {pct(o.sharePct)}
            </span>
          </div>
        ))}
      </div>
      {listed.length > 0 && (
        <div className="also">
          also: {listed.map((o) => `${labels[o.wallet]} ${pct(o.sharePct)}`).join(', ')}
        </div>
      )}
    </div>
  )
}

function tooltip(o: Owner, labels: Record<string, string>): string {
  const head = `${o.isTreasury ? 'Treasury (Varenholt Instruments)' : labels[o.wallet]} · ${vhi(o.shares)} · ${pct(o.sharePct)}`
  if (o.isTreasury) return `${head} · not yet distributed`
  return o.unvested !== null ? `${head} · of which ${vhi(o.unvested)} not yet vested` : head
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
