import type { Product, StockEvent } from './types'

/**
 * 移動平均法による原価計算。
 * 在庫の増減記録を時刻順に再生して、商品ごとの平均原価と、各販売時点の原価を求める。
 * 記録は全端末で同じものが同期されるので、どの端末で計算しても（同期後は）同じ結果になる。
 *
 * - 入荷（initial / restock）: (在庫 × 平均原価 + 入荷数 × 仕入単価) ÷ (在庫 + 入荷数)
 *   在庫が 0 以下だった場合は仕入単価がそのまま平均原価になる
 * - 原価修正（revalue）: 平均原価を指定値に置き換える
 * - 販売・調整・取消戻し: 数量だけ変わり、平均原価は変わらない
 */

export type CostInfo = {
  /** 現在の平均原価 */
  avg: number
  /** 直近の仕入単価（記録が無ければ null） */
  lastCost: number | null
  stock: number
}

export type Costing = {
  byProduct: Map<string, CostInfo>
  /** `${saleId}:${productId}` → 販売時点の平均原価 */
  saleCost: Map<string, number>
}

export const saleCostKey = (saleId: string, productId: string) => `${saleId}:${productId}`

/** events は時刻順に並んでいること */
export function computeCosting(events: StockEvent[], products: Record<string, Product>): Costing {
  const byProduct = new Map<string, CostInfo>()
  const saleCost = new Map<string, number>()
  const get = (id: string) => {
    let c = byProduct.get(id)
    if (!c) {
      c = { avg: products[id]?.cost ?? 0, lastCost: null, stock: 0 }
      byProduct.set(id, c)
    }
    return c
  }

  for (const e of events) {
    const c = get(e.productId)
    const uc = e.unitCost ?? null
    if ((e.reason === 'initial' || e.reason === 'restock') && e.delta > 0) {
      const cost = uc ?? c.avg
      c.avg = c.stock > 0 ? (c.avg * c.stock + cost * e.delta) / (c.stock + e.delta) : cost
      if (uc !== null) c.lastCost = uc
    } else if (e.reason === 'revalue') {
      if (uc !== null) c.avg = uc
    } else if (e.reason === 'sale' && e.saleId) {
      saleCost.set(saleCostKey(e.saleId, e.productId), c.avg)
    }
    c.stock += e.delta
  }

  // 記録の無い商品は登録時の原価
  for (const p of Object.values(products)) get(p.id)
  return { byProduct, saleCost }
}

/** 入荷した場合の平均原価の見込み */
export function previewAvg(info: CostInfo, qty: number, unitCost: number) {
  if (qty <= 0) return info.avg
  return info.stock > 0 ? (info.avg * info.stock + unitCost * qty) / (info.stock + qty) : unitCost
}
