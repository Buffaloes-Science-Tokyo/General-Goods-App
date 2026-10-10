import { useRef, useState } from 'react'
import {
  exportBackup,
  importBackup,
  loadSample,
  resetLocal,
  setDeviceCode,
  updateShopName,
  useStore,
} from '../store'
import { logout, syncNow, useSyncStatus } from '../sync'
import { dateTime, downloadText } from '../format'
import { toast, toastError } from '../components/ui'
import { FeeSettingsCard } from '../components/FeeSettingsCard'
import { RemoteStockCard } from '../components/RemoteStockCard'

export function SettingsPage() {
  const { settings, device, sync, pending, products, sales } = useStore()
  const status = useSyncStatus()
  const [shopName, setShopName] = useState(settings.shopName)
  const [code, setCode] = useState(device.code)
  const fileRef = useRef<HTMLInputElement>(null)

  const statusText =
    status.kind === 'disabled' ? '待機中'
    : status.kind === 'offline' ? 'オフライン（復帰したら自動で送信します）'
    : status.kind === 'syncing' ? '同期中…'
    : status.kind === 'ok' ? '同期済み'
    : `エラー：${status.message}`

  return (
    <div style={{ maxWidth: 760 }}>
      <div className="page-head">
        <h1>設定</h1>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>クラウド同期</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          レジ操作はオフラインでも常に使えます。オンラインのときに自動でクラウド（Neon）へ送信し、
          他の端末の販売・在庫の変更も受け取ります。
        </p>
        <table className="tbl" style={{ marginTop: 12 }}>
          <tbody>
            <tr><td>状態</td><td>{statusText}</td></tr>
            <tr><td>送信待ち</td><td className="num">{pending}件</td></tr>
            <tr><td>最終同期</td><td>{sync.lastSyncAt ? dateTime(sync.lastSyncAt) : '—'}</td></tr>
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => void syncNow()}>今すぐ同期</button>
          <button
            className="btn danger"
            onClick={() => {
              const msg = pending
                ? `まだクラウドに送信していない変更が ${pending}件あります（端末には残り、次にログインしたときに送信します）。ログアウトしますか？`
                : 'ログアウトしますか？'
              if (confirm(msg)) logout()
            }}
          >
            ログアウト
          </button>
        </div>
      </div>

      <RemoteStockCard />

      <FeeSettingsCard />

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>お店と端末</h2>
        <div className="form-grid">
          <label className="field">
            店名（全端末で共有）
            <input className="input" value={shopName} onChange={(e) => setShopName(e.target.value)} onBlur={() => shopName !== settings.shopName && updateShopName(shopName)} />
          </label>
          <label className="field">
            この端末のコード（伝票番号の頭）
            <input
              className="input"
              value={code}
              maxLength={4}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              onBlur={() => code && code !== device.code && setDeviceCode(code)}
            />
          </label>
          <div className="full muted small">
            複数台で使うときは端末ごとに違うコードにすると、伝票番号が重なりません。次の伝票番号：
            {device.code}-{String(device.nextReceipt).padStart(4, '0')}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h2>データ</h2>
        <div className="row">
          <button className="btn" onClick={() => downloadText(`物販バックアップ_${new Date().toISOString().slice(0, 10)}.json`, exportBackup(), 'application/json')}>
            バックアップを保存
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>バックアップから復元</button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              const err = importBackup(await f.text())
              if (err) toastError(err)
              else toast('復元しました')
            }}
          />
        </div>
        <p className="muted small">
          商品 {products.length}件・取引 {sales.length}件
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="btn"
            onClick={() => {
              if (!confirm('サンプル商品と過去14日分のサンプル売上を追加します。同期が有効ならクラウドにも送られます。よろしいですか？')) return
              loadSample()
              toast('サンプルデータを追加しました')
            }}
          >
            サンプルデータを追加
          </button>
          <button
            className="btn danger"
            onClick={() => {
              const msg = pending
                ? `まだクラウドに送信していない変更が ${pending}件あります。消去すると失われます。本当に消去しますか？`
                : 'この端末のデータを消去しますか？（クラウドのデータは残り、同期すると再取得されます）'
              if (!confirm(msg)) return
              resetLocal()
              toast('この端末のデータを消去しました')
            }}
          >
            この端末のデータを消去
          </button>
        </div>
      </div>
    </div>
  )
}
