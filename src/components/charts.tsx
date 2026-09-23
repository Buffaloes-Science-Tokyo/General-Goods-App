import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

function niceMax(v: number) {
  if (v <= 0) return 1
  const exp = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / exp
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return nf * exp
}

const shortYen = (v: number) => (v >= 10000 ? `${(v / 10000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万` : v.toLocaleString('ja-JP'))

export type ColumnDatum = { key: string; label: string; value: number; tip: ReactNode }

/** 縦棒グラフ（1系列）。ホバーでツールチップ */
export function ColumnChart({ data, height = 220, ariaLabel }: { data: ColumnDatum[]; height?: number; ariaLabel: string }) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 44, r: 8, t: 12, b: 26 }
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)))
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  const band = data.length ? iw / data.length : iw
  const bw = Math.min(24, Math.max(3, band * 0.62))
  const labelEvery = Math.max(1, Math.ceil(36 / band))
  const y = (v: number) => pad.t + ih - (v / max) * ih

  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'baseline' : 'grid'} x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis-text" x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end">
              {shortYen(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = pad.l + band * i + band / 2
          const top = y(d.value)
          const h = pad.t + ih - top
          const r = Math.min(4, h, bw / 2)
          const x0 = cx - bw / 2
          const base = pad.t + ih
          return (
            <g key={d.key}>
              {h > 0.5 && (
                <path
                  d={`M${x0},${base} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${base} Z`}
                  fill="var(--series-1)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text className="axis-text" x={cx} y={height - 8} textAnchor="middle">
                  {d.label}
                </text>
              )}
              <rect
                x={pad.l + band * i}
                y={pad.t}
                width={band}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onTouchStart={() => setHover(i)}
              />
            </g>
          )
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(pad.l + band * hover + band / 2, 70), width - 70),
            top: y(data[hover].value),
          }}
        >
          {data[hover].tip}
        </div>
      )}
    </div>
  )
}

export type Share = { key: string; label: string; value: number; color: string; extra?: string }

/** 構成比の積み上げ横棒＋凡例 */
export function ShareBar({ items, format }: { items: Share[]; format: (v: number) => string }) {
  const total = items.reduce((s, i) => s + i.value, 0)
  const visible = items.filter((i) => i.value > 0)
  return (
    <div>
      <div className="stack" role="img" aria-label={visible.map((i) => `${i.label} ${format(i.value)}`).join('、')}>
        {total > 0 ? (
          visible.map((i) => (
            <div key={i.key} style={{ flex: i.value, background: i.color }} title={`${i.label}: ${format(i.value)}`} />
          ))
        ) : (
          <div style={{ flex: 1, background: 'var(--surface-2)' }} />
        )}
      </div>
      <div className="legend">
        {items.map((i) => (
          <div key={i.key} className="li">
            <span className="sw" style={{ background: i.color }} />
            <span>
              {i.label}
              {i.extra && <span className="muted small"> {i.extra}</span>}
            </span>
            <span className="v">{format(i.value)}</span>
            <span className="p">{total ? `${((i.value / total) * 100).toFixed(1)}%` : '—'}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** ランキング用の横棒リスト（1系列） */
export function BarList({ items, format }: { items: { key: string; label: string; value: number; sub?: string }[]; format: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="barlist">
      {items.map((i) => (
        <div key={i.key} className="item" title={`${i.label}: ${format(i.value)}${i.sub ? `（${i.sub}）` : ''}`}>
          <span className="lbl">{i.label}</span>
          <span className="val">
            {format(i.value)}
            {i.sub && <span className="muted small" style={{ fontWeight: 400 }}> {i.sub}</span>}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${(i.value / max) * 100}%`, background: 'var(--series-1)' }} />
          </div>
        </div>
      ))}
    </div>
  )
}
