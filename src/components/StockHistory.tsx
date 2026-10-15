import { Fragment, useState } from 'react'
import { cancelStockEvent, correctStockEvent, isCorrectable, stockAfter, useStore } from '../store'
import { dateTime, fullName, yen } from '../format'
import type { StockEvent, StockReason } from '../types'
import { NumberInput, toast } from './ui'

export const REASON: Record<StockReason, string> = {
  initial: '初期在庫',
  sale: '販売',
  restock: '入荷',
  adjust: '在庫調整',
  void: '取消戻し',
  revalue: '原価修正',
  cancel: '取り消し',
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n))

/**
 * 在庫の履歴。入荷・棚卸し・原価修正は、行の「修正」「取消」で直せる。
 * 記録は消さずに「取り消し」「修正版」を追記する（端末間の同期でずれないように）。
 */
export function StockHistory({ events, showProduct = false }: { events: StockEvent[]; showProduct?: boolean }) {
  const { products, cancelledBy, stockEvents } = useStore()
  const [editing, setEditing] = useState<string | null>(null)
  const byId = new Map(stockEvents.map((e) => [e.id, e]))
  const productName = (id: string) => {
    const p = products.find((x) => x.id === id)
    return p ? fullName(p) : '（削除された商品）'
  }
  const cols = showProduct ? 7 : 6

  function cancel(e: StockEvent) {
    const what = `${dateTime(e.at)} の「${REASON[e.reason]}」`
    const effect = e.reason === 'revalue' ? '平均原価を計算し直します。' : `在庫が ${signed(-e.delta)} 変わります。`
    if (!confirm(`${what}を取り消しますか？\n${effect}`)) return
    cancelStockEvent(e.id)
    toast('取り消しました')
  }

  if (events.length === 0) return <div className="muted small">履歴はありません</div>

  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>日時</th>
            {showProduct && <th>商品</th>}
            <th>内容</th>
            <th>メモ</th>
            <th className="r">単価</th>
            <th className="r">数量</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => {
            const by = cancelledBy.get(e.id)
            const target = e.cancels ? byId.get(e.cancels) : undefined
            return (
              <Fragment key={e.id}>
                <tr className={by ? 'voided' : ''}>
                  <td className="muted small">{dateTime(e.at)}</td>
                  {showProduct && <td>{productName(e.productId)}</td>}
                  <td>
                    {REASON[e.reason] ?? e.reason}
                    {e.cancels && e.reason !== 'cancel' && <span className="badge" style={{ marginLeft: 6 }}>修正後</span>}
                  </td>
                  <td className="muted small">
                    {e.reason === 'cancel' && target && (
                      <div>
                        {dateTime(target.at)} の{REASON[target.reason]}
                        {target.reason === 'revalue' ? `（${yen(target.unitCost ?? 0)}）` : `（${signed(target.delta)}）`}を取り消し
                      </div>
                    )}
                    {e.note}
                  </td>
                  <td className="r num muted">{e.unitCost != null ? yen(e.unitCost) : ''}</td>
                  <td className="r num" style={{ fontWeight: 600 }}>
                    {e.reason === 'revalue' || e.reason === 'cancel' ? '—' : signed(e.delta)}
                  </td>
                  <td className="r nostrike" style={{ whiteSpace: 'nowrap' }}>
                    {by ? (
                      <span className="badge">{by.reason === 'cancel' ? '取消済' : '修正済'}</span>
                    ) : (
                      isCorrectable(e) && (
                        <>
                          <button className="btn sm ghost" onClick={() => setEditing(editing === e.id ? null : e.id)}>修正</button>{' '}
                          <button className="btn sm ghost" onClick={() => cancel(e)}>取消</button>
                        </>
                      )
                    )}
                  </td>
                </tr>
                {editing === e.id && !by && (
                  <tr>
                    <td colSpan={cols} style={{ background: 'var(--surface-2)' }}>
                      <CorrectForm event={e} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 1件の記録を正しい値に直すフォーム */
function CorrectForm({ event: e, onDone }: { event: StockEvent; onDone: () => void }) {
  const { stock } = useStore()
  const current = stock.get(e.productId) ?? 0
  const after = stockAfter(e.id)
  const [qty, setQty] = useState(e.delta)
  const [actual, setActual] = useState(after)
  const [unitCost, setUnitCost] = useState(e.unitCost ?? 0)
  const [note, setNote] = useState(e.note)

  const isRestock = e.reason === 'restock' || e.reason === 'initial'
  // 棚卸しは「その時点の実数」で直す。差の分だけ記録の数量を変える
  const delta = isRestock ? qty : e.reason === 'adjust' ? e.delta + (actual - after) : 0
  const cost = isRestock || e.reason === 'revalue' ? unitCost : null
  const changed = delta !== e.delta || cost !== (e.unitCost ?? null) || note !== e.note
  const invalid = isRestock && qty <= 0

  function save() {
    correctStockEvent(e.id, { delta, unitCost: cost, note })
    toast('修正しました')
    onDone()
  }

  return (
    <div className="form-grid" style={{ padding: '4px 0' }}>
      {isRestock && (
        <>
          <label className="field">
            正しい入荷数
            <NumberInput value={qty} min={0} onChange={setQty} autoFocus />
          </label>
          <label className="field">
            正しい仕入単価（円）
            <NumberInput value={unitCost} min={0} onChange={setUnitCost} />
          </label>
        </>
      )}
      {e.reason === 'adjust' && (
        <label className="field">
          そのときの正しい実数（記録では {after}）
          <NumberInput value={actual} min={0} onChange={setActual} autoFocus />
        </label>
      )}
      {e.reason === 'revalue' && (
        <label className="field">
          正しい平均原価（円）
          <NumberInput value={unitCost} min={0} onChange={setUnitCost} autoFocus />
        </label>
      )}
      <label className="field">
        メモ
        <input className="input" value={note} onChange={(ev) => setNote(ev.target.value)} />
      </label>
      <div className="full muted small">
        {e.reason === 'revalue'
          ? 'この時点からの平均原価を計算し直します。'
          : `現在の在庫 ${current} → ${current + delta - e.delta}`}
        {isRestock && qty <= 0 && '・入荷が無かった場合は「取消」を使ってください'}
      </div>
      <div className="full row">
        <button className="btn primary" onClick={save} disabled={!changed || invalid}>修正する</button>
        <button className="btn" onClick={onDone}>やめる</button>
      </div>
    </div>
  )
}
