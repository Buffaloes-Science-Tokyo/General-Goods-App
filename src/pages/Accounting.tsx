import { useStore } from '../store'
import { accountingLogout } from '../accountingAuth'

export function AccountingApp({ onHome }: { onHome: () => void }) {
  const { settings } = useStore()
  return (
    <div className="app">
      <header className="topbar">
        <button className="btn sm ghost" onClick={onHome}>← ホーム</button>
        <div className="brand">{settings.shopName} 会計</div>
        <button
          className="btn sm ghost"
          style={{ marginLeft: 'auto' }}
          onClick={() => confirm('会計アプリからログアウトしますか？') && accountingLogout()}
        >
          ログアウト
        </button>
      </header>
      <main className="main">
        <div className="card empty">会計アプリは準備中です。</div>
      </main>
    </div>
  )
}
