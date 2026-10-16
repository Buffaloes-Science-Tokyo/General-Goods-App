import { useMemo, useState } from 'react'
import { useStore } from '../../store'
import { dayKey, downloadText, toCsv, yen } from '../../format'
import { byCategory, byMonth, byPool, collectFlows, KIND_LABEL, NO_POOL, totals, type Flow } from '../../accounting'
import { BarList } from '../../components/charts'

type Preset = 'thisMonth' | 'lastMonth' | 'thisYear' | 'all' | 'custom'
const PRESET_LABEL: Record<Exclude<Preset, 'custom'>, string> = { thisMonth: '今月', lastMonth: '先月', thisYear: '今年', all: '全期間' }

function presetRange(p: Exclude<Preset, 'custom'>, flows: Flow[]): [string, string] {
  const d = new Date()
  const y = d.getFullYear()
  const m = d.getMonth()
  if (p === 'thisMonth') return [dayKey(new Date(y, m, 1)), dayKey(new Date(y, m + 1, 0))]
  if (p === 'lastMonth') return [dayKey(new Date(y, m - 1, 1)), dayKey(new Date(y, m, 0))]
  if (p === 'thisYear') return [`${y}-01-01`, `${y}-12-31`]
  return flows.length ? [flows[0].date, flows[flows.length - 1].date] : [dayKey(d), dayKey(d)]
}

const signedYen = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n))
const monthLabel = (k: string) => `${k.slice(0, 4)}年${Number(k.slice(5))}月`

export function AccountingDashboardPage() {
  const { sales, activeStockEvents, products, ledger, hubs, pools, basePools } = useStore()
  const flows = useMemo(
    () => collectFlows({ sales, activeStockEvents, products, ledger, hubs, pools, basePools }),
    [sales, activeStockEvents, products, ledger, hubs, pools, basePools],
  )
  const [preset, setPreset] = useState<Preset>('thisMonth')
  const [custom, setCustom] = useState<[string, string]>(() => presetRange('thisMonth', []))
  const [from, to] = preset === 'custom' ? custom : presetRange(preset, flows)

  const inRange = flows.filter((f) => f.date >= from && f.date <= to)
  const t = totals(inRange)
  const autoIncome = inRange.filter((f) => f.kind === 'income' && f.auto).reduce((a, f) => a + f.amount, 0)
  const autoExpense = inRange.filter((f) => f.kind === 'expense' && f.auto).reduce((a, f) => a + f.amount, 0)
  const incomeCats = byCategory(inRange, 'income')
  const expenseCats = byCategory(inRange, 'expense')
  const months = byMonth(inRange, from, to)
  const poolTotals = byPool(inRange, pools)
  const poolName = new Map(pools.map((p) => [p.id, p.name]))

  function exportCsv() {
    const rows: (string | number)[][] = [['日付', '種類', 'プール', '科目', '金額', '自動/手入力', 'メモ']]
    for (const f of inRange) {
      rows.push([f.date, KIND_LABEL[f.kind], f.poolId ? poolName.get(f.poolId) ?? '' : '', f.category, f.amount, f.auto ? 'レジから自動' : '手入力', f.memo])
    }
    downloadText(`収支明細_${from}_${to}.csv`, toCsv(rows), 'text/csv')
  }

  const catItems = (cats: ReturnType<typeof byCategory>) =>
    cats.map((c) => ({ key: c.key, label: c.category, value: c.amount, sub: c.auto ? 'レジから自動' : undefined }))

  return (
    <div>
      <div className="page-head">
        <h1>会計ダッシュボード</h1>
        <button className="btn" onClick={exportCsv} disabled={!inRange.length}>明細CSV</button>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="seg" role="group" aria-label="期間">
          {(Object.keys(PRESET_LABEL) as (keyof typeof PRESET_LABEL)[]).map((p) => (
            <button key={p} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {PRESET_LABEL[p]}
            </button>
          ))}
          <button
            aria-pressed={preset === 'custom'}
            onClick={() => {
              setCustom([from, to])
              setPreset('custom')
            }}
          >
            期間指定
          </button>
        </div>
        {preset === 'custom' ? (
          <span className="row" style={{ gap: 6 }}>
            <input className="input" type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="開始日" />
            〜
            <input className="input" type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="終了日" />
          </span>
        ) : (
          <span className="muted small">
            {from.replaceAll('-', '/')} 〜 {to.replaceAll('-', '/')}
          </span>
        )}
      </div>

      <div className="kpis">
        <div className="card kpi">
          <div className="label">収入</div>
          <div className="value">{yen(t.income)}</div>
          <div className="delta">うちレジ・オンライン売上 {yen(autoIncome)}</div>
        </div>
        <div className="card kpi">
          <div className="label">支出</div>
          <div className="value">{yen(t.expense)}</div>
          <div className="delta">うち仕入・手数料など {yen(autoExpense)}</div>
        </div>
        <div className="card kpi">
          <div className="label">収支</div>
          <div className="value" style={{ color: t.net < 0 ? 'var(--critical)' : undefined }}>{signedYen(t.net)}</div>
          <div className="delta">収入 − 支出</div>
        </div>
      </div>

      <div className="dash-grid">
        <div className="card span-6">
          <h2>収入の内訳</h2>
          {incomeCats.length ? <BarList items={catItems(incomeCats)} format={yen} /> : <div className="empty">この期間の収入はありません</div>}
        </div>
        <div className="card span-6">
          <h2>支出の内訳</h2>
          {expenseCats.length ? <BarList items={catItems(expenseCats)} format={yen} /> : <div className="empty">この期間の支出はありません</div>}
        </div>
      </div>

      {pools.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>プール別の収支</h2>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>プール</th>
                  <th className="r">収入</th>
                  <th className="r">支出</th>
                  <th className="r">収支</th>
                </tr>
              </thead>
              <tbody>
                {[...poolTotals].map(([id, r]) => (
                  <tr key={id}>
                    <td className={id === NO_POOL ? 'muted' : undefined}>{id === NO_POOL ? '未設定' : poolName.get(id)}</td>
                    <td className="r num">{yen(r.income)}</td>
                    <td className="r num">{yen(r.expense)}</td>
                    <td className="r num" style={{ fontWeight: 700, color: r.net < 0 ? 'var(--critical)' : undefined }}>
                      {signedYen(r.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>月別の収支</h2>
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>月</th>
                <th className="r">収入</th>
                <th className="r">支出</th>
                <th className="r">収支</th>
              </tr>
            </thead>
            <tbody>
              {months.map((r) => (
                <tr key={r.month}>
                  <td>{monthLabel(r.month)}</td>
                  <td className="r num">{yen(r.income)}</td>
                  <td className="r num">{yen(r.expense)}</td>
                  <td className="r num" style={{ fontWeight: 700, color: r.net < 0 ? 'var(--critical)' : undefined }}>
                    {signedYen(r.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted small" style={{ marginTop: 16 }}>
        レジの売上（取り消した会計を除く）、入荷した時点の仕入額（数量 × 仕入単価。入荷の修正・取消を反映）、キャッシュレス決済の手数料、
        オンラインの手数料・発送の実費は自動で反映されます。仕入は「売れたときの原価」ではなく「仕入れたときの支出」として数えています。
        それ以外の収入・経費は「収支の記録」タブで入力してください。
      </p>
    </div>
  )
}
