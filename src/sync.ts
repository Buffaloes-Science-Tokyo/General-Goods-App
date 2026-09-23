import { useSyncExternalStore } from 'react'
import { applySyncResult, collectOutbox, getState, pendingCount, subscribeStore } from './store'
import type { SyncRequest, SyncResponse } from './types'

export type SyncStatus =
  | { kind: 'disabled' }
  | { kind: 'offline' }
  | { kind: 'syncing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }

const ENDPOINT = import.meta.env.VITE_SYNC_ENDPOINT || '/api/sync'
const INTERVAL_MS = 30_000
const DEBOUNCE_MS = 1_500

let status: SyncStatus = { kind: 'disabled' }
const listeners = new Set<() => void>()

function setStatus(s: SyncStatus) {
  status = s
  listeners.forEach((l) => l())
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}

let running: Promise<void> | null = null
let again = false

/** 送信待ちを送り、クラウドの変更を受け取る。実行中に呼ばれたら終わった後にもう一度走る */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}

async function syncOnce() {
  const { sync } = getState()
  if (!sync.token) return setStatus({ kind: 'disabled' })
  if (!navigator.onLine) return setStatus({ kind: 'offline' })

  setStatus({ kind: 'syncing' })
  const sent = collectOutbox()
  const body: SyncRequest = { cursor: sync.cursor, changes: sent }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sync.token}` },
      body: JSON.stringify(body),
    })
    if (res.status === 401) return setStatus({ kind: 'error', message: '合言葉が違います' })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return setStatus({ kind: 'error', message: `サーバーエラー (${res.status}) ${text.slice(0, 120)}` })
    }
    const data = (await res.json()) as SyncResponse
    // 送信中に合言葉が変わっていたら結果は捨てる
    if (getState().sync.token !== sync.token) return
    applySyncResult(sent, data.changes, data.cursor)
    const sentCount = sent.products.length + sent.sales.length + sent.stockEvents.length
    // 上限で分割した残りがあれば続けて送る
    if (sentCount > 0 && pendingCount() > 0) again = true
    setStatus({ kind: 'ok' })
  } catch {
    // fetch 自体の失敗 = 電波が切れた等。次の機会に再送する
    setStatus(navigator.onLine ? { kind: 'error', message: 'サーバーに接続できません' } : { kind: 'offline' })
  }
}

let started = false

/** 自動同期を開始：オンライン復帰時・変更時（少し待って）・定期的に */
export function startAutoSync() {
  if (started) return
  started = true

  window.addEventListener('online', () => void syncNow())
  window.addEventListener('offline', () => {
    if (getState().sync.token) setStatus({ kind: 'offline' })
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  setInterval(() => void syncNow(), INTERVAL_MS)

  let timer: ReturnType<typeof setTimeout> | undefined
  let lastOutbox = getState().outbox
  let lastToken = getState().sync.token
  subscribeStore(() => {
    const s = getState()
    if (s.sync.token !== lastToken) {
      lastToken = s.sync.token
      void syncNow()
    }
    if (s.outbox === lastOutbox) return
    lastOutbox = s.outbox
    const o = s.outbox
    // 同期結果の反映で outbox が空になった場合などは送るものがないので何もしない
    if (!o.products.length && !o.sales.length && !o.stockEvents.length && !o.settings) return
    clearTimeout(timer)
    timer = setTimeout(() => void syncNow(), DEBOUNCE_MS)
  })

  void syncNow()
}
