import { useSyncExternalStore } from 'react'
import { isSessionToken } from './store'

/**
 * 会計アプリのログイン状態。レジ（同期用）のトークンとは別に、この端末の localStorage に保存する。
 * レジのパスワードでは会計アプリに入れないよう、トークンもサーバー側で別の署名になっている。
 */
const KEY = 'accounting-session'
const listeners = new Set<() => void>()

function read(): string {
  try {
    const t = localStorage.getItem(KEY) ?? ''
    return isSessionToken(t) ? t : ''
  } catch {
    return ''
  }
}

let token = read()

function set(next: string) {
  token = next
  try {
    if (next) localStorage.setItem(KEY, next)
    else localStorage.removeItem(KEY)
  } catch {
    // 保存できなくても、このタブを開いている間はログイン状態を保つ
  }
  listeners.forEach((l) => l())
}

export const getAccountingToken = () => token
export const setAccountingToken = (t: string) => set(t)
export const accountingLogout = () => set('')

/** ログイン状態が変わったときに呼ぶ（同期の開始用） */
export function subscribeAccounting(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

// 別のタブでログイン／ログアウトしたら反映する
window.addEventListener('storage', (e) => {
  if (e.key === KEY) {
    token = read()
    listeners.forEach((l) => l())
  }
})

export function useAccountingToken(): string {
  return useSyncExternalStore(subscribeAccounting, () => token)
}
