import { saleCostKey, type Costing } from './costing'
import { dayKey, fullName, num, pct, yen } from './format'
import { channelLabel, channelOf, PAYMENT_LABEL, saleExpenses, saleProfit } from './metrics'
import type { Product, Sale } from './types'
import type Pptx from 'pptxgenjs'

/**
 * 期間を指定した売上報告（PowerPoint）。
 * 集計（summarizeReport）と書き出し（downloadSalesReport）を分けている。
 * pptxgenjs は大きいので、書き出すときだけ読み込む。
 */

export type ReportChannel = 'all' | 'store' | 'online'
export const REPORT_CHANNEL_LABEL: Record<ReportChannel, string> = { all: '店頭＋オンライン', store: '店頭', online: 'オンライン' }

export type ReportInput = {
  /** YYYY-MM-DD（ローカル日付・両端を含む） */
  from: string
  to: string
  channel: ReportChannel
  shopName: string
  sales: Sale[]
  products: Product[]
  stock: Map<string, number>
  costing: Costing
}

type Totals = { revenue: number; profit: number; expenses: number; discount: number; count: number; units: number; avg: number }
type Row = { key: string; label: string; revenue: number; count: number }

export type ReportData = ReturnType<typeof summarizeReport>

const DAY = 86400000
const parseDay = (s: string) => {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}
const WD = '日月火水木金土'
const jpDate = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WD[d.getDay()]}）`

function totals(sales: Sale[], costing: Costing): Totals {
  let revenue = 0
  let profit = 0
  let expenses = 0
  let discount = 0
  let units = 0
  for (const s of sales) {
    revenue += s.total
    profit += saleProfit(s, costing)
    expenses += saleExpenses(s)
    discount += s.discount
    units += s.items.reduce((a, i) => a + i.qty, 0)
  }
  return { revenue, profit, expenses, discount, units, count: sales.length, avg: sales.length ? revenue / sales.length : 0 }
}

function group(sales: Sale[], keyOf: (s: Sale) => string): Row[] {
  const m = new Map<string, Row>()
  for (const s of sales) {
    const k = keyOf(s)
    const r = m.get(k) ?? { key: k, label: k, revenue: 0, count: 0 }
    r.revenue += s.total
    r.count++
    m.set(k, r)
  }
  return [...m.values()].sort((a, b) => b.revenue - a.revenue)
}

export function summarizeReport(input: ReportInput) {
  const { costing } = input
  const start = parseDay(input.from)
  const endExclusive = addDays(parseDay(input.to), 1)
  const days = Math.max(1, Math.round((endExclusive.getTime() - start.getTime()) / DAY))
  // 比較対象は「同じ日数だけ前」の期間
  const prevStart = addDays(start, -days)

  const valid = input.sales.filter((s) => !s.voided && (input.channel === 'all' || channelOf(s) === input.channel))
  const inRange = (s: Sale, a: Date, b: Date) => {
    const t = new Date(s.at)
    return t >= a && t < b
  }
  const sales = valid.filter((s) => inRange(s, start, endExclusive))
  const prevSales = valid.filter((s) => inRange(s, prevStart, start))
  const voided = input.sales.filter(
    (s) => s.voided && (input.channel === 'all' || channelOf(s) === input.channel) && inRange(s, start, endExclusive),
  ).length

  const cur = totals(sales, costing)
  const prev = totals(prevSales, costing)

  // 日別（1日だけのときは時間別）
  const daily: Row[] = []
  if (days === 1) {
    const hours = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: `${h}時`, revenue: 0, count: 0 }))
    sales.forEach((s) => {
      const b = hours[new Date(s.at).getHours()]
      b.revenue += s.total
      b.count++
    })
    const active = hours.filter((h) => h.count).map((h) => Number(h.key))
    const from = Math.min(9, ...active)
    const to = Math.max(20, ...active)
    daily.push(...hours.slice(from, to + 1))
  } else {
    const byDay = new Map<string, Row>()
    for (let d = new Date(start); d < endExclusive; d = addDays(d, 1)) {
      const k = dayKey(d)
      byDay.set(k, { key: k, label: `${d.getMonth() + 1}/${d.getDate()}`, revenue: 0, count: 0 })
    }
    sales.forEach((s) => {
      const r = byDay.get(dayKey(s.at))
      if (r) {
        r.revenue += s.total
        r.count++
      }
    })
    daily.push(...byDay.values())
  }
  const best = sales.length ? daily.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null

  // 時間帯別（期間合計）
  const hourly = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: `${h}時`, revenue: 0, count: 0 }))
  sales.forEach((s) => {
    const b = hourly[new Date(s.at).getHours()]
    b.revenue += s.total
    b.count++
  })
  const activeHours = hourly.filter((h) => h.count)
  const hours = activeHours.length
    ? hourly.slice(Number(activeHours[0].key), Number(activeHours[activeHours.length - 1].key) + 1)
    : []

  // 商品別（商品割引・まとめ買いは差し引く。会計割引・手入力の値引きは按分しない＝ダッシュボードと同じ）
  const pm = new Map<string, { key: string; name: string; category: string; qty: number; revenue: number; profit: number }>()
  sales.forEach((s) =>
    s.items.forEach((i) => {
      const r = pm.get(i.productId) ?? { key: i.productId, name: fullName(i), category: i.category || '未分類', qty: 0, revenue: 0, profit: 0 }
      const net = i.price * i.qty - (i.discount ?? 0)
      r.qty += i.qty
      r.revenue += net
      r.profit += net - (costing.saleCost.get(saleCostKey(s.id, i.productId)) ?? i.cost) * i.qty
      pm.set(i.productId, r)
    }),
  )
  const productRows = [...pm.values()].sort((a, b) => b.revenue - a.revenue)

  const cm = new Map<string, { label: string; revenue: number; qty: number }>()
  productRows.forEach((p) => {
    const c = cm.get(p.category) ?? { label: p.category, revenue: 0, qty: 0 }
    c.revenue += p.revenue
    c.qty += p.qty
    cm.set(p.category, c)
  })
  const categories = [...cm.values()].sort((a, b) => b.revenue - a.revenue)

  const channels = group(sales, channelLabel)
  const payments = group(sales, (s) => PAYMENT_LABEL[s.payment])

  const dm = new Map<string, { name: string; count: number; amount: number }>()
  for (const s of sales) {
    const list = s.discounts?.length ? s.discounts : s.discount > 0 ? [{ ruleId: null, name: '値引き', amount: s.discount }] : []
    for (const d of list) {
      const k = d.ruleId ?? d.name
      const u = dm.get(k) ?? { name: d.name, count: 0, amount: 0 }
      u.count++
      u.amount += d.amount
      dm.set(k, u)
    }
  }
  const discounts = [...dm.values()].sort((a, b) => b.amount - a.amount)

  const lowStock = input.products
    .filter((p) => p.active && !p.deleted && (input.stock.get(p.id) ?? 0) <= p.lowStock)
    .map((p) => ({ name: fullName(p), stock: input.stock.get(p.id) ?? 0, low: p.lowStock }))
    .sort((a, b) => a.stock - b.stock)

  return {
    shopName: input.shopName,
    channel: input.channel,
    periodLabel: days === 1 ? jpDate(start) : `${jpDate(start)} 〜 ${jpDate(addDays(endExclusive, -1))}`,
    prevLabel: days === 1 ? jpDate(prevStart) : `${jpDate(prevStart)} 〜 ${jpDate(addDays(start, -1))}`,
    days,
    cur,
    prev,
    voided,
    daily,
    dailyIsHourly: days === 1,
    best,
    hours,
    productRows,
    categories,
    channels,
    payments,
    discounts,
    lowStock,
  }
}

// ---------- PowerPoint ----------

// アプリのライトテーマと同じ色
const C = {
  ink: '0B0B0B',
  ink2: '52514E',
  muted: '898781',
  line: 'E1E0D9',
  surface: 'F6F6F3',
  accent: '2A78D6',
  good: '006300',
  bad: 'D03B3B',
  series: ['2A78D6', 'EB6834', '1BAF7A', 'EDA100', 'E87BA4', '008300', '4A3AA7', 'E34948'],
}
const FONT = 'Meiryo UI'
const W = 13.333 // 16:9
const M = 0.5

function change(cur: number, prev: number) {
  if (!prev) return { text: '前期間 実績なし', color: C.muted }
  const r = (cur - prev) / prev
  return { text: `${r > 0 ? '▲' : r < 0 ? '▼' : '±'} ${Math.abs(r * 100).toFixed(1)}%  前期間比`, color: r > 0 ? C.good : r < 0 ? C.bad : C.muted }
}

export async function downloadSalesReport(data: ReportData, fileName: string) {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = `${data.shopName} 売上報告`
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT }

  const sub = `${data.periodLabel}・${REPORT_CHANNEL_LABEL[data.channel]}`
  let page = 1
  const newSlide = (title: string, note?: string) => {
    const s = pptx.addSlide()
    s.background = { color: 'FFFFFF' }
    s.addText(title, { x: M, y: 0.35, w: W - 2 * M, h: 0.6, fontFace: FONT, fontSize: 26, bold: true, color: C.ink })
    s.addText(note ? `${sub}　${note}` : sub, { x: M, y: 0.92, w: W - 2 * M, h: 0.35, fontFace: FONT, fontSize: 12, color: C.muted })
    s.addShape(pptx.ShapeType.line, { x: M, y: 1.35, w: W - 2 * M, h: 0, line: { color: C.line, width: 1 } })
    page++
    s.addText(String(page), { x: W - M - 1, y: 7.0, w: 1, h: 0.3, align: 'right', fontFace: FONT, fontSize: 10, color: C.muted })
    return s
  }
  const empty = (s: Pptx.Slide, text = 'この期間の販売はありません') =>
    s.addText(text, { x: M, y: 3, w: W - 2 * M, h: 1, align: 'center', fontFace: FONT, fontSize: 18, color: C.muted })

  const head = (cells: string[], right: boolean[]): Pptx.TableRow =>
    cells.map((t, i) => ({ text: t, options: { bold: true, color: C.ink2, fill: { color: C.surface }, align: right[i] ? 'right' : 'left' } }))
  const row = (cells: (string | number)[], right: boolean[]): Pptx.TableRow =>
    cells.map((t, i) => ({ text: String(t), options: { align: right[i] ? 'right' : 'left' } }))
  function tableOpts(x: number, y: number, w: number, colW: number[]): Pptx.TableProps {
    return { x, y, w, colW, fontFace: FONT, fontSize: 12, color: C.ink, border: { type: 'solid', pt: 0.5, color: C.line }, rowH: 0.36, valign: 'middle', autoPage: false }
  }

  // 1. 表紙
  {
    const s = pptx.addSlide()
    s.background = { color: 'FFFFFF' }
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.25, h: 7.5, fill: { color: C.accent }, line: { color: C.accent } })
    s.addText(data.shopName, { x: 1, y: 2.0, w: W - 2, h: 0.6, fontFace: FONT, fontSize: 20, color: C.ink2 })
    s.addText('売上報告', { x: 1, y: 2.6, w: W - 2, h: 1.1, fontFace: FONT, fontSize: 48, bold: true, color: C.ink })
    s.addText(data.periodLabel, { x: 1, y: 3.9, w: W - 2, h: 0.5, fontFace: FONT, fontSize: 20, color: C.ink })
    s.addText(`対象：${REPORT_CHANNEL_LABEL[data.channel]}`, { x: 1, y: 4.4, w: W - 2, h: 0.4, fontFace: FONT, fontSize: 14, color: C.ink2 })
    s.addText(`作成日 ${jpDate(new Date())}`, { x: 1, y: 6.4, w: W - 2, h: 0.4, fontFace: FONT, fontSize: 12, color: C.muted })
  }

  // 2. サマリー
  {
    const s = newSlide('サマリー', `比較：${data.prevLabel}`)
    const { cur, prev } = data
    const tiles: { label: string; value: string; cmp: { text: string; color: string } }[] = [
      { label: '売上', value: yen(cur.revenue), cmp: change(cur.revenue, prev.revenue) },
      { label: '粗利', value: yen(cur.profit), cmp: change(cur.profit, prev.profit) },
      { label: '粗利率', value: cur.revenue ? pct(cur.profit / cur.revenue) : '—', cmp: { text: prev.revenue ? `前期間 ${pct(prev.profit / prev.revenue)}` : '前期間 実績なし', color: C.muted } },
      { label: '取引数', value: `${num(cur.count)}件`, cmp: change(cur.count, prev.count) },
      { label: '客単価', value: yen(cur.avg), cmp: change(cur.avg, prev.avg) },
      { label: '販売点数', value: `${num(cur.units)}点`, cmp: change(cur.units, prev.units) },
      { label: '割引合計', value: yen(cur.discount), cmp: { text: `前期間 ${yen(prev.discount)}`, color: C.muted } },
      { label: '手数料・発送費', value: yen(cur.expenses), cmp: { text: `前期間 ${yen(prev.expenses)}`, color: C.muted } },
    ]
    const cols = 4
    const gap = 0.25
    const tw = (W - 2 * M - gap * (cols - 1)) / cols
    const th = 2.1
    tiles.forEach((t, i) => {
      const x = M + (i % cols) * (tw + gap)
      const y = 1.75 + Math.floor(i / cols) * (th + gap)
      s.addShape(pptx.ShapeType.roundRect, { x, y, w: tw, h: th, rectRadius: 0.08, fill: { color: C.surface }, line: { color: C.line, width: 0.75 } })
      s.addText(t.label, { x: x + 0.2, y: y + 0.2, w: tw - 0.4, h: 0.4, fontFace: FONT, fontSize: 14, color: C.ink2 })
      s.addText(t.value, { x: x + 0.2, y: y + 0.65, w: tw - 0.4, h: 0.75, fontFace: FONT, fontSize: 30, bold: true, color: C.ink, fit: 'shrink' })
      s.addText(t.cmp.text, { x: x + 0.2, y: y + 1.45, w: tw - 0.4, h: 0.4, fontFace: FONT, fontSize: 12, color: t.cmp.color })
    })
    const notes = [
      data.best && data.best.revenue > 0 ? `${data.dailyIsHourly ? '最も売れた時間' : '最も売れた日'}：${data.best.label}（${yen(data.best.revenue)}・${data.best.count}件）` : '',
      data.voided ? `取消 ${data.voided}件は集計から除いています` : '',
    ].filter(Boolean)
    if (notes.length) s.addText(notes.join('　／　'), { x: M, y: 6.55, w: W - 2 * M, h: 0.4, fontFace: FONT, fontSize: 12, color: C.ink2 })
  }

  // 3. 売上の推移
  {
    const s = newSlide(`売上の推移（${data.dailyIsHourly ? '時間別' : '日別'}）`)
    if (!data.cur.count) empty(s)
    else
      s.addChart(
        pptx.ChartType.bar,
        [{ name: '売上', labels: data.daily.map((d) => d.label), values: data.daily.map((d) => Math.round(d.revenue)) }],
        {
          x: M, y: 1.6, w: W - 2 * M, h: 5.3,
          barDir: 'col',
          chartColors: [C.accent],
          barGapWidthPct: data.daily.length > 40 ? 20 : 60,
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: data.daily.length > 31 ? 8 : 11, catAxisLabelColor: C.ink2,
          valAxisLabelFontFace: FONT, valAxisLabelFontSize: 11, valAxisLabelColor: C.ink2, valAxisLabelFormatCode: '¥#,##0',
          valGridLine: { color: C.line, size: 0.5 },
          catAxisLineShow: true,
          showValue: data.daily.length <= 14,
          dataLabelFormatCode: '¥#,##0', dataLabelFontSize: 10, dataLabelFontFace: FONT, dataLabelColor: C.ink2, dataLabelPosition: 'outEnd',
        },
      )
  }

  // 4. 商品ランキング
  {
    const top = data.productRows.slice(0, 12)
    const s = newSlide('商品ランキング', `売上上位${top.length || ''}`)
    if (!top.length) empty(s)
    else {
      const right = [true, false, false, true, true, true, true]
      s.addTable(
        [
          head(['順位', '商品', 'カテゴリ', '数量', '売上', '粗利', '粗利率'], right),
          ...top.map((p, i) => row([i + 1, p.name, p.category, `${num(p.qty)}点`, yen(p.revenue), yen(p.profit), p.revenue ? pct(p.profit / p.revenue) : '—'], right)),
        ],
        tableOpts(M, 1.6, W - 2 * M, [0.7, 4.53, 2.0, 1.1, 1.5, 1.5, 1.0]),
      )
      if (data.productRows.length > top.length)
        s.addText(`ほか ${data.productRows.length - top.length}商品`, { x: M, y: 6.6, w: 6, h: 0.35, fontFace: FONT, fontSize: 11, color: C.muted })
    }
  }

  // 5. 内訳（カテゴリ・販売先・支払い方法）
  {
    const s = newSlide('売上の内訳')
    if (!data.cur.count) empty(s)
    else {
      const pies: { title: string; rows: { label: string; revenue: number }[] }[] = [
        { title: 'カテゴリ別', rows: data.categories },
        { title: data.channel === 'all' ? '販売先別' : '販売先別（ショップ）', rows: data.channels },
        { title: '支払い方法別', rows: data.payments },
      ]
      const pw = (W - 2 * M - 0.5) / 3
      pies.forEach((p, i) => {
        const x = M + i * (pw + 0.25)
        s.addText(p.title, { x, y: 1.55, w: pw, h: 0.45, fontFace: FONT, fontSize: 16, bold: true, color: C.ink })
        // 7件を超える分は「その他」にまとめる
        const main = p.rows.slice(0, 7)
        const other = p.rows.slice(7).reduce((a, r) => a + r.revenue, 0)
        const rows = other ? [...main, { label: 'その他', revenue: other }] : main
        s.addChart(pptx.ChartType.doughnut, [{ name: p.title, labels: rows.map((r) => r.label), values: rows.map((r) => Math.round(r.revenue)) }], {
          x, y: 2.0, w: pw, h: 3.0,
          holeSize: 55,
          chartColors: rows.map((_, j) => (other && j === rows.length - 1 ? 'C3C2B7' : C.series[j % C.series.length])),
          showLegend: false,
          showPercent: true, showValue: false, showLabel: false,
          dataLabelColor: 'FFFFFF', dataLabelFontSize: 10, dataLabelFontFace: FONT,
        })
        const total = rows.reduce((a, r) => a + r.revenue, 0)
        s.addTable(
          rows.map((r, j) => [
            { text: '■', options: { color: other && j === rows.length - 1 ? 'C3C2B7' : C.series[j % C.series.length] } },
            { text: r.label },
            { text: yen(r.revenue), options: { align: 'right' } },
            { text: total ? pct(r.revenue / total) : '—', options: { align: 'right', color: C.muted } },
          ]),
          { x, y: 5.1, w: pw, colW: [0.3, pw - 2.6, 1.4, 0.9], fontFace: FONT, fontSize: 11, color: C.ink, rowH: 0.24, margin: 0.02, autoPage: false },
        )
      })
    }
  }

  // 6. 時間帯別（複数日のときのみ。1日なら推移が時間別なので省略）
  if (!data.dailyIsHourly) {
    const s = newSlide('時間帯別の売上', '期間合計')
    if (!data.hours.length) empty(s)
    else
      s.addChart(
        pptx.ChartType.bar,
        [{ name: '売上', labels: data.hours.map((h) => h.label), values: data.hours.map((h) => Math.round(h.revenue)) }],
        {
          x: M, y: 1.6, w: W - 2 * M, h: 5.3,
          barDir: 'col',
          chartColors: [C.series[2]],
          barGapWidthPct: 40,
          catAxisLabelFontFace: FONT, catAxisLabelFontSize: 11, catAxisLabelColor: C.ink2,
          valAxisLabelFontFace: FONT, valAxisLabelFontSize: 11, valAxisLabelColor: C.ink2, valAxisLabelFormatCode: '¥#,##0',
          valGridLine: { color: C.line, size: 0.5 },
          showValue: true,
          dataLabelFormatCode: '¥#,##0', dataLabelFontSize: 10, dataLabelFontFace: FONT, dataLabelColor: C.ink2, dataLabelPosition: 'outEnd',
        },
      )
  }

  // 7. 割引の実績
  {
    const s = newSlide('割引の実績', `割引合計 ${yen(data.cur.discount)}`)
    const list = data.discounts.slice(0, 12)
    if (!list.length) empty(s, 'この期間に使われた割引はありません')
    else {
      const right = [false, true, true]
      s.addTable(
        [head(['割引', '利用回数', '割引額'], right), ...list.map((d) => row([d.name, `${num(d.count)}回`, yen(d.amount)], right))],
        tableOpts(M, 1.6, 8, [5, 1.4, 1.6]),
      )
    }
  }

  // 8. 在庫アラート（作成時点）
  {
    const s = newSlide('在庫アラート', `作成時点で在庫下限以下の販売中商品`)
    const list = data.lowStock.slice(0, 13)
    if (!list.length) empty(s, '補充が必要な商品はありません')
    else {
      const right = [false, true, true]
      s.addTable(
        [
          head(['商品', '在庫', '下限'], right),
          ...list.map((p) => [
            { text: p.name },
            { text: p.stock <= 0 ? '在庫切れ' : String(p.stock), options: { align: 'right' as const, bold: true, color: p.stock <= 0 ? C.bad : C.ink } },
            { text: String(p.low), options: { align: 'right' as const, color: C.muted } },
          ]),
        ],
        tableOpts(M, 1.6, 8, [5.6, 1.2, 1.2]),
      )
      if (data.lowStock.length > list.length)
        s.addText(`ほか ${data.lowStock.length - list.length}商品`, { x: M, y: 6.6, w: 6, h: 0.35, fontFace: FONT, fontSize: 11, color: C.muted })
    }
  }

  await pptx.writeFile({ fileName })
}
