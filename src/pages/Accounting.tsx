import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { syncNow } from '../sync'
import { accountingLogout } from '../accountingAuth'
import { SyncIndicator } from '../components/SyncIndicator'
import { ToastHost } from '../components/ui'
import { AccountingDashboardPage } from './accounting/Dashboard'
import { LedgerPage } from './accounting/Ledger'

const TABS = [
  { id: 'accounting', label: 'ダッシュボード', el: AccountingDashboardPage },
  { id: 'accounting-records', label: '収支の記録', el: LedgerPage },
] as const
type TabId = (typeof TABS)[number]['id']

const readHash = (): TabId => {
  const h = location.hash.slice(1)
  return (TABS.find((t) => t.id === h)?.id ?? 'accounting') as TabId
}

export function AccountingApp({ onHome }: { onHome: () => void }) {
  const { settings, persistError } = useStore()
  const [tab, setTab] = useState<TabId>(readHash)

  useEffect(() => {
    const onHash = () => setTab(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (id: TabId) => {
    location.hash = id
    setTab(id)
  }
  const Page = TABS.find((t) => t.id === tab)!.el

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn sm ghost" onClick={onHome} title="ホームに戻る">← ホーム</button>
        <div className="brand">{settings.shopName} 会計</div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <SyncIndicator onClick={() => void syncNow()} />
        <button className="btn sm ghost" onClick={() => confirm('会計アプリからログアウトしますか？') && accountingLogout()}>
          ログアウト
        </button>
      </header>
      {persistError && <div className="save-error">端末への保存に失敗しました：{persistError}</div>}
      <main className="main">
        <Page />
      </main>
      <ToastHost />
    </div>
  )
}
