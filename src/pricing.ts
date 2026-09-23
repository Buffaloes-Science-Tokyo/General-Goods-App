import { matchesTarget } from './discounts'
import type { DiscountRule, FeeSettings, Product, ShopFee } from './types'

/**
 * 「最悪の場合でも粗利を下回らない最低額（最低販売価格）」の計算。
 *
 * 1点を価格 p で売ったときの最悪の粗利：
 *   p − 平均原価 − 追加コスト − p × 手数料率 − 注文ごとの固定手数料
 * これが「最低限残す粗利（円 + p × %）」以上になる最小の p が最低額：
 *   p ≥ (平均原価 + 追加コスト + 固定手数料 + 最低粗利円) ÷ (1 − 手数料率 − 最低粗利%)
 *
 * 店頭とオンラインそれぞれで計算し、高い方（厳しい方）を採用する。
 * - 店頭：キャッシュレスの手数料率（現金より不利なため）＋ レジ用の追加コスト
 * - オンライン：登録したショップのうち一番不利な手数料率・固定額（1点だけの注文を想定）＋ オンライン用の追加コスト
 *   （ショップを1つも登録していなければ、オンラインは計算しない）
 */

export const DEFAULT_FEES: FeeSettings = { cashlessRate: 0, shops: [], minProfitYen: 0, minProfitPercent: 0 }

export type Floor = {
  /** 最低額（円・切り上げ）。成り立たない場合は Infinity */
  price: number
  /** どちらの売り方で決まったか */
  channel: 'store' | 'online'
  /** 内訳（表示用） */
  cost: number
  extra: number
  rate: number
  fixed: number
}

export function worstShop(fees: FeeSettings): ShopFee | null {
  if (!fees.shops.length) return null
  return {
    name: fees.shops.reduce((a, s) => (s.rate > a.rate ? s : a)).name,
    rate: Math.max(...fees.shops.map((s) => s.rate)),
    fixed: Math.max(...fees.shops.map((s) => s.fixed)),
  }
}

/** 名前が一致するショップの手数料（大文字小文字・前後の空白は無視） */
export function shopFeeOf(fees: FeeSettings, shop: string): ShopFee | null {
  const key = shop.trim().toLowerCase()
  return fees.shops.find((s) => s.name.trim().toLowerCase() === key) ?? null
}

export function floorPrice(p: Product, avgCost: number, fees: FeeSettings): Floor {
  const minPct = Math.max(0, fees.minProfitPercent) / 100
  const calc = (channel: Floor['channel'], extra: number, ratePct: number, fixed: number): Floor => {
    const denom = 1 - ratePct / 100 - minPct
    const numer = avgCost + extra + fixed + Math.max(0, fees.minProfitYen)
    return { price: denom <= 0 ? Infinity : Math.ceil(numer / denom), channel, cost: avgCost, extra, rate: ratePct, fixed }
  }
  const store = calc('store', p.extraCostStore ?? 0, fees.cashlessRate, 0)
  const shop = worstShop(fees)
  if (!shop) return store
  const online = calc('online', p.extraCostOnline ?? 0, shop.rate, shop.fixed)
  return online.price > store.price ? online : store
}

export const CHANNEL_LABEL = { store: 'レジ（キャッシュレス）', online: 'オンライン' } as const

// ---------- 割引ルールのチェック ----------

export type RuleCheckRow = {
  product: Product
  /** 割引後の1点あたりの価格（最悪の場合） */
  after: number
  floor: Floor
}

export type RuleCheck = {
  rows: RuleCheckRow[]
  /** 最低額を下回る商品 */
  below: RuleCheckRow[]
  /**
   * 最低額を下回らない、割引の値の上限（%・円引き）または下限（N点で◯円）。
   * 対象が無い・計算できない場合は null。
   */
  limit: number | null
  /** limit が上限か下限か */
  limitKind: 'max' | 'min'
}

/**
 * 割引1つだけが付いたときに、対象商品の価格が最低額を下回らないかを調べる。
 * （他の割引と重なった場合は含まない）
 */
export function checkRule(
  rule: Pick<DiscountRule, 'kind' | 'target' | 'valueType' | 'value' | 'minQty' | 'minSubtotal'>,
  products: Product[],
  avgCostOf: (p: Product) => number,
  fees: FeeSettings,
): RuleCheck {
  const targets = products.filter((p) => p.active && (rule.kind === 'order' || matchesTarget(rule.target, { ...p, productId: p.id })))
  const v = Math.max(0, rule.value)

  // 1点あたり、割引後の価格（最悪の場合）
  const afterOf = (p: Product): number => {
    if (rule.kind === 'bundle' && rule.valueType === 'setPrice') return v / Math.max(1, rule.minQty)
    if (rule.valueType === 'percent') return p.price - Math.floor((p.price * Math.min(100, v)) / 100)
    if (rule.kind === 'order') {
      // 会計割引の円引き：条件ぎりぎりの会計（または1点だけの会計）に全額かかった場合
      const base = Math.max(rule.minSubtotal, p.price)
      return p.price - (Math.min(v, base) * p.price) / base
    }
    return p.price - Math.min(v, p.price)
  }

  const rows = targets.map((p) => ({ product: p, after: afterOf(p), floor: floorPrice(p, avgCostOf(p), fees) }))
  const below = rows.filter((r) => r.after < r.floor.price)

  let limit: number | null = null
  let limitKind: RuleCheck['limitKind'] = 'max'
  const finite = rows.filter((r) => Number.isFinite(r.floor.price) && r.product.price > 0)
  if (finite.length) {
    if (rule.kind === 'bundle' && rule.valueType === 'setPrice') {
      limitKind = 'min'
      limit = Math.max(1, rule.minQty) * Math.max(...finite.map((r) => r.floor.price))
    } else if (rule.valueType === 'percent') {
      limit = Math.max(0, Math.min(...finite.map((r) => Math.floor(((r.product.price - r.floor.price) / r.product.price) * 100))))
    } else if (rule.kind === 'order') {
      // 余裕の割合が一番小さい商品で、条件ぎりぎりの会計を想定
      limit = Math.max(
        0,
        Math.min(...finite.map((r) => Math.floor((Math.max(rule.minSubtotal, r.product.price) * (r.product.price - r.floor.price)) / r.product.price))),
      )
    } else {
      limit = Math.max(0, Math.min(...finite.map((r) => r.product.price - r.floor.price)))
    }
  }
  return { rows, below, limit, limitKind }
}
