import { saleCostKey, type Costing } from './costing'
import type { Sale } from './types'

/** 販売1件の売上原価（販売時点の移動平均原価。無ければ会計時に記録した原価） */
export function saleCogs(s: Sale, costing: Costing) {
  return s.items.reduce((a, i) => a + (costing.saleCost.get(saleCostKey(s.id, i.productId)) ?? i.cost) * i.qty, 0)
}

/** 販売にかかった経費：店頭のキャッシュレス手数料、オンラインの手数料＋発送の実費 */
export const saleExpenses = (s: Sale) =>
  (s.paymentFee ?? 0) + (s.online ? Math.max(0, s.online.fee) + Math.max(0, s.online.shippingCost) : 0)

/** 粗利 = お客様の支払額 − 売上原価 − 経費（会計手数料など） */
export const saleProfit = (s: Sale, costing: Costing) => s.total - saleCogs(s, costing) - saleExpenses(s)

export const channelOf = (s: Sale) => s.channel ?? 'store'

/** 「店頭」または オンラインのショップ名 */
export const channelLabel = (s: Sale) => (channelOf(s) === 'online' ? s.online?.shop || 'オンライン' : '店頭')

export const PAYMENT_LABEL = { cash: '現金', cashless: 'キャッシュレス', online: 'オンライン決済' } as const
