import { useEffect, useState } from 'react'
import { addHub, BASE_HUB_NAME, deleteHub, NO_POOLS, resetHubSold, updateBasePools, updateHub, useStore } from '../store'
import { fullName } from '../format'
import type { HubPools, StockHub } from '../types'
import { NumberInput, toast, toastError } from './ui'

/** 棚卸しハブの追加・編集と、ハブごとの持ち出し数 */
export function HubsCard() {
  const { hubs, basePools } = useStore()
  // 編集中のハブ（null = ベース）
  const [sel, setSel] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const current = hubs.find((h) => h.hub.id === sel) ?? null

  function add() {
    const name = newName.trim()
    if (!name) return
    if (name === BASE_HUB_NAME || hubs.some((h) => h.hub.name === name)) return toastError('同じ名前のハブがあります')
    setSel(addHub(name))
    setAdding(false)
    setNewName('')
    toast(`ハブ「${name}」を追加しました`)
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>棚卸しハブ</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        物販の会場など、在庫を持っていく先をハブとして登録し、ハブごとに持っていく数を決めます。
        レジでハブを選ぶと、そのハブに持っていった商品だけが表示され、「持ち出し数 − そのハブで売れた数」を超えては売れません。
        売れた分は本体の在庫からも減ります。ハブの設定は全端末で共有されます。
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <button className="chip" aria-pressed={sel === null} onClick={() => setSel(null)}>
          {BASE_HUB_NAME}
        </button>
        {hubs.map((h) => (
          <button key={h.hub.id} className="chip" aria-pressed={sel === h.hub.id} onClick={() => setSel(h.hub.id)}>
            {h.hub.name}
          </button>
        ))}
        {adding ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <input
              className="input"
              autoFocus
              placeholder="ハブの名前（例：大阪イベント）"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              style={{ width: 220 }}
            />
            <button className="btn sm primary" type="submit" disabled={!newName.trim()}>追加</button>
            <button className="btn sm ghost" type="button" onClick={() => setAdding(false)}>やめる</button>
          </form>
        ) : (
          <button className="btn sm" onClick={() => setAdding(true)}>＋ ハブを追加</button>
        )}
      </div>

      {current ? (
        <HubEditor key={current.hub.id} hub={current.hub} sold={current.sold} onDeleted={() => setSel(null)} />
      ) : (
        <>
          <div className="muted small" style={{ padding: '8px 0' }}>
            「{BASE_HUB_NAME}」はすべての在庫です。名前や持ち出し数は変更できません。
            {hubs.length === 0 && '「＋ ハブを追加」で持っていく先を登録してください。'}
          </div>
          <PoolSelects value={basePools} onChange={updateBasePools} />
        </>
      )}
    </div>
  )
}

function HubEditor({ hub, sold, onDeleted }: { hub: StockHub; sold: Map<string, number>; onDeleted: () => void }) {
  const { products, stock, hubs } = useStore()
  const [h, setH] = useState(hub)
  const [query, setQuery] = useState('')
  // 表示は同期のたびに作り直されるので、中身が変わったときだけ入力欄を更新する
  const savedKey = JSON.stringify({ name: hub.name, allocations: hub.allocations })
  useEffect(() => {
    const saved = JSON.parse(savedKey) as Pick<StockHub, 'name' | 'allocations'>
    setH((cur) => ({ ...cur, ...saved }))
  }, [savedKey])
  const dirty = savedKey !== JSON.stringify({ name: h.name, allocations: h.allocations })

  const setAlloc = (id: string, n: number) => {
    const allocations = { ...h.allocations }
    if (n > 0) allocations[id] = n
    else delete allocations[id]
    setH({ ...h, allocations })
  }
  const totalQty = Object.values(h.allocations).reduce((a, b) => a + b, 0)
  const soldTotal = [...sold.values()].reduce((a, b) => a + b, 0)
  const listed = products.filter(
    (p) =>
      (p.active || h.allocations[p.id]) &&
      (!query || `${p.name} ${p.type} ${p.size} ${p.sku} ${p.category}`.toLowerCase().includes(query.toLowerCase())),
  )

  function save() {
    const name = h.name.trim()
    if (!name) return toastError('ハブの名前を入力してください')
    if (name === BASE_HUB_NAME || hubs.some((x) => x.hub.id !== hub.id && x.hub.name === name)) {
      return toastError('同じ名前のハブがあります')
    }
    updateHub(hub.id, { name, allocations: h.allocations })
    toast('保存しました')
  }

  return (
    <>
      <div className="form-grid">
        <label className="field">
          ハブの名前
          <input className="input" value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />
        </label>
        <label className="field">
          商品を探す
          <input className="input" value={query} placeholder="商品名・カテゴリ・商品コード" onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>

      <div style={{ marginTop: 12 }}>
        <PoolSelects value={hub.pools ?? NO_POOLS} onChange={(pools) => updateHub(hub.id, { pools })} />
      </div>

      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>商品</th>
              <th className="num">本体在庫</th>
              <th className="num">持ち出し数</th>
              <th className="num">売れた</th>
              <th className="num">残り</th>
            </tr>
          </thead>
          <tbody>
            {listed.map((p) => {
              const alloc = h.allocations[p.id] ?? 0
              const s = sold.get(p.id) ?? 0
              const left = stock.get(p.id) ?? 0
              return (
                <tr key={p.id}>
                  <td>{fullName(p)}</td>
                  <td className="num">{left}</td>
                  <td className="num">
                    <NumberInput value={alloc} min={0} onChange={(n) => setAlloc(p.id, n)} style={{ width: 80 }} aria-label={`${fullName(p)}の持ち出し数`} />
                  </td>
                  <td className="num">{s || ''}</td>
                  <td className="num">{alloc ? Math.max(0, Math.min(left, alloc - s)) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        持ち出し {Object.keys(h.allocations).length}商品・{totalQty}点・売れた {soldTotal}点
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty} onClick={save}>保存</button>
        <button className="btn ghost" disabled={totalQty === 0} onClick={() => setH({ ...h, allocations: {} })}>
          持ち出し数をすべて 0 に
        </button>
        <button
          className="btn"
          disabled={soldTotal === 0}
          onClick={() => {
            if (!confirm(`「${hub.name}」の売れた数を 0 に戻しますか？（過去の売上はそのまま残ります）`)) return
            resetHubSold(hub.id)
            toast('売れた数をリセットしました')
          }}
        >
          売れた数をリセット
        </button>
        <button
          className="btn danger"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            if (!confirm(`ハブ「${hub.name}」を削除しますか？\nこのハブを選んでいるレジはベースに戻ります（過去の売上はそのまま残ります）。`)) return
            deleteHub(hub.id)
            onDeleted()
            toast('削除しました')
          }}
        >
          ハブを削除
        </button>
      </div>
    </>
  )
}

/** レジの売上（現金・キャッシュレス）を反映する会計のプール。選んだらすぐ保存する */
function PoolSelects({ value, onChange }: { value: HubPools; onChange: (v: HubPools) => void }) {
  const { pools } = useStore()
  if (!pools.length) {
    return <p className="muted small" style={{ margin: 0 }}>売上の反映先にする会計のプールは、会計アプリの「プール」で追加できます。</p>
  }
  const select = (key: keyof HubPools, label: string) => (
    <label className="field">
      {label}
      <select
        className="input"
        value={pools.some((p) => p.id === value[key]) ? value[key]! : ''}
        onChange={(e) => {
          onChange({ ...value, [key]: e.target.value || null })
          toast('売上の反映先を保存しました')
        }}
      >
        <option value="">未設定</option>
        {pools.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
    </label>
  )
  return (
    <div className="form-grid">
      {select('cash', '現金の売上の反映先（会計のプール）')}
      {select('cashless', 'キャッシュレスの売上の反映先（会計のプール）')}
    </div>
  )
}
