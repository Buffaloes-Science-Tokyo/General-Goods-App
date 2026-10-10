import { useEffect, useState } from 'react'
import { isSessionToken, useStore } from './store'
import { syncNow, useSyncStatus } from './sync'
import { RegisterPage } from './pages/Register'
import { ProductsPage } from './pages/Products'
import { SalesPage } from './pages/Sales'
import { OnlinePage } from './pages/Online'
import { DiscountsPage } from './pages/Discounts'
import { DashboardPage } from './pages/Dashboard'
import { SettingsPage } from './pages/Settings'
import { LoginPage } from './pages/Login'
import { ToastHost } from './components/ui'

const TABS = [
  { id: 'register', label: 'レジ', el: RegisterPage },
  { id: 'online', label: 'オンライン', el: OnlinePage },
  { id: 'products', label: '商品・在庫', el: ProductsPage },
  { id: 'discounts', label: '割引', el: DiscountsPage },
  { id: 'sales', label: '販売履歴', el: SalesPage },
  { id: 'dashboard', label: 'ダッシュボード', el: DashboardPage },
  { id: 'settings', label: '設定', el: SettingsPage },
] as const
type TabId = (typeof TABS)[number]['id']

const readHash = (): TabId => {
  const h = location.hash.slice(1)
  return (TABS.find((t) => t.id === h)?.id ?? 'register') as TabId
}

function SyncIndicator({ onClick }: { onClick: () => void }) {
  const status = useSyncStatus()
  const { pending } = useStore()
  const map = {
    disabled: { dot: 'var(--muted)', text: '待機中' },
    offline: { dot: 'var(--warning)', text: 'オフライン' },
    syncing: { dot: 'var(--accent)', text: '同期中' },
    ok: { dot: 'var(--good)', text: '同期済み' },
    error: { dot: 'var(--critical)', text: '同期エラー' },
  } as const
  const m = map[status.kind]
  return (
    <button
      className="btn sm ghost"
      onClick={onClick}
      title={status.kind === 'error' ? status.message : '同期の状態'}
      style={{ marginLeft: 'auto' }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 99, background: m.dot, display: 'inline-block' }} />
      {m.text}
      {pending > 0 && status.kind !== 'disabled' && <span className="badge">送信待ち {pending}</span>}
    </button>
  )
}

export default function App() {
  const { sync } = useStore()
  return isSessionToken(sync.token) ? <MainApp /> : <LoginPage />
}

function MainApp() {
  const [tab, setTab] = useState<TabId>(readHash)
  const { settings, persistError } = useStore()

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
        <div className="brand">{settings.shopName}</div>
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.id} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <SyncIndicator
          onClick={() => {
            void syncNow()
            if (tab !== 'settings') go('settings')
          }}
        />
      </header>
      {persistError && <div className="save-error">端末への保存に失敗しました：{persistError}</div>}
      <main className="main">
        <Page />
      </main>
      <ToastHost />
    </div>
  )
}
