import { useMemo, useState } from 'react'
import { deleteLedgerEntry, saveLedgerEntry, useStore, type LedgerInput } from '../../store'
import { dayKey, downloadText, toCsv, yen } from '../../format'
import { collectFlows, EXPENSE_CATEGORIES, INCOME_CATEGORIES, isPurchase, KIND_LABEL } from '../../accounting'
import type { LedgerEntry } from '../../types'
import { Modal, NumberInput, toast, toastError } from '../../components/ui'

const today = () => dayKey(new Date())
const blank = (kind: LedgerEntry['kind'] = 'expense', date = today()): LedgerInput => ({ date, kind, category: '', amount: 0, memo: '' })

/** 一覧の1行：手入力の記録、または在庫の仕入（入荷）から自動で作った支出 */
type Row = { id: string; date: string; kind: LedgerEntry['kind']; category: string; amount: number; memo: string; entry: LedgerEntry | null }

/**
 * 収支の記録。手入力の記録に加えて、在庫の仕入（入荷・初期在庫）を支出として自動で載せる（編集は入荷の記録の側で行う）。
 * レジの売上・手数料はダッシュボードで合算する
 */
export function LedgerPage() {
  const { ledger, activeStockEvents, products } = useStore()
  const purchases = useMemo(
    () => collectFlows({ sales: [], activeStockEvents, products, ledger: [] }).filter(isPurchase),
    [activeStockEvents, products],
  )
  const rows: Row[] = [
    ...ledger.map((x) => ({ ...x, entry: x })),
    ...purchases.map((f) => ({ id: f.id, date: f.date, kind: f.kind, category: f.category, amount: f.amount, memo: f.memo, entry: null })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  const [draft, setDraft] = useState<LedgerInput>(blank)
  const [editing, setEditing] = useState<LedgerEntry | null>(null)
  const [month, setMonth] = useState(today().slice(0, 7))
  const [kind, setKind] = useState<'all' | LedgerEntry['kind']>('all')

  const shown = rows.filter((x) => (!month || x.date.startsWith(month)) && (kind === 'all' || x.kind === kind))
  const income = shown.filter((x) => x.kind === 'income').reduce((a, x) => a + x.amount, 0)
  const expense = shown.filter((x) => x.kind === 'expense').reduce((a, x) => a + x.amount, 0)

  function add() {
    const err = validate(draft)
    if (err) return toastError(err)
    saveLedgerEntry({ ...draft, category: draft.category.trim(), memo: draft.memo.trim() })
    toast(`${KIND_LABEL[draft.kind]} ${yen(draft.amount)} を記録しました`)
    // 続けて入力しやすいよう、日付と種類は残す
    setDraft(blank(draft.kind, draft.date))
  }

  function exportCsv() {
    const out: (string | number)[][] = [['日付', '種類', '科目', '金額', 'メモ']]
    for (const x of [...shown].reverse()) out.push([x.date, KIND_LABEL[x.kind], x.category, x.amount, x.memo])
    downloadText(`収支の記録_${month || '全期間'}.csv`, toCsv(out), 'text/csv')
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
        </p>
        {shown.length === 0 ? (
          <div className="empty">記録はありません</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>日付</th>
                  <th>種類</th>
                  <th>科目</th>
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
                    <td>
                      {x.category}
                      {!x.entry && <span className="badge" style={{ marginLeft: 6 }}>自動</span>}
                    </td>
                    <td className="muted small">{x.memo}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>
                      {x.kind === 'expense' ? '−' : ''}
                      {yen(x.amount)}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      {!x.entry ? (
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
  const [v, setV] = useState<LedgerInput>({ date: entry.date, kind: entry.kind, category: entry.category, amount: entry.amount, memo: entry.memo })
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
            saveLedgerEntry({ ...v, category: v.category.trim(), memo: v.memo.trim() }, entry.id)
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

function EntryForm({ value: v, onChange }: { value: LedgerInput; onChange: (v: LedgerInput) => void }) {
  const { ledger } = useStore()
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
      <label className="field">
        金額（円）
        <NumberInput value={v.amount} min={0} onChange={(n) => onChange({ ...v, amount: n })} />
      </label>
      <label className="field full">
        メモ
        <input className="input" value={v.memo} placeholder="任意（支払先・内容など）" onChange={(e) => onChange({ ...v, memo: e.target.value })} />
      </label>
    </div>
  )
}
