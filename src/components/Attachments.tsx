import { useState } from 'react'
import { addImage, discardImage, MAX_ATTACHMENTS, useAttachmentUrl } from '../attachments'
import type { Attachment } from '../types'
import { Modal, toastError } from './ui'

/** 画像の小さな表示（この端末に無ければ取得してから表示する） */
function Thumb({ a }: { a: Attachment }) {
  const { url, error } = useAttachmentUrl(a)
  return (
    <span className="att-thumb" title={error ?? a.name}>
      {url ? <img src={url} alt={a.name} /> : <span className="muted small">{error ? '表示不可' : '…'}</span>}
    </span>
  )
}

/**
 * 記録のフォームで画像を添付する欄。選んだ画像は縮小して端末に保存し、記録を保存したときに送信する。
 * 縮小に時間がかかる間もフォームの入力が消えないよう、追加・削除は差分で親に渡す
 */
export function AttachmentPicker({
  value,
  onAdd,
  onRemove,
}: {
  value: Attachment[]
  onAdd: (list: Attachment[]) => void
  onRemove: (id: string) => void
}) {
  const [busy, setBusy] = useState(0)
  const room = MAX_ATTACHMENTS - value.length - busy

  async function pick(list: FileList | null) {
    const picked = [...(list ?? [])]
    if (!picked.length) return
    if (picked.length > room) toastError(`画像は1つの記録に${MAX_ATTACHMENTS}枚までです`)
    const take = picked.slice(0, Math.max(0, room))
    setBusy((n) => n + take.length)
    const added: Attachment[] = []
    for (const f of take) {
      try {
        added.push(await addImage(f))
      } catch (e) {
        toastError(e instanceof Error ? e.message : String(e))
      }
    }
    setBusy((n) => n - take.length)
    if (added.length) onAdd(added)
  }

  return (
    <div className="att-list">
      {value.map((a) => (
        <span key={a.id} className="att-item">
          <Thumb a={a} />
          <button
            type="button"
            className="att-remove"
            aria-label={`${a.name} を外す`}
            onClick={() => {
              onRemove(a.id)
              discardImage(a.id)
            }}
          >
            ×
          </button>
        </span>
      ))}
      {busy > 0 && <span className="muted small">画像を準備中…</span>}
      {room > 0 && (
        <label className="btn sm att-add">
          ＋ 画像を添付
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void pick(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      )}
    </div>
  )
}

/** 一覧の行に出す「画像 N」ボタン。押すと画像を大きく表示する */
export function AttachmentsButton({ items, title }: { items: Attachment[] | undefined; title: string }) {
  const [open, setOpen] = useState(false)
  if (!items?.length) return null
  return (
    <>
      <button className="btn sm ghost" onClick={() => setOpen(true)} title="添付した画像を見る">
        画像 {items.length}
      </button>
      {open && (
        <Modal title={title} onClose={() => setOpen(false)}>
          <div className="att-view">
            {items.map((a) => (
              <ViewerItem key={a.id} a={a} />
            ))}
          </div>
          <div className="actions">
            <button className="btn" onClick={() => setOpen(false)}>閉じる</button>
          </div>
        </Modal>
      )}
    </>
  )
}

function ViewerItem({ a }: { a: Attachment }) {
  const { url, error } = useAttachmentUrl(a)
  return (
    <div>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt={a.name} />
        </a>
      ) : (
        <div className="empty small">{error ?? '読み込み中…'}</div>
      )}
      <div className="row small" style={{ marginTop: 4 }}>
        <span className="muted grow">{a.name}</span>
        {url && (
          <a className="btn sm" href={url} download={a.name}>
            保存
          </a>
        )}
      </div>
    </div>
  )
}
