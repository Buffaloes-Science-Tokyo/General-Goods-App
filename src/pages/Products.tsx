import { Fragment, useMemo, useState } from 'react'
import { addProduct, deleteProduct, restock, revalueCost, setStock, updateProduct, useStore, type ProductInput } from '../store'
import { previewAvg, type CostInfo } from '../costing'
import { CHANNEL_LABEL, floorPrice } from '../pricing'
import { compareSize, dateTime, groupByName, downloadText, fullName, pct, toCsv, yen } from '../format'
import type { Product, StockReason } from '../types'
import { Modal, NumberInput, StockBadge, toast, VariantSummary } from '../components/ui'

const REASON: Record<StockReason, string> = {
  initial: '初期在庫',
  sale: '販売',
  restock: '入荷',
  adjust: '調整',
  void: '取消戻し',
  revalue: '原価修正',
}

/** 平均原価は小数になりうるので、表示は円未満を四捨五入 */
const costYen = (n: number) => yen(Math.round(n))

type Filter = 'all' | 'low' | 'inactive'

export function ProductsPage() {
  const { products, stock, costing, fees } = useStore()
  const avgOf = (p: Product) => costing.byProduct.get(p.id)?.avg ?? p.cost
  // 'new' = 新規 / { copyOf } = 既存商品を元に別サイズ・タイプを追加 / Product = 編集
  const [editing, setEditing] = useState<Product | 'new' | { copyOf: Product } | null>(null)
  const [stockTarget, setStockTarget] = useState<Product | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const lowCount = products.filter((p) => (stock.get(p.id) ?? 0) <= p.lowStock).length
  const shown = products.filter((p) => {
    const s = stock.get(p.id) ?? 0
    if (filter === 'low' && s > p.lowStock) return false
    if (filter === 'inactive' && p.active) return false
    if (query && !`${p.name} ${p.type} ${p.size} ${p.sku} ${p.category}`.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })
  // 商品名が同じもの（タイプ・サイズ違い）は1行にまとめ、▲で中身を表示
  const groups = groupByName(shown)
  const [open, setOpen] = useState<Set<string>>(new Set())
  // 検索・絞り込み中は該当するタイプ・サイズが見えるよう全部開く
  const autoOpen = filter !== 'all' || !!query
  const toggleOpen = (name: string) => {
    const next = new Set(open)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setOpen(next)
  }

  const totals = useMemo(() => {
    let units = 0
    let retail = 0
    let costValue = 0
    for (const p of products) {
      const s = Math.max(0, stock.get(p.id) ?? 0)
      units += s
      retail += s * p.price
      costValue += s * (costing.byProduct.get(p.id)?.avg ?? p.cost)
    }
    return { units, retail, costValue }
  }, [products, stock, costing])

  function exportCsv() {
    const rows: (string | number)[][] = [
      ['商品コード', '商品名', 'タイプ', 'サイズ', 'カテゴリ', '販売価格', '平均原価', '直近仕入単価', '粗利率', '在庫数', '在庫金額(原価)', '在庫下限', '販売中'],
    ]
    for (const p of products) {
      const avg = avgOf(p)
      const s = stock.get(p.id) ?? 0
      rows.push([
        p.sku, p.name, p.type, p.size, p.category, p.price, Math.round(avg * 100) / 100, costing.byProduct.get(p.id)?.lastCost ?? '',
        p.price ? ((p.price - avg) / p.price).toFixed(3) : '', s, Math.round(Math.max(0, s) * avg), p.lowStock, p.active ? '○' : '',
      ])
    }
    downloadText(`在庫一覧_${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), 'text/csv')
  }

  function productRow(p: Product, child: boolean) {
    const s = stock.get(p.id) ?? 0
    const avg = avgOf(p)
    const last = costing.byProduct.get(p.id)?.lastCost
    const margin = p.price - avg
    return (
      <tr key={p.id} className={`${p.active ? '' : 'inactive'}${child ? ' variant-row' : ''}`}>
        <td>
          <div style={{ fontWeight: 600 }}>
            {!child && p.name}
            {p.type && <span className="attr">{p.type}</span>}
            {p.size && <span className="attr size">{p.size}</span>}
          </div>
          <div className="muted small">{p.sku}{!p.active && '・販売停止中'}</div>
        </td>
        <td>{p.category}</td>
        <td className="r">
          <NumberInput
            value={p.price}
            min={0}
            onChange={(v) => updateProduct(p.id, { price: v })}
            style={{ width: 96 }}
            aria-label={`${fullName(p)} の販売価格`}
          />
          <FloorNote price={p.price} floor={floorPrice(p, avg, fees).price} />
        </td>
        <td className="r num">
          {costYen(avg)}
          {last != null && Math.round(last) !== Math.round(avg) && (
            <div className="muted small">直近仕入 {yen(last)}</div>
          )}
        </td>
        <td className="r num">
          {costYen(margin)}
          <div className="muted small">{p.price ? pct(margin / p.price) : '—'}</div>
        </td>
        <td className="r num">
          <div style={{ fontWeight: 700, fontSize: 16 }}>{s}</div>
          <StockBadge stock={s} low={p.lowStock} />
        </td>
        <td className="r" style={{ whiteSpace: 'nowrap' }}>
          <button className="btn sm" onClick={() => setStockTarget(p)}>在庫</button>{' '}
          <button className="btn sm ghost" onClick={() => setEditing(p)}>編集</button>
        </td>
      </tr>
    )
  }

  return (
    <div>
      <div className="page-head">
        <h1>商品・在庫・価格</h1>
        <button className="btn" onClick={exportCsv} disabled={!products.length}>CSV出力</button>
        <button className="btn primary" onClick={() => setEditing('new')}>＋ 商品を追加</button>
      </div>

      <div className="kpis">
        <div className="card kpi">
          <div className="label">商品数</div>
          <div className="value">{products.length}</div>
        </div>
        <div className="card kpi">
          <div className="label">在庫点数</div>
          <div className="value">{totals.units.toLocaleString()}</div>
        </div>
        <div className="card kpi">
          <div className="label">在庫金額（売価）</div>
          <div className="value">{yen(totals.retail)}</div>
          <div className="delta">原価 {yen(totals.costValue)}</div>
        </div>
        <div className="card kpi">
          <div className="label">要補充</div>
          <div className="value">{lowCount}</div>
          <div className="delta">在庫下限以下の商品</div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="seg" role="group" aria-label="絞り込み">
            <button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>すべて</button>
            <button aria-pressed={filter === 'low'} onClick={() => setFilter('low')}>要補充 ({lowCount})</button>
            <button aria-pressed={filter === 'inactive'} onClick={() => setFilter('inactive')}>販売停止中</button>
          </div>
          <input className="input grow" placeholder="検索" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 280 }} />
        </div>

        {products.length === 0 ? (
          <div className="empty">
            まだ商品がありません。「＋ 商品を追加」から登録するか、「設定」タブでサンプルデータを読み込めます。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>商品</th>
                  <th>カテゴリ</th>
                  <th className="r">販売価格</th>
                  <th className="r">平均原価</th>
                  <th className="r">粗利 / 率</th>
                  <th className="r">在庫</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  if (g.items.length === 1) return productRow(g.items[0], false)
                  const isOpen = autoOpen || open.has(g.name)
                  const s = g.items.reduce((a, p) => a + (stock.get(p.id) ?? 0), 0)
                  const prices = g.items.map((p) => p.price)
                  const lo = Math.min(...prices)
                  const hi = Math.max(...prices)
                  const cats = [...new Set(g.items.map((p) => p.category))]
                  return (
                    <Fragment key={`g:${g.name}`}>
                      <tr className="group-row" onClick={() => toggleOpen(g.name)}>
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            <button
                              className={`tri-btn${isOpen ? ' open' : ''}`}
                              aria-expanded={isOpen}
                              aria-label={isOpen ? 'タイプ・サイズを閉じる' : 'タイプ・サイズを表示'}
                              onClick={(e) => {
                                e.stopPropagation()
                                toggleOpen(g.name)
                              }}
                            >
                              ▲
                            </button>
                            {g.name}
                            <span className="muted small" style={{ fontWeight: 400, marginLeft: 6 }}>{g.items.length}種類</span>
                          </div>
                          <VariantSummary items={g.items} />
                        </td>
                        <td>{cats.join('・')}</td>
                        <td className="r num">{lo === hi ? yen(lo) : `${yen(lo)}〜${yen(hi)}`}</td>
                        <td></td>
                        <td></td>
                        <td className="r num">
                          <div style={{ fontWeight: 700, fontSize: 16 }}>{s}</div>
                          <div className="muted small">合計</div>
                        </td>
                        <td></td>
                      </tr>
                      {isOpen && g.items.map((p) => productRow(p, true))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
            {shown.length === 0 && <div className="empty">該当する商品はありません</div>}
          </div>
        )}
      </div>

      {editing && (
        <ProductForm
          key={editing === 'new' ? 'new' : 'copyOf' in editing ? `copy-${editing.copyOf.id}` : editing.id}
          product={editing === 'new' || 'copyOf' in editing ? null : editing}
          copyOf={editing !== 'new' && 'copyOf' in editing ? editing.copyOf : null}
          onDuplicate={(p) => setEditing({ copyOf: p })}
          onClose={() => setEditing(null)}
        />
      )}
      {stockTarget && <StockModal product={stockTarget} onClose={() => setStockTarget(null)} />}
    </div>
  )
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]

/** 販売価格の下に最低額を小さく出す。下回っていれば赤 */
function FloorNote({ price, floor }: { price: number; floor: number }) {
  if (!Number.isFinite(floor)) return <div className="small" style={{ color: 'var(--critical)' }}>最低額 計算不可</div>
  const below = price < floor
  return (
    <div className="small" style={{ color: below ? 'var(--critical)' : 'var(--muted)' }} title="最悪の場合でも粗利を下回らない最低の価格">
      {below ? '▼ ' : ''}最低 {yen(floor)}
    </div>
  )
}

function ProductForm({
  product,
  copyOf,
  onDuplicate,
  onClose,
}: {
  product: Product | null
  /** この商品の内容を引き継いで、別のサイズ・タイプとして新規登録する */
  copyOf: Product | null
  onDuplicate: (p: Product) => void
  onClose: () => void
}) {
  const { products, costing, fees } = useStore()
  const categories = uniq(products.map((p) => p.category))
  const types = uniq(products.map((p) => p.type))
  const sizes = uniq(products.map((p) => p.size)).sort(compareSize)
  const nextSku = `G-${String(products.length + 1).padStart(3, '0')}`
  const [f, setF] = useState<ProductInput>(() => {
    if (product) return product
    if (copyOf) {
      const { id: _id, updatedAt: _u, deleted: _d, ...rest } = copyOf
      // 原価は元の商品の現在の平均原価を初期値にする
      const cost = Math.round(costing.byProduct.get(copyOf.id)?.avg ?? copyOf.cost)
      return { ...rest, cost, size: '', sku: nextSku, active: true }
    }
    return { name: '', category: categories[0] ?? '', type: '', size: '', price: 0, cost: 0, lowStock: 5, sku: nextSku, active: true }
  })
  const [initial, setInitial] = useState(0)
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setF({ ...f, [k]: v })
  const avg = product ? (costing.byProduct.get(product.id)?.avg ?? product.cost) : f.cost
  const margin = f.price - avg

  function save() {
    if (!f.name.trim()) return
    const clean = { ...f, name: f.name.trim(), category: f.category.trim(), type: f.type.trim(), size: f.size.trim() }
    const dup = products.find(
      (p) => p.id !== product?.id && p.name === clean.name && p.type === clean.type && p.size === clean.size,
    )
    if (dup && !confirm(`同じ商品名・タイプ・サイズの商品「${fullName(dup)}」がすでにあります。このまま保存しますか？`)) return
    if (product) {
      const { cost: _unused, ...rest } = clean
      updateProduct(product.id, rest)
      toast('保存しました')
    } else {
      addProduct(clean, initial)
      toast('商品を追加しました')
    }
    onClose()
  }

  function remove() {
    if (!product) return
    if (!confirm(`「${fullName(product)}」を削除しますか？（販売履歴は残ります）`)) return
    deleteProduct(product.id)
    toast('削除しました')
    onClose()
  }

  return (
    <Modal title={product ? '商品を編集' : copyOf ? `「${copyOf.name}」の別サイズ・タイプを追加` : '商品を追加'} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="field full">
          商品名
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus={!copyOf} required />
        </label>
        <label className="field">
          タイプ
          <input
            className="input"
            list="type-list"
            value={f.type}
            onChange={(e) => set('type', e.target.value)}
            placeholder="例：ブラック、通常版（任意）"
          />
          <datalist id="type-list">
            {types.map((t) => <option key={t} value={t} />)}
          </datalist>
        </label>
        <label className="field">
          サイズ
          <input
            className="input"
            list="size-list"
            value={f.size}
            onChange={(e) => set('size', e.target.value)}
            placeholder="例：M、L、F（任意）"
            autoFocus={!!copyOf}
          />
          <datalist id="size-list">
            {uniq([...sizes, 'S', 'M', 'L', 'XL', 'F']).map((s) => <option key={s} value={s} />)}
          </datalist>
        </label>
        <label className="field">
          カテゴリ
          <input className="input" list="cat-list" value={f.category} onChange={(e) => set('category', e.target.value)} />
          <datalist id="cat-list">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
        </label>
        <label className="field">
          商品コード
          <input className="input" value={f.sku} onChange={(e) => set('sku', e.target.value)} />
        </label>
        <label className="field">
          販売価格（円・税込）
          <NumberInput value={f.price} min={0} onChange={(v) => set('price', v)} />
        </label>
        {product ? (
          <div className="field">
            平均原価
            <div style={{ padding: '7px 0', color: 'var(--ink)' }} className="num">
              {costYen(avg)}
            </div>
          </div>
        ) : (
          <label className="field">
            仕入単価（原価・円）
            <NumberInput value={f.cost} min={0} onChange={(v) => set('cost', v)} />
          </label>
        )}
        <div className="full muted small">
          粗利 {costYen(margin)}（粗利率 {f.price ? pct(margin / f.price) : '—'}）
          {product && '・原価は「在庫」の入荷（仕入単価）や原価修正で更新されます'}
        </div>
        {!product && (
          <label className="field">
            初期在庫
            <NumberInput value={initial} min={0} onChange={setInitial} />
          </label>
        )}
        <div className="full field">
          最悪の場合の追加コスト（1点あたり・円）
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <span className="muted small">レジで売るとき</span>
            <NumberInput value={f.extraCostStore ?? 0} min={0} onChange={(v) => set('extraCostStore', v)} style={{ width: 80 }} aria-label="レジの追加コスト" />
            <span className="muted small">オンラインで売るとき</span>
            <NumberInput value={f.extraCostOnline ?? 0} min={0} onChange={(v) => set('extraCostOnline', v)} style={{ width: 80 }} aria-label="オンラインの追加コスト" />
          </div>
          <span className="muted small">袋・梱包材・おまけなど。割引の最低額の計算に使います（実際の粗利からは引きません）。</span>
          {(() => {
            const fl = floorPrice({ ...f, id: product?.id ?? '', deleted: false, updatedAt: '' } as Product, avg, fees)
            return (
              <span className="small">
                最低額 <b className="num">{Number.isFinite(fl.price) ? yen(fl.price) : '計算できません'}</b>
                <span className="muted">
                  （{CHANNEL_LABEL[fl.channel]}で売った場合。原価 {costYen(fl.cost)}＋追加 {yen(fl.extra)}
                  {fl.rate ? `・手数料 ${fl.rate}%` : ''}
                  {fl.fixed ? `＋${yen(fl.fixed)}` : ''}）
                </span>
                {f.price < fl.price && <span style={{ color: 'var(--critical)' }}> 販売価格が最低額を下回っています</span>}
              </span>
            )
          })()}
        </div>
        <label className="field">
          在庫下限（この数以下で警告）
          <NumberInput value={f.lowStock} min={0} onChange={(v) => set('lowStock', v)} />
        </label>
        <label className="full row" style={{ fontSize: 14 }}>
          <input type="checkbox" checked={f.active} onChange={(e) => set('active', e.target.checked)} />
          レジに表示する（販売中）
        </label>
        <div className="full actions" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            {product && (
              <>
                <button type="button" className="btn danger" onClick={remove}>削除</button>
                <button type="button" className="btn" onClick={() => onDuplicate(product)} title="商品名・価格などを引き継いで新しく登録">
                  別サイズ・タイプを追加
                </button>
              </>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>キャンセル</button>
            <button type="submit" className="btn primary" disabled={!f.name.trim()}>保存</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

type StockMode = 'restock' | 'count' | 'revalue'

function StockModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const { stock, stockEvents, costing } = useStore()
  const current = stock.get(product.id) ?? 0
  const info: CostInfo = costing.byProduct.get(product.id) ?? { avg: product.cost, lastCost: null, stock: current }
  const [mode, setMode] = useState<StockMode>('restock')
  const [qty, setQty] = useState(0)
  const [unitCost, setUnitCost] = useState(Math.round(info.lastCost ?? info.avg))
  const [actual, setActual] = useState(current)
  const [newCost, setNewCost] = useState(Math.round(info.avg))
  const [note, setNote] = useState('')
  const history = stockEvents.filter((e) => e.productId === product.id).slice(-30).reverse()
  const nextAvg = previewAvg(info, qty, unitCost)

  function switchMode(m: StockMode) {
    setMode(m)
    setActual(current)
    setNewCost(Math.round(info.avg))
  }

  function apply() {
    if (mode === 'restock') {
      if (qty <= 0) return
      restock(product.id, qty, unitCost, note)
      toast(`${qty}個 入荷しました（平均原価 ${costYen(nextAvg)}）`)
      setQty(0)
    } else if (mode === 'count') {
      if (actual === current) return
      setStock(product.id, actual, note || '棚卸し')
      toast(`在庫を ${actual} に修正しました`)
    } else {
      revalueCost(product.id, newCost, note)
      toast(`平均原価を ${yen(newCost)} に修正しました`)
    }
    setNote('')
  }

  const disabled =
    mode === 'restock' ? qty <= 0 : mode === 'count' ? actual === current : Math.round(info.avg) === newCost

  return (
    <Modal title={`在庫：${fullName(product)}`} onClose={onClose}>
      <div className="row" style={{ marginBottom: 4 }}>
        <div className="grow">
          在庫 <b className="num" style={{ fontSize: 22 }}>{current}</b>
          <span className="muted small" style={{ marginLeft: 12 }}>
            平均原価 <b className="num">{costYen(info.avg)}</b>
            {info.lastCost != null && <>・直近仕入 {yen(info.lastCost)}</>}
          </span>
        </div>
      </div>
      <div className="seg" role="group" style={{ margin: '8px 0 12px' }}>
        <button aria-pressed={mode === 'restock'} onClick={() => switchMode('restock')}>入荷</button>
        <button aria-pressed={mode === 'count'} onClick={() => switchMode('count')}>棚卸し</button>
        <button aria-pressed={mode === 'revalue'} onClick={() => switchMode('revalue')}>原価修正</button>
      </div>
      <div className="form-grid">
        {mode === 'restock' && (
          <>
            <label className="field">
              入荷数
              <NumberInput value={qty} min={0} onChange={setQty} autoFocus />
            </label>
            <label className="field">
              仕入単価（円）
              <NumberInput value={unitCost} min={0} onChange={setUnitCost} />
            </label>
            <div className="full muted small">
              {qty > 0 ? (
                <>
                  入荷後：在庫 {current + qty}・平均原価 {costYen(info.avg)} →{' '}
                  <b style={{ color: 'var(--ink)' }}>{costYen(nextAvg)}</b>
                  （粗利率 {product.price ? pct((product.price - nextAvg) / product.price) : '—'}）
                </>
              ) : (
                '仕入単価が前回と違っても、在庫全体の平均原価（移動平均）で粗利を計算します。'
              )}
            </div>
          </>
        )}
        {mode === 'count' && (
          <label className="field">
            実際の在庫数
            <NumberInput value={actual} min={0} onChange={setActual} autoFocus />
          </label>
        )}
        {mode === 'revalue' && (
          <>
            <label className="field">
              修正後の平均原価（円）
              <NumberInput value={newCost} min={0} onChange={setNewCost} autoFocus />
            </label>
            <div className="full muted small">
              入力ミスの訂正などに使います。在庫数は変わらず、これ以降の販売の粗利がこの原価で計算されます（過去の販売は変わりません）。
            </div>
          </>
        )}
        <label className="field">
          メモ
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="任意（仕入先など）" />
        </label>
        <div className="full">
          <button className="btn primary" onClick={apply} disabled={disabled}>
            {mode === 'restock'
              ? `＋${qty} 入荷する`
              : mode === 'count'
                ? `在庫を ${actual} にする（${actual - current >= 0 ? '+' : ''}${actual - current}）`
                : `平均原価を ${yen(newCost)} にする`}
          </button>
        </div>
      </div>

      <h4 style={{ margin: '20px 0 8px', fontSize: 14 }}>在庫の履歴（直近30件）</h4>
      <table className="tbl">
        <thead>
          <tr>
            <th>日時</th>
            <th>内容</th>
            <th>メモ</th>
            <th className="r">単価</th>
            <th className="r">数量</th>
          </tr>
        </thead>
        <tbody>
          {history.map((e) => (
            <tr key={e.id}>
              <td className="muted small">{dateTime(e.at)}</td>
              <td>{REASON[e.reason]}</td>
              <td className="muted small">{e.note}</td>
              <td className="r num muted">{e.unitCost != null ? yen(e.unitCost) : ''}</td>
              <td className="r num" style={{ fontWeight: 600 }}>
                {e.reason === 'revalue' ? '—' : e.delta > 0 ? `+${e.delta}` : e.delta}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {history.length === 0 && <div className="muted small">履歴はありません</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </Modal>
  )
}
