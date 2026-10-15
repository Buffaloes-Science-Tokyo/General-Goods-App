import { useStore } from '../store'
import { useSyncStatus } from '../sync'

/** 同期の状態（ヘッダー右端） */
export function SyncIndicator({ onClick }: { onClick: () => void }) {
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
