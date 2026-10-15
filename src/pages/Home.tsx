import { useStore } from '../store'

export type AppId = 'register' | 'accounting'

export const APPS: { id: AppId; name: string; icon: string; desc: string }[] = [
  { id: 'register', name: 'レジアプリ', icon: '🧾', desc: 'レジ・オンライン注文・商品と在庫・割引・販売履歴・ダッシュボード' },
  { id: 'accounting', name: '会計アプリ', icon: '📒', desc: '帳簿・経費・収支の管理' },
]

export function HomePage({ onOpen }: { onOpen: (id: AppId) => void }) {
  const { settings } = useStore()
  return (
    <div className="home">
      <div className="home-inner">
        <h1>{settings.shopName}</h1>
        <p className="muted" style={{ margin: 0 }}>使うアプリを選んでください</p>
        <div className="home-apps">
          {APPS.map((a) => (
            <button key={a.id} className="home-app" onClick={() => onOpen(a.id)}>
              <span className="home-app-icon" aria-hidden>{a.icon}</span>
              <span className="home-app-name">{a.name}</span>
              <span className="home-app-desc">{a.desc}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
