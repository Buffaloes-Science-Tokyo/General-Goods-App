import { useEffect, useState } from 'react'
import { isSessionToken, useStore } from './store'
import { syncNow } from './sync'
import { SyncIndicator } from './components/SyncIndicator'
import { RegisterPage } from './pages/Register'
import { ProductsPage } from './pages/Products'
import { StocktakePage } from './pages/Stocktake'
import { SalesPage } from './pages/Sales'
import { OnlinePage } from './pages/Online'
import { DiscountsPage } from './pages/Discounts'
import { DashboardPage } from './pages/Dashboard'
import { SettingsPage } from './pages/Settings'
import { LoginPage } from './pages/Login'
import { HomePage, type AppId } from './pages/Home'
import { AccountingApp } from './pages/Accounting'
import { useAccountingToken } from './accountingAuth'
import { ToastHost } from './components/ui'

const TABS = [
  { id: 'register', label: 'レジ', el: RegisterPage },
  { id: 'online', label: 'オンライン', el: OnlinePage },
  { id: 'products', label: '商品・在庫', el: ProductsPage },
  { id: 'stocktake', label: '棚卸し', el: StocktakePage },
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

/** URL の # から開いているアプリを決める（レジのタブ名ならレジアプリ、それ以外はホーム） */
const readApp = (): AppId | null => {
  const h = location.hash.slice(1)
  if (h === 'accounting' || h.startsWith('accounting-')) return 'accounting'
  if (TABS.some((t) => t.id === h)) return 'register'
  return null
}

const goHome = () => {
  history.pushState(null, '', location.pathname + location.search)
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export default function App() {
  const { sync } = useStore()
  const accountingToken = useAccountingToken()
  const [app, setApp] = useState(readApp)

  useEffect(() => {
    const onHash = () => setApp(readApp())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  if (!app) return <HomePage onOpen={(id) => (location.hash = id)} />
  // アプリに入るには、そのアプリのパスワードでのログインが必要（レジと会計は別）
  const loggedIn = app === 'accounting' ? !!accountingToken : isSessionToken(sync.token)
  if (!loggedIn) return <LoginPage key={app} app={app} onBack={goHome} />
  return app === 'accounting' ? <AccountingApp onHome={goHome} /> : <RegisterApp />
}

function RegisterApp() {
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
        <button className="btn sm ghost" onClick={goHome} title="ホームに戻る">← ホーム</button>
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
