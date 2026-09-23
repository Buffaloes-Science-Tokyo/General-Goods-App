import { useState } from 'react'
import { useStore, voidSale } from '../store'
import { dateTime, dayKey, downloadText, fullName, toCsv, yen } from '../format'
import type { Sale } from '../types'
import { Modal, toast } from '../components/ui'
import { channelLabel, channelOf, PAYMENT_LABEL } from '../metrics'

export function SalesPage() {
  const { sales } = useStore()
  const [day, setDay] = useState('')
  const [channel, setChannel] = useState<'all' | 'store' | 'online'>('all')
  const [detail, setDetail] = useState<Sale | null>(null)

  const list = sales
    .filter((s) => (!day || dayKey(s.at) === day) && (channel === 'all' || channelOf(s) === channel))
    .slice()
    .reverse()
  const valid = list.filter((s) => !s.voided)
  const total = valid.reduce((a, s) => a + s.total, 0)

  function exportCsv() {
    const rows: (string | number)[][] = [['伝票番号', '販売先', '日時', '商品', 'タイプ', 'サイズ', 'カテゴリ', '単価', '数量', '金額', '割引(伝票)', '割引内訳', '合計(伝票)', '支払い', '取消']]
    for (const s of list) {
      for (const i of s.items) {
        rows.push([s.receiptNo, channelLabel(s), new Date(s.at).toLocaleString('ja-JP'), i.name, i.type ?? '', i.size ?? '', i.category, i.price, i.qty, i.price * i.qty, s.discount, (s.discounts ?? []).map((d) => `${d.name}:${d.amount}`).join(' / '), s.total, PAYMENT_LABEL[s.payment], s.voided ? '取消' : ''])
      }
    }
    downloadText(`販売履歴_${day || '全期間'}.csv`, toCsv(rows), 'text/csv')
  }

  return (
    <div>
      <div className="page-head">
        <h1>販売履歴</h1>
        <div className="seg" role="group" aria-label="販売先">
          <button aria-pressed={channel === 'all'} onClick={() => setChannel('all')}>すべて</button>
          <button aria-pressed={channel === 'store'} onClick={() => setChannel('store')}>店頭</button>
          <button aria-pressed={channel === 'online'} onClick={() => setChannel('online')}>オンライン</button>
        </div>
        <input type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} aria-label="日付で絞り込み" />
        {day && <button className="btn ghost" onClick={() => setDay('')}>全期間</button>}
        <button className="btn" onClick={exportCsv} disabled={!list.length}>CSV出力</button>
      </div>
      <div className="card">
        <div className="row muted small" style={{ marginBottom: 8 }}>
          {valid.length}件・合計 <b className="num" style={{ color: 'var(--ink)' }}>{yen(total)}</b>
          {list.length !== valid.length && <span>（取消 {list.length - valid.length}件を除く）</span>}
        </div>
        {list.length === 0 ? (
          <div className="empty">販売履歴はありません</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>伝票</th>
                  <th>販売先</th>
                  <th>日時</th>
                  <th>内容</th>
                  <th>支払い</th>
                  <th className="r">合計</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className={s.voided ? 'voided' : ''}>
                    <td className="num">{s.receiptNo}</td>
                    <td>
                      <span className={`badge${channelOf(s) === 'online' ? ' on' : ''}`}>{channelLabel(s)}</span>
                    </td>
                    <td className="num">{dateTime(s.at)}</td>
                    <td>
                      {s.items[0] && fullName(s.items[0])}
                      {s.items.length > 1 && <span className="muted"> 他{s.items.length - 1}品</span>}
                      <span className="muted small"> ・{s.items.reduce((a, i) => a + i.qty, 0)}点</span>
                    </td>
                    <td>{PAYMENT_LABEL[s.payment]}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>{yen(s.total)}</td>
                    <td className="r nostrike">
                      {s.voided ? <span className="badge">取消済</span> : null}{' '}
                      <button className="btn sm ghost" onClick={() => setDetail(s)}>詳細</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detail && <SaleDetail sale={sales.find((s) => s.id === detail.id) ?? detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

function SaleDetail({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  function doVoid() {
    if (!confirm(`伝票 ${sale.receiptNo}（${yen(sale.total)}）を取り消しますか？\n在庫は元に戻ります。`)) return
    voidSale(sale.id)
    toast('取引を取り消しました')
  }
  return (
    <Modal title={`伝票 ${sale.receiptNo}`} onClose={onClose}>
      <div className="muted small" style={{ marginBottom: 8 }}>
        {channelLabel(sale)}・{new Date(sale.at).toLocaleString('ja-JP')}・{PAYMENT_LABEL[sale.payment]}
        {sale.voided && <span className="badge" style={{ marginLeft: 8 }}>取消済</span>}
      </div>
      <table className="tbl">
        <tbody>
          {sale.items.map((i) => (
            <tr key={i.productId}>
              <td>{fullName(i)}</td>
              <td className="r num muted">{yen(i.price)} × {i.qty}</td>
              <td className="r num">
                {yen(i.price * i.qty)}
                {!!i.discount && <div className="muted small">−{yen(i.discount)}</div>}
              </td>
            </tr>
          ))}
          <tr><td colSpan={2}>小計</td><td className="r num">{yen(sale.subtotal)}</td></tr>
          {sale.discounts?.length
            ? sale.discounts.map((d, k) => (
                <tr key={k}>
                  <td colSpan={2}>割引：{d.name}</td>
                  <td className="r num">−{yen(d.amount)}</td>
                </tr>
              ))
            : sale.discount > 0 && <tr><td colSpan={2}>値引き</td><td className="r num">−{yen(sale.discount)}</td></tr>}
          {!!sale.online?.shipping && <tr><td colSpan={2}>送料</td><td className="r num">{yen(sale.online.shipping)}</td></tr>}
          <tr><td colSpan={2}><b>合計</b></td><td className="r num"><b>{yen(sale.total)}</b></td></tr>
          {!!sale.paymentFee && (
            <tr className="muted"><td colSpan={2}>会計手数料（お店の負担）</td><td className="r num">{yen(sale.paymentFee)}</td></tr>
          )}
          {sale.payment === 'cash' && (
            <>
              <tr><td colSpan={2}>お預かり</td><td className="r num">{yen(sale.received)}</td></tr>
              <tr><td colSpan={2}>お釣り</td><td className="r num">{yen(sale.change)}</td></tr>
            </>
          )}
        </tbody>
      </table>
      <div className="actions" style={{ justifyContent: 'space-between' }}>
        <button className="btn danger" onClick={doVoid} disabled={sale.voided}>取引を取り消す</button>
        <button className="btn" onClick={onClose}>閉じる</button>
      </div>
    </Modal>
  )
}
