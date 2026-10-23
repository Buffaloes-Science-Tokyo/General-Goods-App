import { useState, type Dispatch, type SetStateAction } from 'react'
import { deleteCashFlow, saveCashFlow, useStore, type CashFlowInput } from '../../store'
import { dayKey, downloadText, toCsv, yen } from '../../format'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES, KIND_LABEL } from '../../accounting'
import type { CashFlowEntry } from '../../types'
import { Modal, NumberInput, toast, toastError } from '../../components/ui'
import { AttachmentPicker, AttachmentsButton } from '../../components/Attachments'
import { queueUploads } from '../../attachments'

const today = () => dayKey(new Date())
const blank = (kind: CashFlowEntry['kind'] = 'expense', date = today(), endDate: string | null = null): CashFlowInput => ({
  date, endDate, kind, category: '', counterparty: '', amount: 0, memo: '', attachments: [],
})
/** 記録の最後の日（日付だけの記録はその日） */
const lastDay = (x: Pick<CashFlowEntry, 'date' | 'endDate'>) => x.endDate || x.date
/** 一覧の日付の表示（今年なら月/日、期間は「開始〜終了」） */
function dateLabel(x: Pick<CashFlowEntry, 'date' | 'endDate'>) {
  const year = today().slice(0, 4)
  const fmt = (d: string) => (d.startsWith(year) ? d.slice(5) : d).replaceAll('-', '/')
  return x.endDate ? `${fmt(x.date)}〜${fmt(x.endDate)}` : fmt(x.date)
}
/** 選んだ月と重なるか（期間の記録は、期間のどこかがその月に入っていれば表示する） */
const inMonth = (x: Pick<CashFlowEntry, 'date' | 'endDate'>, month: string) => x.date.slice(0, 7) <= month && lastDay(x).slice(0, 7) >= month
const signedYen = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n))
/** 相手の絞り込みで「相手なし」を表す値 */
const NO_PARTY = '\u0000none'

/**
 * キャッシュフロー。お金の出入りを、種類・日付（または期間）・科目・相手・金額で記録する。
 * 収支の記録とは別のもので、ダッシュボードやプールの収支には含めない
 */
export function CashFlowPage() {
  const { cashFlows } = useStore()
  const [draft, setDraft] = useState<CashFlowInput>(blank)
  const [editing, setEditing] = useState<CashFlowEntry | null>(null)
  const [month, setMonth] = useState(today().slice(0, 7))
  const [kind, setKind] = useState<'all' | CashFlowEntry['kind']>('all')
  const [party, setParty] = useState('all')

  const parties = [...new Set(cashFlows.map((x) => x.counterparty).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'))

  const shown = cashFlows.filter(
    (x) =>
      (!month || inMonth(x, month)) &&
      (kind === 'all' || x.kind === kind) &&
      (party === 'all' || (party === NO_PARTY ? !x.counterparty : x.counterparty === party)),
  )
  const income = shown.filter((x) => x.kind === 'income').reduce((a, x) => a + x.amount, 0)
  const expense = shown.filter((x) => x.kind === 'expense').reduce((a, x) => a + x.amount, 0)

  // 相手ごとの合計（絞り込み後）
  const byParty = new Map<string, { income: number; expense: number }>()
  for (const x of shown) {
    const k = x.counterparty || ''
    const r = byParty.get(k) ?? { income: 0, expense: 0 }
    r[x.kind] += x.amount
    byParty.set(k, r)
  }
  const partyRows = [...byParty.entries()].sort((a, b) => b[1].income + b[1].expense - (a[1].income + a[1].expense))

  function add() {
    const err = validate(draft)
    if (err) return toastError(err)
    saveCashFlow(clean(draft))
    queueUploads(draft.attachments)
    toast(`${KIND_LABEL[draft.kind]} ${yen(draft.amount)} を記録しました`)
    // 続けて入力しやすいよう、日付（期間）と種類は残す
    setDraft(blank(draft.kind, draft.date, draft.endDate ?? null))
  }

  function exportCsv() {
    const out: (string | number)[][] = [['日付（開始日）', '終了日', '種類', '科目', '相手', '金額', 'メモ']]
    for (const x of [...shown].reverse()) out.push([x.date, x.endDate ?? '', KIND_LABEL[x.kind], x.category, x.counterparty, x.amount, x.memo])
    downloadText(`キャッシュフロー_${month || '全期間'}.csv`, toCsv(out), 'text/csv')
  }

  return (
    <div>
      <div className="page-head">
        <h1>キャッシュフロー</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>記録する</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          お金の出入りを、相手ごとに記録します。日付（1日）か期間（開始日〜終了日）を選べます。期間の金額は、その期間の合計として扱います。
          ここでの記録は「収支の記録」とは別のもので、ダッシュボードやプールの収支には含めません。
        </p>
        <CashFlowForm value={draft} onChange={setDraft} />
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
          {parties.length > 0 && (
            <select className="input" value={party} onChange={(e) => setParty(e.target.value)} aria-label="相手" style={{ width: 'auto' }}>
              <option value="all">すべての相手</option>
              {parties.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value={NO_PARTY}>相手なし</option>
            </select>
          )}
          <button className="btn sm" onClick={exportCsv} disabled={!shown.length}>CSV出力</button>
        </div>
        <p className="small" style={{ margin: '0 0 8px' }}>
          {month ? `${Number(month.slice(5))}月（期間の記録は、この月と重なるもの）` : '全期間'}・{shown.length}件　収入 <b className="num">{yen(income)}</b>　支出{' '}
          <b className="num">{yen(expense)}</b>　差引{' '}
          <b className="num" style={{ color: income < expense ? 'var(--critical)' : undefined }}>{signedYen(income - expense)}</b>
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
                  <th>相手</th>
                  <th>メモ</th>
                  <th className="r">金額</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => (
                  <tr key={x.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{dateLabel(x)}</td>
                    <td>
                      <span className={`badge ${x.kind === 'income' ? 'income' : 'expense'}`}>{KIND_LABEL[x.kind]}</span>
                    </td>
                    <td>{x.category}</td>
                    <td>{x.counterparty || <span className="muted">—</span>}</td>
                    <td className="muted small">
                      {x.memo}
                      <AttachmentsButton items={x.attachments} title={`${dateLabel(x)} ${x.category} の画像`} />
                    </td>
                    <td className="r num" style={{ fontWeight: 600 }}>
                      {x.kind === 'expense' ? '−' : ''}
                      {yen(x.amount)}
                    </td>
                    <td className="r" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm ghost" onClick={() => setEditing(x)}>編集</button>{' '}
                      <button
                        className="btn sm ghost"
                        onClick={() => {
                          const who = x.counterparty ? `（${x.counterparty}）` : ''
                          if (!confirm(`${dateLabel(x)} の${KIND_LABEL[x.kind]}「${x.category}」${who}${yen(x.amount)} を削除しますか？`)) return
                          deleteCashFlow(x.id)
                          toast('削除しました')
                        }}
                      >
                        削除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {partyRows.length > 1 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>
            相手ごとの合計<span className="sub">上の絞り込みの範囲</span>
          </h2>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>相手</th>
                  <th className="r">収入</th>
                  <th className="r">支出</th>
                  <th className="r">差引</th>
                </tr>
              </thead>
              <tbody>
                {partyRows.map(([name, r]) => (
                  <tr key={name}>
                    <td className={name ? undefined : 'muted'}>{name || '相手なし'}</td>
                    <td className="r num">{yen(r.income)}</td>
                    <td className="r num">{yen(r.expense)}</td>
                    <td className="r num" style={{ fontWeight: 700, color: r.income < r.expense ? 'var(--critical)' : undefined }}>
                      {signedYen(r.income - r.expense)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && <EditModal key={editing.id} entry={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)

function validate(x: CashFlowInput) {
  if (!isDate(x.date)) return x.endDate == null ? '日付を入力してください' : '開始日を入力してください'
  if (x.endDate != null) {
    if (!isDate(x.endDate)) return '終了日を入力してください'
    if (x.endDate < x.date) return '終了日は開始日以降にしてください'
  }
  if (!x.category.trim()) return '科目を入力してください'
  if (!(x.amount > 0)) return '金額を入力してください'
  return null
}

const clean = (x: CashFlowInput): CashFlowInput => ({
  ...x,
  // 開始日と終了日が同じなら、日付だけの記録にする
  endDate: x.endDate && x.endDate !== x.date ? x.endDate : null,
  category: x.category.trim(),
  counterparty: x.counterparty.trim(),
  memo: x.memo.trim(),
})

function EditModal({ entry, onClose }: { entry: CashFlowEntry; onClose: () => void }) {
  const [v, setV] = useState<CashFlowInput>({
    date: entry.date, endDate: entry.endDate ?? null, kind: entry.kind, category: entry.category, counterparty: entry.counterparty, amount: entry.amount, memo: entry.memo,
    attachments: entry.attachments ?? [],
  })
  const err = validate(v)
  return (
    <Modal title="記録を編集" onClose={onClose}>
      <CashFlowForm value={v} onChange={setV} />
      <div className="actions">
        <button className="btn" onClick={onClose}>やめる</button>
        <button
          className="btn primary"
          disabled={!!err}
          onClick={() => {
            saveCashFlow(clean(v), entry.id)
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

function CashFlowForm({ value: v, onChange }: { value: CashFlowInput; onChange: Dispatch<SetStateAction<CashFlowInput>> }) {
  const { cashFlows, ledger } = useStore()
  // 候補：よく使う科目 ＋ これまでに入力した科目（収支の記録・キャッシュフロー）
  const used = [...cashFlows, ...ledger].filter((x) => x.kind === v.kind).map((x) => x.category).filter(Boolean)
  const categories = [...new Set([...(v.kind === 'income' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES), ...used])]
  const parties = [...new Set(cashFlows.map((x) => x.counterparty).filter(Boolean))]
  const catList = `cashflow-cats-${v.kind}`
  return (
    <div className="form-grid">
      <div className="field">
        種類
        <div className="seg" role="group" aria-label="種類">
          <button type="button" aria-pressed={v.kind === 'expense'} onClick={() => onChange({ ...v, kind: 'expense' })}>支出</button>
          <button type="button" aria-pressed={v.kind === 'income'} onClick={() => onChange({ ...v, kind: 'income' })}>収入</button>
        </div>
      </div>
      <div className="field">
        日付
        <div className="seg" role="group" aria-label="日付の指定">
          <button type="button" aria-pressed={v.endDate == null} onClick={() => onChange({ ...v, endDate: null })}>日付</button>
          <button type="button" aria-pressed={v.endDate != null} onClick={() => v.endDate == null && onChange({ ...v, endDate: v.date })}>期間</button>
        </div>
      </div>
      {v.endDate == null ? (
        <label className="field">
          日付
          <input className="input" type="date" value={v.date} onChange={(e) => onChange({ ...v, date: e.target.value })} />
        </label>
      ) : (
        <>
          <label className="field">
            開始日
            <input className="input" type="date" value={v.date} max={v.endDate || undefined} onChange={(e) => onChange({ ...v, date: e.target.value })} />
          </label>
          <label className="field">
            終了日
            <input className="input" type="date" value={v.endDate} min={v.date || undefined} onChange={(e) => onChange({ ...v, endDate: e.target.value })} />
          </label>
        </>
      )}
      <label className="field">
        科目
        <input
          className="input"
          list={catList}
          value={v.category}
          placeholder={v.kind === 'income' ? '例：雑収入' : '例：会場費'}
          onChange={(e) => onChange({ ...v, category: e.target.value })}
        />
        <datalist id={catList}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="field">
        相手
        <input
          className="input"
          list="cashflow-parties"
          value={v.counterparty}
          placeholder={v.kind === 'income' ? '例：受取元' : '例：支払先'}
          onChange={(e) => onChange({ ...v, counterparty: e.target.value })}
        />
        <datalist id="cashflow-parties">
          {parties.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="field">
        {v.endDate == null ? '金額（円）' : '金額（円・期間の合計）'}
        <NumberInput value={v.amount} min={0} onChange={(n) => onChange({ ...v, amount: n })} />
      </label>
      <label className="field full">
        メモ
        <input className="input" value={v.memo} placeholder="任意" onChange={(e) => onChange({ ...v, memo: e.target.value })} />
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
