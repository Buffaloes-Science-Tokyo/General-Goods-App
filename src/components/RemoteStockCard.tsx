import { useEffect, useState } from 'react'
import { uid, updateRemote, useStore } from '../store'
import { fullName } from '../format'
import type { RemoteSettings } from '../types'
import { NumberInput, toast, toastError } from './ui'

const EMPTY: RemoteSettings = { active: false, eventId: '', name: '', allocations: {} }

/** 遠方物販：商品ごとの持ち出し数と、遠方モードの開始・終了 */
export function RemoteStockCard() {
  const { products, stock, remote } = useStore()
  const saved = remote?.settings ?? EMPTY
  const [r, setR] = useState<RemoteSettings>(saved)
  const [query, setQuery] = useState('')
  // 表示は同期のたびに作り直されるので、中身が変わったときだけ入力欄を更新する
  const savedKey = JSON.stringify(saved)
  useEffect(() => setR(JSON.parse(savedKey)), [savedKey])
  const dirty = savedKey !== JSON.stringify(r)

  const setAlloc = (id: string, n: number) => {
    const allocations = { ...r.allocations }
    if (n > 0) allocations[id] = n
    else delete allocations[id]
    setR({ ...r, allocations })
  }
  const totalQty = Object.values(r.allocations).reduce((a, b) => a + b, 0)
  const listed = products.filter(
    (p) =>
      (p.active || r.allocations[p.id]) &&
      (!query || `${p.name} ${p.type} ${p.size} ${p.sku} ${p.category}`.toLowerCase().includes(query.toLowerCase())),
  )

  function save(next: RemoteSettings, message: string) {
    updateRemote(next)
    toast(message)
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>遠方物販（持ち出し在庫）</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        遠方に持っていく数を商品ごとに決めます。遠方モード中のレジには持ち出した商品だけが表示され、
        「持ち出し数 − 遠方で売れた数」を超えては売れません。売れた分は本体の在庫からも減ります。設定は全端末で共有されます。
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <span>
          状態：
          {saved.active ? <b>遠方モード中{saved.name && `（${saved.name}）`}</b> : <span className="muted">通常</span>}
        </span>
      </div>

      <div className="form-grid">
        <label className="field">
          物販の名前
          <input className="input" value={r.name} placeholder="例：大阪イベント" onChange={(e) => setR({ ...r, name: e.target.value })} />
        </label>
        <label className="field">
          商品を探す
          <input className="input" value={query} placeholder="商品名・カテゴリ・商品コード" onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>商品</th>
              <th className="num">本体在庫</th>
              <th className="num">持ち出し数</th>
              {saved.active && <th className="num">売れた</th>}
              {saved.active && <th className="num">残り</th>}
            </tr>
          </thead>
          <tbody>
            {listed.map((p) => {
              const alloc = r.allocations[p.id] ?? 0
              const sold = remote?.sold.get(p.id) ?? 0
              const left = stock.get(p.id) ?? 0
              return (
                <tr key={p.id}>
                  <td>{fullName(p)}</td>
                  <td className="num">{left}</td>
                  <td className="num">
                    <NumberInput value={alloc} min={0} onChange={(n) => setAlloc(p.id, n)} style={{ width: 80 }} aria-label={`${fullName(p)}の持ち出し数`} />
                  </td>
                  {saved.active && <td className="num">{sold}</td>}
                  {saved.active && <td className="num">{alloc ? Math.max(0, Math.min(left, alloc - sold)) : '—'}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">持ち出し {Object.keys(r.allocations).length}商品・{totalQty}点</p>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty} onClick={() => save(r, '持ち出し在庫を保存しました')}>
          保存
        </button>
        <button className="btn ghost" disabled={totalQty === 0} onClick={() => setR({ ...r, allocations: {} })}>
          持ち出し数をすべて 0 に
        </button>
        {saved.active ? (
          <button
            className="btn danger"
            onClick={() => {
              if (!confirm('遠方モードを終了して、レジを通常の表示に戻しますか？（全端末に反映されます）')) return
              save({ ...r, active: false }, '遠方モードを終了しました')
            }}
          >
            遠方モードを終了
          </button>
        ) : (
          <button
            className="btn"
            onClick={() => {
              if (totalQty === 0) return toastError('持ち出し数を入力してください')
              if (!confirm('遠方モードを開始しますか？全端末のレジが持ち出した商品だけの表示になり、売れた数は 0 から数えます。')) return
              save({ ...r, active: true, eventId: uid() }, '遠方モードを開始しました')
            }}
          >
            遠方モードを開始
          </button>
        )}
      </div>
    </div>
  )
}
