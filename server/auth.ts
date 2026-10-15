/**
 * パスワードログイン。
 * - POST /api/login に { password, app } を送ると、パスワードが一致すればセッショントークンを返す
 *   - app が 'register'（省略時）なら APP_PASSWORD、'accounting' なら ACCOUNTING_PASSWORD と比べる
 * - トークンは「発行時刻.署名」。署名は SYNC_TOKEN を鍵にした HMAC で、アプリ名とそのパスワードも含めて計算する
 *   → レジのトークンでは会計アプリに入れない（逆も同じ）
 *   → パスワードを変えると、そのアプリの発行済みトークンはすべて使えなくなる（全端末が再ログイン）
 * - オフラインでもレジを止めないため、トークンに有効期限は設けない（ログアウトまたはパスワード変更まで有効）
 * - 端末にはパスワードそのものではなくトークンだけを保存する
 */

export type AuthEnv = { APP_PASSWORD?: string; SYNC_TOKEN?: string; ACCOUNTING_PASSWORD?: string }
export type AppScope = 'register' | 'accounting'

const enc = new TextEncoder()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** アプリごとのパスワード。未設定なら undefined */
const passwordFor = (env: AuthEnv, app: AppScope) => (app === 'accounting' ? env.ACCOUNTING_PASSWORD : env.APP_PASSWORD)

// レジは従来の "session:" のまま（発行済みのトークンを使い続けられるように）
const PREFIX: Record<AppScope, string> = { register: 'session', accounting: 'accounting' }

async function sign(secret: string, app: AppScope, password: string, issuedAt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${PREFIX[app]}:${issuedAt}:${password}`))
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Authorization: Bearer <token> が、そのアプリの有効なセッショントークンか */
export async function verifySession(req: Request, env: AuthEnv, app: AppScope = 'register'): Promise<boolean> {
  const password = passwordFor(env, app)
  if (!password || !env.SYNC_TOKEN) return false
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const [issuedAt, sig, ...rest] = token.split('.')
  if (!issuedAt || !sig || rest.length || !/^\d+$/.test(issuedAt)) return false
  return safeEqual(sig, await sign(env.SYNC_TOKEN, app, password, issuedAt))
}

export async function handleLogin(req: Request, env: AuthEnv): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  let body: { password?: unknown; app?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  const app: AppScope = body.app === 'accounting' ? 'accounting' : 'register'
  const expected = passwordFor(env, app)
  if (!expected || !env.SYNC_TOKEN) {
    const name = app === 'accounting' ? 'ACCOUNTING_PASSWORD' : 'APP_PASSWORD'
    return json({ error: `サーバーに ${name} / SYNC_TOKEN が設定されていません` }, 500)
  }

  if (typeof body.password !== 'string' || !safeEqual(body.password, expected)) {
    // 総当たりを遅くする
    await new Promise((r) => setTimeout(r, 1000))
    return json({ error: 'パスワードが違います' }, 401)
  }
  const issuedAt = String(Date.now())
  return json({ token: `${issuedAt}.${await sign(env.SYNC_TOKEN, app, expected, issuedAt)}` })
}
