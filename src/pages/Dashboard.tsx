import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { compareSize, dayKey, fullName, num, pct, yen } from '../format'
import type { Sale, SaleItem } from '../types'
import { saleCostKey, type Costing } from '../costing'
import { channelLabel, channelOf, PAYMENT_LABEL, saleProfit } from '../metrics'
import { BarList, ColumnChart, ShareBar, type ColumnDatum, type Share } from '../components/charts'
import { Modal, StockBadge, toast, toastError } from '../components/ui'
import { downloadSalesReport, REPORT_CHANNEL_LABEL, summarizeReport, type ReportChannel } from '../report'

type Range = 'today' | '7d' | '30d' | 'all'
const RANGE_LABEL: Record<Range, string> = { today: '今日', '7d': '直近7日', '30d': '直近30日', all: '全期間' }

// カテゴリ色は「カテゴリ名」に固定で割り当てる（期間を変えても色が変わらない）
const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7']
const MAX_CATS = SERIES.length

type Dim = 'category' | 'type' | 'size'
const DIM_LABEL: Record<Dim, string> = { category: 'カテゴリ', type: 'タイプ', size: 'サイズ' }
const NONE = '指定なし'
const dimOf = (x: { category?: string; type?: string; size?: string }, dim: Dim) =>
  (dim === 'category' ? x.category || '未分類' : x[dim]) || NONE

function startOf(range: Range): Date | null {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (range === 'today') return d
  if (range === '7d') return (d.setDate(d.getDate() - 6), d)
  if (range === '30d') return (d.setDate(d.getDate() - 29), d)
  return null
}

/** 粗利は販売時点の移動平均原価で計算し、オンラインの手数料・発送費も引く */
function summarize(sales: Sale[], costing: Costing) {
  let revenue = 0
  let profit = 0
  let units = 0
  for (const s of sales) {
    revenue += s.total
    profit += saleProfit(s, costing)
    units += s.items.reduce((a, i) => a + i.qty, 0)
  }
  return { revenue, profit, units, count: sales.length, avg: sales.length ? revenue / sales.length : 0 }
}

function Delta({ cur, prev }: { cur: number; prev: number | null }) {
  if (prev === null) return null
  if (prev === 0) return <div className="delta">前期間 実績なし</div>
  const r = (cur - prev) / prev
  const cls = r > 0 ? 'up' : r < 0 ? 'down' : ''
  return (
    <div className={`delta ${cls}`}>
      {r > 0 ? '▲' : r < 0 ? '▼' : '±'} {Math.abs(r * 100).toFixed(1)}% <span className="muted">前期間比</span>
    </div>
  )
}

export function DashboardPage() {
  const { sales: allSales, products, stock, costing } = useStore()
  const [range, setRange] = useState<Range>('7d')
  const [rankBy, setRankBy] = useState<'revenue' | 'profit' | 'qty'>('revenue')
  const [dim, setDim] = useState<Dim>('category')
  const [channel, setChannel] = useState<'all' | 'store' | 'online'>('all')
  const [reportOpen, setReportOpen] = useState(false)

  const valid = useMemo(
    () => allSales.filter((s) => !s.voided && (channel === 'all' || channelOf(s) === channel)),
    [allSales, channel],
  )

  const { sales, prevSales, start } = useMemo(() => {
    const st = startOf(range)
    if (!st) return { sales: valid, prevSales: null, start: null }
    const span = Date.now() - st.getTime()
    const prevStart = new Date(st.getTime() - (range === 'today' ? 86400000 : span))
    // 前期間は「同じ長さだけ前」（今日なら昨日の同時刻まで）
    const prevEnd = new Date(Date.now() - (range === 'today' ? 86400000 : span))
    return {
      sales: valid.filter((s) => new Date(s.at) >= st),
      prevSales: valid.filter((s) => {
        const t = new Date(s.at)
        return t >= prevStart && t < (range === 'today' ? prevEnd : st)
      }),
      start: st,
    }
  }, [valid, range])

  const cur = summarize(sales, costing)
  const prev = prevSales ? summarize(prevSales, costing) : null

  // 推移：今日なら時間別、それ以外は日別
  const trend: ColumnDatum[] = useMemo(() => {
    if (range === 'today') {
      const buckets = Array.from({ length: 24 }, () => ({ v: 0, n: 0 }))
      sales.forEach((s) => {
        const h = new Date(s.at).getHours()
        buckets[h].v += s.total
        buckets[h].n++
      })
      const hours = buckets.map((b, h) => ({ ...b, h })).filter((b, h) => b.n > 0 || (h >= 9 && h <= 20))
      const from = Math.min(...hours.map((b) => b.h))
      const to = Math.max(...hours.map((b) => b.h))
      return buckets.slice(from, to + 1).map((b, i) => {
        const h = from + i
        return { key: String(h), label: `${h}時`, value: b.v, tip: <Tip title={`${h}:00〜${h}:59`} revenue={b.v} count={b.n} /> }
      })
    }
    const first = start ?? (valid[0] ? new Date(valid[0].at) : new Date())
    const days: Date[] = []
    const d = new Date(first)
    d.setHours(0, 0, 0, 0)
    const end = new Date()
    while (d <= end && days.length < 400) {
      days.push(new Date(d))
      d.setDate(d.getDate() + 1)
    }
    const byDay = new Map<string, { v: number; n: number }>()
    sales.forEach((s) => {
      const k = dayKey(s.at)
      const b = byDay.get(k) ?? { v: 0, n: 0 }
      b.v += s.total
      b.n++
      byDay.set(k, b)
    })
    const wd = '日月火水木金土'
    return days.map((day) => {
      const k = dayKey(day)
      const b = byDay.get(k) ?? { v: 0, n: 0 }
      return {
        key: k,
        label: `${day.getMonth() + 1}/${day.getDate()}`,
        value: b.v,
        tip: <Tip title={`${day.getMonth() + 1}月${day.getDate()}日（${wd[day.getDay()]}）`} revenue={b.v} count={b.n} />,
      }
    })
  }, [sales, range, start, valid])

  // 時間帯別（複数日のとき）：いつ売れるか
  const byHour: ColumnDatum[] = useMemo(() => {
    const buckets = Array.from({ length: 24 }, () => ({ v: 0, n: 0 }))
    sales.forEach((s) => {
      const h = new Date(s.at).getHours()
      buckets[h].v += s.total
      buckets[h].n++
    })
    const active = buckets.map((b, h) => (b.n ? h : -1)).filter((h) => h >= 0)
    if (!active.length) return []
    const from = Math.min(...active)
    const to = Math.max(...active)
    return buckets.slice(from, to + 1).map((b, i) => ({
      key: String(from + i),
      label: `${from + i}時`,
      value: b.v,
      tip: <Tip title={`${from + i}時台（期間合計）`} revenue={b.v} count={b.n} />,
    }))
  }, [sales])

  const ranking = useMemo(() => {
    const m = new Map<string, { name: string; revenue: number; profit: number; qty: number }>()
    sales.forEach((s) => {
      // 商品割引・まとめ買いは差し引いた金額で集計（会計割引・手入力の値引きは商品別には按分しない）
      s.items.forEach((i) => {
        const r = m.get(i.productId) ?? { name: fullName(i), revenue: 0, profit: 0, qty: 0 }
        const net = i.price * i.qty - (i.discount ?? 0)
        r.revenue += net
        r.qty += i.qty
        r.profit += net - (costing.saleCost.get(saleCostKey(s.id, i.productId)) ?? i.cost) * i.qty
        m.set(i.productId, r)
      })
    })
    return [...m.entries()]
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => b[rankBy] - a[rankBy])
      .slice(0, 10)
  }, [sales, rankBy, costing])

  // 色は値の名前に固定で割り当てる（期間を変えても同じ色）。「指定なし」は常にグレー
  const dimColor = useMemo(() => {
    const names = [...new Set([...products.map((p) => dimOf(p, dim)), ...valid.flatMap((s) => s.items.map((i: SaleItem) => dimOf(i, dim)))])]
      .filter((n) => n !== NONE)
      .sort((a, b) => (dim === 'size' ? compareSize(a, b) : a.localeCompare(b, 'ja')))
    const m = new Map(names.map((n, i) => [n, i < MAX_CATS ? `var(${SERIES[i]})` : 'var(--muted)']))
    m.set(NONE, 'var(--muted)')
    return m
  }, [products, valid, dim])

  const categories: Share[] = useMemo(() => {
    const m = new Map<string, number>()
    sales.forEach((s) =>
      s.items.forEach((i) => m.set(dimOf(i, dim), (m.get(dimOf(i, dim)) ?? 0) + i.price * i.qty - (i.discount ?? 0))),
    )
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1])
    const main = sorted.filter(([k]) => dimColor.get(k) !== 'var(--muted)')
    if (dim === 'size') main.sort((a, b) => compareSize(a[0], b[0]))
    const rest = sorted.filter(([k]) => dimColor.get(k) === 'var(--muted)')
    const items: Share[] = main.map(([k, v]) => ({ key: k, label: k, value: v, color: dimColor.get(k)! }))
    // 8種類目以降と「指定なし」はグレーでまとめる
    const other = rest.filter(([k]) => k !== NONE).reduce((a, [, v]) => a + v, 0)
    const none = rest.find(([k]) => k === NONE)?.[1] ?? 0
    if (other) items.push({ key: '__other', label: 'その他', value: other, color: 'var(--muted)' })
    if (none) items.push({ key: '__none', label: NONE, value: none, color: 'var(--axis)' })
    return items
  }, [sales, dimColor, dim])

  const payments: Share[] = useMemo(() => {
    const colors = { cash: 'var(--series-1)', cashless: 'var(--series-2)', online: 'var(--series-3)' } as const
    return (['cash', 'cashless', 'online'] as const)
      .map((k) => {
        const list = sales.filter((s) => s.payment === k)
        return { key: k, label: PAYMENT_LABEL[k], value: list.reduce((a, s) => a + s.total, 0), color: colors[k], extra: `${list.length}件` }
      })
      .filter((x) => x.key !== 'online' || x.value > 0)
  }, [sales])

  // 販売先（店頭／各ショップ）。色は名前で固定：店頭が1色目、ショップは名前順
  const channels: Share[] = useMemo(() => {
    const shopNames = [...new Set(allSales.filter((s) => channelOf(s) === 'online').map(channelLabel))].sort((a, b) => a.localeCompare(b, 'ja'))
    const color = new Map(['店頭', ...shopNames].map((n, i) => [n, i < MAX_CATS ? `var(${SERIES[i]})` : 'var(--muted)']))
    const m = new Map<string, { v: number; n: number }>()
    sales.forEach((s) => {
      const k = channelLabel(s)
      const x = m.get(k) ?? { v: 0, n: 0 }
      x.v += s.total
      x.n++
      m.set(k, x)
    })
    return [...m.entries()]
      .sort((a, b) => (a[0] === '店頭' ? -1 : b[0] === '店頭' ? 1 : b[1].v - a[1].v))
      .map(([k, x]) => ({ key: k, label: k, value: x.v, color: color.get(k) ?? 'var(--muted)', extra: `${x.n}件` }))
  }, [sales, allSales])
  const hasOnline = allSales.some((s) => channelOf(s) === 'online')

  const discountUsage = useMemo(() => {
    const m = new Map<string, { name: string; count: number; amount: number }>()
    let total = 0
    let withDiscount = 0
    for (const s of sales) {
      if (s.discount > 0) withDiscount++
      const list = s.discounts?.length ? s.discounts : s.discount > 0 ? [{ ruleId: null, name: '値引き', amount: s.discount }] : []
      for (const d of list) {
        const key = d.ruleId ?? d.name
        const u = m.get(key) ?? { name: d.name, count: 0, amount: 0 }
        u.count++
        u.amount += d.amount
        m.set(key, u)
        total += d.amount
      }
    }
    const items = [...m.entries()].map(([key, u]) => ({ key, ...u })).sort((a, b) => b.amount - a.amount)
    return { items, total, withDiscount }
  }, [sales])

  const lowStock = products
    .filter((p) => p.active && (stock.get(p.id) ?? 0) <= p.lowStock)
    .sort((a, b) => (stock.get(a.id) ?? 0) - (stock.get(b.id) ?? 0))

  return (
    <div>
      <div className="page-head">
        <h1>売上ダッシュボード</h1>
        {hasOnline && (
          <div className="seg" role="group" aria-label="販売先">
            <button aria-pressed={channel === 'all'} onClick={() => setChannel('all')}>すべて</button>
            <button aria-pressed={channel === 'store'} onClick={() => setChannel('store')}>店頭</button>
            <button aria-pressed={channel === 'online'} onClick={() => setChannel('online')}>オンライン</button>
          </div>
        )}
        <div className="seg" role="group" aria-label="期間">
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setReportOpen(true)}>報告書(pptx)</button>
      </div>
      {reportOpen && <ReportDialog initialChannel={channel} onClose={() => setReportOpen(false)} />}

      <div className="kpis">
        <div className="card kpi">
          <div className="label">売上</div>
          <div className="value">{yen(cur.revenue)}</div>
          <Delta cur={cur.revenue} prev={prev?.revenue ?? null} />
        </div>
        <div className="card kpi">
          <div className="label">粗利</div>
          <div className="value">{yen(cur.profit)}</div>
          <div className="delta">粗利率 {cur.revenue ? pct(cur.profit / cur.revenue) : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">取引数</div>
          <div className="value">{num(cur.count)}件</div>
          <Delta cur={cur.count} prev={prev?.count ?? null} />
        </div>
        <div className="card kpi">
          <div className="label">客単価</div>
          <div className="value">{yen(cur.avg)}</div>
          <Delta cur={cur.avg} prev={prev?.avg ?? null} />
        </div>
        <div className="card kpi">
          <div className="label">販売点数</div>
          <div className="value">{num(cur.units)}点</div>
          <Delta cur={cur.units} prev={prev?.units ?? null} />
        </div>
      </div>

      <div className="dash-grid">
        <div className="card span-8">
          <h2>
            売上の推移<span className="sub">{range === 'today' ? '時間別' : '日別'}</span>
          </h2>
          {sales.length || range !== 'all' ? (
            <ColumnChart data={trend} ariaLabel="売上の推移" />
          ) : (
            <div className="empty">まだ売上がありません</div>
          )}
        </div>

        <div className="card span-4">
          <h2>支払い方法</h2>
          <ShareBar items={payments} format={yen} />
          {hasOnline && channel === 'all' && (
            <>
              <h2 style={{ marginTop: 20 }}>販売先</h2>
              <ShareBar items={channels} format={yen} />
            </>
          )}
        </div>

        <div className="card span-6">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 className="grow" style={{ margin: 0 }}>
              商品ランキング<span className="sub">上位10</span>
            </h2>
            <div className="seg" role="group" aria-label="並び順">
              <button aria-pressed={rankBy === 'revenue'} onClick={() => setRankBy('revenue')}>売上</button>
              <button aria-pressed={rankBy === 'profit'} onClick={() => setRankBy('profit')}>粗利</button>
              <button aria-pressed={rankBy === 'qty'} onClick={() => setRankBy('qty')}>数量</button>
            </div>
          </div>
          {ranking.length ? (
            <BarList
              items={ranking.map((r) => ({
                key: r.key,
                label: r.name,
                value: Math.round(r[rankBy]),
                sub:
                  rankBy === 'revenue'
                    ? `${r.qty}点`
                    : rankBy === 'profit'
                      ? `率 ${r.revenue ? pct(r.profit / r.revenue) : '—'}`
                      : yen(r.revenue),
              }))}
              format={rankBy === 'qty' ? (v) => `${num(v)}点` : yen}
            />
          ) : (
            <div className="empty">この期間の販売はありません</div>
          )}
        </div>

        <div className="card span-6">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 className="grow" style={{ margin: 0 }}>{DIM_LABEL[dim]}別売上</h2>
            <div className="seg" role="group" aria-label="集計の切り口">
              {(Object.keys(DIM_LABEL) as Dim[]).map((d) => (
                <button key={d} aria-pressed={dim === d} onClick={() => setDim(d)}>
                  {DIM_LABEL[d]}
                </button>
              ))}
            </div>
          </div>
          {categories.length ? <ShareBar items={categories} format={yen} /> : <div className="empty">この期間の販売はありません</div>}
        </div>

        <div className="card span-6">
          <h2>
            割引の実績<span className="sub">割引合計 {yen(discountUsage.total)}・{discountUsage.withDiscount}件の会計で利用</span>
          </h2>
          {discountUsage.items.length ? (
            <BarList
              items={discountUsage.items.map((u) => ({ key: u.key, label: u.name, value: u.amount, sub: `${u.count}回` }))}
              format={yen}
            />
          ) : (
            <div className="empty">この期間に使われた割引はありません</div>
          )}
        </div>

        {range !== 'today' && (
          <div className="card span-6">
            <h2>
              時間帯別の売上<span className="sub">混雑する時間の目安</span>
            </h2>
            {byHour.length ? <ColumnChart data={byHour} height={180} ariaLabel="時間帯別の売上" /> : <div className="empty">この期間の販売はありません</div>}
          </div>
        )}

        <div className={`card ${range !== 'today' ? 'span-6' : 'span-12'}`}>
          <h2>
            在庫アラート<span className="sub">在庫下限以下の販売中商品</span>
          </h2>
          {lowStock.length === 0 ? (
            <div className="muted small">補充が必要な商品はありません</div>
          ) : (
            <table className="tbl">
              <tbody>
                {lowStock.map((p) => (
                  <tr key={p.id}>
                    <td>{fullName(p)}</td>
                    <td className="muted small">下限 {p.lowStock}</td>
                    <td className="r num" style={{ fontWeight: 700 }}>{stock.get(p.id) ?? 0}</td>
                    <td className="r">
                      <StockBadge stock={stock.get(p.id) ?? 0} low={p.lowStock} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

function Tip({ title, revenue, count }: { title: string; revenue: number; count: number }) {
  return (
    <>
      <div className="t-title">{title}</div>
      <div className="t-row">売上 <b>{yen(revenue)}</b></div>
      <div className="t-row">取引 <b>{count}件</b></div>
    </>
  )
}

/** 期間を指定して売上報告の PowerPoint を作る */
function ReportDialog({ initialChannel, onClose }: { initialChannel: ReportChannel; onClose: () => void }) {
  const { sales, products, stock, costing, settings } = useStore()
  const today = dayKey(new Date())
  const shift = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    return dayKey(d)
  }
  const [from, setFrom] = useState(shift(-6))
  const [to, setTo] = useState(today)
  const [channel, setChannel] = useState<ReportChannel>(initialChannel)
  const [busy, setBusy] = useState(false)

  // 全期間 = 最初の販売日〜今日
  const firstDay = useMemo(() => sales.reduce((a, s) => (s.voided ? a : Math.min(a, new Date(s.at).getTime())), Date.now()), [sales])
  const firstKey = dayKey(new Date(firstDay))
  const now = new Date()
  const presets: { label: string; from: string; to: string }[] = [
    { label: '全期間', from: firstKey, to: today },
    { label: '今日', from: today, to: today },
    { label: '直近7日', from: shift(-6), to: today },
    { label: '直近30日', from: shift(-29), to: today },
    { label: '今月', from: dayKey(new Date(now.getFullYear(), now.getMonth(), 1)), to: today },
    { label: '先月', from: dayKey(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: dayKey(new Date(now.getFullYear(), now.getMonth(), 0)) },
  ]
  const invalid = !from || !to || from > to
  // 最初の販売日以前から今日までなら全期間扱い（比べる前期間がない）
  const allTime = from <= firstKey && to >= today
  const data = useMemo(
    () => (invalid ? null : summarizeReport({ from, to, channel, allTime, shopName: settings.shopName, sales, products, stock, costing })),
    [invalid, from, to, channel, allTime, settings.shopName, sales, products, stock, costing],
  )

  async function create() {
    if (!data) return
    setBusy(true)
    try {
      await downloadSalesReport(data, `売上報告_${allTime ? `全期間_${to}` : from === to ? from : `${from}_${to}`}.pptx`)
      toast('報告書を作成しました')
      onClose()
    } catch (e) {
      console.error(e)
      toastError('報告書を作成できませんでした')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="売上報告書を作成（PowerPoint）" onClose={onClose}>
      <div className="row" style={{ marginBottom: 12 }}>
        {presets.map((p) => (
          <button key={p.label} className="btn sm" aria-pressed={from === p.from && to === p.to} onClick={() => (setFrom(p.from), setTo(p.to))}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <label className="field">
          開始日
          <input type="date" className="input" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <span style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>〜</span>
        <label className="field">
          終了日
          <input type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="seg" role="group" aria-label="対象" style={{ marginBottom: 12 }}>
        {(Object.keys(REPORT_CHANNEL_LABEL) as ReportChannel[]).map((c) => (
          <button key={c} aria-pressed={channel === c} onClick={() => setChannel(c)}>
            {REPORT_CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="muted small">
        {invalid ? (
          <span style={{ color: 'var(--critical)' }}>開始日は終了日以前にしてください</span>
        ) : (
          data && (
            <>
              {data.cur.count}件・売上 <b style={{ color: 'var(--ink)' }}>{yen(data.cur.revenue)}</b>・粗利 {yen(data.cur.profit)}
              <br />
              サマリー・売上の推移・商品ランキング・内訳・時間帯別・割引・在庫アラートのスライドを作成します
            </>
          )
        )}
      </div>
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>閉じる</button>
        <button className="btn primary" onClick={create} disabled={invalid || busy}>
          {busy ? '作成中…' : 'pptxを作成'}
        </button>
      </div>
    </Modal>
  )
}
