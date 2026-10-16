import { useMemo, useState } from 'react'
import { addPool, BASE_HUB_NAME, deletePool, updatePool, useStore } from '../../store'
import { yen } from '../../format'
import { byPool, collectFlows, NO_POOL } from '../../accounting'
import type { Pool } from '../../types'
import { Modal, toast, toastError } from '../../components/ui'

const signedYen = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n))

/** 収支の記録を、そのプールで絞り込んで開く */
const openLedger = (pool: string) => (location.hash = `accounting-records?pool=${encodeURIComponent(pool)}`)

/**
 * プール（お金の置き場所）の追加・編集と、プールごとの収支（全期間）。
 * レジの売上をどのプールに入れるかは、レジアプリの「棚卸し」のハブの設定で選ぶ
 */
export function PoolsPage() {
  const { sales, activeStockEvents, products, ledger, hubs, pools, basePools } = useStore()
  const flows = useMemo(
    () => collectFlows({ sales, activeStockEvents, products, ledger, hubs, pools, basePools }),
    [sales, activeStockEvents, products, ledger, hubs, pools, basePools],
  )
  const sums = byPool(flows, pools)
  const [name, setName] = useState('')
  const [memo, setMemo] = useState('')
  const [editing, setEditing] = useState<Pool | null>(null)

  // プール → そこに売上が入るハブ（「ベース・現金」など）
  const feeds = new Map<string, string[]>()
  const feed = (pool: string | null, label: string) => pool && feeds.set(pool, [...(feeds.get(pool) ?? []), label])
  for (const [hubName, p] of [[BASE_HUB_NAME, basePools] as const, ...hubs.map((h) => [h.hub.name, h.hub.pools] as const)]) {
    feed(p?.cash ?? null, `${hubName}・現金`)
    feed(p?.cashless ?? null, `${hubName}・キャッシュレス`)
  }

  const duplicate = (n: string, id?: string) => pools.some((p) => p.id !== id && p.name === n)

  function add() {
    const n = name.trim()
    if (!n) return
    if (duplicate(n)) return toastError('同じ名前のプールがあります')
    addPool(n, memo)
    setName('')
    setMemo('')
    toast(`プール「${n}」を追加しました`)
  }

  const unassigned = sums.get(NO_POOL)

  return (
    <div>
      <div className="page-head">
        <h1>プール</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>プールを追加</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          手元の現金・銀行口座・決済サービスの残高など、お金の置き場所ごとにプールを作り、収支をプールごとにまとめます。
          レジの売上をどのプールに入れるかは、レジアプリの「棚卸し」でハブごとに（現金・キャッシュレス別に）選べます。
          手入力の収支は「収支の記録」でプールを選んで記録します。
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            add()
          }}
        >
          <input className="input" placeholder="プールの名前（例：手元の現金）" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 220 }} />
          <input className="input grow" placeholder="メモ（任意）" value={memo} onChange={(e) => setMemo(e.target.value)} />
          <button className="btn primary" type="submit" disabled={!name.trim()}>追加</button>
        </form>
      </div>

      <div className="card">
        <h2>プールごとの収支（全期間）</h2>
        {pools.length === 0 ? (
          <div className="empty">プールはまだありません</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>プール</th>
                  <th>レジの売上の反映元</th>
                  <th className="r">収入</th>
                  <th className="r">支出</th>
                  <th className="r">収支</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pools.map((p) => {
                  const t = sums.get(p.id) ?? { income: 0, expense: 0, net: 0 }
                  return (
                    <tr key={p.id}>
                      <td>
                        <b>{p.name}</b>
                        {p.memo && <div className="muted small">{p.memo}</div>}
                      </td>
                      <td className="small">{feeds.get(p.id)?.join('、') || <span className="muted">—</span>}</td>
                      <td className="r num">{yen(t.income)}</td>
                      <td className="r num">{yen(t.expense)}</td>
                      <td className="r num" style={{ fontWeight: 700, color: t.net < 0 ? 'var(--critical)' : undefined }}>{signedYen(t.net)}</td>
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm" onClick={() => openLedger(p.id)}>記録を見る</button>{' '}
                        <button className="btn sm ghost" onClick={() => setEditing(p)}>編集</button>
                      </td>
                    </tr>
                  )
                })}
                {unassigned && (
                  <tr>
                    <td className="muted">未設定</td>
                    <td className="muted small">プールを選んでいない記録・オンラインの注文・在庫の仕入</td>
                    <td className="r num">{yen(unassigned.income)}</td>
                    <td className="r num">{yen(unassigned.expense)}</td>
                    <td className="r num" style={{ fontWeight: 700, color: unassigned.net < 0 ? 'var(--critical)' : undefined }}>
                      {signedYen(unassigned.net)}
                    </td>
                    <td className="r">
                      <button className="btn sm" onClick={() => openLedger(NO_POOL)}>記録を見る</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          レジの会計は、会計した時点のハブの設定で反映先が決まります（設定を変えても、それまでの会計は元のプールのまま）。
          設定する前の会計は、今の設定に従って数えます。キャッシュレスの手数料は、売上と同じプールの支出になります。
        </p>
      </div>

      {editing && (
        <EditModal
          key={editing.id}
          pool={editing}
          duplicate={(n) => duplicate(n, editing.id)}
          inUse={!!feeds.get(editing.id)?.length}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function EditModal({ pool, duplicate, inUse, onClose }: { pool: Pool; duplicate: (name: string) => boolean; inUse: boolean; onClose: () => void }) {
  const [name, setName] = useState(pool.name)
  const [memo, setMemo] = useState(pool.memo)
  return (
    <Modal title="プールを編集" onClose={onClose}>
      <div className="form-grid">
        <label className="field">
          名前
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          メモ
          <input className="input" value={memo} placeholder="任意" onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button
          className="btn danger"
          style={{ marginRight: 'auto' }}
          onClick={() => {
            const note = inUse ? '\nこのプールを反映先にしているハブは「未設定」になります。' : ''
            if (!confirm(`プール「${pool.name}」を削除しますか？\nこのプールの記録は消えず、「未設定」として数えます。${note}`)) return
            deletePool(pool.id)
            toast('削除しました')
            onClose()
          }}
        >
          削除
        </button>
        <button className="btn" onClick={onClose}>やめる</button>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={() => {
            const n = name.trim()
            if (duplicate(n)) return toastError('同じ名前のプールがあります')
            updatePool(pool.id, { name: n, memo: memo.trim() })
            toast('保存しました')
            onClose()
          }}
        >
          保存
        </button>
      </div>
    </Modal>
  )
}
