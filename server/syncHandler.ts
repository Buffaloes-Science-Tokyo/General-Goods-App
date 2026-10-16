import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import type { SyncChanges, SyncRequest, SyncResponse } from '../src/types'
import { verifySession, type AuthEnv } from './auth.js'

/**
 * 同期 API 本体（Web 標準の Request → Response）。
 * Vercel Functions（api/sync.ts）と開発サーバー（vite.config.ts）の両方から使う。
 *
 * - 各テーブルの行は書き込まれるたびに sync_seq から新しい seq を振られる
 * - クライアントは前回の cursor より大きい seq の行だけを受け取る
 * - 書き込みは advisory lock で直列化し、seq の順にコミットされることを保証する
 *   （これがないと「小さい seq が後からコミットされて取りこぼす」ことがある）
 */

type Env = AuthEnv & { DATABASE_URL?: string }

const SCHEMA = [
  `create sequence if not exists sync_seq`,
  `create table if not exists products (
    id text primary key,
    name text not null,
    category text not null default '',
    price integer not null,
    cost integer not null,
    low_stock integer not null default 0,
    sku text not null default '',
    active boolean not null default true,
    deleted boolean not null default false,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `alter table products add column if not exists product_type text not null default ''`,
  `alter table products add column if not exists size text not null default ''`,
  `alter table products add column if not exists extra_cost_store integer not null default 0`,
  `alter table products add column if not exists extra_cost_online integer not null default 0`,
  `create index if not exists products_seq_idx on products (seq)`,
  `create table if not exists sales (
    id text primary key,
    receipt_no text not null,
    at timestamptz not null,
    device_id text not null,
    items jsonb not null,
    subtotal integer not null,
    discount integer not null,
    total integer not null,
    payment text not null,
    received integer not null,
    change_amount integer not null,
    voided boolean not null default false,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `create index if not exists sales_seq_idx on sales (seq)`,
  `create index if not exists sales_at_idx on sales (at)`,
  `create table if not exists stock_events (
    id text primary key,
    product_id text not null,
    at timestamptz not null,
    delta integer not null,
    reason text not null,
    note text not null default '',
    sale_id text,
    device_id text not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  // 仕入単価（入荷・原価修正のとき）。既存のDBにも追加されるよう alter で
  `alter table stock_events add column if not exists unit_cost double precision`,
  // 取り消し・修正の対象の記録ID
  `alter table stock_events add column if not exists cancels text`,
  `create index if not exists stock_events_seq_idx on stock_events (seq)`,
  `create index if not exists stock_events_product_idx on stock_events (product_id)`,
  `alter table sales add column if not exists discounts jsonb not null default '[]'`,
  `alter table sales add column if not exists channel text not null default 'store'`,
  `alter table sales add column if not exists online jsonb`,
  `alter table sales add column if not exists payment_fee integer not null default 0`,
  `create table if not exists discount_rules (
    id text primary key,
    data jsonb not null,
    deleted boolean not null default false,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `create index if not exists discount_rules_seq_idx on discount_rules (seq)`,
  // 会計アプリの収支の記録（会計アプリのパスワードでログインした端末だけが読み書きする）
  `create table if not exists ledger_entries (
    id text primary key,
    data jsonb not null,
    deleted boolean not null default false,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `create index if not exists ledger_entries_seq_idx on ledger_entries (seq)`,
  // キャッシュフローの記録（収支の記録と同じく会計アプリでログインした端末だけが読み書きする）
  `create table if not exists cash_flows (
    id text primary key,
    data jsonb not null,
    deleted boolean not null default false,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `create index if not exists cash_flows_seq_idx on cash_flows (seq)`,
  `create table if not exists shop_settings (
    id text primary key,
    shop_name text not null,
    updated_at timestamptz not null,
    seq bigint not null default nextval('sync_seq')
  )`,
  `alter table shop_settings add column if not exists fees jsonb`,
  `alter table sales add column if not exists remote_event text`,
  `alter table shop_settings add column if not exists remote jsonb`,
  `alter table shop_settings add column if not exists hubs jsonb`,
  `alter table shop_settings add column if not exists pools jsonb`,
  `alter table shop_settings add column if not exists base_pools jsonb`,
  `alter table sales add column if not exists pool_id text`,
]

const UPSERT_PRODUCTS = `
insert into products (id, name, category, product_type, size, price, cost, extra_cost_store, extra_cost_online, low_stock, sku,
  active, deleted, updated_at)
select id, name, category, coalesce(type, ''), coalesce(size, ''), price, cost, coalesce("extraCostStore", 0),
  coalesce("extraCostOnline", 0), "lowStock", sku, active, deleted, "updatedAt"
from jsonb_to_recordset($1::jsonb) as x(
  id text, name text, category text, type text, size text, price integer, cost integer, "extraCostStore" integer,
  "extraCostOnline" integer, "lowStock" integer,
  sku text, active boolean, deleted boolean, "updatedAt" timestamptz)
on conflict (id) do update set
  name = excluded.name, category = excluded.category, product_type = excluded.product_type, size = excluded.size,
  price = excluded.price, cost = excluded.cost,
  extra_cost_store = excluded.extra_cost_store, extra_cost_online = excluded.extra_cost_online,
  low_stock = excluded.low_stock, sku = excluded.sku, active = excluded.active, deleted = excluded.deleted,
  updated_at = excluded.updated_at, seq = nextval('sync_seq')
where products.updated_at < excluded.updated_at`

const UPSERT_SALES = `
insert into sales (id, receipt_no, channel, remote_event, pool_id, online, at, device_id, items, subtotal, discount, discounts, total, payment_fee,
  payment, received, change_amount, voided, updated_at)
select id, "receiptNo", coalesce(channel, 'store'), "remoteEvent", "poolId", online, at, "deviceId", items, subtotal, discount, coalesce(discounts, '[]'),
  total, coalesce("paymentFee", 0), payment, received, change, voided, "updatedAt"
from jsonb_to_recordset($1::jsonb) as x(
  id text, "receiptNo" text, channel text, "remoteEvent" text, "poolId" text, online jsonb, at timestamptz, "deviceId" text, items jsonb, subtotal integer,
  discount integer, discounts jsonb, total integer, "paymentFee" integer, payment text, received integer, change integer,
  voided boolean, "updatedAt" timestamptz)
-- 商品は変えない。オンライン注文の情報（発送状況・送料など）は新しい方、取消はどちらかで取り消されていれば取消
on conflict (id) do update set
  online = case when excluded.updated_at > sales.updated_at then excluded.online else sales.online end,
  total = case when excluded.updated_at > sales.updated_at then excluded.total else sales.total end,
  received = case when excluded.updated_at > sales.updated_at then excluded.received else sales.received end,
  voided = sales.voided or excluded.voided,
  updated_at = greatest(sales.updated_at, excluded.updated_at),
  seq = nextval('sync_seq')
where excluded.updated_at > sales.updated_at or (excluded.voided and not sales.voided)`

const INSERT_EVENTS = `
insert into stock_events (id, product_id, at, delta, unit_cost, reason, note, sale_id, device_id, cancels)
select id, "productId", at, delta, "unitCost", reason, note, "saleId", "deviceId", cancels
from jsonb_to_recordset($1::jsonb) as x(
  id text, "productId" text, at timestamptz, delta integer, "unitCost" double precision, reason text, note text,
  "saleId" text, "deviceId" text, cancels text)
on conflict (id) do nothing`

// 割引ルールは中身を丸ごと jsonb で保存（項目が増えてもスキーマ変更不要）。最後に更新したものが勝つ
const UPSERT_DISCOUNT_RULES = `
insert into discount_rules (id, data, deleted, updated_at)
select x->>'id', x, coalesce((x->>'deleted')::boolean, false), (x->>'updatedAt')::timestamptz
from jsonb_array_elements($1::jsonb) as x
on conflict (id) do update set
  data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = nextval('sync_seq')
where discount_rules.updated_at < excluded.updated_at`

// 収支の記録も同じく jsonb で保存。最後に更新したものが勝つ
const UPSERT_LEDGER = `
insert into ledger_entries (id, data, deleted, updated_at)
select x->>'id', x, coalesce((x->>'deleted')::boolean, false), (x->>'updatedAt')::timestamptz
from jsonb_array_elements($1::jsonb) as x
on conflict (id) do update set
  data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = nextval('sync_seq')
where ledger_entries.updated_at < excluded.updated_at`

// キャッシュフローの記録も同じく jsonb で保存。最後に更新したものが勝つ
const UPSERT_CASH_FLOWS = `
insert into cash_flows (id, data, deleted, updated_at)
select x->>'id', x, coalesce((x->>'deleted')::boolean, false), (x->>'updatedAt')::timestamptz
from jsonb_array_elements($1::jsonb) as x
on conflict (id) do update set
  data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = nextval('sync_seq')
where cash_flows.updated_at < excluded.updated_at`

const UPSERT_SETTINGS = `
insert into shop_settings (id, shop_name, fees, remote, hubs, pools, base_pools, updated_at)
select 'shop', "shopName", fees, remote, hubs, pools, "basePools", "updatedAt"
from jsonb_to_recordset($1::jsonb) as x("shopName" text, fees jsonb, remote jsonb, hubs jsonb, pools jsonb, "basePools" jsonb, "updatedAt" timestamptz)
on conflict (id) do update set
  shop_name = excluded.shop_name, fees = coalesce(excluded.fees, shop_settings.fees),
  remote = coalesce(excluded.remote, shop_settings.remote), hubs = coalesce(excluded.hubs, shop_settings.hubs),
  pools = coalesce(excluded.pools, shop_settings.pools), base_pools = coalesce(excluded.base_pools, shop_settings.base_pools),
  updated_at = excluded.updated_at, seq = nextval('sync_seq')
where shop_settings.updated_at < excluded.updated_at`

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())

let schemaReady: Promise<unknown> | null = null

function ensureSchema(sql: NeonQueryFunction<false, false>) {
  schemaReady ??= sql.transaction(SCHEMA.map((q) => sql.query(q))).catch((e) => {
    schemaReady = null
    throw e
  })
  return schemaReady
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function isRequest(v: unknown): v is SyncRequest {
  if (!v || typeof v !== 'object') return false
  const r = v as SyncRequest
  const c = r.changes
  return (
    typeof r.cursor === 'number' &&
    !!c &&
    Array.isArray(c.products) &&
    Array.isArray(c.sales) &&
    Array.isArray(c.stockEvents)
  )
}

export async function handleSync(
  req: Request,
  env: Env,
  makeSql: (url: string) => NeonQueryFunction<false, false> = neon,
): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!env.DATABASE_URL || !env.SYNC_TOKEN || !env.APP_PASSWORD) {
    return json({ error: 'サーバーに DATABASE_URL / SYNC_TOKEN / APP_PASSWORD が設定されていません' }, 500)
  }
  // レジ・会計どちらのログインでも同期できる（会計のダッシュボードにレジの販売・入荷を反映するため）。
  // 収支の記録は会計アプリでログインした端末だけが読み書きできる
  const accounting = await verifySession(req, env, 'accounting')
  if (!accounting && !(await verifySession(req, env))) return json({ error: 'unauthorized' }, 401)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (!isRequest(body)) return json({ error: 'invalid request' }, 400)

  const sql = makeSql(env.DATABASE_URL)
  try {
    await ensureSchema(sql)

    const { changes, cursor } = body
    const writes = []
    if (changes.products.length) writes.push(sql.query(UPSERT_PRODUCTS, [JSON.stringify(changes.products)]))
    if (changes.sales.length) writes.push(sql.query(UPSERT_SALES, [JSON.stringify(changes.sales)]))
    if (changes.stockEvents.length) writes.push(sql.query(INSERT_EVENTS, [JSON.stringify(changes.stockEvents)]))
    const rules = changes.discountRules ?? []
    if (rules.length) writes.push(sql.query(UPSERT_DISCOUNT_RULES, [JSON.stringify(rules)]))
    if (changes.settings) writes.push(sql.query(UPSERT_SETTINGS, [JSON.stringify([changes.settings])]))
    const ledger = accounting ? (changes.ledger ?? []) : []
    if (ledger.length) writes.push(sql.query(UPSERT_LEDGER, [JSON.stringify(ledger)]))
    const cashFlows = accounting ? (changes.cashFlows ?? []) : []
    if (cashFlows.length) writes.push(sql.query(UPSERT_CASH_FLOWS, [JSON.stringify(cashFlows)]))
    if (writes.length) {
      await sql.transaction([sql.query('select pg_advisory_xact_lock(727001)'), ...writes])
    }

    const [products, sales, events, settings, discountRules, ledgerRows, cashFlowRows] = await sql.transaction(
      [
        sql.query(
          `select id, name, category, product_type, size, price, cost, extra_cost_store, extra_cost_online, low_stock, sku, active, deleted, updated_at, seq::float8 as seq
           from products where seq > $1`,
          [cursor],
        ),
        sql.query(
          `select id, receipt_no, channel, remote_event, pool_id, online, at, device_id, items, subtotal, discount, discounts, total, payment_fee, payment, received, change_amount,
                  voided, updated_at, seq::float8 as seq
           from sales where seq > $1`,
          [cursor],
        ),
        sql.query(
          `select id, product_id, at, delta, unit_cost, reason, note, sale_id, device_id, cancels, seq::float8 as seq
           from stock_events where seq > $1`,
          [cursor],
        ),
        sql.query(`select shop_name, fees, remote, hubs, pools, base_pools, updated_at, seq::float8 as seq from shop_settings where seq > $1`, [cursor]),
        sql.query(`select data, seq::float8 as seq from discount_rules where seq > $1`, [cursor]),
        accounting
          ? sql.query(`select data, seq::float8 as seq from ledger_entries where seq > $1`, [cursor])
          : sql.query(`select 1 where false`),
        accounting
          ? sql.query(`select data, seq::float8 as seq from cash_flows where seq > $1`, [cursor])
          : sql.query(`select 1 where false`),
      ],
      { readOnly: true, isolationLevel: 'RepeatableRead' },
    )

    let next = cursor
    const bump = (rows: Record<string, unknown>[]) => rows.forEach((r) => (next = Math.max(next, Number(r.seq))))
    bump(products)
    bump(sales)
    bump(events)
    bump(settings)
    bump(discountRules)
    bump(ledgerRows)
    bump(cashFlowRows)

    const out: SyncChanges = {
      products: products.map((r) => ({
        id: r.id, name: r.name, category: r.category, type: r.product_type, size: r.size, price: r.price, cost: r.cost,
        extraCostStore: r.extra_cost_store, extraCostOnline: r.extra_cost_online, lowStock: r.low_stock,
        sku: r.sku, active: r.active, deleted: r.deleted, updatedAt: iso(r.updated_at),
      })),
      sales: sales.map((r) => ({
        id: r.id, receiptNo: r.receipt_no, channel: r.channel, ...(r.remote_event ? { remoteEvent: r.remote_event } : {}),
        ...(r.pool_id ? { poolId: r.pool_id } : {}),
        ...(r.online ? { online: r.online } : {}), at: iso(r.at), deviceId: r.device_id, items: r.items,
        subtotal: r.subtotal, discount: r.discount, discounts: r.discounts, total: r.total, paymentFee: r.payment_fee, payment: r.payment, received: r.received,
        change: r.change_amount, voided: r.voided, updatedAt: iso(r.updated_at),
      })),
      stockEvents: events.map((r) => ({
        id: r.id, productId: r.product_id, at: iso(r.at), delta: r.delta, unitCost: r.unit_cost, reason: r.reason, note: r.note,
        saleId: r.sale_id, deviceId: r.device_id, ...(r.cancels ? { cancels: r.cancels } : {}),
      })),
      discountRules: discountRules.map((r) => r.data),
      ...(accounting ? { ledger: ledgerRows.map((r) => r.data), cashFlows: cashFlowRows.map((r) => r.data) } : {}),
      settings: settings[0]
        ? {
            shopName: settings[0].shop_name,
            ...(settings[0].fees ? { fees: settings[0].fees } : {}),
            ...(settings[0].remote ? { remote: settings[0].remote } : {}),
            ...(settings[0].hubs ? { hubs: settings[0].hubs } : {}),
            ...(settings[0].pools ? { pools: settings[0].pools } : {}),
            ...(settings[0].base_pools ? { basePools: settings[0].base_pools } : {}),
            updatedAt: iso(settings[0].updated_at),
          }
        : null,
    }
    const res: SyncResponse = { cursor: next, changes: out }
    return json(res)
  } catch (e) {
    console.error('[sync]', e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
}
