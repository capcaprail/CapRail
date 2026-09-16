import { useLayoutEffect, useRef, useState } from 'react'
import { pct } from '../format.ts'

// The one visual idea: the whole company as a 28px bar. Treasury first as empty paper,
// each owner a solid segment, the not-yet-vested part hatched. Segments whose label does
// not fit are listed under the bar instead — measured, not guessed, so 1280 and 375 differ.

export type StripSegment = {
  key: string
  label: string
  // Share of the whole, in percent.
  sharePct: number
  // Hatched part of this segment, in percent of the segment; null when not applicable.
  unvestedPct: number | null
  treasury: boolean
  tip: string
}

export function OwnershipStrip({ segments }: { segments: StripSegment[] }) {
  const labelRow = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  useLayoutEffect(() => {
    const row = labelRow.current
    if (!row) return
    const measure = () => {
      const next = new Set<string>()
      for (const box of row.querySelectorAll<HTMLElement>('[data-key]')) {
        const text = box.firstElementChild
        if (text instanceof HTMLElement && text.scrollWidth > box.clientWidth) {
          next.add(box.dataset.key ?? '')
        }
      }
      setHidden((prev) => (sameSet(prev, next) ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  const listed = segments.filter((segment) => hidden.has(segment.key))

  return (
    <div className="mt-7">
      <div className="strip">
        {segments.map((segment, i) => (
          <div
            key={segment.key}
            className={['seg', segment.treasury && 'tre', i >= segments.length - 3 && 'r']
              .filter(Boolean)
              .join(' ')}
            style={{ flex: `${segment.sharePct} 0 0` }}
          >
            {segment.unvestedPct !== null && segment.unvestedPct > 0 && (
              <div className="un hatch" style={{ width: `${segment.unvestedPct}%` }} />
            )}
            <div className="tip">{segment.tip}</div>
          </div>
        ))}
      </div>
      <div className="strip-l" ref={labelRow}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="lb"
            data-key={segment.key}
            style={{ flex: `${segment.sharePct} 0 0` }}
          >
            <span style={{ visibility: hidden.has(segment.key) ? 'hidden' : 'visible' }}>
              {segment.label} {pct(segment.sharePct)}
            </span>
          </div>
        ))}
      </div>
      {listed.length > 0 && (
        <div className="also">
          also: {listed.map((segment) => `${segment.label} ${pct(segment.sharePct)}`).join(', ')}
        </div>
      )}
    </div>
  )
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}
