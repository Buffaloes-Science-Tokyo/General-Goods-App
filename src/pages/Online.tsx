import { useMemo, useState } from 'react'
import { onlineTotals, recordOnlineOrder, updateOnlineOrder, useStore, voidSale, type OnlineLine } from '../store'
import { dateTime, downloadText, fullName, pct, toCsv, yen } from '../format'
import { saleCogs, saleExpenses, saleProfit } from '../metrics'
import type { OnlineOrderInfo, Sale } from '../types'
import { Modal, NumberInput, toast, toastError } from '../components/ui'
import { shopFeeOf } from '../pricing'

const SHOP_PRESETS = ['BASE', 'BOOTH', 'STORES', 'Shopify', 'minne', 'Creema', 'メルカリShops']

type StatusFilter = 'all' | 'unshipped' | 'shipped' | 'cancelled'

/** datetime-local 用（ローカル時刻） */
const toLocalInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function OnlinePage() {
  const { sales, costing } = useStore()
  const [adding, setAdding] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [shop, setShop] = useState('')

  const orders = useMemo(() => sales.filter((s) => s.channel === 'online').slice().reverse(), [sales])
  const shops = [...new Set(orders.map((o) => o.online?.shop ?? ''))].filter(Boolean)
  const unshipped = orders.filter((o) => !o.voided && o.online?.status === 'unshipped')

  const shown = orders.filter((o) => {
    if (shop && o.online?.shop !== shop) return false
    if (status === 'cancelled') return o.voided
    if (status === 'all') return true
    return !o.voided && o.online?.status === status
  })

  // 今月の実績
  const month = useMemo(() => {
    const start = new Date()
    start.setDate(1)
    start.setHours(0, 0, 0, 0)
    const list = orders.filter((o) => !o.voided && new Date(o.at) >= start)
    const revenue = list.reduce((a, o) => a + o.total, 0)
    const expenses = list.reduce((a, o) => a + saleExpenses(o), 0)
    const profit = list.reduce((a, o) => a + saleProfit(o, costing), 0)
    return { count: list.length, revenue, expenses, profit }
  }, [orders, costing])

  function exportCsv() {
    const rows: (string | number)[][] = [
      ['注文日時', 'ショップ', '注文番号', 'お客様', '商品', 'タイプ', 'サイズ', '単価', '数量', '商品小計(注文)', '値引き', '送料', '合計', '手数料', '発送実費', '状態', '発送日'],
    ]
    for (const o of shown) {
      const on = o.online!
      for (const i of o.items) {
        rows.push([
          new Date(o.at).toLocaleString('ja-JP'), on.shop, o.receiptNo, on.customer, i.name, i.type ?? '', i.size ?? '', i.price, i.qty,
          o.subtotal, o.discount, on.shipping, o.total, on.fee, on.shippingCost,
          o.voided ? 'キャンセル' : on.status === 'shipped' ? '発送済' : '未発送',
          on.shippedAt ? new Date(on.shippedAt).toLocaleDateString('ja-JP') : '',
        ])
      }
    }
    downloadText(`オンライン注文_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv')
  }

  const detail = detailId ? sales.find((s) => s.id === detailId) : null

  return (
    <div>
      <div className="page-head">
        <h1>オンラインショップ</h1>
        <button className="btn" onClick={exportCsv} disabled={!shown.length}>CSV出力</button>
        <button className="btn primary" onClick={() => setAdding(true)}>＋ 注文を記録</button>
      </div>

      <div className="kpis">
        <div className="card kpi">
          <div className="label">今月の売上</div>
          <div className="value">{yen(month.revenue)}</div>
          <div className="delta">{month.count}件（送料込み）</div>
        </div>
        <div className="card kpi">
          <div className="label">今月の手数料・発送費</div>
          <div className="value">{yen(month.expenses)}</div>
          <div className="delta">売上の {month.revenue ? pct(month.expenses / month.revenue) : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">今月の粗利</div>
          <div className="value">{yen(month.profit)}</div>
          <div className="delta">粗利率 {month.revenue ? pct(month.profit / month.revenue) : '—'}</div>
        </div>
        <div className="card kpi">
          <div className="label">未発送</div>
          <div className="value">{unshipped.length}件</div>
          <div className="delta">{unshipped.length ? `いちばん古い注文 ${dateTime(unshipped[unshipped.length - 1].at)}` : 'すべて発送済み'}</div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="seg" role="group" aria-label="状態で絞り込み">
            <button aria-pressed={status === 'all'} onClick={() => setStatus('all')}>すべて</button>
            <button aria-pressed={status === 'unshipped'} onClick={() => setStatus('unshipped')}>未発送 ({unshipped.length})</button>
            <button aria-pressed={status === 'shipped'} onClick={() => setStatus('shipped')}>発送済</button>
            <button aria-pressed={status === 'cancelled'} onClick={() => setStatus('cancelled')}>キャンセル</button>
          </div>
          {shops.length > 1 && (
            <select className="select" value={shop} onChange={(e) => setShop(e.target.value)} aria-label="ショップで絞り込み">
              <option value="">すべてのショップ</option>
              {shops.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          )}
        </div>

        {orders.length === 0 ? (
          <div className="empty">
            オンラインショップの注文はまだありません。「＋ 注文を記録」から、BASE や BOOTH などで売れた注文を記録できます。在庫は店頭と共通で減ります。
          </div>
        ) : shown.length === 0 ? (
          <div className="empty">該当する注文はありません</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>注文日時</th>
                  <th>ショップ・注文番号</th>
                  <th>内容</th>
                  <th className="r">合計</th>
                  <th className="r">手数料・発送費</th>
                  <th>状態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const on = o.online!
                  return (
                    <tr key={o.id} className={o.voided ? 'voided' : ''}>
                      <td className="num">{dateTime(o.at)}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{on.shop}</div>
                        <div className="muted small">{o.receiptNo}{on.customer && `・${on.customer}`}</div>
                      </td>
                      <td>
                        {o.items[0] && fullName(o.items[0])}
                        {o.items.length > 1 && <span className="muted"> 他{o.items.length - 1}品</span>}
                        <span className="muted small"> ・{o.items.reduce((a, i) => a + i.qty, 0)}点</span>
                      </td>
                      <td className="r num" style={{ fontWeight: 600 }}>{yen(o.total)}</td>
                      <td className="r num muted">{saleExpenses(o) ? `−${yen(saleExpenses(o))}` : '—'}</td>
                      <td className="nostrike">
                        {o.voided ? (
                          <span className="badge">キャンセル</span>
                        ) : on.status === 'shipped' ? (
                          <span className="badge on">発送済</span>
                        ) : (
                          <button className="btn sm" onClick={() => { updateOnlineOrder(o.id, { status: 'shipped' }); toast('発送済みにしました') }}>
                            発送済にする
                          </button>
                        )}
                      </td>
                      <td className="r nostrike">
                        <button className="btn sm ghost" onClick={() => setDetailId(o.id)}>詳細</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <OrderForm shops={shops} onClose={() => setAdding(false)} />}
      {detail && <OrderDetail sale={detail} onClose={() => setDetailId(null)} />}
    </div>
  )
}

function OrderForm({ shops, onClose }: { shops: string[]; onClose: () => void }) {
  const { products, stock, costing, fees } = useStore()
  // 手数料を手で変えるまでは、設定のショップ手数料から自動で計算する
  const [feeTouched, setFeeTouched] = useState(false)
  const [at, setAt] = useState(toLocalInput(new Date()))
  const [info, setInfo] = useState<Omit<OnlineOrderInfo, 'shippedAt'>>({
    shop: shops[0] ?? '',
    orderNo: '',
    customer: '',
    shipping: 0,
    fee: 0,
    shippingCost: 0,
    status: 'unshipped',
    note: '',
  })
  const [lines, setLines] = useState<OnlineLine[]>([])
  const [discount, setDiscount] = useState(0)
  const [pick, setPick] = useState('')
  const [feeRate, setFeeRate] = useState('')
  const setI = <K extends keyof typeof info>(k: K, v: (typeof info)[K]) => setInfo({ ...info, [k]: v })

  const byId = new Map(products.map((p) => [p.id, p]))
  const totals = onlineTotals(lines, discount, info.shipping)
  const shopFee = shopFeeOf(fees, info.shop)
  const autoFee = shopFee ? Math.round((totals.total * shopFee.rate) / 100) + (lines.length ? shopFee.fixed : 0) : null
  if (!feeTouched && autoFee !== null && autoFee !== info.fee) setInfo({ ...info, fee: autoFee })
  const cogs = lines.reduce((a, l) => a + (costing.byProduct.get(l.productId)?.avg ?? byId.get(l.productId)?.cost ?? 0) * l.qty, 0)
  const profit = totals.total - cogs - info.fee - info.shippingCost
  const short = lines.filter((l) => l.qty > (stock.get(l.productId) ?? 0))

  function addLine(id: string) {
    if (!id) return
    const p = byId.get(id)
    if (!p) return
    const cur = lines.find((l) => l.productId === id)
    setLines(cur ? lines.map((l) => (l.productId === id ? { ...l, qty: l.qty + 1 } : l)) : [...lines, { productId: id, qty: 1, price: p.price }])
    setPick('')
  }
  const setLine = (id: string, patch: Partial<OnlineLine>) => setLines(lines.map((l) => (l.productId === id ? { ...l, ...patch } : l)))

  function save() {
    if (!lines.length) return toastError('商品を追加してください')
    if (!info.shop.trim()) return toastError('ショップ名を入力してください')
    if (short.length && !confirm(`在庫が足りない商品があります（${short.map((l) => fullName(byId.get(l.productId)!)).join('、')}）。このまま記録すると在庫がマイナスになります。記録しますか？`)) return
    const r = recordOnlineOrder({ at: new Date(at).toISOString(), lines, discount, info })
    if (!r.ok) return toastError(r.error)
    toast('注文を記録しました')
    onClose()
  }

  return (
    <Modal title="オンライン注文を記録" onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="field">
          ショップ
          <input className="input" list="shop-list" value={info.shop} onChange={(e) => setI('shop', e.target.value)} placeholder="例：BASE" autoFocus required />
          <datalist id="shop-list">
            {[...new Set([...shops, ...SHOP_PRESETS])].map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label className="field">
          注文日時
          <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} required />
        </label>
        <label className="field">
          注文番号（任意）
          <input className="input" value={info.orderNo} onChange={(e) => setI('orderNo', e.target.value)} placeholder="ショップ側の番号" />
        </label>
        <label className="field">
          お客様（任意）
          <input className="input" value={info.customer} onChange={(e) => setI('customer', e.target.value)} />
        </label>

        <div className="field full">
          商品
          <select className="select" value={pick} onChange={(e) => addLine(e.target.value)} aria-label="商品を追加">
            <option value="">＋ 商品を選んで追加</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}（{yen(p.price)}・在庫{stock.get(p.id) ?? 0}）
              </option>
            ))}
          </select>
          {lines.length > 0 && (
            <table className="tbl" style={{ marginTop: 6 }}>
              <thead>
                <tr>
                  <th>商品</th>
                  <th className="r">販売単価</th>
                  <th className="r">数量</th>
                  <th className="r">小計</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const p = byId.get(l.productId)!
                  const left = stock.get(l.productId) ?? 0
                  return (
                    <tr key={l.productId}>
                      <td>
                        {fullName(p)}
                        {l.qty > left && <div className="small" style={{ color: 'var(--critical)' }}>在庫 {left}</div>}
                      </td>
                      <td className="r">
                        <NumberInput value={l.price} min={0} onChange={(v) => setLine(l.productId, { price: v })} style={{ width: 84 }} aria-label="販売単価" />
                      </td>
                      <td className="r">
                        <NumberInput value={l.qty} min={0} onChange={(v) => setLine(l.productId, { qty: v })} style={{ width: 56 }} aria-label="数量" />
                      </td>
                      <td className="r num">{yen(l.price * l.qty)}</td>
                      <td className="r">
                        <button type="button" className="btn sm ghost" onClick={() => setLines(lines.filter((x) => x.productId !== l.productId))}>削除</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <label className="field">
          クーポン・値引き（円）
          <NumberInput value={discount} min={0} onChange={setDiscount} />
        </label>
        <label className="field">
          送料（お客様から受け取った額）
          <NumberInput value={info.shipping} min={0} onChange={(v) => setI('shipping', v)} />
        </label>
        <label className="field">
          販売・決済手数料（円）
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <NumberInput value={info.fee} min={0} onChange={(v) => { setFeeTouched(true); setI('fee', v) }} className="grow" />
            <span className="muted small" style={{ whiteSpace: 'nowrap' }}>または</span>
            <input
              className="input num"
              style={{ width: 64 }}
              inputMode="decimal"
              placeholder="%"
              value={feeRate}
              aria-label="手数料率（%）"
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d.]/g, '')
                const n = parseFloat(v)
                setFeeRate(v)
                setFeeTouched(true)
                if (!Number.isNaN(n)) setI('fee', Math.round((totals.total * n) / 100))
              }}
            />
            <span className="muted small">%</span>
          </div>
          {shopFee && !feeTouched && (
            <span className="muted small">
              {shopFee.name} の設定（{shopFee.rate}%{shopFee.fixed ? `＋${shopFee.fixed}円` : ''}）で自動計算
            </span>
          )}
        </label>
        <label className="field">
          発送にかかった実費（円）
          <NumberInput value={info.shippingCost} min={0} onChange={(v) => setI('shippingCost', v)} />
        </label>

        <div className="field full">
          状態
          <div className="seg" role="group">
            <button type="button" aria-pressed={info.status === 'unshipped'} onClick={() => setI('status', 'unshipped')}>未発送</button>
            <button type="button" aria-pressed={info.status === 'shipped'} onClick={() => setI('status', 'shipped')}>発送済</button>
          </div>
        </div>
        <label className="field full">
          メモ
          <input className="input" value={info.note} onChange={(e) => setI('note', e.target.value)} placeholder="任意（配送方法、ギフト指定など）" />
        </label>

        <div className="full disc-preview" style={{ fontWeight: 400 }}>
          <div className="sum-row"><span>商品小計</span><span className="num">{yen(totals.subtotal)}</span></div>
          {totals.discount > 0 && <div className="sum-row"><span>クーポン・値引き</span><span className="num">−{yen(totals.discount)}</span></div>}
          {info.shipping > 0 && <div className="sum-row"><span>送料</span><span className="num">{yen(info.shipping)}</span></div>}
          <div className="sum-row" style={{ fontWeight: 700, fontSize: 16 }}><span>お客様の支払額</span><span className="num">{yen(totals.total)}</span></div>
          <div className="sum-row muted small">
            <span>原価 {yen(Math.round(cogs))}・手数料 {yen(info.fee)}・発送費 {yen(info.shippingCost)}</span>
            <span className="num">粗利 {yen(Math.round(profit))}</span>
          </div>
        </div>

        <div className="full actions">
          <button type="button" className="btn" onClick={onClose}>キャンセル</button>
          <button type="submit" className="btn primary" disabled={!lines.length}>記録する</button>
        </div>
      </form>
    </Modal>
  )
}

function OrderDetail({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  const { costing } = useStore()
  const on = sale.online!
  const [fee, setFee] = useState(on.fee)
  const [shippingCost, setShippingCost] = useState(on.shippingCost)
  const [note, setNote] = useState(on.note)
  const dirty = fee !== on.fee || shippingCost !== on.shippingCost || note !== on.note

  function cancel() {
    if (!confirm(`注文 ${sale.receiptNo}（${yen(sale.total)}）をキャンセルしますか？\n在庫は元に戻ります。`)) return
    voidSale(sale.id)
    toast('キャンセルしました')
  }

  return (
    <Modal title={`${on.shop} ${sale.receiptNo}`} onClose={onClose}>
      <div className="muted small" style={{ marginBottom: 8 }}>
        注文 {new Date(sale.at).toLocaleString('ja-JP')}
        {on.customer && `・${on.customer}`}
        {sale.voided ? (
          <span className="badge" style={{ marginLeft: 8 }}>キャンセル</span>
        ) : on.status === 'shipped' ? (
          <span className="badge on" style={{ marginLeft: 8 }}>発送済{on.shippedAt && ` ${dateTime(on.shippedAt)}`}</span>
        ) : (
          <span className="badge low" style={{ marginLeft: 8 }}>未発送</span>
        )}
      </div>
      <table className="tbl">
        <tbody>
          {sale.items.map((i) => (
            <tr key={i.productId}>
              <td>{fullName(i)}</td>
              <td className="r num muted">{yen(i.price)} × {i.qty}</td>
              <td className="r num">{yen(i.price * i.qty)}</td>
            </tr>
          ))}
          <tr><td colSpan={2}>商品小計</td><td className="r num">{yen(sale.subtotal)}</td></tr>
          {sale.discount > 0 && <tr><td colSpan={2}>クーポン・値引き</td><td className="r num">−{yen(sale.discount)}</td></tr>}
          {on.shipping > 0 && <tr><td colSpan={2}>送料</td><td className="r num">{yen(on.shipping)}</td></tr>}
          <tr><td colSpan={2}><b>お客様の支払額</b></td><td className="r num"><b>{yen(sale.total)}</b></td></tr>
          <tr className="muted"><td colSpan={2}>原価</td><td className="r num">−{yen(Math.round(saleCogs(sale, costing)))}</td></tr>
          <tr className="muted"><td colSpan={2}>手数料・発送費</td><td className="r num">−{yen(saleExpenses(sale))}</td></tr>
          <tr><td colSpan={2}>粗利</td><td className="r num">{yen(Math.round(saleProfit(sale, costing)))}</td></tr>
        </tbody>
      </table>

      {!sale.voided && (
        <div className="form-grid" style={{ marginTop: 16 }}>
          <label className="field">
            販売・決済手数料（円）
            <NumberInput value={fee} min={0} onChange={setFee} />
          </label>
          <label className="field">
            発送にかかった実費（円）
            <NumberInput value={shippingCost} min={0} onChange={setShippingCost} />
          </label>
          <label className="field full">
            メモ
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="full row">
            <button
              className="btn"
              disabled={!dirty}
              onClick={() => {
                updateOnlineOrder(sale.id, { fee, shippingCost, note })
                toast('保存しました')
              }}
            >
              変更を保存
            </button>
            {on.status === 'shipped' ? (
              <button className="btn ghost" onClick={() => updateOnlineOrder(sale.id, { status: 'unshipped' })}>未発送に戻す</button>
            ) : (
              <button className="btn primary" onClick={() => { updateOnlineOrder(sale.id, { status: 'shipped' }); toast('発送済みにしました') }}>
                発送済にする
              </button>
            )}
          </div>
        </div>
      )}

      <div className="actions" style={{ justifyContent: 'space-between' }}>
        <button className="btn danger" onClick={cancel} disabled={sale.voided}>注文をキャンセル</button>
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </Modal>
  )
}
