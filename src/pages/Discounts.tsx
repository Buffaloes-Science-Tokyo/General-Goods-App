import { useMemo, useState } from 'react'
import { deleteDiscountRule, saveDiscountRule, setDiscountEnabled, useStore, type DiscountRuleInput } from '../store'
import { compareSize, fullName, yen } from '../format'
import { describeRule, isInPeriod } from '../discounts'
import type { DiscountRule, DiscountTarget, Product } from '../types'
import { Modal, NumberInput, toast } from '../components/ui'
import { CHANNEL_LABEL, checkRule, type RuleCheck } from '../pricing'

const KIND_LABEL: Record<DiscountRule['kind'], string> = { item: '商品割引', bundle: 'まとめ買い', order: '会計割引' }
const SCOPE_LABEL: Record<DiscountTarget['scope'], string> = {
  all: 'すべての商品',
  product: '商品を選ぶ',
  category: 'カテゴリ',
  type: 'タイプ',
  size: 'サイズ',
}

export function targetLabel(t: DiscountTarget, products: Product[]) {
  if (t.scope === 'all') return 'すべての商品'
  if (!t.values.length) return '（対象なし）'
  const names =
    t.scope === 'product'
      ? t.values.map((id) => {
          const p = products.find((x) => x.id === id)
          return p ? fullName(p) : '削除された商品'
        })
      : t.values
  const head = names.slice(0, 2).join('・')
  const more = names.length > 2 ? ` 他${names.length - 2}件` : ''
  return `${t.scope === 'product' ? '' : `${SCOPE_LABEL[t.scope]}「`}${head}${more}${t.scope === 'product' ? '' : '」'}`
}

/** datetime-local 用の "YYYY-MM-DDTHH:mm"（ローカル時刻） */
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null)
const shortDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function status(r: DiscountRule) {
  if (!r.enabled) return { label: '停止中', cls: '' }
  const now = new Date()
  if (r.startAt && now < new Date(r.startAt)) return { label: '開始前', cls: 'low' }
  if (!isInPeriod(r, now)) return { label: '期間終了', cls: '' }
  return { label: '適用中', cls: 'on' }
}

export function DiscountsPage() {
  const { discountRules, products, sales, costing, fees } = useStore()
  const [editing, setEditing] = useState<DiscountRule | 'new' | null>(null)
  const belowCount = (r: DiscountRule) =>
    checkRule(r, products, (p) => costing.byProduct.get(p.id)?.avg ?? p.cost, fees).below.length

  // 割引ごとの利用実績（取消を除く）
  const usage = useMemo(() => {
    const m = new Map<string, { count: number; amount: number }>()
    for (const s of sales) {
      if (s.voided) continue
      for (const d of s.discounts ?? []) {
        const key = d.ruleId ?? '__manual'
        const u = m.get(key) ?? { count: 0, amount: 0 }
        u.count++
        u.amount += d.amount
        m.set(key, u)
      }
    }
    return m
  }, [sales])

  return (
    <div>
      <div className="page-head">
        <h1>割引設定</h1>
        <button className="btn primary" onClick={() => setEditing('new')}>＋ 割引を追加</button>
      </div>

      <div className="card">
        {discountRules.length === 0 ? (
          <div className="empty">
            割引はまだありません。「＋ 割引を追加」から、商品割引・まとめ買い・会計割引を登録できます。
          </div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>割引</th>
                  <th>内容</th>
                  <th>適用</th>
                  <th>期間</th>
                  <th className="r">利用実績</th>
                  <th>状態</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {discountRules.map((r) => {
                  const st = status(r)
                  const u = usage.get(r.id)
                  return (
                    <tr key={r.id} className={r.enabled ? '' : 'inactive'}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.name}</div>
                        <div className="muted small">{KIND_LABEL[r.kind]}</div>
                      </td>
                      <td>
                        {describeRule(r, targetLabel(r.target, products))}
                        {belowCount(r) > 0 && (
                          <div className="small" style={{ color: 'var(--critical)' }}>▲ {belowCount(r)}件の商品で最低額を下回ります</div>
                        )}
                      </td>
                      <td className="small">{r.mode === 'auto' ? '自動' : 'レジで選択'}</td>
                      <td className="small muted num">
                        {r.startAt || r.endAt ? `${r.startAt ? shortDate(r.startAt) : ''} 〜 ${r.endAt ? shortDate(r.endAt) : ''}` : '期限なし'}
                      </td>
                      <td className="r num">
                        {u ? (
                          <>
                            {yen(u.amount)}
                            <div className="muted small">{u.count}回</div>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="r" style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn sm" onClick={() => setDiscountEnabled(r.id, !r.enabled)}>
                          {r.enabled ? '停止' : '再開'}
                        </button>{' '}
                        <button className="btn sm ghost" onClick={() => setEditing(r)}>編集</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {usage.get('__manual') && (
          <div className="muted small" style={{ marginTop: 12 }}>
            手入力の値引き：{usage.get('__manual')!.count}回・{yen(usage.get('__manual')!.amount)}
          </div>
        )}
      </div>

      <div className="card muted small" style={{ marginTop: 16, lineHeight: 1.8 }}>
        <b style={{ color: 'var(--ink)' }}>割引の重なり方</b>
        <br />
        ・商品割引とまとめ買いは、1つの商品に1つだけ付きます。複数が当てはまるときは、お客様に一番得なものが優先されます。
        <br />
        ・会計割引は、商品の割引を引いた後の金額で判定し、一番得なもの1つだけが付きます。
        <br />
        ・レジの手入力の値引きは、最後に引かれます。レジでは、自動で付いた割引をその会計だけ外すこともできます。
      </div>

      {editing && <RuleForm rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function RuleForm({ rule, onClose }: { rule: DiscountRule | null; onClose: () => void }) {
  const { products, costing, fees } = useStore()
  const [f, setF] = useState<DiscountRuleInput>(
    rule ?? {
      name: '',
      kind: 'item',
      target: { scope: 'all', values: [] },
      valueType: 'percent',
      value: 10,
      minQty: 3,
      minSubtotal: 5000,
      mode: 'auto',
      enabled: true,
      startAt: null,
      endAt: null,
    },
  )
  const set = <K extends keyof DiscountRuleInput>(k: K, v: DiscountRuleInput[K]) => setF({ ...f, [k]: v })

  const options = useMemo(() => {
    const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]
    return {
      product: products.map((p) => ({ value: p.id, label: fullName(p) })),
      category: uniq(products.map((p) => p.category)).map((v) => ({ value: v, label: v })),
      type: uniq(products.map((p) => p.type)).map((v) => ({ value: v, label: v })),
      size: uniq(products.map((p) => p.size))
        .sort(compareSize)
        .map((v) => ({ value: v, label: v })),
    }
  }, [products])

  function setKind(kind: DiscountRule['kind']) {
    // setPrice はまとめ買い専用
    const valueType = kind !== 'bundle' && f.valueType === 'setPrice' ? 'percent' : f.valueType
    setF({ ...f, kind, valueType, target: kind === 'order' ? { scope: 'all', values: [] } : f.target })
  }

  const needsTarget = f.kind !== 'order'
  const targetOk = !needsTarget || f.target.scope === 'all' || f.target.values.length > 0
  const periodOk = !f.startAt || !f.endAt || f.startAt < f.endAt
  const valueOk = f.value > 0 && (f.valueType !== 'percent' || f.value <= 100)
  const canSave = f.name.trim() && targetOk && periodOk && valueOk

  const avgCostOf = (p: Product) => costing.byProduct.get(p.id)?.avg ?? p.cost
  const check = checkRule(f, products, avgCostOf, fees)

  function save() {
    if (!canSave) return
    if (
      check.below.length &&
      !confirm(
        `${check.below.length}件の商品で、最悪の場合に最低額を下回ります（粗利が設定より少なくなるか、赤字になる可能性があります）。\nこのまま保存しますか？`,
      )
    )
      return
    saveDiscountRule({ ...f, name: f.name.trim() }, rule?.id)
    toast(rule ? '割引を保存しました' : '割引を追加しました')
    onClose()
  }

  function remove() {
    if (!rule || !confirm(`割引「${rule.name}」を削除しますか？（過去の会計の記録は残ります）`)) return
    deleteDiscountRule(rule.id)
    toast('削除しました')
    onClose()
  }

  const valueTypes: { v: DiscountRule['valueType']; label: string }[] =
    f.kind === 'bundle'
      ? [
          { v: 'setPrice', label: 'N点で◯円' },
          { v: 'percent', label: '%オフ' },
          { v: 'yen', label: '1点◯円引き' },
        ]
      : f.kind === 'item'
        ? [
            { v: 'percent', label: '%オフ' },
            { v: 'yen', label: '1点◯円引き' },
          ]
        : [
            { v: 'percent', label: '%オフ' },
            { v: 'yen', label: '◯円引き' },
          ]

  const opts = f.target.scope === 'all' ? [] : options[f.target.scope]

  return (
    <Modal title={rule ? '割引を編集' : '割引を追加'} onClose={onClose}>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <label className="field full">
          割引の名前（レジと履歴に表示）
          <input
            className="input"
            value={f.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="例：アパレル 10%オフ、缶バッジ3個で1,200円"
            autoFocus
            required
          />
        </label>

        <div className="field full">
          種類
          <div className="seg" role="group">
            {(Object.keys(KIND_LABEL) as DiscountRule['kind'][]).map((k) => (
              <button type="button" key={k} aria-pressed={f.kind === k} onClick={() => setKind(k)}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        {needsTarget && (
          <div className="field full">
            対象
            <select
              className="select"
              value={f.target.scope}
              onChange={(e) => set('target', { scope: e.target.value as DiscountTarget['scope'], values: [] })}
            >
              {(Object.keys(SCOPE_LABEL) as DiscountTarget['scope'][]).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s]}
                </option>
              ))}
            </select>
            {f.target.scope !== 'all' && (
              <div className="pick-list">
                {opts.length === 0 && <span className="muted small">選べる値がありません</span>}
                {opts.map((o) => {
                  const on = f.target.values.includes(o.value)
                  return (
                    <label key={o.value} className={`pick${on ? ' on' : ''}`}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          set('target', {
                            ...f.target,
                            values: on ? f.target.values.filter((x) => x !== o.value) : [...f.target.values, o.value],
                          })
                        }
                      />
                      {o.label}
                    </label>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {f.kind === 'bundle' && (
          <label className="field">
            {f.valueType === 'setPrice' ? '何点で' : '何点以上で'}
            <NumberInput value={f.minQty} min={1} onChange={(v) => set('minQty', Math.max(1, v))} />
          </label>
        )}
        {f.kind === 'order' && (
          <label className="field">
            お会計がいくら以上で（円）
            <NumberInput value={f.minSubtotal} min={0} onChange={(v) => set('minSubtotal', v)} />
          </label>
        )}

        <div className="field full">
          割引のしかた
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <div className="seg" role="group">
              {valueTypes.map((t) => (
                <button type="button" key={t.v} aria-pressed={f.valueType === t.v} onClick={() => set('valueType', t.v)}>
                  {t.label}
                </button>
              ))}
            </div>
            <NumberInput value={f.value} min={0} onChange={(v) => set('value', v)} style={{ width: 100 }} aria-label="割引の値" />
            <span className="muted">{f.valueType === 'percent' ? '%' : '円'}</span>
          </div>
        </div>

        <div className="field full">
          適用のしかた
          <div className="seg" role="group">
            <button type="button" aria-pressed={f.mode === 'auto'} onClick={() => set('mode', 'auto')}>
              条件を満たしたら自動
            </button>
            <button type="button" aria-pressed={f.mode === 'manual'} onClick={() => set('mode', 'manual')}>
              レジで選んだときだけ
            </button>
          </div>
          <span className="muted small">「レジで選んだときだけ」は、SNSフォロー割・学割など、確認してから付ける割引向けです。</span>
        </div>

        <label className="field">
          開始（任意）
          <input className="input" type="datetime-local" value={toLocalInput(f.startAt)} onChange={(e) => set('startAt', fromLocalInput(e.target.value))} />
        </label>
        <label className="field">
          終了（任意）
          <input className="input" type="datetime-local" value={toLocalInput(f.endAt)} onChange={(e) => set('endAt', fromLocalInput(e.target.value))} />
        </label>

        <label className="full row" style={{ fontSize: 14 }}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          この割引を使う
        </label>

        <div className="full disc-preview">
          {describeRule({ ...f, id: '', deleted: false, updatedAt: '' }, targetLabel(f.target, products))}
          {!targetOk && <div className="warn">対象を1つ以上選んでください</div>}
          {!periodOk && <div className="warn">終了は開始より後にしてください</div>}
          {!valueOk && <div className="warn">{f.valueType === 'percent' ? '1〜100% で入力してください' : '1円以上で入力してください'}</div>}
        </div>

        {targetOk && valueOk && (
          <ProfitCheck check={check} rule={f} onApplyLimit={(v) => set('value', v)} />
        )}

        <div className="full actions" style={{ justifyContent: 'space-between' }}>
          <div>
            {rule && (
              <button type="button" className="btn danger" onClick={remove}>削除</button>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>キャンセル</button>
            <button type="submit" className="btn primary" disabled={!canSave}>保存</button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

/** 割引の粗利チェック：最悪の場合の最低額と、割引の上限（下限）を示す */
function ProfitCheck({
  check,
  rule,
  onApplyLimit,
}: {
  check: RuleCheck
  rule: DiscountRuleInput
  onApplyLimit: (v: number) => void
}) {
  const { fees } = useStore()
  if (!check.rows.length) return null
  const fmt = (v: number) => (rule.valueType === 'percent' ? `${v}%` : yen(v))
  const ok = check.below.length === 0
  // 余裕の少ない順に最大5件
  const rows = [...check.rows].sort((a, b) => a.after - a.floor.price - (b.after - b.floor.price)).slice(0, 5)
  const limitText =
    check.limit === null
      ? null
      : rule.valueType === 'setPrice'
        ? `「${rule.minQty}点で ${yen(check.limit)}」以上なら最低額を下回りません`
        : check.limit <= 0
          ? 'この対象では、割引すると最低額を下回ります'
          : `最大 ${fmt(check.limit)} までなら最低額を下回りません`
  const canApply = check.limit !== null && check.limit > 0 && check.limit !== rule.value

  return (
    <div className={`full profit-check${ok ? ' ok' : ' ng'}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{ok ? '✓ 最悪の場合でも最低額を下回りません' : `▲ ${check.below.length}件の商品で最低額を下回ります`}</b>
        {canApply && (
          <button type="button" className="btn sm" onClick={() => onApplyLimit(check.limit!)}>
            {rule.valueType === 'setPrice' ? '最低額' : '上限'}の {fmt(check.limit!)} にする
          </button>
        )}
      </div>
      {limitText && <div className="small" style={{ marginTop: 2 }}>{limitText}</div>}
      <table className="tbl" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th>商品</th>
            <th className="r">通常</th>
            <th className="r">割引後（1点）</th>
            <th className="r">最低額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const below = r.after < r.floor.price
            return (
              <tr key={r.product.id}>
                <td>
                  {fullName(r.product)}
                  <div className="muted small">{CHANNEL_LABEL[r.floor.channel]}で売った場合</div>
                </td>
                <td className="r num">{yen(r.product.price)}</td>
                <td className="r num" style={{ fontWeight: 600, color: below ? 'var(--critical)' : undefined }}>
                  {yen(Math.floor(r.after))}
                </td>
                <td className="r num">{Number.isFinite(r.floor.price) ? yen(r.floor.price) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {check.rows.length > rows.length && <div className="muted small">ほか {check.rows.length - rows.length}件（余裕の少ない順に表示）</div>}
      <div className="muted small" style={{ marginTop: 6 }}>
        最低額 ＝ 平均原価＋追加コスト＋手数料（キャッシュレス {fees.cashlessRate}%
        {fees.shops.length ? '・オンラインは一番高いショップ' : ''}）
        {fees.minProfitYen || fees.minProfitPercent ? `＋最低粗利（${fees.minProfitYen}円＋${fees.minProfitPercent}%）` : ''}
        を下回らない価格。{rule.kind === 'order' && rule.valueType === 'yen' ? '円引きは、条件ぎりぎりの会計に全額かかった場合で計算。' : ''}
        他の割引と重なった場合は含みません。
      </div>
    </div>
  )
}
