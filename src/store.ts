import { useSyncExternalStore } from 'react'
import { get as idbGet, set as idbSet } from 'idb-keyval'
import type {
  DiscountRule,
  FeeSettings,
  LedgerEntry,
  OnlineOrderInfo,
  PaymentMethod,
  Product,
  StockHub,
  Sale,
  SaleItem,
  ShopSettings,
  StockEvent,
  StockReason,
  SyncChanges,
} from './types'
import { computeCosting, type Costing } from './costing'
import { compareSize, fullName } from './format'
import { computeDiscounts, type DiscountOptions } from './discounts'
import { DEFAULT_FEES } from './pricing'

/**
 * ローカルファーストのストア。
 * すべての操作はまず端末（IndexedDB）に保存され、変更は outbox に積まれる。
 * sync.ts がオンライン時に outbox をクラウドへ送り、他端末の変更を受け取って merge する。
 */

type Outbox = { products: string[]; sales: string[]; stockEvents: string[]; discountRules: string[]; ledger: string[]; settings: boolean }

export type LocalState = {
  schema: 2
  products: Record<string, Product>
  sales: Record<string, Sale>
  stockEvents: Record<string, StockEvent>
  discountRules: Record<string, DiscountRule>
  /** 会計アプリの収支の記録（会計アプリでログインした端末だけが同期する） */
  ledger: Record<string, LedgerEntry>
  settings: ShopSettings
  /** この端末の情報（同期しない）。hubId = この端末のレジで選んでいるハブ（無ければベース） */
  device: { id: string; code: string; nextReceipt: number; hubId?: string }
  outbox: Outbox
  /** 同期設定（同期しない） */
  sync: { cursor: number; token: string; lastSyncAt: string | null }
}

const IDB_KEY = 'goods-selling:state'
const EPOCH = '1970-01-01T00:00:00.000Z'

export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

const randomCode = () => {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return c[Math.floor(Math.random() * c.length)] + c[Math.floor(Math.random() * c.length)]
}

const emptyOutbox = (): Outbox => ({ products: [], sales: [], stockEvents: [], discountRules: [], ledger: [], settings: false })

const emptyState = (): LocalState => ({
  schema: 2,
  products: {},
  sales: {},
  stockEvents: {},
  discountRules: {},
  ledger: {},
  settings: { shopName: 'グッズ物販', updatedAt: EPOCH },
  device: { id: uid(), code: randomCode(), nextReceipt: 1 },
  outbox: emptyOutbox(),
  sync: { cursor: 0, token: '', lastSyncAt: null },
})

let state: LocalState = emptyState()
const listeners = new Set<() => void>()
let persistError: string | null = null
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('goods-selling') : null

function notify() {
  listeners.forEach((l) => l())
}

function commit(next: LocalState) {
  state = next
  notify()
  idbSet(IDB_KEY, next)
    .then(() => {
      persistError = null
      channel?.postMessage('changed')
    })
    .catch((e: unknown) => {
      persistError = e instanceof Error ? e.message : String(e)
      notify()
    })
}

function isState(v: unknown): v is LocalState {
  return !!v && typeof v === 'object' && (v as LocalState).schema === 2
}

async function readPersisted(): Promise<LocalState | null> {
  const saved: unknown = await idbGet(IDB_KEY)
  if (!isState(saved)) return null
  // 以前のバージョンで保存したデータに無い項目を補う
  // 以前の「合言葉」がそのまま入っている場合はログイン済みとみなさず、パスワードでのログインを求める
  const sync = isSessionToken(saved.sync.token) ? saved.sync : { ...saved.sync, token: '' }
  return { ...emptyState(), ...saved, sync, discountRules: saved.discountRules ?? {}, ledger: saved.ledger ?? {}, outbox: { ...emptyOutbox(), ...saved.outbox } }
}

/** ログインで受け取るトークンの形式（発行時刻.署名）か */
export const isSessionToken = (token: string) => /^\d+\.[A-Za-z0-9_-]+$/.test(token)

/** 起動時に IndexedDB から読み込む */
export async function initStore() {
  try {
    const saved = await readPersisted()
    if (saved) state = saved
    else commit(state) // 端末IDを確定させる
  } catch (e) {
    persistError = e instanceof Error ? e.message : String(e)
  }
  // 同じ端末の別タブで変更があれば読み直す
  channel?.addEventListener('message', async () => {
    const saved = await readPersisted()
    if (saved) {
      state = saved
      notify()
    }
  })
}

// ---------- 読み取り（派生ビュー） ----------

export type View = {
  products: Product[]
  sales: Sale[]
  /** すべての在庫記録（取り消されたものも含む。時刻順） */
  stockEvents: StockEvent[]
  /** 取り消し・修正された記録のID → それを取り消した（置き換えた）記録 */
  cancelledBy: Map<string, StockEvent>
  /** 取り消し・修正を反映した、在庫数・原価の計算に使う記録（時刻順） */
  activeStockEvents: StockEvent[]
  /** 収支の記録（削除済みを除く。日付の新しい順） */
  ledger: LedgerEntry[]
  /** 削除されていない割引ルール（作成順） */
  discountRules: DiscountRule[]
  stock: Map<string, number>
  /** 移動平均原価（商品別・販売時点別） */
  costing: Costing
  settings: ShopSettings
  /** 手数料・最低粗利の設定（未設定なら既定値） */
  fees: FeeSettings
  device: LocalState['device']
  sync: LocalState['sync']
  /** 棚卸しハブ（ベース以外）と、商品ごとの売れた数・残り（持ち出し数 − このハブで売れた数） */
  hubs: HubView[]
  /** この端末のレジで選んでいるハブ。ベースなら null */
  hub: HubView | null
  pending: number
  persistError: string | null
}

let viewCache: { src: LocalState; err: string | null; view: View } | null = null

function buildView(s: LocalState): View {
  const stock = new Map<string, number>()
  // 時刻 → ID の順で並べる（全端末で同じ順序にして、原価計算の結果をそろえる）
  const stockEvents = Object.values(s.stockEvents).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const { effective, cancelledBy } = resolveCorrections(stockEvents)
  for (const e of effective) stock.set(e.productId, (stock.get(e.productId) ?? 0) + e.delta)
  return {
    products: Object.values(s.products)
      .filter((p) => !p.deleted)
      // 以前のデータにはタイプ・サイズが無いので空文字で補う
      .map((p) => (p.type === undefined || p.size === undefined ? { ...p, type: p.type ?? '', size: p.size ?? '' } : p))
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category, 'ja') ||
          a.name.localeCompare(b.name, 'ja') ||
          a.type.localeCompare(b.type, 'ja') ||
          compareSize(a.size, b.size) ||
          a.sku.localeCompare(b.sku),
      ),
    sales: Object.values(s.sales).sort((a, b) => a.at.localeCompare(b.at)),
    stockEvents,
    cancelledBy,
    activeStockEvents: effective,
    ledger: Object.values(s.ledger)
      .filter((x) => !x.deleted)
      .sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt)),
    discountRules: Object.values(s.discountRules)
      .filter((r) => !r.deleted)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    stock,
    costing: computeCosting(effective, s.products),
    settings: s.settings,
    fees: { ...DEFAULT_FEES, ...s.settings.fees },
    device: s.device,
    sync: s.sync,
    ...buildHubs(s),
    pending:
      s.outbox.products.length +
      s.outbox.sales.length +
      s.outbox.stockEvents.length +
      s.outbox.discountRules.length +
      s.outbox.ledger.length +
      (s.outbox.settings ? 1 : 0),
    persistError,
  }
}

export type HubView = { hub: StockHub; left: Map<string, number>; sold: Map<string, number> }

/** ベースの名前（ハブを選んでいないとき＝すべての在庫） */
export const BASE_HUB_NAME = 'ベース'

/** ハブの一覧。以前の遠方物販の設定しか無いデータは、それを1つのハブとして扱う */
function hubsOf(settings: ShopSettings): StockHub[] {
  if (settings.hubs) return settings.hubs
  const r = settings.remote
  if (!r || (!r.eventId && !Object.keys(r.allocations).length)) return []
  const eventId = r.eventId || 'remote'
  return [{ id: eventId, name: r.name || '遠方物販', allocations: r.allocations, eventId }]
}

function buildHubs(s: LocalState): Pick<View, 'hubs' | 'hub'> {
  const hubs = hubsOf(s.settings).map((hub) => {
    const sold = hubSold(s, hub.eventId)
    const left = new Map(Object.entries(hub.allocations).map(([id, n]) => [id, n - (sold.get(id) ?? 0)]))
    return { hub, left, sold }
  })
  // 選んでいたハブが他の端末で削除されていたらベースに戻る
  return { hubs, hub: hubs.find((h) => h.hub.id === s.device.hubId) ?? null }
}

/** そのハブで売れた数（取り消した会計は除く） */
function hubSold(s: LocalState, eventId: string) {
  const sold = new Map<string, number>()
  for (const sale of Object.values(s.sales)) {
    if (sale.voided || sale.remoteEvent !== eventId) continue
    for (const i of sale.items) sold.set(i.productId, (sold.get(i.productId) ?? 0) + i.qty)
  }
  return sold
}


function getView(): View {
  if (!viewCache || viewCache.src !== state || viewCache.err !== persistError) {
    viewCache = { src: state, err: persistError, view: buildView(state) }
  }
  return viewCache.view
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useStore(): View {
  return useSyncExternalStore(subscribe, getView)
}

export const getState = () => state
export const pendingCount = () => getView().pending
export const subscribeStore = subscribe

// ---------- 書き込みヘルパー ----------

const now = () => new Date().toISOString()
const addId = (list: string[], id: string) => (list.includes(id) ? list : [...list, id])

function makeEvent(
  productId: string,
  delta: number,
  reason: StockReason,
  note: string,
  saleId: string | null = null,
  at = now(),
  unitCost: number | null = null,
): StockEvent {
  return { id: uid(), productId, at, delta, unitCost, reason, note, saleId, deviceId: state.device.id }
}

/**
 * 取り消し・修正を反映して、在庫数と原価の計算に使う記録だけを残す。
 * - 他の記録に cancels で指された記録は無効（取り消し・修正の前の値）
 * - 同じ記録を複数の端末で同時に訂正したときは、ID順で最初の訂正だけを有効にする（全端末で同じ結果になる）
 */
function resolveCorrections(events: StockEvent[]) {
  const cancelledBy = new Map<string, StockEvent>()
  for (const e of events) {
    if (!e.cancels) continue
    const w = cancelledBy.get(e.cancels)
    if (!w || e.id < w.id) cancelledBy.set(e.cancels, e)
  }
  const effective = events.filter((e) => !cancelledBy.has(e.id) && (!e.cancels || cancelledBy.get(e.cancels) === e))
  return { effective, cancelledBy }
}

function withEvents(s: LocalState, events: StockEvent[]): LocalState {
  const stockEvents = { ...s.stockEvents }
  const ids = [...s.outbox.stockEvents]
  for (const e of events) {
    stockEvents[e.id] = e
    ids.push(e.id)
  }
  return { ...s, stockEvents, outbox: { ...s.outbox, stockEvents: ids } }
}

function withProduct(s: LocalState, p: Product): LocalState {
  return {
    ...s,
    products: { ...s.products, [p.id]: p },
    outbox: { ...s.outbox, products: addId(s.outbox.products, p.id) },
  }
}

function withSale(s: LocalState, sale: Sale): LocalState {
  return {
    ...s,
    sales: { ...s.sales, [sale.id]: sale },
    outbox: { ...s.outbox, sales: addId(s.outbox.sales, sale.id) },
  }
}

export const stockOf = (id: string) => getView().stock.get(id) ?? 0

/** レジで売れる数。ハブを選んでいるときは持ち出し分の残りも上限になる（持ち出していない商品は 0） */
export function sellableOf(id: string) {
  const { stock, hub } = getView()
  const left = stock.get(id) ?? 0
  return hub ? Math.min(left, hub.left.get(id) ?? 0) : left
}
export const avgCostOf = (id: string) => getView().costing.byProduct.get(id)?.avg ?? state.products[id]?.cost ?? 0

// ---------- 商品 ----------

export type ProductInput = Omit<Product, 'id' | 'updatedAt' | 'deleted'>

export function addProduct(input: ProductInput, initialStock: number) {
  const p: Product = { ...input, id: uid(), deleted: false, updatedAt: now() }
  let next = withProduct(state, p)
  if (initialStock) next = withEvents(next, [makeEvent(p.id, initialStock, 'initial', '新規登録', null, now(), p.cost)])
  commit(next)
}

export function updateProduct(id: string, patch: Partial<ProductInput>) {
  const p = state.products[id]
  if (!p) return
  commit(withProduct(state, { ...p, ...patch, updatedAt: now() }))
}

export function deleteProduct(id: string) {
  const p = state.products[id]
  if (!p) return
  commit(withProduct(state, { ...p, deleted: true, updatedAt: now() }))
}

/** 入荷（仕入単価つき。平均原価が更新される） */
export function restock(id: string, qty: number, unitCost: number, note = '') {
  if (qty <= 0 || !state.products[id]) return
  commit(withEvents(state, [makeEvent(id, qty, 'restock', note, null, now(), Math.max(0, unitCost))]))
}

/** 在庫数の調整（平均原価は変わらない） */
export function adjustStock(id: string, delta: number, note = '') {
  if (!delta || !state.products[id]) return
  commit(withEvents(state, [makeEvent(id, delta, 'adjust', note)]))
}

/** 原価の修正（在庫数は変えず、平均原価を指定値にする。以降の販売の粗利に反映） */
export function revalueCost(id: string, unitCost: number, note = '') {
  if (!state.products[id] || unitCost < 0) return
  commit(withEvents(state, [makeEvent(id, 0, 'revalue', note || '原価修正', null, now(), unitCost)]))
}

/** 在庫数を実数に合わせる（棚卸し） */
export function setStock(id: string, actual: number, note = '棚卸し') {
  adjustStock(id, actual - stockOf(id), note)
}

/** あとから取り消し・修正できる記録（販売や取消戻しは販売履歴の側で取り消す） */
export const CORRECTABLE: ReadonlySet<StockReason> = new Set(['initial', 'restock', 'adjust', 'revalue'])

/** 取り消し・修正できるか（対象の種類で、まだ取り消されていない記録） */
export function isCorrectable(e: StockEvent) {
  return CORRECTABLE.has(e.reason) && !getView().cancelledBy.has(e.id)
}

/** 誤って記録した入荷・棚卸し・原価修正を取り消す（無かったことにして在庫数・平均原価を計算し直す） */
export function cancelStockEvent(id: string, note = '') {
  const e = state.stockEvents[id]
  if (!e || !isCorrectable(e)) return
  commit(withEvents(state, [{ ...makeEvent(e.productId, 0, 'cancel', note), cancels: id }]))
}

/** 記録の数量・単価を直す。元の記録を取り消し、同じ時刻に正しい値の記録を入れる */
export function correctStockEvent(id: string, fix: { delta: number; unitCost: number | null; note: string }) {
  const e = state.stockEvents[id]
  if (!e || !isCorrectable(e)) return
  const unitCost = fix.unitCost == null ? null : Math.max(0, fix.unitCost)
  commit(withEvents(state, [{ ...makeEvent(e.productId, fix.delta, e.reason, fix.note, null, e.at, unitCost), cancels: id }]))
}

/** その記録の直後の在庫数（取り消された記録は除いて数える） */
export function stockAfter(id: string) {
  const { stockEvents, cancelledBy } = getView()
  const target = state.stockEvents[id]
  if (!target) return 0
  let n = 0
  for (const e of stockEvents) {
    if (e.productId !== target.productId) continue
    if (e.id === id) return n + e.delta
    if (cancelledBy.has(e.id) || (e.cancels && cancelledBy.get(e.cancels) !== e)) continue
    n += e.delta
  }
  return n
}

// ---------- レジ ----------

export type CartLine = { productId: string; qty: number }
export type CheckoutResult = { ok: true; sale: Sale } | { ok: false; error: string }

/** 会計する。割引はレジの表示と同じ computeDiscounts で、この時点のルールで計算し直す */
export function checkout(
  cart: CartLine[],
  discountOpts: DiscountOptions,
  payment: PaymentMethod,
  received: number,
): CheckoutResult {
  const lines = cart.filter((c) => c.qty > 0)
  if (lines.length === 0) return { ok: false, error: 'カートが空です' }

  const items: SaleItem[] = []
  for (const line of lines) {
    const p = state.products[line.productId]
    if (!p || p.deleted) return { ok: false, error: '削除された商品がカートに含まれています' }
    const left = sellableOf(p.id)
    if (left < line.qty) return { ok: false, error: `「${fullName(p)}」の在庫が足りません（残り${left}）` }
    items.push({
      productId: p.id, name: p.name, category: p.category, type: p.type ?? '', size: p.size ?? '',
      price: p.price, cost: avgCostOf(p.id), qty: line.qty,
    })
  }

  const calc = computeDiscounts(items.map((i) => ({ ...i, type: i.type ?? '', size: i.size ?? '' })), getView().discountRules, discountOpts)
  const { subtotal, total } = calc
  // キャッシュレスは会計手数料がかかる（会計時の料率で記録）
  const fees = getView().fees
  const paymentFee = payment === 'cashless' ? Math.round((total * Math.max(0, fees.cashlessRate)) / 100) : 0
  items.forEach((i) => {
    const d = calc.lineDiscount.get(i.productId)
    if (d) i.discount = d
  })
  if (payment === 'cash' && received < total) return { ok: false, error: 'お預かり金額が不足しています' }

  const at = now()
  const { device } = state
  const hub = getView().hub
  const sale: Sale = {
    id: uid(),
    receiptNo: `${device.code}-${String(device.nextReceipt).padStart(4, '0')}`,
    ...(hub ? { remoteEvent: hub.hub.eventId } : {}),
    at,
    deviceId: device.id,
    items,
    subtotal,
    discount: calc.totalDiscount,
    discounts: calc.applied.map(({ ruleId, name, amount }) => ({ ruleId, name, amount })),
    total,
    ...(paymentFee ? { paymentFee } : {}),
    payment,
    received: payment === 'cash' ? received : total,
    change: payment === 'cash' ? received - total : 0,
    voided: false,
    updatedAt: at,
  }
  let next = withSale(state, sale)
  next = withEvents(next, items.map((i) => makeEvent(i.productId, -i.qty, 'sale', `伝票 ${sale.receiptNo}`, sale.id, at)))
  next = { ...next, device: { ...device, nextReceipt: device.nextReceipt + 1 } }
  commit(next)
  return { ok: true, sale }
}

// ---------- オンラインショップの注文 ----------

export type OnlineLine = { productId: string; qty: number; price: number }
export type OnlineOrderInput = {
  at: string
  lines: OnlineLine[]
  /** クーポン・値引き */
  discount: number
  info: Omit<OnlineOrderInfo, 'shippedAt'>
}

export function onlineTotals(lines: OnlineLine[], discount: number, shipping: number) {
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0)
  const disc = Math.min(Math.max(0, discount), subtotal)
  return { subtotal, discount: disc, total: subtotal - disc + Math.max(0, shipping) }
}

/**
 * オンラインショップの注文を記録する。在庫は店頭と共通で減らす。
 * すでに売れた注文の記録なので、在庫が足りなくても記録はできる（在庫はマイナスになる）。
 */
export function recordOnlineOrder(input: OnlineOrderInput): CheckoutResult {
  const lines = input.lines.filter((l) => l.qty > 0)
  if (!lines.length) return { ok: false, error: '商品を追加してください' }
  const items: SaleItem[] = []
  for (const l of lines) {
    const p = state.products[l.productId]
    if (!p || p.deleted) return { ok: false, error: '削除された商品が含まれています' }
    const existing = items.find((i) => i.productId === p.id)
    if (existing) {
      existing.qty += l.qty
      continue
    }
    items.push({
      productId: p.id, name: p.name, category: p.category, type: p.type ?? '', size: p.size ?? '',
      price: Math.max(0, l.price), cost: avgCostOf(p.id), qty: l.qty,
    })
  }
  const { subtotal, discount, total } = onlineTotals(lines, input.discount, input.info.shipping)
  const at = input.at
  const { device } = state
  const stamp = now()
  const shop = input.info.shop.trim() || 'オンライン'
  const sale: Sale = {
    id: uid(),
    receiptNo: input.info.orderNo.trim() || `ON-${device.code}-${String(device.nextReceipt).padStart(4, '0')}`,
    channel: 'online',
    online: { ...input.info, shop, shippedAt: input.info.status === 'shipped' ? stamp : null },
    at,
    deviceId: device.id,
    items,
    subtotal,
    discount,
    discounts: discount > 0 ? [{ ruleId: null, name: 'クーポン・値引き', amount: discount }] : [],
    total,
    payment: 'online',
    received: total,
    change: 0,
    voided: false,
    updatedAt: stamp,
  }
  let next = withSale(state, sale)
  next = withEvents(next, items.map((i) => makeEvent(i.productId, -i.qty, 'sale', `${shop} ${sale.receiptNo}`, sale.id, at)))
  next = { ...next, device: { ...device, nextReceipt: device.nextReceipt + 1 } }
  commit(next)
  return { ok: true, sale }
}

/** 注文情報（発送状況・手数料・メモなど）を更新。商品と金額は変えない */
export function updateOnlineOrder(id: string, patch: Partial<OnlineOrderInfo>) {
  const sale = state.sales[id]
  if (!sale?.online) return
  const online = { ...sale.online, ...patch }
  if (patch.status === 'shipped' && sale.online.status !== 'shipped') online.shippedAt = now()
  if (patch.status === 'unshipped') online.shippedAt = null
  const total = sale.subtotal - sale.discount + Math.max(0, online.shipping)
  commit(withSale(state, { ...sale, online, total, received: total, updatedAt: now() }))
}

/** 取引の取り消し（在庫を戻す） */
export function voidSale(id: string) {
  const sale = state.sales[id]
  if (!sale || sale.voided) return
  let next = withSale(state, { ...sale, voided: true, updatedAt: now() })
  next = withEvents(
    next,
    sale.items.map((i) => makeEvent(i.productId, i.qty, 'void', `伝票 ${sale.receiptNo} 取消`, sale.id)),
  )
  commit(next)
}

// ---------- 割引ルール ----------

export type DiscountRuleInput = Omit<DiscountRule, 'id' | 'updatedAt' | 'deleted'>

function withRule(s: LocalState, r: DiscountRule): LocalState {
  return {
    ...s,
    discountRules: { ...s.discountRules, [r.id]: r },
    outbox: { ...s.outbox, discountRules: addId(s.outbox.discountRules, r.id) },
  }
}

export function saveDiscountRule(input: DiscountRuleInput, id?: string) {
  const base = id ? state.discountRules[id] : undefined
  commit(withRule(state, { ...input, id: base?.id ?? uid(), deleted: false, updatedAt: now() }))
}

export function setDiscountEnabled(id: string, enabled: boolean) {
  const r = state.discountRules[id]
  if (r) commit(withRule(state, { ...r, enabled, updatedAt: now() }))
}

export function deleteDiscountRule(id: string) {
  const r = state.discountRules[id]
  if (r) commit(withRule(state, { ...r, deleted: true, updatedAt: now() }))
}

// ---------- 設定 ----------

export function updateShopName(shopName: string) {
  commit({
    ...state,
    settings: { ...state.settings, shopName, updatedAt: now() },
    outbox: { ...state.outbox, settings: true },
  })
}

/** 会計手数料・最低粗利の設定（全端末で共有） */
export function updateFees(fees: FeeSettings) {
  commit({
    ...state,
    settings: { ...state.settings, fees, updatedAt: now() },
    outbox: { ...state.outbox, settings: true },
  })
}

// ---------- 会計（収支の記録） ----------

export type LedgerInput = Omit<LedgerEntry, 'id' | 'deleted' | 'updatedAt'>

function withLedger(s: LocalState, x: LedgerEntry): LocalState {
  return { ...s, ledger: { ...s.ledger, [x.id]: x }, outbox: { ...s.outbox, ledger: addId(s.outbox.ledger, x.id) } }
}

/** 収支を記録する。id を渡すとその記録を書き換える */
export function saveLedgerEntry(input: LedgerInput, id?: string) {
  const prev = id ? state.ledger[id] : undefined
  const x: LedgerEntry = { ...input, amount: Math.max(0, Math.round(input.amount)), id: prev?.id ?? uid(), deleted: false, updatedAt: now() }
  commit(withLedger(state, x))
}

export function deleteLedgerEntry(id: string) {
  const x = state.ledger[id]
  if (x) commit(withLedger(state, { ...x, deleted: true, updatedAt: now() }))
}

/** 会計アプリでログインしたとき：収支の記録を最初から受け取り直し、この端末の記録も送り直す */
export function resyncForAccounting() {
  commit({ ...state, outbox: { ...state.outbox, ledger: Object.keys(state.ledger) }, sync: { ...state.sync, cursor: 0 } })
}

// ---------- 棚卸しハブ ----------

/** ハブの一覧を保存する（全端末で共有） */
function saveHubs(hubs: StockHub[]) {
  commit({
    ...state,
    settings: { ...state.settings, hubs, updatedAt: now() },
    outbox: { ...state.outbox, settings: true },
  })
}

/** ハブを追加して、その ID を返す */
export function addHub(name: string) {
  const hub: StockHub = { id: uid(), name: name.trim(), allocations: {}, eventId: uid() }
  saveHubs([...hubsOf(state.settings), hub])
  return hub.id
}

/** ハブの名前・持ち出し数を変える */
export function updateHub(id: string, patch: Partial<Pick<StockHub, 'name' | 'allocations'>>) {
  saveHubs(hubsOf(state.settings).map((h) => (h.id === id ? { ...h, ...patch } : h)))
}

/** 売れた数を 0 から数え直す（同じハブを次の物販で使うときなど） */
export function resetHubSold(id: string) {
  saveHubs(hubsOf(state.settings).map((h) => (h.id === id ? { ...h, eventId: uid() } : h)))
}

/** ハブを削除する（過去の売上はそのまま。選んでいた端末はベースに戻る） */
export function deleteHub(id: string) {
  saveHubs(hubsOf(state.settings).filter((h) => h.id !== id))
}

/** この端末のレジで使うハブを選ぶ（null = ベース）。端末ごとの設定で、同期しない */
export function selectHub(id: string | null) {
  const { hubId: _, ...device } = state.device
  commit({ ...state, device: id ? { ...device, hubId: id } : device })
}

export function setDeviceCode(code: string) {
  commit({ ...state, device: { ...state.device, code } })
}

/** ログアウト：トークンだけ消す。この端末のデータと送信待ちは残し、次にログインしたときに送る */
export function clearSyncToken() {
  commit({ ...state, sync: { ...state.sync, token: '' } })
}

export function setSyncToken(token: string) {
  // ログインし直したら別のクラウドかもしれないので、全件受信し直し、この端末のデータも全件送り直す
  // （サーバー側は ID で重複を除くので、同じデータを送っても増えない）
  const s = state
  commit({
    ...s,
    outbox: {
      products: Object.keys(s.products),
      sales: Object.keys(s.sales),
      stockEvents: Object.keys(s.stockEvents),
      discountRules: Object.keys(s.discountRules),
      ledger: Object.keys(s.ledger),
      settings: s.settings.updatedAt !== EPOCH,
    },
    sync: { ...s.sync, token, cursor: 0 },
  })
}

// ---------- 同期（sync.ts から使う） ----------

/**
 * 送信待ちを取り出す（1回のリクエストが大きくなりすぎないよう種類ごとに上限あり）。
 * 収支の記録は会計アプリでログインしているときだけ送る
 */
export function collectOutbox(withLedger: boolean, limit = 500): SyncChanges {
  const s = state
  return {
    products: s.outbox.products.slice(0, limit).map((id) => s.products[id]).filter(Boolean),
    sales: s.outbox.sales.slice(0, limit).map((id) => s.sales[id]).filter(Boolean),
    stockEvents: s.outbox.stockEvents.slice(0, limit * 4).map((id) => s.stockEvents[id]).filter(Boolean),
    discountRules: s.outbox.discountRules.slice(0, limit).map((id) => s.discountRules[id]).filter(Boolean),
    settings: s.outbox.settings ? s.settings : null,
    ...(withLedger ? { ledger: s.outbox.ledger.slice(0, limit).map((id) => s.ledger[id]).filter(Boolean) } : {}),
  }
}

const t = (iso: string) => Date.parse(iso) || 0

/** 送信済みの変更を outbox から外し、受信した変更を取り込む */
export function applySyncResult(sent: SyncChanges, remote: SyncChanges, cursor: number) {
  const s = state
  const products = { ...s.products }
  const sales = { ...s.sales }
  const stockEvents = { ...s.stockEvents }
  const discountRules = { ...s.discountRules }
  const ledger = { ...s.ledger }
  let settings = s.settings

  // 送信できたものは outbox から除く（送信後にさらに編集されたものは残す）
  const sentP = new Map(sent.products.map((p) => [p.id, p.updatedAt]))
  const sentS = new Map(sent.sales.map((x) => [x.id, x.updatedAt]))
  const sentE = new Set(sent.stockEvents.map((e) => e.id))
  const sentR = new Map((sent.discountRules ?? []).map((r) => [r.id, r.updatedAt]))
  const sentL = new Map((sent.ledger ?? []).map((x) => [x.id, x.updatedAt]))
  const outbox: Outbox = {
    products: s.outbox.products.filter((id) => sentP.get(id) !== products[id]?.updatedAt),
    sales: s.outbox.sales.filter((id) => sentS.get(id) !== sales[id]?.updatedAt),
    stockEvents: s.outbox.stockEvents.filter((id) => !sentE.has(id)),
    discountRules: s.outbox.discountRules.filter((id) => sentR.get(id) !== discountRules[id]?.updatedAt),
    ledger: s.outbox.ledger.filter((id) => sentL.get(id) !== ledger[id]?.updatedAt),
    settings: s.outbox.settings && !(sent.settings && sent.settings.updatedAt === s.settings.updatedAt),
  }

  // 商品・設定は「最後に更新したものが勝つ」
  for (const p of remote.products) {
    const local = products[p.id]
    if (!local || t(p.updatedAt) > t(local.updatedAt)) products[p.id] = p
  }
  for (const r of remote.discountRules ?? []) {
    const local = discountRules[r.id]
    if (!local || t(r.updatedAt) > t(local.updatedAt)) discountRules[r.id] = r
  }
  for (const x of remote.ledger ?? []) {
    const local = ledger[x.id]
    if (!local || t(x.updatedAt) > t(local.updatedAt)) ledger[x.id] = x
  }
  if (remote.settings && t(remote.settings.updatedAt) > t(settings.updatedAt)) settings = remote.settings

  // 取引の商品・金額は変わらない。オンライン注文の情報は新しい方、取消はどちらかで取り消されていれば取消
  for (const x of remote.sales) {
    const local = sales[x.id]
    if (!local) sales[x.id] = x
    else if (t(x.updatedAt) > t(local.updatedAt)) sales[x.id] = { ...x, voided: x.voided || local.voided }
    else if (x.voided && !local.voided) sales[x.id] = { ...local, voided: true }
  }

  // 在庫増減は追記のみ（ID で重複排除）
  for (const e of remote.stockEvents) if (!stockEvents[e.id]) stockEvents[e.id] = e

  commit({
    ...s,
    products,
    sales,
    stockEvents,
    discountRules,
    ledger,
    settings,
    outbox,
    sync: { ...s.sync, cursor, lastSyncAt: now() },
  })
}

// ---------- データ管理 ----------

export type Backup = { app: 'goods-selling'; exportedAt: string } & Pick<
  LocalState,
  'products' | 'sales' | 'stockEvents' | 'discountRules' | 'settings'
>

export function exportBackup(): string {
  const { products, sales, stockEvents, discountRules, settings } = state
  const b: Backup = { app: 'goods-selling', exportedAt: now(), products, sales, stockEvents, discountRules, settings }
  return JSON.stringify(b, null, 2)
}

/** バックアップを取り込む（既存データに merge し、クラウドにも送る） */
export function importBackup(text: string): string | null {
  let b: Backup
  try {
    b = JSON.parse(text)
  } catch {
    return 'JSONの読み込みに失敗しました'
  }
  if (b?.app !== 'goods-selling' || !b.products || !b.sales || !b.stockEvents) return 'このファイルは物販アプリのバックアップではありません'
  const s = state
  commit({
    ...s,
    products: { ...s.products, ...b.products },
    sales: { ...s.sales, ...b.sales },
    stockEvents: { ...s.stockEvents, ...b.stockEvents },
    discountRules: { ...s.discountRules, ...(b.discountRules ?? {}) },
    settings: b.settings && t(b.settings.updatedAt) > t(s.settings.updatedAt) ? b.settings : s.settings,
    outbox: {
      products: [...new Set([...s.outbox.products, ...Object.keys(b.products)])],
      sales: [...new Set([...s.outbox.sales, ...Object.keys(b.sales)])],
      stockEvents: [...new Set([...s.outbox.stockEvents, ...Object.keys(b.stockEvents)])],
      discountRules: [...new Set([...s.outbox.discountRules, ...Object.keys(b.discountRules ?? {})])],
      ledger: s.outbox.ledger,
      settings: s.outbox.settings,
    },
  })
  return null
}

/** この端末のデータを消去（クラウドのデータは残る。同期すると再取得される） */
export function resetLocal() {
  const fresh = emptyState()
  commit({ ...fresh, device: state.device, sync: { ...state.sync, cursor: 0, lastSyncAt: null } })
}

/** デモ用のサンプル商品と過去14日分の売上を追加 */
export function loadSample() {
  // [商品名, カテゴリ, タイプ, サイズ, 価格, 原価, 現在庫]
  const defs: [string, string, string, string, number, number, number][] = [
    ['アクリルスタンド', 'アクスタ', 'キャラA', '', 1500, 600, 40],
    ['アクリルスタンド', 'アクスタ', 'キャラB', '', 1500, 600, 35],
    ['缶バッジ', '缶バッジ', 'ランダム', '', 500, 150, 120],
    ['缶バッジ', '缶バッジ', '5個セット', '', 2400, 800, 20],
    ['Tシャツ', 'アパレル', 'ブラック', 'M', 3500, 1400, 15],
    ['Tシャツ', 'アパレル', 'ブラック', 'L', 3500, 1400, 15],
    ['Tシャツ', 'アパレル', 'ホワイト', 'M', 3500, 1400, 8],
    ['タオル', 'アパレル', 'フェイス', 'F', 2000, 700, 30],
    ['クリアファイル', '文具', '', 'A4', 400, 120, 80],
    ['ステッカー', '文具', '', '', 300, 60, 100],
    ['ブロマイド', 'ブロマイド', '5枚組', '', 1000, 250, 50],
    ['キーホルダー', '小物', '', '', 800, 300, 3],
  ]
  const stamp = now()
  const products: Product[] = defs.map(([name, category, type, size, price, cost], i) => ({
    id: uid(), name, category, type, size, price, cost, lowStock: 5,
    // 袋代（レジ）・梱包材（オンライン）の目安
    extraCostStore: price >= 2000 ? 30 : 10,
    extraCostOnline: price >= 2000 ? 150 : 60,
    sku: `G-${String(i + 1).padStart(3, '0')}`, active: true, deleted: false, updatedAt: stamp,
  }))
  const weights = [3, 3, 6, 1, 1.2, 1.2, 0.8, 1.5, 2, 3, 2, 1]
  const wsum = weights.reduce((a, b) => a + b, 0)
  const pick = () => {
    let r = Math.random() * wsum
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]) < 0) return products[i]
    return products[0]
  }

  const start = new Date()
  start.setDate(start.getDate() - 14)
  start.setHours(9, 0, 0, 0)
  const sales: Sale[] = []
  const events: StockEvent[] = []
  const sold = new Map<string, number>()
  const nowDate = new Date()
  for (let d = 13; d >= 0; d--) {
    const day = new Date()
    day.setDate(day.getDate() - d)
    const weekend = day.getDay() === 0 || day.getDay() === 6
    const count = Math.round((weekend ? 18 : 7) + Math.random() * 8)
    for (let n = 0; n < count; n++) {
      const at = new Date(day)
      at.setHours(10 + Math.floor(Math.random() * 8), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0)
      if (at > nowDate) continue
      const byId = new Map<string, SaleItem>()
      const lines = 1 + Math.floor(Math.random() * 3)
      for (let k = 0; k < lines; k++) {
        const p = pick()
        const item = byId.get(p.id) ?? {
          productId: p.id, name: p.name, category: p.category, type: p.type, size: p.size, price: p.price, cost: p.cost, qty: 0,
        }
        item.qty += Math.random() < 0.2 ? 2 : 1
        byId.set(p.id, item)
      }
      const items = [...byId.values()]
      const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0)
      const cash = Math.random() < 0.55
      const received = cash ? Math.ceil(subtotal / 1000) * 1000 : subtotal
      const iso = at.toISOString()
      const sale: Sale = {
        id: uid(), receiptNo: '', at: iso, deviceId: state.device.id, items, subtotal, discount: 0, total: subtotal,
        payment: cash ? 'cash' : 'cashless', received, change: received - subtotal, voided: false, updatedAt: iso,
      }
      sales.push(sale)
      items.forEach((i) => sold.set(i.productId, (sold.get(i.productId) ?? 0) + i.qty))
    }
  }
  sales.sort((a, b) => a.at.localeCompare(b.at))
  const code = 'SMP'
  sales.forEach((s, i) => {
    s.receiptNo = `${code}-${String(i + 1).padStart(4, '0')}`
    s.items.forEach((i2) => events.push(makeEvent(i2.productId, -i2.qty, 'sale', `伝票 ${s.receiptNo}`, s.id, s.at)))
  })
  // 途中で仕入単価が上がった入荷（移動平均原価の例）
  const mid = new Date()
  mid.setDate(mid.getDate() - 7)
  mid.setHours(9, 0, 0, 0)
  const restocks = [
    makeEvent(products[0].id, 20, 'restock', '再入荷（仕入値上げ）', null, mid.toISOString(), 680),
    makeEvent(products[4].id, 10, 'restock', '再入荷（仕入値上げ）', null, mid.toISOString(), 1550),
  ]
  const restocked = new Map(restocks.map((e) => [e.productId, e.delta]))
  // 現在庫がちょうど定義値になるよう初期在庫を設定
  const initial = products.map((p, i) =>
    makeEvent(
      p.id,
      defs[i][6] + (sold.get(p.id) ?? 0) - (restocked.get(p.id) ?? 0),
      'initial',
      'サンプルデータ',
      null,
      start.toISOString(),
      p.cost,
    ),
  )

  // サンプルの割引ルール
  const rule = (r: Omit<DiscountRule, 'id' | 'updatedAt' | 'deleted' | 'enabled' | 'startAt' | 'endAt'>): DiscountRule => ({
    ...r, id: uid(), enabled: true, startAt: null, endAt: null, deleted: false, updatedAt: stamp,
  })
  const rules: DiscountRule[] = [
    rule({
      name: '缶バッジ 3個で1,200円', kind: 'bundle', target: { scope: 'product', values: [products[2].id] },
      valueType: 'setPrice', value: 1200, minQty: 3, minSubtotal: 0, mode: 'auto',
    }),
    rule({
      name: '5,000円以上で300円引き', kind: 'order', target: { scope: 'all', values: [] },
      valueType: 'yen', value: 300, minQty: 1, minSubtotal: 5000, mode: 'auto',
    }),
    rule({
      name: 'SNSフォロー割 5%', kind: 'order', target: { scope: 'all', values: [] },
      valueType: 'percent', value: 5, minQty: 1, minSubtotal: 0, mode: 'manual',
    }),
  ]

  let next = state
  if (!state.settings.fees) {
    next = {
      ...next,
      settings: {
        ...next.settings,
        fees: {
          cashlessRate: 3.25,
          shops: [
            { name: 'BASE', rate: 6.6, fixed: 40 },
            { name: 'BOOTH', rate: 5.6, fixed: 45 },
          ],
          minProfitYen: 0,
          minProfitPercent: 0,
        },
        updatedAt: stamp,
      },
      outbox: { ...next.outbox, settings: true },
    }
  }
  rules.forEach((r) => (next = withRule(next, r)))
  products.forEach((p) => (next = withProduct(next, p)))
  sales.forEach((s) => (next = withSale(next, s)))
  next = withEvents(next, [...initial, ...restocks, ...events])
  commit(next)
}
