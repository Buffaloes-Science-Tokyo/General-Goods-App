import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { verifySession, type AuthEnv } from './auth.js'
import { ensureSchema } from './syncHandler.js'

/**
 * 添付画像の API（Web 標準の Request → Response）。
 * Vercel Functions（api/attachments.ts）と開発サーバー（vite.config.ts）の両方から使う。
 *
 * - PUT /api/attachments?id=… ：画像を保存（本文が画像そのもの。同じ ID は上書きしない）
 * - GET /api/attachments?id=… ：画像を返す
 * - 会計アプリでログインした端末だけが使える
 * - 画像は ID ごとに中身が変わらないので、上書き・更新の競合は起きない
 */

type Env = AuthEnv & { DATABASE_URL?: string }

/** 1枚の上限（Vercel Functions の本文の上限 4.5MB より小さく） */
export const MAX_ATTACHMENT_BYTES = 4_000_000

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export async function handleAttachment(
  req: Request,
  env: Env,
  makeSql: (url: string) => NeonQueryFunction<false, false> = neon,
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'PUT') return json({ error: 'GET / PUT only' }, 405)
  if (!env.DATABASE_URL || !env.SYNC_TOKEN) return json({ error: 'サーバーに DATABASE_URL / SYNC_TOKEN が設定されていません' }, 500)
  if (!(await verifySession(req, env, 'accounting'))) return json({ error: 'unauthorized' }, 401)

  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ error: 'invalid id' }, 400)

  const sql = makeSql(env.DATABASE_URL)
  try {
    await ensureSchema(sql)

    if (req.method === 'GET') {
      // bytea はドライバによって返り方が違うので、base64 の文字列でやり取りする
      const rows = await sql.query(`select mime, encode(data, 'base64') as data from attachments where id = $1`, [id])
      if (!rows[0]) return json({ error: 'not found' }, 404)
      const bytes = new Uint8Array(Buffer.from(String(rows[0].data), 'base64'))
      return new Response(bytes, {
        headers: { 'content-type': String(rows[0].mime), 'cache-control': 'private, max-age=31536000, immutable' },
      })
    }

    const mime = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!/^image\/[a-z0-9.+-]+$/.test(mime)) return json({ error: '画像ではありません' }, 415)
    const body = new Uint8Array(await req.arrayBuffer())
    if (!body.length) return json({ error: 'empty' }, 400)
    if (body.length > MAX_ATTACHMENT_BYTES) return json({ error: '画像が大きすぎます' }, 413)
    await sql.query(
      `insert into attachments (id, mime, data) values ($1, $2, decode($3, 'base64')) on conflict (id) do nothing`,
      [id, mime, Buffer.from(body).toString('base64')],
    )
    return json({ ok: true })
  } catch (e) {
    console.error('[attachments]', e)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
}
