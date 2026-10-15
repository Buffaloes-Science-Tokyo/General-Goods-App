import { useState } from 'react'
import { useStore } from '../store'
import { login, takeLogoutReason } from '../sync'
import { APPS, type AppId } from './Home'

export function LoginPage({ app, onBack }: { app: AppId; onBack: () => void }) {
  const { settings, pending } = useStore()
  const appName = APPS.find((a) => a.id === app)!.name
  const [password, setPassword] = useState('')
  const [error, setError] = useState(() => takeLogoutReason(app))
  const [busy, setBusy] = useState(false)

  return (
    <div className="login">
      <form
        className="card login-card"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!password || busy) return
          setBusy(true)
          setError('')
          const err = await login(password, app)
          setBusy(false)
          if (err) setError(err)
        }}
      >
        <h1>{appName}</h1>
        <p className="muted small" style={{ margin: 0 }}>{settings.shopName}</p>
        <label className="field">
          パスワード
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="btn primary" type="submit" disabled={!password || busy}>
          {busy ? 'ログイン中…' : 'ログイン'}
        </button>
        <button className="btn ghost" type="button" onClick={onBack}>
          ← ホームに戻る
        </button>
        {app === 'register' && pending > 0 && (
          <p className="muted small" style={{ margin: 0 }}>
            この端末に未送信の変更が {pending}件あります。ログインすると送信します。
          </p>
        )}
      </form>
    </div>
  )
}
