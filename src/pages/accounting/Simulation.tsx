import { useEffect, useMemo, useState } from 'react'
import { BASE_HUB_NAME, NO_POOLS, uid, useStore } from '../../store'
import { dayKey, fullName, num, pct, yen } from '../../format'
import { collectFlows, EXPENSE_CATEGORIES, type Flow } from '../../accounting'
import { FlowsSummary, usePeriod } from './Dashboard'
import { pastCashlessShare, unitEconomics, type UnitEconomics } from '../../simulation'
import { BarList, ShareBar, type Share } from '../../components/charts'
import { NumberInput, toastError } from '../../components/ui'
import type { Product } from '../../types'

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7']
const signedYen = (n: number) => (n < 0 ? `−${yen(-n)}` : yen(n))
const tone = (n: number) => ({ color: n < 0 ? 'var(--critical)' : undefined })

/** 入力はこの端末に残す（タブを切り替えても消えないように）。保存できない環境でも動くようにする */
const STORAGE_KEY = 'goods-selling:simulation'
/** 仮の支出（シミュレーションだけで使う。会計の記録には残らない） */
type SimExpense = { id: string; date: string; category: string; amount: number; memo: string; poolId: string | null }
type Saved = { qty: Record<string, number>; sharePct: number | null; expenses: SimExpense[] }
function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '') as Partial<Saved>
    return { qty: v.qty ?? {}, sharePct: v.sharePct ?? null, expenses: v.expenses ?? [] }
  } catch {
    return { qty: {}, sharePct: null, expenses: [] }
  }
}

type Row = { p: Product; u: UnitEconomics; qty: number }

/** 今の在庫のうち何点売れるかを入力して、その場合の売上・粗利・収支を見る */
export function SimulationPage() {
  const { products, stock, costing, fees, sales, activeStockEvents, ledger, hubs, pools, basePools } = useStore()
  // 会計ダッシュボードの実績（シミュレーションの売上を足す前）
  const actual = useMemo(
    () => collectFlows({ sales, activeStockEvents, products, ledger, hubs, pools, basePools }),
    [sales, activeStockEvents, products, ledger, hubs, pools, basePools],
  )
  // どのハブで売る想定か（売上を入れるプールが決まる）。'' = ベース
  const [hubId, setHubId] = useState('')
  const [saved] = useState(load)
  const [qty, setQty] = useState(saved.qty)
  const [expenses, setExpenses] = useState(saved.expenses)
  // キャッシュレスの割合の初期値は、これまでの店頭の売上の実績（無ければ半々）
  const past = useMemo(() => pastCashlessShare(sales), [sales])
  const defaultPct = Math.round((past ?? 0.5) * 100)
  const [sharePct, setSharePct] = useState<number | null>(saved.sharePct)
  const share = Math.min(100, Math.max(0, sharePct ?? defaultPct)) / 100
  const [bulkPct, setBulkPct] = useState(50)
  const [view, setView] = useState<'sales' | 'accounting'>('sales')

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ qty, sharePct, expenses } satisfies Saved))
    } catch {
      // 保存できなくても、この画面を開いている間は使える
    }
  }, [qty, sharePct, expenses])

  const assumptions = { cashlessShare: share, feeRate: fees.cashlessRate }
  const rows: Row[] = products
    .map((p) => ({ p, left: stock.get(p.id) ?? 0 }))
    .filter((x) => x.left > 0)
    .map(({ p, left }) => {
      const u = unitEconomics(p, costing.byProduct.get(p.id)?.avg ?? p.cost, left, assumptions)
      return { p, u, qty: Math.min(left, Math.max(0, qty[p.id] ?? 0)) }
    })

  const setAll = (f: (r: Row) => number) => setQty(Object.fromEntries(rows.map((r) => [r.p.id, f(r)])))

  // ---- 集計 ----
  let revenue = 0
  let profit = 0
  let fee = 0
  let units = 0
  let stockCost = 0
  let stockUnits = 0
  let netTotal = 0
  for (const r of rows) {
    revenue += r.qty * r.u.price
    profit += r.qty * r.u.profit
    fee += r.qty * r.u.fee
    netTotal += r.qty * r.u.net
    units += r.qty
    stockCost += r.u.stockCost
    stockUnits += r.u.stock
  }
  // 在庫に対する収支 = 売れた分の手取り − 在庫全体の仕入額 − 仮の支出
  const other = expenses.reduce((a, x) => a + x.amount, 0)
  const balance = netTotal - stockCost - other
  const fullProfit = rows.reduce((a, r) => a + r.u.fullProfit, 0)
  const leftUnits = stockUnits - units
  const leftCost = rows.reduce((a, r) => a + (r.u.stock - r.qty) * r.u.cost, 0)

  const sold = rows.filter((r) => r.qty > 0)
  const ranking = [...sold].sort((a, b) => b.qty * b.u.price - a.qty * a.u.price).slice(0, 10)

  const byCategory = new Map<string, number>()
  for (const r of sold) byCategory.set(r.p.category || '未分類', (byCategory.get(r.p.category || '未分類') ?? 0) + r.qty * r.u.price)
  const categories: Share[] = [...byCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => ({ key: k, label: k, value: v, color: i < SERIES.length ? `var(${SERIES[i]})` : 'var(--muted)' }))

  const payments: Share[] = [
    { key: 'cash', label: '現金', value: revenue * (1 - share), color: 'var(--series-1)', extra: pct(1 - share) },
    { key: 'cashless', label: 'キャッシュレス', value: revenue * share, color: 'var(--series-2)', extra: pct(share) },
  ]

  // ---- 会計ダッシュボードに足す、シミュレーションの収支（今日の日付で計上） ----
  const hubPools = hubId ? hubs.find((h) => h.hub.id === hubId)?.hub.pools ?? NO_POOLS : basePools
  const live = (id: string | null) => (id && pools.some((p) => p.id === id) ? id : null)
  const today = dayKey(new Date())
  const extraTotal = rows.reduce((a, r) => a + r.qty * r.u.extra, 0)
  const simFlows: Flow[] = [
    ...(
      [
        ['sim:cash', 'income', '売上（シミュレーション・現金）', revenue * (1 - share), live(hubPools.cash)],
        ['sim:cashless', 'income', '売上（シミュレーション・キャッシュレス）', revenue * share, live(hubPools.cashless)],
        ['sim:fee', 'expense', '決済手数料（シミュレーション）', fee, live(hubPools.cashless)],
        ['sim:extra', 'expense', '追加コスト（シミュレーション）', extraTotal, null],
      ] as const
    )
      .filter(([, , , amount]) => amount > 0)
      .map(([id, kind, category, amount, poolId]) => ({ id, date: today, kind, category, amount: Math.round(amount), auto: false, memo: 'シミュレーション', poolId })),
    // 仮の支出は科目に「（仮）」を付けて、実績の科目と分けて表示する
    ...expenses.map((x) => ({
      id: `sim:${x.id}`, date: x.date, kind: 'expense' as const, category: `${x.category}（仮）`, amount: x.amount, auto: false, memo: x.memo, poolId: live(x.poolId),
    })),
  ]
  const withSim = [...actual, ...simFlows].sort((a, b) => a.date.localeCompare(b.date))
  const period = usePeriod(withSim, 'all')

  return (
    <div>
      <div className="page-head">
        <h1>シミュレーション</h1>
        <div className="seg" role="group" aria-label="表示">
          <button aria-pressed={view === 'sales'} onClick={() => setView('sales')}>売上シミュレーション</button>
          <button aria-pressed={view === 'accounting'} onClick={() => setView('accounting')}>会計ダッシュボード（シミュレーション後）</button>
        </div>
      </div>

      {view === 'sales' ? (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2>前提</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              今の在庫が何点売れるかを下の表に入力すると、その場合の売上・粗利を計算します。店頭で定価で売るとして計算します（割引は含みません）。
              1点あたりの手取りは「価格 − 追加コスト（レジ） − キャッシュレス手数料（{fees.cashlessRate}% × キャッシュレスの割合）」です。
              「黒字」は、今の在庫の仕入額（在庫数 × 平均原価）を売れた分の手取りで回収できることを指します。
            </p>
            <div className="form-grid">
              <label className="field">
                キャッシュレスの割合（%）
                <NumberInput value={Math.round(share * 100)} min={0} onChange={(n) => setSharePct(Math.min(100, n))} />
                <span className="muted small">
                  {past === null ? '店頭の売上の実績が無いので 50% から' : `店頭の実績 ${Math.round(past * 100)}%`}
                  {sharePct !== null && sharePct !== defaultPct && (
                    <>
                      {' '}
                      <button className="btn sm ghost" type="button" onClick={() => setSharePct(null)}>実績に戻す</button>
                    </>
                  )}
                </span>
              </label>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="small">すべての商品で在庫の</span>
              <NumberInput value={bulkPct} min={0} onChange={(n) => setBulkPct(Math.min(100, n))} style={{ width: 70 }} aria-label="売れる割合（%）" />
              <span className="small">% が売れる</span>
              <button className="btn sm" onClick={() => setAll((r) => Math.round((r.u.stock * bulkPct) / 100))} disabled={!rows.length}>入力する</button>
              <button className="btn sm" onClick={() => setAll((r) => r.u.breakEven ?? r.u.stock)} disabled={!rows.length} title="黒字にならない商品は在庫すべて">
                黒字に必要な数
              </button>
              <button className="btn sm" onClick={() => setAll((r) => r.u.stock)} disabled={!rows.length}>すべて完売</button>
              <button className="btn sm ghost" onClick={() => setQty({})} disabled={!units}>すべて 0 に</button>
            </div>
          </div>

          <div className="kpis">
            <div className="card kpi">
              <div className="label">売上</div>
              <div className="value">{yen(revenue)}</div>
              <div className="delta">在庫を完売すると {yen(rows.reduce((a, r) => a + r.u.stock * r.u.price, 0))}</div>
            </div>
            <div className="card kpi">
              <div className="label">粗利</div>
              <div className="value" style={tone(profit)}>{signedYen(profit)}</div>
              <div className="delta">粗利率 {revenue ? pct(profit / revenue) : '—'}・手数料 {yen(fee)}</div>
            </div>
            <div className="card kpi">
              <div className="label">販売点数</div>
              <div className="value">{num(units)}点</div>
              <div className="delta">在庫 {num(stockUnits)}点の {stockUnits ? pct(units / stockUnits) : '—'}</div>
            </div>
            <div className="card kpi">
              <div className="label">在庫に対する収支</div>
              <div className="value" style={tone(balance)}>{signedYen(balance)}</div>
              <div className="delta">
                手取り − 在庫の仕入額 {yen(stockCost)}
                {other > 0 && ` − 仮の支出 ${yen(other)}`}
              </div>
            </div>
            <div className="card kpi">
              <div className="label">売れ残り</div>
              <div className="value">{num(leftUnits)}点</div>
              <div className="delta">仕入額 {yen(leftCost)}</div>
            </div>
          </div>

          <div className="dash-grid">
            <div className="card span-6">
              <h2>
                商品別の売上<span className="sub">上位10</span>
              </h2>
              {ranking.length ? (
                <BarList
                  items={ranking.map((r) => ({ key: r.p.id, label: fullName(r.p), value: r.qty * r.u.price, sub: `${r.qty}点・粗利 ${yen(r.qty * r.u.profit)}` }))}
                  format={yen}
                />
              ) : (
                <div className="empty">売れる数を入力してください</div>
              )}
            </div>
            <div className="card span-6">
              <h2>カテゴリ別売上</h2>
              {categories.length ? <ShareBar items={categories} format={yen} /> : <div className="empty">売れる数を入力してください</div>}
              <h2 style={{ marginTop: 20 }}>支払い方法</h2>
              <ShareBar items={payments} format={yen} />
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h2>商品ごとの見込み</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              「黒字に必要な数」は、その商品の今の在庫の仕入額を回収するのに最低限売れる必要がある数です。
              「完売時の粗利」は、今の在庫がすべて売れたときの粗利です。
            </p>
            {rows.length === 0 ? (
              <div className="empty">在庫のある商品がありません</div>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th className="r">在庫</th>
                      <th className="r">価格</th>
                      <th className="r">平均原価</th>
                      <th className="r">1点の粗利</th>
                      <th className="r">黒字に必要な数</th>
                      <th className="r">完売時の粗利</th>
                      <th className="r">売れる数</th>
                      <th className="r">この想定の収支</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ p, u, qty: q }) => {
                      const result = q * u.net - u.stockCost
                      return (
                        <tr key={p.id}>
                          <td>
                            {fullName(p)}
                            {!p.active && <span className="badge" style={{ marginLeft: 6 }}>レジに非表示</span>}
                          </td>
                          <td className="r num">{u.stock}</td>
                          <td className="r num">{yen(u.price)}</td>
                          <td className="r num">{yen(u.cost)}</td>
                          <td className="r num" style={tone(u.profit)}>{signedYen(u.profit)}</td>
                          <td className="r num">
                            <BreakEven u={u} />
                          </td>
                          <td className="r num" style={{ fontWeight: 600, ...tone(u.fullProfit) }}>{signedYen(u.fullProfit)}</td>
                          <td className="r">
                            <NumberInput
                              value={q}
                              min={0}
                              onChange={(n) => setQty({ ...qty, [p.id]: Math.min(u.stock, n) })}
                              style={{ width: 72 }}
                              aria-label={`${fullName(p)}の売れる数`}
                            />
                          </td>
                          <td className="r num" style={tone(result)}>
                            {signedYen(result)}
                            {u.breakEven !== null && u.breakEven <= u.stock && (
                              <div className="small" style={{ color: q >= u.breakEven ? 'var(--good-text)' : 'var(--muted)' }}>
                                {q >= u.breakEven ? '黒字' : `あと${u.breakEven - q}点で黒字`}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700 }}>
                      <td>合計</td>
                      <td className="r num">{num(stockUnits)}</td>
                      <td />
                      <td className="r num muted small">仕入額 {yen(stockCost)}</td>
                      <td />
                      <td />
                      <td className="r num" style={tone(fullProfit)}>{signedYen(fullProfit)}</td>
                      <td className="r num">{num(units)}</td>
                      <td className="r num" style={tone(netTotal - stockCost)}>{signedYen(netTotal - stockCost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            今の会計の実績に、このシミュレーションの売上・手数料・追加コスト（今日の日付）と仮の支出を足した場合の会計ダッシュボードです。
            在庫の仕入額は入荷したときに実績の支出として計上済みなので、ここでは足しません。
            売れる数は「売上シミュレーション」の表で入力します（今は {num(units)}点・売上 {yen(revenue)}）。
          </p>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2>仮の支出</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              これからかかりそうな会場費・交通費などを仮に記録して、収支がどうなるかを見ます。シミュレーションの中だけで使い、会計の記録には残りません（この端末に保存されます）。
            </p>
            <SimExpenses value={expenses} onChange={setExpenses} />
            {hubs.length > 0 && (
              <div className="form-grid" style={{ marginTop: 16 }}>
                <label className="field">
                  売る場所（ハブ）
                  <select className="input" value={hubId} onChange={(e) => setHubId(e.target.value)}>
                    <option value="">{BASE_HUB_NAME}</option>
                    {hubs.map((h) => (
                      <option key={h.hub.id} value={h.hub.id}>{h.hub.name}</option>
                    ))}
                  </select>
                  <span className="muted small">シミュレーションの売上を、このハブの設定のプールに入れます</span>
                </label>
              </div>
            )}
          </div>

          {period.picker}
          <FlowsSummary flows={withSim} base={actual} from={period.from} to={period.to} />
        </>
      )}
    </div>
  )
}

function BreakEven({ u }: { u: UnitEconomics }) {
  if (u.breakEven === null) return <span style={{ color: 'var(--critical)' }}>売るほど赤字</span>
  if (u.breakEven > u.stock) {
    return (
      <span style={{ color: 'var(--critical)' }} title={`黒字には ${u.breakEven}点必要`}>
        完売しても赤字
      </span>
    )
  }
  return (
    <>
      {u.breakEven}点
      <div className="muted small">在庫の {pct(u.stock ? u.breakEven / u.stock : 0)}</div>
    </>
  )
}

/** 仮の支出の入力と一覧 */
function SimExpenses({ value, onChange }: { value: SimExpense[]; onChange: (v: SimExpense[]) => void }) {
  const { pools, ledger } = useStore()
  const blank = (): Omit<SimExpense, 'id'> => ({ date: dayKey(new Date()), category: '', amount: 0, memo: '', poolId: null })
  const [draft, setDraft] = useState(blank)
  // 候補：よく使う科目 ＋ これまでに記録した支出の科目
  const options = [...new Set([...EXPENSE_CATEGORIES, ...ledger.filter((x) => x.kind === 'expense').map((x) => x.category)])]
  const poolName = new Map(pools.map((p) => [p.id, p.name]))
  const invalid = !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !draft.category.trim() || !(draft.amount > 0)

  function add() {
    if (invalid) return toastError('日付・科目・金額を入力してください')
    const x = { ...draft, id: uid(), category: draft.category.trim(), memo: draft.memo.trim(), amount: Math.round(draft.amount) }
    onChange([...value, x].sort((a, b) => a.date.localeCompare(b.date)))
    // 続けて入力しやすいよう、日付とプールは残す
    setDraft({ ...blank(), date: draft.date, poolId: draft.poolId })
  }

  return (
    <>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <label className="field">
          日付
          <input className="input" type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
        </label>
        <label className="field">
          科目
          <input className="input" list="sim-expense-cats" value={draft.category} placeholder="例：会場費" onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
          <datalist id="sim-expense-cats">
            {options.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="field">
          金額（円）
          <NumberInput value={draft.amount} min={0} onChange={(n) => setDraft({ ...draft, amount: n })} />
        </label>
        {pools.length > 0 && (
          <label className="field">
            プール
            <select className="input" value={draft.poolId ?? ''} onChange={(e) => setDraft({ ...draft, poolId: e.target.value || null })}>
              <option value="">未設定</option>
              {pools.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field full">
          メモ
          <input className="input" value={draft.memo} placeholder="任意" onChange={(e) => setDraft({ ...draft, memo: e.target.value })} />
        </label>
        <div className="row">
          <button className="btn primary" type="submit" disabled={invalid}>仮に記録する</button>
        </div>
      </form>

      {value.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>日付</th>
                <th>科目</th>
                {pools.length > 0 && <th>プール</th>}
                <th>メモ</th>
                <th className="r">金額</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {value.map((x) => (
                <tr key={x.id}>
                  <td className="num">{x.date.replaceAll('-', '/')}</td>
                  <td>{x.category}</td>
                  {pools.length > 0 && <td className="small">{(x.poolId && poolName.get(x.poolId)) || <span className="muted">—</span>}</td>}
                  <td className="muted small">{x.memo}</td>
                  <td className="r num" style={{ fontWeight: 600 }}>−{yen(x.amount)}</td>
                  <td className="r">
                    <button className="btn sm ghost" onClick={() => onChange(value.filter((y) => y.id !== x.id))}>削除</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={pools.length > 0 ? 4 : 3}>
                  合計 {value.length}件{' '}
                  <button className="btn sm ghost" onClick={() => confirm('仮の支出をすべて消しますか？') && onChange([])}>すべて消す</button>
                </td>
                <td className="r num">−{yen(value.reduce((a, x) => a + x.amount, 0))}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}
