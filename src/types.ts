// 同期されるレコード（クライアント・サーバー共通）

export type Product = {
  id: string
  name: string
  category: string
  /** タイプ（例：ブラック、通常版、キャラA）。無ければ空文字 */
  type: string
  /** サイズ（例：M、L、F）。無ければ空文字 */
  size: string
  /** 販売価格（税込・円） */
  price: number
  /**
   * 登録時の原価（円）。入荷記録に仕入単価が無いときの基準値。
   * 実際の原価は入荷ごとの仕入単価から移動平均で計算する（costing.ts）
   */
  cost: number
  /** 最悪の場合の追加コスト（1点あたり・円）：レジで売るとき（袋など） */
  extraCostStore?: number
  /** 最悪の場合の追加コスト（1点あたり・円）：オンラインで売るとき（梱包材など） */
  extraCostOnline?: number
  /** この数以下で「残りわずか」表示 */
  lowStock: number
  sku: string
  /** false でレジに表示しない */
  active: boolean
  /** 削除済み（同期のため物理削除はしない） */
  deleted: boolean
  updatedAt: string
}

/** online = オンラインショップ側で決済済み */
export type PaymentMethod = 'cash' | 'cashless' | 'online'

export type SalesChannel = 'store' | 'online'

/** オンラインショップの注文情報（channel = 'online' の販売に付く） */
export type OnlineOrderInfo = {
  /** ショップ名（BASE、BOOTH など） */
  shop: string
  /** ショップ側の注文番号 */
  orderNo: string
  customer: string
  /** お客様から受け取った送料（売上に含む） */
  shipping: number
  /** 販売・決済手数料（粗利から引く） */
  fee: number
  /** 発送にかかった実費（粗利から引く） */
  shippingCost: number
  status: 'unshipped' | 'shipped'
  shippedAt: string | null
  note: string
}

export type SaleItem = {
  productId: string
  name: string
  category: string
  /** 会計時点のタイプ・サイズ（以前のデータには無い） */
  type?: string
  size?: string
  price: number
  /** 会計した端末での、その時点の平均原価（参考値。集計は costing.ts で再計算した値を使う） */
  cost: number
  qty: number
  /** この行に付いた割引額（商品割引・まとめ買い。会計割引・手入力の値引きは含まない） */
  discount?: number
}

/** 会計に適用された割引の記録 */
export type SaleDiscount = {
  /** 割引ルールの ID（手入力の値引きは null） */
  ruleId: string | null
  name: string
  amount: number
}

export type Sale = {
  id: string
  /** 伝票番号（端末コード-連番。例: A3-0012） */
  receiptNo: string
  /** 店頭 or オンライン（以前のデータは店頭） */
  channel?: SalesChannel
  /** ハブ（ベース以外）のレジで会計したとき、そのハブの集計ID（StockHub.eventId） */
  remoteEvent?: string
  online?: OnlineOrderInfo
  at: string
  deviceId: string
  items: SaleItem[]
  subtotal: number
  /** 割引の合計 */
  discount: number
  /** 割引の内訳（以前のデータには無い） */
  discounts?: SaleDiscount[]
  /** お客様の支払額（オンラインは送料込み） */
  total: number
  /** 店頭の会計手数料（キャッシュレス決済の手数料。会計時の料率で計算） */
  paymentFee?: number
  payment: PaymentMethod
  received: number
  change: number
  voided: boolean
  updatedAt: string
}

/**
 * revalue = 原価の修正（数量は変えず、平均原価を指定値にする）
 * cancel = 誤って記録した入荷・棚卸しなどの取り消し（cancels の記録を無かったことにする。数量は 0）
 */
export type StockReason = 'initial' | 'sale' | 'restock' | 'adjust' | 'void' | 'revalue' | 'cancel'

/** 在庫の増減記録。在庫数はこの合計で決まる（端末間で競合しない） */
export type StockEvent = {
  id: string
  productId: string
  at: string
  delta: number
  /** 仕入単価（initial / restock）または修正後の原価（revalue）。それ以外は null */
  unitCost?: number | null
  reason: StockReason
  note: string
  saleId: string | null
  deviceId: string
  /**
   * 取り消す（置き換える）記録のID。記録は消さずに追記だけで同期するため、訂正はこの形で表す。
   * - reason が cancel：その記録の取り消し
   * - それ以外：その記録の修正版（at は元の記録と同じ時刻にして、原価計算の順序を保つ）
   */
  cancels?: string | null
}

/** 割引の対象（すべて／商品／カテゴリ／タイプ／サイズ） */
export type DiscountTarget = {
  scope: 'all' | 'product' | 'category' | 'type' | 'size'
  /** product なら商品ID、それ以外は値の名前 */
  values: string[]
}

export type DiscountRule = {
  id: string
  name: string
  /** item = 商品割引 / bundle = まとめ買い / order = 会計割引 */
  kind: 'item' | 'bundle' | 'order'
  /** item・bundle の対象商品 */
  target: DiscountTarget
  /** percent = %オフ / yen = 円引き / setPrice = N点で◯円（bundle のみ） */
  valueType: 'percent' | 'yen' | 'setPrice'
  value: number
  /** bundle：この点数以上（setPrice ならこの点数ごと） */
  minQty: number
  /** order：この金額以上 */
  minSubtotal: number
  /** auto = 条件を満たすと自動で適用 / manual = レジで選んだときだけ適用 */
  mode: 'auto' | 'manual'
  enabled: boolean
  /** 有効期間（ISO 文字列。null なら制限なし） */
  startAt: string | null
  endAt: string | null
  deleted: boolean
  updatedAt: string
}

/** オンラインショップごとの手数料 */
export type ShopFee = {
  name: string
  /** 売上に対する % */
  rate: number
  /** 注文ごとの固定額（円） */
  fixed: number
}

export type FeeSettings = {
  /** キャッシュレス決済の手数料（%） */
  cashlessRate: number
  shops: ShopFee[]
  /** 割引の最低額を計算するときに、最低限残す粗利（1点あたり） */
  minProfitYen: number
  minProfitPercent: number
}

/**
 * 棚卸しハブ（全端末で共有）。物販の会場など、在庫を持ち出す先。
 * ベース（すべての在庫）はハブの一覧には含めず、変更できない。
 * レジでハブを選ぶと、そのハブに持ち出した商品だけを表示し、「持ち出し数 − このハブで売れた数」を超えては売れない。
 * 売れた分は通常どおり本体の在庫からも減る
 */
export type StockHub = {
  id: string
  name: string
  /** 商品ID → 持ち出し数 */
  allocations: Record<string, number>
  /** 売れた数を数える区切りのID。「売れた数をリセット」で新しくなり、その後の会計だけを数える */
  eventId: string
}

/**
 * 以前の遠方物販の設定（全端末で共有）。hubs が無いデータでは、これを1つのハブとして読み込む。
 * 商品ごとに持ち出し数を決め、遠方モード中のレジではその商品だけを表示する。
 * 残り＝持ち出し数 − この物販で売れた数（取消は戻る）。売れた分は通常どおり本体の在庫からも減る
 */
export type RemoteSettings = {
  /** 遠方モード中か */
  active: boolean
  /** 物販ごとの ID。開始するたびに新しくなり、売れた数はこの ID の会計だけで数える */
  eventId: string
  /** 物販の名前（例：大阪イベント） */
  name: string
  /** 商品ID → 持ち出し数 */
  allocations: Record<string, number>
}

export type ShopSettings = {
  shopName: string
  /** 以前のデータには無い */
  fees?: FeeSettings
  /** 以前のデータ。hubs に移したあとは使わない */
  remote?: RemoteSettings
  /** 棚卸しハブ（ベース以外）。以前のデータには無い */
  hubs?: StockHub[]
  updatedAt: string
}

export type SyncChanges = {
  products: Product[]
  sales: Sale[]
  stockEvents: StockEvent[]
  settings: ShopSettings | null
  /** 以前のクライアントは送ってこないので省略可 */
  discountRules?: DiscountRule[]
}

export type SyncRequest = {
  /** 前回受け取ったサーバー側の位置 */
  cursor: number
  changes: SyncChanges
}

export type SyncResponse = {
  cursor: number
  changes: SyncChanges
}
