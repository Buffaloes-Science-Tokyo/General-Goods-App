import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { deleteLedgerEntry, saveLedgerEntry, useStore, type LedgerInput } from '../../store'
import { dayKey, downloadText, toCsv, yen } from '../../format'
import { collectFlows, EXPENSE_CATEGORIES, INCOME_CATEGORIES, isPurchase, KIND_LABEL, NO_POOL } from '../../accounting'
import type { LedgerEntry } from '../../types'
import { Modal, NumberInput, toast, toastError } from '../../components/ui'
import { AttachmentPicker, AttachmentsButton } from '../../components/Attachments'
import { queueUploads } from '../../attachments'

const today = () => dayKey(new Date())
const blank = (kind: LedgerEntry['kind'] = 'expense', date = today(), poolId: string | null = null): LedgerInput => ({
  date, kind, category: '', amount: 0, memo: '', poolId, counterparty: '', attachments: [],
})
const clean = (x: LedgerInput): LedgerInput => ({ ...x, category: x.category.trim(), memo: x.memo.trim(), counterparty: (x.counterparty ?? '').trim() })

/** URL の「?pool=…」（プールのタブから開いたとき） */
const poolFromHash = () => new URLSearchParams(location.hash.split('?')[1] ?? '').get('pool') ?? 'all'

/**
 * 一覧の1行：手入力の記録、在庫の仕入（入荷）から自動で作った支出、
 * またはレジの売上・手数料（プールで絞り込んだときだけ。日ごと・科目ごとにまとめる）
 */
type Row = {
  id: string
  date: string
  kind: LedgerEntry['kind']
  category: string
  amount: number
  memo: string
  poolId: string | null
  entry: LedgerEntry | null
  /** 自動の行の出どころ（編集できない理由の表示用） */
  source?: 'stock' | 'register'
}

/**
 * 収支の記録。手入力の記録に加えて、在庫の仕入（入荷・初期在庫）を支出として自動で載せる（編集は入荷の記録の側で行う）。
 * プールで絞り込んだときは、そのプールに反映されるレジの売上・手数料も日ごとにまとめて載せ、プールの収支が分かるようにする
 */
export function LedgerPage() {
  const { ledger, sales, activeStockEvents, products, hubs, pools, basePools, settings } = useStore()
  const flows = useMemo(
    () => collectFlows({ sales, activeStockEvents, products, ledger, hubs, pools, basePools }),
    [sales, activeStockEvents, products, ledger, hubs, pools, basePools],
  )
  const [pool, setPool] = useState(poolFromHash)
  // 絞り込んでいるプールを、記録するときの初期値にする
  const poolOf = (id: string) => (pools.some((p) => p.id === id) ? id : null)
  const [draft, setDraft] = useState<LedgerInput>(() => blank('expense', today(), poolOf(pool)))
  const [editing, setEditing] = useState<LedgerEntry | null>(null)
  const [month, setMonth] = useState(today().slice(0, 7))
  const [kind, setKind] = useState<'all' | LedgerEntry['kind']>('all')
  // 削除したプールも、過去の記録の表示のために名前を引けるようにする
  const poolName = new Map((settings.pools ?? []).map((p) => [p.id, p.name]))

  const entries = new Map(ledger.map((x) => [x.id, x]))
  const register = new Map<string, Row & { count: number }>()
  const rows: Row[] = []
  for (const f of flows) {
    if (!f.auto) rows.push({ ...f, entry: entries.get(f.id) ?? null })
    else if (isPurchase(f)) rows.push({ ...f, entry: null, source: 'stock' })
    else if (pool !== 'all') {
      const key = `${f.date}|${f.poolId}|${f.category}`
      const r = register.get(key) ?? { ...f, id: key, amount: 0, entry: null, source: 'register' as const, count: 0 }
      r.amount += f.amount
      r.count++
      register.set(key, r)
    }
  }
  for (const r of register.values()) rows.push({ ...r, memo: `${r.count}件` })
  rows.sort((a, b) => b.date.localeCompare(a.date))

  const shown = rows.filter(
    (x) =>
      (!month || x.date.startsWith(month)) &&
      (kind === 'all' || x.kind === kind) &&
      (pool === 'all' || (x.poolId ?? NO_POOL) === pool),
  )
  const income = shown.filter((x) => x.kind === 'income').reduce((a, x) => a + x.amount, 0)
  const expense = shown.filter((x) => x.kind === 'expense').reduce((a, x) => a + x.amount, 0)

  function add() {
    const err = validate(draft)
    if (err) return toastError(err)
    saveLedgerEntry(clean(draft))
    queueUploads(draft.attachments)
    toast(`${KIND_LABEL[draft.kind]} ${yen(draft.amount)} を記録しました`)
    // 続けて入力しやすいよう、日付・種類・プールは残す
    setDraft(blank(draft.kind, draft.date, draft.poolId ?? null))
  }

  const poolLabel = (id: string | null) => (id ? poolName.get(id) ?? '' : '')
  const filterName = pool === 'all' ? '' : pool === NO_POOL ? '_未設定' : `_${poolLabel(pool)}`

  function exportCsv() {
    const out: (string | number)[][] = [['日付', '種類', 'プール', '科目', 'キャッシュフロー対応', '金額', 'メモ']]
    for (const x of [...shown].reverse()) {
      out.push([x.date, KIND_LABEL[x.kind], poolLabel(x.poolId), x.category, x.entry?.counterparty ?? '', x.amount, x.memo])
    }
    downloadText(`収支の記録_${month || '全期間'}${filterName}.csv`, toCsv(out), 'text/csv')
  }

  return (
    <div>
      <div className="page-head">
        <h1>収支の記録</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>記録する</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          会場費・交通費などの経費や、レジ以外の収入を記録します。
          在庫の仕入（「商品・在庫」での入荷・初期在庫）は、仕入額（数量 × 仕入単価）が支出として自動で計上されるので入力不要です。
          レジの売上・手数料もダッシュボードに自動で反映されます。
          プールを選ぶと、そのプールの収支として数えます（プールは「プール」タブで追加できます）。
        </p>
        <EntryForm value={draft} onChange={setDraft} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" onClick={add} disabled={!!validate(draft)}>記録する</button>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }} className="grow">記録の一覧</h2>
          <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="月" />
          <button className="btn sm ghost" onClick={() => setMonth('')} disabled={!month}>全期間</button>
          {pools.length > 0 && (
            <select className="input" value={pool} onChange={(e) => setPool(e.target.value)} aria-label="プール" style={{ width: 'auto' }}>
              <option value="all">すべてのプール</option>
              {pools.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value={NO_POOL}>プール未設定</option>
            </select>
          )}
          <div className="seg" role="group" aria-label="種類">
            <button aria-pressed={kind === 'all'} onClick={() => setKind('all')}>すべて</button>
            <button aria-pressed={kind === 'income'} onClick={() => setKind('income')}>収入</button>
            <button aria-pressed={kind === 'expense'} onClick={() => setKind('expense')}>支出</button>
          </div>
          <button className="btn sm" onClick={exportCsv} disabled={!shown.length}>CSV出力</button>
        </div>
        <p className="small" style={{ margin: '0 0 8px' }}>
          {month ? `${Number(month.slice(5))}月` : '全期間'}・{shown.length}件　収入 <b className="num">{yen(income)}</b>　支出{' '}
          <b className="num">{yen(expense)}</b>
          {pool !== 'all' && (
            <>
              　収支{' '}
              <b className="num" style={{ color: income < expense ? 'var(--critical)' : undefined }}>
                {income < expense ? `−${yen(expense - income)}` : yen(income - expense)}
              </b>
            </>
          )}
        </p>
        {pool !== 'all' && (
          <p className="muted small" style={{ margin: '0 0 8px' }}>
            レジの売上・キャッシュレスの手数料は、ハブの設定でこのプールに反映される分を日ごとにまとめて表示しています。
          </p>
        )}
        {shown.length === 0 ? (
          <div className="empty">記録はありません</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>種類</th>
                  {pools.length > 0 && <th>プール</th>}
                  <th>科目</th>
                  <th>キャッシュフロー対応</th>
                  <th>メモ</th>
                  <th className="r">金額</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id}>
                    <td className="num">{x.date.slice(5).replace('-', '/')}</td>
                    <td>
                      <span className={`badge ${x.kind === 'income' ? 'income' : 'expense'}`}>{KIND_LABEL[x.kind]}</span>
                    </td>
                    {pools.length > 0 && (
                      <td className="small">
                        {x.poolId ? (
                          poolName.get(x.poolId)
                        ) : x.entry?.poolId && poolName.has(x.entry.poolId) ? (
                          <span className="muted">{poolName.get(x.entry.poolId)}（削除済み）</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    )}
                    <td>
                      {x.category}
                      {!x.entry && <span className="badge" style={{ marginLeft: 6 }}>自動</span>}
                    </td>
                    <td className="small">{x.entry?.counterparty || <span className="muted">—</span>}</td>
                    <td className="muted small">
                      {x.memo}
                      <AttachmentsButton items={x.entry?.attachments} title={`${x.date} ${x.category} の画像`} />
                    </td>
                    <td className="r num" style={{ fontWeight: 600 }}>
                      {x.kind === 'expense' ? '−' : ''}
                      {yen(x.amount)}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {x.source === 'register' ? (
                        <span className="muted small" title="会計の取消は、レジアプリの販売履歴で行います">レジから</span>
                      ) : !x.entry ? (
                        <span className="muted small" title="入荷の数量・単価の修正や取消は、レジアプリの在庫の履歴で行います">在庫の入荷から</span>
                      ) : (
                        <>
                          <button className="btn sm ghost" onClick={() => setEditing(x.entry)}>編集</button>{' '}
                          <button
                            className="btn sm ghost"
                            onClick={() => {
                              if (!confirm(`${x.date} の${KIND_LABEL[x.kind]}「${x.category}」${yen(x.amount)} を削除しますか？`)) return
                              deleteLedgerEntry(x.id)
                              toast('削除しました')
                            }}
                          >
                            削除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && <EditModal key={editing.id} entry={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function validate(x: LedgerInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date)) return '日付を入力してください'
  if (!x.category.trim()) return '科目を入力してください'
  if (!(x.amount > 0)) return '金額を入力してください'
  return null
}

function EditModal({ entry, onClose }: { entry: LedgerEntry; onClose: () => void }) {
  const [v, setV] = useState<LedgerInput>({
    date: entry.date, kind: entry.kind, category: entry.category, amount: entry.amount, memo: entry.memo, poolId: entry.poolId ?? null,
    counterparty: entry.counterparty ?? '', attachments: entry.attachments ?? [],
  })
  const err = validate(v)
  return (
    <Modal title="記録を編集" onClose={onClose}>
      <EntryForm value={v} onChange={setV} />
      <div className="actions">
        <button className="btn" onClick={onClose}>やめる</button>
        <button
          className="btn primary"
          disabled={!!err}
          onClick={() => {
            saveLedgerEntry(clean(v), entry.id)
            queueUploads(v.attachments)
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

function EntryForm({ value: v, onChange }: { value: LedgerInput; onChange: Dispatch<SetStateAction<LedgerInput>> }) {
  const { ledger, pools, cashFlows } = useStore()
  // 相手名の候補：キャッシュフローの相手 ＋ これまでに収支の記録で入力した相手（候補に無い名前も入力できる）
  const parties = [...new Set([...cashFlows, ...ledger].map((x) => x.counterparty ?? '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))
  // 候補：よく使う科目 ＋ これまでに入力した科目
  const used = ledger.filter((x) => x.kind === v.kind).map((x) => x.category)
  const options = [...new Set([...(v.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...used])]
  const listId = `ledger-cats-${v.kind}`
  return (
    <div className="form-grid">
      <div className="field">
        種類
        <div className="seg" role="group" aria-label="種類">
          <button type="button" aria-pressed={v.kind === 'expense'} onClick={() => onChange({ ...v, kind: 'expense' })}>支出</button>
          <button type="button" aria-pressed={v.kind === 'income'} onClick={() => onChange({ ...v, kind: 'income' })}>収入</button>
        </div>
      </div>
      <label className="field">
        日付
        <input className="input" type="date" value={v.date} onChange={(e) => onChange({ ...v, date: e.target.value })} />
      </label>
      <label className="field">
        科目
        <input
          className="input"
          list={listId}
          value={v.category}
          placeholder={v.kind === 'income' ? '例：雑収入' : '例：会場費'}
          onChange={(e) => onChange({ ...v, category: e.target.value })}
        />
        <datalist id={listId}>
          {options.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      {pools.length > 0 && (
        <label className="field">
          プール
          <select
            className="input"
            value={pools.some((p) => p.id === v.poolId) ? v.poolId! : ''}
            onChange={(e) => onChange({ ...v, poolId: e.target.value || null })}
          >
            <option value="">未設定</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        キャッシュフロー対応（相手名）
        <input
          className="input"
          list="ledger-cashflow-parties"
          value={v.counterparty ?? ''}
          placeholder="任意（キャッシュフローの相手）"
          onChange={(e) => onChange({ ...v, counterparty: e.target.value })}
        />
        <datalist id="ledger-cashflow-parties">
          {parties.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="field">
        金額（円）
        <NumberInput value={v.amount} min={0} onChange={(n) => onChange({ ...v, amount: n })} />
      </label>
      <label className="field full">
        メモ
        <input className="input" value={v.memo} placeholder="任意（支払先・内容など）" onChange={(e) => onChange({ ...v, memo: e.target.value })} />
      </label>
      <div className="field full">
        画像（レシートなど）
        <AttachmentPicker
          value={v.attachments ?? []}
          onAdd={(list) => onChange((x) => ({ ...x, attachments: [...(x.attachments ?? []), ...list] }))}
          onRemove={(id) => onChange((x) => ({ ...x, attachments: (x.attachments ?? []).filter((a) => a.id !== id) }))}
        />
      </div>
    </div>
  )
}
