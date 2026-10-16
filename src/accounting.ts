import { dayKey } from './format'
import type { View } from './store'
import type { LedgerEntry, Sale } from './types'

/**
 * 会計の収支。手入力の記録に、レジのデータから自動で作る収支を合わせる。
 * - 収入：店頭・オンラインの売上（取り消した会計は除く。オンラインは送料込みの支払額）
 * - 支出：入荷した時点の仕入額（数量 × 仕入単価。取り消し・修正を反映）、決済手数料、オンラインの手数料・発送の実費
 * 仕入は「売れたときの原価」ではなく「仕入れたときの支出」として数える（お金の出入りの考え方）
 */
export type Flow = {
  /** 元の記録のID（販売・在庫の記録・収支の記録） */
  id: string
  /** ローカル日付 YYYY-MM-DD */
  date: string
  kind: LedgerEntry['kind']
  category: string
  amount: number
  /** レジのデータから自動で作ったもの */
  auto: boolean
  memo: string
  /** どのプールの収支か（未設定・削除されたプールは null） */
  poolId: string | null
}

export const AUTO = {
  storeSales: '売上（店頭）',
  onlineSales: '売上（オンライン）',
  restock: '仕入（入荷）',
  initial: '仕入（初期在庫）',
  paymentFee: '決済手数料（キャッシュレス）',
  onlineFee: '販売手数料（オンライン）',
  shippingCost: '発送費（オンライン）',
} as const

export const EXPENSE_CATEGORIES = ['会場費', '交通費', '宿泊費', '送料', '資材・備品', '制作費', '外注費', '広告宣伝費', '通信費', '手数料', '雑費']
export const INCOME_CATEGORIES = ['売上（その他）', '雑収入']

export const KIND_LABEL = { income: '収入', expense: '支出' } as const

type Source = Pick<View, 'sales' | 'activeStockEvents' | 'products' | 'ledger' | 'hubs' | 'pools' | 'basePools'>

/** 未設定の行をまとめるキー（プールの絞り込みで使う） */
export const NO_POOL = 'none'

/**
 * 店頭の会計の反映先プール。会計時に記録したプールがあればそれ、無ければ（以前の会計や、未設定だったとき）
 * 今のハブ（またはベース）の設定から決める。オンラインの注文はどのハブにも属さないので未設定
 */
function salePool(s: Sale, { hubs, basePools }: Pick<Source, 'hubs' | 'basePools'>): string | null {
  if (s.poolId) return s.poolId
  if (s.channel === 'online') return null
  const pools = s.remoteEvent ? hubs.find((h) => h.hub.eventId === s.remoteEvent)?.hub.pools : basePools
  return pools?.[s.payment === 'cash' ? 'cash' : 'cashless'] ?? null
}

export function collectFlows({ sales, activeStockEvents, products, ledger, hubs, pools, basePools }: Source): Flow[] {
  const live = new Set(pools.map((p) => p.id))
  const pool = (id: string | null | undefined) => (id && live.has(id) ? id : null)
  const flows: Flow[] = []
  const push = (id: string, date: string, kind: Flow['kind'], category: string, amount: number, memo: string, poolId: string | null = null) => {
    if (amount > 0) flows.push({ id, date, kind, category, amount, auto: true, memo, poolId })
  }

  for (const s of sales) {
    if (s.voided) continue
    const date = dayKey(s.at)
    const online = s.channel === 'online'
    const p = pool(salePool(s, { hubs, basePools }))
    push(`${s.id}:sale`, date, 'income', online ? AUTO.onlineSales : AUTO.storeSales, s.total, online ? `${s.online?.shop ?? ''} ${s.online?.orderNo ?? ''}`.trim() : `伝票 ${s.receiptNo}`, p)
    // キャッシュレスの手数料は、売上と同じプールから引かれる（入金額が手数料の分だけ少ない）
    push(`${s.id}:fee`, date, 'expense', AUTO.paymentFee, s.paymentFee ?? 0, `伝票 ${s.receiptNo}`, p)
    if (s.online) {
      const ref = `${s.online.shop} ${s.online.orderNo}`.trim()
      push(`${s.id}:onlineFee`, date, 'expense', AUTO.onlineFee, s.online.fee, ref)
      push(`${s.id}:shipping`, date, 'expense', AUTO.shippingCost, s.online.shippingCost, ref)
    }
  }

  const byId = new Map(products.map((p) => [p.id, p]))
  for (const e of activeStockEvents) {
    if ((e.reason !== 'restock' && e.reason !== 'initial') || e.delta <= 0) continue
    const p = byId.get(e.productId)
    const unit = e.unitCost ?? p?.cost ?? 0
    const name = p ? [p.name, p.type, p.size].filter(Boolean).join(' ') : '（削除された商品）'
    push(e.id, dayKey(e.at), 'expense', e.reason === 'restock' ? AUTO.restock : AUTO.initial, e.delta * unit, `${name} ×${e.delta}${e.note ? `（${e.note}）` : ''}`)
  }

  for (const x of ledger) {
    flows.push({ id: x.id, date: x.date, kind: x.kind, category: x.category || '未分類', amount: x.amount, auto: false, memo: x.memo, poolId: pool(x.poolId) })
  }
  return flows.sort((a, b) => a.date.localeCompare(b.date))
}

/** 在庫の仕入（入荷・初期在庫）から自動で作った支出か */
export const isPurchase = (f: Flow) => f.auto && (f.category === AUTO.restock || f.category === AUTO.initial)

export type Totals = { income: number; expense: number; net: number }

export function totals(flows: Flow[]): Totals {
  let income = 0
  let expense = 0
  for (const f of flows) {
    if (f.kind === 'income') income += f.amount
    else expense += f.amount
  }
  return { income, expense, net: income - expense }
}

/** プールごとの合計（プールの登録順。未設定は NO_POOL で最後） */
export function byPool(flows: Flow[], pools: View['pools']) {
  const m = new Map<string, Totals>([...pools.map((p) => [p.id, { income: 0, expense: 0, net: 0 }] as const)])
  for (const f of flows) {
    const k = f.poolId ?? NO_POOL
    const cur = m.get(k) ?? { income: 0, expense: 0, net: 0 }
    if (f.kind === 'income') cur.income += f.amount
    else cur.expense += f.amount
    cur.net = cur.income - cur.expense
    m.set(k, cur)
  }
  return m
}

/** 科目ごとの合計（大きい順） */
export function byCategory(flows: Flow[], kind: Flow['kind']) {
  const m = new Map<string, { category: string; amount: number; auto: boolean }>()
  for (const f of flows) {
    if (f.kind !== kind) continue
    const key = `${f.auto ? 'a' : 'm'}:${f.category}`
    const cur = m.get(key) ?? { category: f.category, amount: 0, auto: f.auto }
    cur.amount += f.amount
    m.set(key, cur)
  }
  return [...m.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.amount - a.amount)
}

/** 月ごとの合計（YYYY-MM の古い順。記録の無い月も 0 で埋める） */
export function byMonth(flows: Flow[], from: string, to: string) {
  const months: string[] = []
  if (from && to) {
    let y = Number(from.slice(0, 4))
    let m = Number(from.slice(5, 7))
    const end = to.slice(0, 7)
    for (;;) {
      const key = `${y}-${String(m).padStart(2, '0')}`
      months.push(key)
      if (key >= end || months.length > 240) break
      if (++m > 12) (m = 1), y++
    }
  }
  const map = new Map(months.map((k) => [k, { month: k, income: 0, expense: 0 }]))
  for (const f of flows) {
    const k = f.date.slice(0, 7)
    const row = map.get(k) ?? { month: k, income: 0, expense: 0 }
    if (f.kind === 'income') row.income += f.amount
    else row.expense += f.amount
    map.set(k, row)
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ ...r, net: r.income - r.expense }))
}
