import type { DiscountRule, DiscountTarget } from './types'

/**
 * 割引の計算。レジの表示と会計（store.checkout）の両方で同じ関数を使う。
 *
 * 1. 商品割引・まとめ買い（行に付く割引）
 *    1つの商品行に付く割引は1つだけ。お客様に一番得になるものから順に確定していく。
 * 2. 会計割引（合計に付く割引）
 *    行の割引を引いた後の金額で条件を判定し、一番得になるものを1つだけ適用。
 * 3. 手入力の値引き（円 or %）を最後に引く。
 *
 * 割引額の端数は切り捨て（1円未満はお客様に不利にならない方向ではなく、割引額を切り捨て）。
 */

export type CalcLine = {
  productId: string
  name: string
  category: string
  type: string
  size: string
  price: number
  qty: number
}

export type AppliedDiscount = {
  ruleId: string | null
  name: string
  amount: number
  /** 行に付く割引の内訳（productId → 割引額） */
  lines: Record<string, number>
}

export type ManualDiscount = { kind: 'yen' | 'percent'; value: number }

export type DiscountOptions = {
  /** 自動適用のルールのうち、この会計では外すもの */
  disabled: ReadonlySet<string>
  /** 手動適用のルールのうち、この会計で使うもの */
  manualOn: ReadonlySet<string>
  manual: ManualDiscount
  now?: Date
}

export type DiscountResult = {
  subtotal: number
  applied: AppliedDiscount[]
  /** productId → その行に付いた割引額 */
  lineDiscount: Map<string, number>
  totalDiscount: number
  total: number
  /** 条件未達などで今は効いていないが、対象になりうるルール（レジでのヒント表示用） */
  available: DiscountRule[]
}

export const MANUAL_NAME = '手入力の値引き'

export function isInPeriod(r: DiscountRule, now = new Date()) {
  if (r.startAt && now < new Date(r.startAt)) return false
  if (r.endAt && now > new Date(r.endAt)) return false
  return true
}

export function isLive(r: DiscountRule, now = new Date()) {
  return !r.deleted && r.enabled && isInPeriod(r, now)
}

export function matchesTarget(t: DiscountTarget, l: Pick<CalcLine, 'productId' | 'category' | 'type' | 'size'>) {
  switch (t.scope) {
    case 'all':
      return true
    case 'product':
      return t.values.includes(l.productId)
    case 'category':
      return t.values.includes(l.category)
    case 'type':
      return t.values.includes(l.type)
    case 'size':
      return t.values.includes(l.size)
  }
}

/** 行に付く割引ルール1つを、指定の行に適用したときの割引額（行ごと） */
function lineRuleAmount(rule: DiscountRule, lines: CalcLine[]): Record<string, number> {
  const target = lines.filter((l) => matchesTarget(rule.target, l))
  const out: Record<string, number> = {}
  if (!target.length) return out
  const v = Math.max(0, rule.value)

  const perUnit = (l: CalcLine) =>
    rule.valueType === 'percent' ? Math.floor((l.price * l.qty * Math.min(100, v)) / 100) : Math.min(v, l.price) * l.qty

  if (rule.kind === 'item') {
    for (const l of target) out[l.productId] = perUnit(l)
    return out
  }

  // まとめ買い
  const totalQty = target.reduce((a, l) => a + l.qty, 0)
  const minQty = Math.max(1, rule.minQty)
  if (totalQty < minQty) return out

  if (rule.valueType !== 'setPrice') {
    for (const l of target) out[l.productId] = perUnit(l)
    return out
  }

  // 「N個で X 円」：単価の高いものから N 個ずつ組にする（お客様に一番得）
  const units = target.flatMap((l) => Array.from({ length: l.qty }, () => l)).sort((a, b) => b.price - a.price)
  const sets = Math.floor(units.length / minQty)
  const used = units.slice(0, sets * minQty)
  const normal = used.reduce((a, l) => a + l.price, 0)
  const amount = normal - sets * v
  if (amount <= 0) return out
  // 行ごとの内訳は、組に入った金額の比率で按分（端数は最後の行へ）
  const contrib = new Map<string, number>()
  for (const l of used) contrib.set(l.productId, (contrib.get(l.productId) ?? 0) + l.price)
  let rest = amount
  const entries = [...contrib]
  entries.forEach(([pid, c], i) => {
    const a = i === entries.length - 1 ? rest : Math.floor((amount * c) / normal)
    out[pid] = a
    rest -= a
  })
  return out
}

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

export function computeDiscounts(lines: CalcLine[], rules: DiscountRule[], opts: DiscountOptions): DiscountResult {
  const now = opts.now ?? new Date()
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0)
  const live = rules.filter((r) => isLive(r, now))
  const usable = live.filter((r) => (r.mode === 'auto' ? !opts.disabled.has(r.id) : opts.manualOn.has(r.id)))

  const applied: AppliedDiscount[] = []
  const lineDiscount = new Map<string, number>()

  // 1. 行に付く割引：得なものから確定。確定した行は他の割引の対象から外す
  let remaining = lines.filter((l) => l.qty > 0)
  let candidates = usable.filter((r) => r.kind === 'item' || r.kind === 'bundle')
  for (;;) {
    let best: { rule: DiscountRule; lines: Record<string, number>; amount: number } | null = null
    for (const rule of candidates) {
      const res = lineRuleAmount(rule, remaining)
      const amount = sum(res)
      if (amount > 0 && (!best || amount > best.amount)) best = { rule, lines: res, amount }
    }
    if (!best) break
    applied.push({ ruleId: best.rule.id, name: best.rule.name, amount: best.amount, lines: best.lines })
    for (const [pid, a] of Object.entries(best.lines)) lineDiscount.set(pid, (lineDiscount.get(pid) ?? 0) + a)
    const usedIds = new Set(Object.keys(best.lines))
    remaining = remaining.filter((l) => !usedIds.has(l.productId))
    candidates = candidates.filter((r) => r !== best!.rule)
  }

  // 2. 会計割引：一番得なもの1つ
  const afterLines = subtotal - sum(Object.fromEntries(lineDiscount))
  let bestOrder: { rule: DiscountRule; amount: number } | null = null
  for (const rule of usable.filter((r) => r.kind === 'order')) {
    if (afterLines < rule.minSubtotal || afterLines <= 0) continue
    const v = Math.max(0, rule.value)
    const amount = rule.valueType === 'percent' ? Math.floor((afterLines * Math.min(100, v)) / 100) : Math.min(v, afterLines)
    if (amount > 0 && (!bestOrder || amount > bestOrder.amount)) bestOrder = { rule, amount }
  }
  if (bestOrder) applied.push({ ruleId: bestOrder.rule.id, name: bestOrder.rule.name, amount: bestOrder.amount, lines: {} })

  // 3. 手入力の値引き
  const beforeManual = afterLines - (bestOrder?.amount ?? 0)
  const mv = Math.max(0, opts.manual.value || 0)
  const manualAmount = Math.min(
    beforeManual,
    opts.manual.kind === 'percent' ? Math.floor((beforeManual * Math.min(100, mv)) / 100) : Math.round(mv),
  )
  if (manualAmount > 0) applied.push({ ruleId: null, name: MANUAL_NAME, amount: manualAmount, lines: {} })

  const totalDiscount = applied.reduce((a, d) => a + d.amount, 0)

  // ヒント：対象商品はカートにあるが、条件未達・外した・手動で未使用のルール
  const appliedIds = new Set(applied.map((a) => a.ruleId))
  const available = live.filter(
    (r) =>
      !appliedIds.has(r.id) &&
      (r.kind === 'order' ? lines.length > 0 : lines.some((l) => matchesTarget(r.target, l))),
  )

  return { subtotal, applied, lineDiscount, totalDiscount, total: subtotal - totalDiscount, available }
}

/** ルールの内容を短い文章に（一覧・レジでの表示用） */
export function describeRule(r: DiscountRule, targetLabel: string) {
  const v = r.valueType === 'percent' ? `${r.value}%オフ` : r.valueType === 'setPrice' ? `${r.value.toLocaleString()}円` : `${r.value.toLocaleString()}円引き`
  if (r.kind === 'item') return `${targetLabel}：${r.valueType === 'yen' ? `1点につき${v}` : v}`
  if (r.kind === 'bundle') {
    if (r.valueType === 'setPrice') return `${targetLabel}：${r.minQty}点で${v}`
    return `${targetLabel}：${r.minQty}点以上で${r.valueType === 'yen' ? `1点につき${v}` : v}`
  }
  return r.minSubtotal > 0 ? `${r.minSubtotal.toLocaleString()}円以上のお会計で${v}` : `お会計から${v}`
}
