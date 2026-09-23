import { useEffect, useState } from 'react'
import { updateFees, useStore } from '../store'
import type { FeeSettings } from '../types'
import { NumberInput, toast } from './ui'

/** 小数も入る % 入力（NumberInput は整数用のため） */
function RateInput({ value, onChange, label }: { value: number; onChange: (n: number) => void; label: string }) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText((t) => (parseFloat(t) === value ? t : String(value))), [value])
  return (
    <input
      className="input num"
      inputMode="decimal"
      style={{ width: 80 }}
      aria-label={label}
      value={text}
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d.]/g, '')
        setText(v)
        const n = parseFloat(v)
        onChange(Number.isNaN(n) ? 0 : Math.min(100, n))
      }}
      onBlur={() => setText(String(value))}
    />
  )
}

export function FeeSettingsCard() {
  const { fees } = useStore()
  const [f, setF] = useState<FeeSettings>(fees)
  // 表示は同期のたびに作り直されるので、中身が変わったときだけ入力欄を更新する
  const feesKey = JSON.stringify(fees)
  useEffect(() => setF(JSON.parse(feesKey)), [feesKey])
  const dirty = JSON.stringify(f) !== JSON.stringify(fees)
  const setShop = (i: number, patch: Partial<FeeSettings['shops'][number]>) =>
    setF({ ...f, shops: f.shops.map((s, k) => (k === i ? { ...s, ...patch } : s)) })

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h2>会計手数料と最低粗利</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        キャッシュレスの手数料は会計ごとに記録して粗利から引きます。ここでの設定は、割引を作るときの「最低額」（最悪の場合でも粗利を下回らない価格）の計算にも使います。全端末で共有されます。
      </p>

      <div className="form-grid">
        <div className="field">
          キャッシュレス決済の手数料
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <RateInput value={f.cashlessRate} onChange={(n) => setF({ ...f, cashlessRate: n })} label="キャッシュレス手数料率" />
            <span className="muted">%</span>
          </span>
        </div>
        <div className="field">
          割引しても最低限残す粗利（1点あたり）
          <span className="row" style={{ flexWrap: 'nowrap' }}>
            <NumberInput value={f.minProfitYen} min={0} onChange={(n) => setF({ ...f, minProfitYen: n })} style={{ width: 80 }} aria-label="最低粗利（円）" />
            <span className="muted">円 ＋ 価格の</span>
            <RateInput value={f.minProfitPercent} onChange={(n) => setF({ ...f, minProfitPercent: n })} label="最低粗利（%）" />
            <span className="muted">%</span>
          </span>
        </div>
      </div>

      <div className="field" style={{ marginTop: 16 }}>
        オンラインショップの手数料
        <table className="tbl">
          <thead>
            <tr>
              <th>ショップ名</th>
              <th className="r">販売・決済手数料</th>
              <th className="r">注文ごとの固定額</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {f.shops.map((s, i) => (
              <tr key={i}>
                <td>
                  <input className="input" value={s.name} onChange={(e) => setShop(i, { name: e.target.value })} placeholder="例：BASE" aria-label="ショップ名" />
                </td>
                <td className="r">
                  <RateInput value={s.rate} onChange={(n) => setShop(i, { rate: n })} label="手数料率" /> <span className="muted">%</span>
                </td>
                <td className="r">
                  <NumberInput value={s.fixed} min={0} onChange={(n) => setShop(i, { fixed: n })} style={{ width: 80 }} aria-label="固定額" />{' '}
                  <span className="muted">円</span>
                </td>
                <td className="r">
                  <button className="btn sm ghost danger" onClick={() => setF({ ...f, shops: f.shops.filter((_, k) => k !== i) })}>削除</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div>
          <button className="btn sm" onClick={() => setF({ ...f, shops: [...f.shops, { name: '', rate: 0, fixed: 0 }] })}>
            ＋ ショップを追加
          </button>
        </div>
        <span className="muted small">
          オンライン注文を記録するとき、ショップ名が一致すれば手数料が自動で入ります。最低額の計算では、登録したショップのうち一番高い手数料で考えます。
        </span>
      </div>

      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="btn primary"
          disabled={!dirty}
          onClick={() => {
            updateFees({ ...f, shops: f.shops.filter((s) => s.name.trim()).map((s) => ({ ...s, name: s.name.trim() })) })
            toast('手数料の設定を保存しました')
          }}
        >
          保存
        </button>
        {dirty && (
          <button className="btn ghost" onClick={() => setF(fees)}>
            元に戻す
          </button>
        )}
      </div>
    </div>
  )
}
