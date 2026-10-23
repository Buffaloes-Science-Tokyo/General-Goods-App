import { useEffect, useState } from 'react'
import { createStore, del as idbDel, get as idbGet, set as idbSet, update as idbUpdate } from 'idb-keyval'
import { getAccountingToken } from './accountingAuth'
import { uid } from './store'
import type { Attachment } from './types'

/**
 * 収支の記録・キャッシュフローに添付する画像。
 * - 画像は端末で縮小してから、この端末の IndexedDB に保存する（オフラインでも添付・表示できる）
 * - 記録を保存すると送信待ちに積み、会計アプリでログインしていてオンラインのときに /api/attachments へ送る
 * - 他の端末の画像は、表示するときに取得して端末に保存する
 * - 記録の同期（sync.ts）とは別に送るので、画像が大きくても記録の同期は止まらない
 */

const ENDPOINT = import.meta.env.VITE_ATTACHMENT_ENDPOINT || '/api/attachments'
const files = createStore('goods-selling-attachments', 'files')
const PENDING = 'pending'
const blobKey = (id: string) => `blob:${id}`

/** 縮小するときの長辺（px）。レシートの文字が読める大きさ */
const MAX_EDGE = 2000
/** これ以下で長辺も MAX_EDGE 以下なら、縮小せずそのまま使う */
const KEEP_BYTES = 1_500_000
/** 1枚の上限（サーバーの MAX_ATTACHMENT_BYTES と同じ） */
const MAX_BYTES = 4_000_000
/** 1つの記録に添付できる枚数 */
export const MAX_ATTACHMENTS = 10

const KEEP_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/** 画像を縮小する（長辺 MAX_EDGE・JPEG）。ブラウザが読めない形式で小さければそのまま使う */
async function shrink(file: File): Promise<Blob> {
  let bmp: ImageBitmap
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    if (file.size <= MAX_BYTES && file.type.startsWith('image/')) return file
    throw new Error(`「${file.name}」は読み込めない形式です`)
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height))
  if (scale === 1 && file.size <= KEEP_BYTES && KEEP_TYPES.has(file.type)) {
    bmp.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  const ctx = canvas.getContext('2d')!
  // 透過部分は白にする（JPEG は透過できない）
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
  if (!blob) throw new Error(`「${file.name}」を変換できませんでした`)
  return blob
}

/** 画像を縮小してこの端末に保存し、記録に付ける情報を返す（まだ送信はしない） */
export async function addImage(file: File): Promise<Attachment> {
  const blob = await shrink(file)
  if (blob.size > MAX_BYTES) throw new Error(`「${file.name}」が大きすぎます（4MB まで）`)
  const id = uid()
  await idbSet(blobKey(id), blob, files)
  const name = blob === file ? file.name : file.name.replace(/\.[^.]*$/, '') + '.jpg'
  return { id, name, type: blob.type || 'image/jpeg', size: blob.size }
}

/** 記録を保存したとき：その記録の画像を送信待ちに積んで送る */
export function queueUploads(list: Attachment[] | undefined) {
  if (!list?.length) return
  void idbUpdate<string[]>(PENDING, (v = []) => [...new Set([...v, ...list.map((a) => a.id)])], files)
    .then(() => uploadPending())
    .catch(() => {})
}

let uploading: Promise<void> | null = null

/** 送信待ちの画像を送る（sync.ts の同期のあとにも呼ぶ）。会計アプリでログインしていなければ何もしない */
export function uploadPending(): Promise<void> {
  uploading ??= (async () => {
    const ids = (await idbGet<string[]>(PENDING, files)) ?? []
    for (const id of ids) {
      const token = getAccountingToken()
      if (!token || !navigator.onLine) return
      const blob = await idbGet<Blob>(blobKey(id), files)
      if (blob) {
        const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'content-type': blob.type || 'image/jpeg', authorization: `Bearer ${token}` },
          body: blob,
        }).catch(() => null)
        // 通信できない・ログアウトされた等は次の同期で送り直す。送れない画像（形式・大きさ）は諦める
        if (!res || res.status === 401 || res.status >= 500) return
      }
      await idbUpdate<string[]>(PENDING, (v = []) => v.filter((x) => x !== id), files)
    }
  })()
    .catch(() => {})
    .finally(() => {
      uploading = null
    })
  return uploading
}

/** 表示用の URL（この端末に無ければサーバーから取得して保存する） */
const urls = new Map<string, Promise<string>>()

export function attachmentUrl(a: Attachment): Promise<string> {
  let p = urls.get(a.id)
  if (!p) {
    p = (async () => {
      const local = await idbGet<Blob>(blobKey(a.id), files)
      if (local) return URL.createObjectURL(local)
      const token = getAccountingToken()
      if (!token) throw new Error('会計アプリにログインしてください')
      if (!navigator.onLine) throw new Error('オフラインのため表示できません')
      const res = await fetch(`${ENDPOINT}?id=${encodeURIComponent(a.id)}`, { headers: { authorization: `Bearer ${token}` } })
      if (res.status === 404) throw new Error('記録した端末からまだ送信されていません')
      if (!res.ok) throw new Error(`取得できませんでした (${res.status})`)
      const blob = await res.blob()
      await idbSet(blobKey(a.id), blob, files).catch(() => {})
      return URL.createObjectURL(blob)
    })()
    // 失敗したときは次に表示するときに取り直す
    p.catch(() => urls.delete(a.id))
    urls.set(a.id, p)
  }
  return p
}

export function useAttachmentUrl(a: Attachment): { url: string | null; error: string | null } {
  const [r, setR] = useState<{ id: string; url: string | null; error: string | null }>({ id: a.id, url: null, error: null })
  useEffect(() => {
    let alive = true
    attachmentUrl(a).then(
      (url) => alive && setR({ id: a.id, url, error: null }),
      (e: unknown) => alive && setR({ id: a.id, url: null, error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      alive = false
    }
  }, [a.id])
  return r.id === a.id ? r : { url: null, error: null }
}

/** 記録に付けずにやめた画像を端末から消す（送信待ちに積んだ画像は消さない） */
export function discardImage(id: string) {
  void idbGet<string[]>(PENDING, files)
    .then((v) => (v?.includes(id) ? undefined : idbDel(blobKey(id), files)))
    .catch(() => {})
}
