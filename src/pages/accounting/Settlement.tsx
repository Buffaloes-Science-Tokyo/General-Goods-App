import { useState } from 'react'
import { useStore } from '../../store'
import { downloadText, toCsv, yen } from '../../format'
import { KIND_LABEL } from '../../accounting'
import { Modal } from '../../components/ui'

/** 対象名ごとの、必要な額（キャッシュフロー）と実際の額（収支の記録の「キャッシュフロー対応」） */
type Party = {
  name: string
  /** 必要な返金額（キャッシュフローの支出） */
  refundDue: number
  /** 実際に支出した額（記録の支出） */
  refundPaid: number
  /** 必要な徴収額（キャッシュフローの収入） */
  collectDue: number
  /** 実際の収入額（記録の収入） */
  collected: number
}

/** 明細の1行 */
type Line = { id: string; source: 'cashflow' | 'ledger'; date: string; endDate?: string | null; kind: 'income' | 'expense'; category: string; amount: number; memo: string }

const signedYen = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n))

/** 残り（必要 − 実際）の表示。0 なら済み、マイナスなら払いすぎ・取りすぎ */
function Remain({ due, done, over }: { due: number; done: number; over: string }) {
  const r = due - done
  if (due === 0 && done === 0) return <span className="muted">—</span>
  if (r === 0) return <span className="badge on">済み</span>
  if (r < 0) return <span style={{ color: 'var(--critical)' }} title={`${yen(-r)} ${over}`}>{signedYen(r)}（{over}）</span>
  return <b>{yen(r)}</b>
}

/**
 * 徴収・返金の管理。キャッシュフローに記録した「必要な額」と、収支の記録で「キャッシュフロー対応」に
 * 相手名を書いた「実際の額」を、対象名ごとに突き合わせて差を出す
 */
export function SettlementPage() {
  const { cashFlows, ledger } = useStore()
  const [onlyOpen, setOnlyOpen] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)

  const map = new Map<string, Party>()
  const get = (name: string) => {
    let p = map.get(name)
    if (!p) map.set(name, (p = { name, refundDue: 0, refundPaid: 0, collectDue: 0, collected: 0 }))
    return p
  }
  for (const x of cashFlows) {
    if (!x.counterparty) continue
    const p = get(x.counterparty)
    if (x.kind === 'expense') p.refundDue += x.amount
    else p.collectDue += x.amount
  }
  for (const x of ledger) {
    if (!x.counterparty) continue
    const p = get(x.counterparty)
    if (x.kind === 'expense') p.refundPaid += x.amount
    else p.collected += x.amount
  }
  const isOpen = (p: Party) => p.refundDue !== p.refundPaid || p.collectDue !== p.collected
  const parties = [...map.values()].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || a.name.localeCompare(b.name, 'ja'))
  const shown = onlyOpen ? parties.filter(isOpen) : parties

  const sum = (k: keyof Omit<Party, 'name'>) => shown.reduce((a, p) => a + p[k], 0)
  const total = { refundDue: sum('refundDue'), refundPaid: sum('refundPaid'), collectDue: sum('collectDue'), collected: sum('collected') }

  function exportCsv() {
    const out: (string | number)[][] = [['対象', '必要な返金額', '支出した額', '返金の残り', '必要な徴収額', '収入額', '徴収の残り']]
    for (const p of shown) {
      out.push([p.name, p.refundDue, p.refundPaid, p.refundDue - p.refundPaid, p.collectDue, p.collected, p.collectDue - p.collected])
    }
    downloadText('徴収返金管理.csv', toCsv(out), 'text/csv')
  }

  return (
    <div>
      <div className="page-head">
        <h1>徴収返金管理</h1>
        <button className="btn" onClick={exportCsv} disabled={!shown.length}>CSV出力</button>
      </div>

      <p className="muted small" style={{ marginTop: 0 }}>
        対象名ごとに、キャッシュフローに記録した額を「必要な額」、収支の記録で「キャッシュフロー対応」にその名前を書いた額を「実際の額」として突き合わせます。
        返金はキャッシュフローの支出と記録の支出、徴収はキャッシュフローの収入と記録の収入を比べます。残りがマイナスのときは、必要な額より多く支出・収入しています。
      </p>

      <div className="kpis">
        <div className="card kpi">
          <div className="label">返金の残り</div>
          <div className="value">{signedYen(total.refundDue - total.refundPaid)}</div>
          <div className="delta">必要 {yen(total.refundDue)}・支出済み {yen(total.refundPaid)}</div>
        </div>
        <div className="card kpi">
          <div className="label">徴収の残り</div>
          <div className="value">{signedYen(total.collectDue - total.collected)}</div>
          <div className="delta">必要 {yen(total.collectDue)}・収入済み {yen(total.collected)}</div>
        </div>
        <div className="card kpi">
          <div className="label">残りがある対象</div>
          <div className="value">{parties.filter(isOpen).length}件</div>
          <div className="delta">全 {parties.length}件</div>
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }} className="grow">対象ごと</h2>
          <div className="seg" role="group" aria-label="表示">
            <button aria-pressed={!onlyOpen} onClick={() => setOnlyOpen(false)}>すべて</button>
            <button aria-pressed={onlyOpen} onClick={() => setOnlyOpen(true)}>残りがあるもの</button>
          </div>
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            {parties.length ? '残りがある対象はありません' : 'キャッシュフローの相手、または記録の「キャッシュフロー対応」に入力した対象名がありません'}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th rowSpan={2}>対象</th>
                  <th colSpan={3} style={{ textAlign: 'center' }}>返金</th>
                  <th colSpan={3} style={{ textAlign: 'center' }}>徴収</th>
                  <th rowSpan={2}></th>
                </tr>
                <tr>
                  <th className="r">必要な額</th>
                  <th className="r">支出した額</th>
                  <th className="r">残り</th>
                  <th className="r">必要な額</th>
                  <th className="r">収入額</th>
                  <th className="r">残り</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.name}>
                    <td><b>{p.name}</b></td>
                    <td className="r num">{yen(p.refundDue)}</td>
                    <td className="r num">{yen(p.refundPaid)}</td>
                    <td className="r num"><Remain due={p.refundDue} done={p.refundPaid} over="支出しすぎ" /></td>
                    <td className="r num">{yen(p.collectDue)}</td>
                    <td className="r num">{yen(p.collected)}</td>
                    <td className="r num"><Remain due={p.collectDue} done={p.collected} over="収入しすぎ" /></td>
                    <td className="r">
                      <button className="btn sm ghost" onClick={() => setDetail(p.name)}>明細</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>合計</td>
                  <td className="r num">{yen(total.refundDue)}</td>
                  <td className="r num">{yen(total.refundPaid)}</td>
                  <td className="r num">{signedYen(total.refundDue - total.refundPaid)}</td>
                  <td className="r num">{yen(total.collectDue)}</td>
                  <td className="r num">{yen(total.collected)}</td>
                  <td className="r num">{signedYen(total.collectDue - total.collected)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {detail !== null && <DetailModal name={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

/** 対象名の明細（キャッシュフローと記録） */
function DetailModal({ name, onClose }: { name: string; onClose: () => void }) {
  const { cashFlows, ledger } = useStore()
  const lines: Line[] = [
    ...cashFlows.filter((x) => x.counterparty === name).map((x) => ({ ...x, source: 'cashflow' as const })),
    ...ledger.filter((x) => x.counterparty === name).map((x) => ({ ...x, source: 'ledger' as const })),
  ].sort((a, b) => b.date.localeCompare(a.date))
  const date = (x: Line) => (x.endDate ? `${x.date}〜${x.endDate}` : x.date).replaceAll('-', '/')
  return (
    <Modal title={`${name} の明細`} onClose={onClose}>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>日付</th>
              <th>区分</th>
              <th>科目</th>
              <th>メモ</th>
              <th className="r">金額</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((x) => (
              <tr key={`${x.source}:${x.id}`}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{date(x)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {x.source === 'cashflow' ? (x.kind === 'expense' ? '必要な返金' : '必要な徴収') : x.kind === 'expense' ? '支出した' : '収入した'}
                  <div className="muted small">{x.source === 'cashflow' ? 'キャッシュフロー' : '記録'}・{KIND_LABEL[x.kind]}</div>
                </td>
                <td>{x.category || <span className="muted">—</span>}</td>
                <td className="muted small">{x.memo}</td>
                <td className="r num" style={{ fontWeight: 600 }}>{yen(x.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions">
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </Modal>
  )
}
