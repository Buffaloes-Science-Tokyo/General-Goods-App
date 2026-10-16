import type { Product, Sale } from './types'

/**
 * 売上シミュレーション。今の在庫のうち何点売れるかを仮定して、売上・粗利・収支を見積もる。
 * 店頭（レジ）で定価で売ると仮定する（割引は考えない）。
 *
 * 1点あたりの手取り = 価格 − 追加コスト（袋など） − 価格 × キャッシュレス手数料率 × キャッシュレスの割合
 * 1点あたりの粗利   = 手取り − 平均原価
 * 「黒字」は、今の在庫の仕入額（在庫数 × 平均原価）を、売れた分の手取りで回収できること：
 *   黒字に必要な販売数 = 在庫の仕入額 ÷ 1点あたりの手取り（切り上げ）
 */

export type Assumptions = {
  /** キャッシュレスで払われる割合（0〜1） */
  cashlessShare: number
  /** キャッシュレス決済の手数料（%） */
  feeRate: number
}

export type UnitEconomics = {
  price: number
  /** 平均原価 */
  cost: number
  extra: number
  /** 1点あたりの手数料の見込み */
  fee: number
  /** 1点あたりの手取り（原価を引く前） */
  net: number
  /** 1点あたりの粗利 */
  profit: number
  stock: number
  /** 今の在庫の仕入額 */
  stockCost: number
  /** 黒字に必要な販売数。手取りが 0 以下で、いくら売っても回収できないときは null */
  breakEven: number | null
  /** 在庫がすべて売れたときの粗利（= 在庫に対する収支） */
  fullProfit: number
}

export function unitEconomics(p: Product, cost: number, stock: number, a: Assumptions): UnitEconomics {
  const extra = Math.max(0, p.extraCostStore ?? 0)
  const fee = (p.price * Math.max(0, a.feeRate) * a.cashlessShare) / 100
  const net = p.price - extra - fee
  const stockCost = stock * cost
  // 浮動小数の誤差で 1 点多くならないよう、わずかに引いてから切り上げる
  const breakEven = stockCost <= 0 ? 0 : net > 0 ? Math.ceil(stockCost / net - 1e-9) : null
  return { price: p.price, cost, extra, fee, net, profit: net - cost, stock, stockCost, breakEven, fullProfit: stock * (net - cost) }
}

/** これまでの店頭の売上のうち、キャッシュレスの割合（金額ベース）。売上が無ければ null */
export function pastCashlessShare(sales: Sale[]): number | null {
  let all = 0
  let cashless = 0
  for (const s of sales) {
    if (s.voided || (s.channel ?? 'store') !== 'store') continue
    all += s.total
    if (s.payment === 'cashless') cashless += s.total
  }
  return all > 0 ? cashless / all : null
}
