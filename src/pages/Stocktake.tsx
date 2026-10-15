import { CORRECTABLE, useStore } from '../store'
import { HubsCard } from '../components/HubsCard'
import { StockHistory } from '../components/StockHistory'

/** 棚卸し：ハブ（持っていく先）ごとの持ち出し数と、入荷・在庫調整の記録の訂正 */
export function StocktakePage() {
  const { stockEvents } = useStore()
  // 入荷・棚卸し・原価修正と、その取り消し（修正・取消できる記録）
  const history = stockEvents
    .filter((e) => CORRECTABLE.has(e.reason) || e.reason === 'cancel')
    .slice(-50)
    .reverse()

  return (
    <div>
      <div className="page-head">
        <h1>棚卸し</h1>
      </div>

      <HubsCard />

      <div className="card">
        <h2>
          入荷・在庫調整の記録<span className="sub">直近50件</span>
        </h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          間違えて入荷・在庫調整・原価修正をしたときは、「修正」で正しい数に直すか、「取消」で無かったことにできます。
          在庫数と平均原価は自動で計算し直します。
        </p>
        <StockHistory events={history} showProduct />
      </div>
    </div>
  )
}
