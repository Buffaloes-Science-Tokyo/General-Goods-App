import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initStore } from './store'
import { startAutoSync } from './sync'
import './styles.css'

// アプリ本体をキャッシュしてオフラインでも起動できるようにする（本番ビルドのみ）
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW 登録失敗', e))
  })
}

initStore().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  startAutoSync()
})
