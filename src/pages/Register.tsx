import { useMemo, useState } from 'react'
import { checkout, useStore, type CartLine } from '../store'
import { fullName, yen } from '../format'
import { computeDiscounts, matchesTarget, MANUAL_NAME, type CalcLine, type ManualDiscount } from '../discounts'
import type { DiscountRule, PaymentMethod, Sale } from '../types'
import { Modal, NumberInput, StockBadge, toastError } from '../components/ui'

const QUICK_CASH = [1000, 5000, 10000]
const NO_MANUAL: ManualDiscount = { kind: 'yen', value: 0 }

export function RegisterPage() {
  const { products, stock, discountRules } = useStore()
  const [cat, setCat] = useState<string>('すべて')
  const [query, setQuery] = useState('')
  const [cart, setCart] = useState<CartLine[]>([])
  // この会計で外した自動割引 / 使う手動割引 / 手入力の値引き
  const [disabled, setDisabled] = useState<Set<string>>(new Set())
  const [manualOn, setManualOn] = useState<Set<string>>(new Set())
  const [manual, setManual] = useState<ManualDiscount>(NO_MANUAL)
  const [payment, setPayment] = useState<PaymentMethod>('cash')
  const [received, setReceived] = useState(0)
  const [done, setDone] = useState<Sale | null>(null)

  const sellable = products.filter((p) => p.active)
  const categories = useMemo(() => ['すべて', ...new Set(sellable.map((p) => p.category || '未分類'))], [sellable])
  const shown = sellable.filter(
    (p) =>
      (cat === 'すべて' || (p.category || '未分類') === cat) &&
      (!query || `${p.name} ${p.type} ${p.size} ${p.sku}`.toLowerCase().includes(query.toLowerCase())),
  )

  const byId = new Map(products.map((p) => [p.id, p]))
  const lines = cart.map((c) => ({ ...c, product: byId.get(c.productId) })).filter((l) => l.product)
  const calcLines: CalcLine[] = lines.map((l) => ({ ...l.product!, productId: l.productId, qty: l.qty }))
  const calc = computeDiscounts(calcLines, discountRules, { disabled, manualOn, manual })
  const { subtotal, total } = calc
  const change = received - total
  const itemCount = lines.reduce((s, l) => s + l.qty, 0)

  const qtyInCart = (id: string) => cart.find((c) => c.productId === id)?.qty ?? 0

  function add(id: string, delta = 1) {
    const left = stock.get(id) ?? 0
    const cur = cart.find((c) => c.productId === id)
    const nextQty = (cur?.qty ?? 0) + delta
    if (delta > 0 && nextQty > left) return toastError('在庫が足りません')
    if (nextQty <= 0) return setCart(cart.filter((c) => c.productId !== id))
    setCart(cur ? cart.map((c) => (c.productId === id ? { ...c, qty: nextQty } : c)) : [...cart, { productId: id, qty: nextQty }])
  }

  function clear() {
    setCart([])
    setDisabled(new Set())
    setManualOn(new Set())
    setManual(NO_MANUAL)
    setReceived(0)
  }

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(id)
    else next.delete(id)
    return next
  }

  /** 適用中の割引を外す */
  function removeApplied(ruleId: string | null) {
    if (ruleId === null) return setManual(NO_MANUAL)
    const rule = discountRules.find((r) => r.id === ruleId)
    if (rule?.mode === 'manual') setManualOn(toggle(manualOn, ruleId, false))
    else setDisabled(toggle(disabled, ruleId, true))
  }

  /** 使える割引を適用する（外した自動割引を戻す／手動割引を使う） */
  function useRule(rule: DiscountRule) {
    if (rule.mode === 'manual') setManualOn(toggle(manualOn, rule.id, true))
    else setDisabled(toggle(disabled, rule.id, false))
  }

  /** 条件未達の割引に「あと◯円」「あと◯点」を出す */
  function hint(rule: DiscountRule): string | null {
    if (rule.mode === 'auto' && disabled.has(rule.id)) return '外しています'
    if (rule.kind === 'order') {
      const afterLines = subtotal - [...calc.lineDiscount.values()].reduce((a, b) => a + b, 0)
      if (afterLines < rule.minSubtotal) return `あと${yen(rule.minSubtotal - afterLines)}`
    }
    if (rule.kind === 'bundle') {
      const qty = calcLines.filter((l) => matchesTarget(rule.target, l)).reduce((a, l) => a + l.qty, 0)
      if (qty < rule.minQty) return `対象をあと${rule.minQty - qty}点`
    }
    if (rule.mode === 'manual') return null
    return 'ほかの割引が優先'
  }

  function complete() {
    const r = checkout(cart, { disabled, manualOn, manual }, payment, payment === 'cash' ? received : total)
    if (!r.ok) return toastError(r.error)
    setDone(r.sale)
    clear()
  }

  const canPay = lines.length > 0 && (payment === 'cashless' || received >= total)
  const ruleLabel = (id: string | null) => (id ? discountRules.find((r) => r.id === id)?.name : null)

  return (
    <div className="register">
      <section className="catalog">
        <div className="row" style={{ marginBottom: 12 }}>
          <input
            className="input grow"
            placeholder="商品名・タイプ・サイズ・商品コードで検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cat-tabs">
          {categories.map((c) => (
            <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c}
            </button>
          ))}
        </div>
        {sellable.length === 0 ? (
          <div className="card empty">
            商品がまだありません。「商品・在庫」タブから登録してください。
          </div>
        ) : (
          <div className="tiles">
            {shown.map((p) => {
              const left = stock.get(p.id) ?? 0
              const inCart = qtyInCart(p.id)
              return (
                <button key={p.id} className="tile" onClick={() => add(p.id)} disabled={left <= 0}>
                  {inCart > 0 && <span className="in-cart">{inCart}</span>}
                  <span className="name">{p.name}</span>
                  {(p.type || p.size) && (
                    <span className="attrs">
                      {p.type && <span className="attr">{p.type}</span>}
                      {p.size && <span className="attr size">{p.size}</span>}
                    </span>
                  )}
                  <span className="meta">
                    <span>{p.category}</span>
                    <StockBadge stock={left} low={p.lowStock} />
                  </span>
                  <span className="price num">{yen(p.price)}</span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      <aside className="card cart">
        <div className="row">
          <h2 style={{ margin: 0 }} className="grow">
            お会計 <span className="sub">{itemCount}点</span>
          </h2>
          {lines.length > 0 && (
            <button className="btn sm ghost danger" onClick={clear}>
              クリア
            </button>
          )}
        </div>

        <div className="cart-lines">
          {lines.length === 0 && <div className="muted small" style={{ padding: '16px 0' }}>商品をタップして追加</div>}
          {lines.map((l) => {
            const d = calc.lineDiscount.get(l.productId) ?? 0
            return (
              <div key={l.productId} className="cart-line">
                <div>
                  <div className="nm">{fullName(l.product!)}</div>
                  <div className="unit num">{yen(l.product!.price)}</div>
                </div>
                <div className="amt num">
                  {d > 0 ? (
                    <>
                      <s className="muted small" style={{ fontWeight: 400 }}>{yen(l.product!.price * l.qty)}</s>
                      <div>{yen(l.product!.price * l.qty - d)}</div>
                    </>
                  ) : (
                    yen(l.product!.price * l.qty)
                  )}
                </div>
                <div className="qty">
                  <button onClick={() => add(l.productId, -1)} aria-label="1つ減らす">−</button>
                  <span className="num">{l.qty}</span>
                  <button onClick={() => add(l.productId, 1)} aria-label="1つ増やす">＋</button>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button className="btn sm ghost" onClick={() => add(l.productId, -l.qty)}>
                    削除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="sum-row">
          <span className="muted">小計</span>
          <span className="num">{yen(subtotal)}</span>
        </div>

        {calc.applied.map((a) => (
          <div key={a.ruleId ?? 'manual'} className="sum-row disc-row">
            <span className="disc-name">
              <span className="disc-tag">割引</span>
              {a.ruleId ? ruleLabel(a.ruleId) : MANUAL_NAME}
              <button className="x" onClick={() => removeApplied(a.ruleId)} aria-label={`${a.name}を外す`} title="この会計では外す">
                ×
              </button>
            </span>
            <span className="num">−{yen(a.amount)}</span>
          </div>
        ))}

        {lines.length > 0 && calc.available.length > 0 && (
          <div className="disc-avail">
            {calc.available.map((r) => {
              const h = hint(r)
              const canApply = r.mode === 'manual' || disabled.has(r.id)
              return (
                <button key={r.id} className="chip disc-chip" disabled={!canApply} onClick={() => useRule(r)} title={canApply ? '適用する' : undefined}>
                  {canApply && '＋ '}
                  {r.name}
                  {h && <span className="muted small"> ・{h}</span>}
                </button>
              )
            })}
          </div>
        )}

        <div className="sum-row">
          <span className="muted">値引き</span>
          <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="seg" role="group" aria-label="値引きの単位">
              <button aria-pressed={manual.kind === 'yen'} onClick={() => setManual({ ...manual, kind: 'yen' })}>円</button>
              <button aria-pressed={manual.kind === 'percent'} onClick={() => setManual({ ...manual, kind: 'percent' })}>%</button>
            </span>
            <NumberInput
              value={manual.value}
              onChange={(v) => setManual({ ...manual, value: manual.kind === 'percent' ? Math.min(100, v) : v })}
              min={0}
              style={{ width: 90 }}
              aria-label="値引き"
            />
          </span>
        </div>
        <div className="sum-row total">
          <span>合計</span>
          <span className="num">{yen(total)}</span>
        </div>
        {calc.totalDiscount > 0 && (
          <div className="muted small" style={{ textAlign: 'right', marginTop: -8 }}>
            {yen(calc.totalDiscount)} お得
          </div>
        )}

        <div className="seg" role="group" aria-label="支払い方法">
          <button aria-pressed={payment === 'cash'} onClick={() => setPayment('cash')}>現金</button>
          <button aria-pressed={payment === 'cashless'} onClick={() => setPayment('cashless')}>キャッシュレス</button>
        </div>

        {payment === 'cash' && (
          <>
            <div className="sum-row">
              <span className="muted">お預かり</span>
              <NumberInput value={received} onChange={setReceived} min={0} style={{ width: 140 }} aria-label="お預かり金額" />
            </div>
            <div className="quick-cash">
              <button className="btn sm" onClick={() => setReceived(total)}>ちょうど</button>
              {QUICK_CASH.map((v) => (
                <button key={v} className="btn sm" onClick={() => setReceived(received + v)}>
                  +{v.toLocaleString()}
                </button>
              ))}
            </div>
            <div className="sum-row">
              <span className="muted">お釣り</span>
              <span className={`change num${lines.length && change < 0 ? ' short' : ''}`}>
                {lines.length === 0 ? '—' : change < 0 ? `不足 ${yen(-change)}` : yen(change)}
              </span>
            </div>
          </>
        )}

        <button className="btn primary lg" disabled={!canPay} onClick={complete}>
          会計する
        </button>
      </aside>

      {done && (
        <Modal title="会計完了" onClose={() => setDone(null)}>
          <div className="receipt">
            <div className="muted small" style={{ textAlign: 'center' }}>
              伝票 {done.receiptNo}
            </div>
            {done.payment === 'cash' ? (
              <>
                <div className="muted" style={{ textAlign: 'center', marginTop: 8 }}>お釣り</div>
                <div className="big num">{yen(done.change)}</div>
                <div className="muted small" style={{ textAlign: 'center' }}>
                  合計 {yen(done.total)} ／ お預かり {yen(done.received)}
                </div>
              </>
            ) : (
              <>
                <div className="muted" style={{ textAlign: 'center', marginTop: 8 }}>キャッシュレス決済</div>
                <div className="big num">{yen(done.total)}</div>
              </>
            )}
            {done.discount > 0 && (
              <div className="muted small" style={{ textAlign: 'center', marginTop: 4 }}>
                割引 {yen(done.discount)}（{(done.discounts ?? []).map((d) => d.name).join('、')}）
              </div>
            )}
          </div>
          <div className="actions">
            <button className="btn primary lg" style={{ width: '100%' }} autoFocus onClick={() => setDone(null)}>
              次のお客様へ
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
