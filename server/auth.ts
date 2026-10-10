/**
 * パスワードログイン。
 * - POST /api/login に { password } を送ると、APP_PASSWORD と一致すればセッショントークンを返す
 * - トークンは「発行時刻.署名」。署名は SYNC_TOKEN を鍵にした HMAC で、APP_PASSWORD も含めて計算する
 *   → パスワードを変えると、発行済みのトークンはすべて使えなくなる（全端末が再ログイン）
 * - オフラインでもレジを止めないため、トークンに有効期限は設けない（ログアウトまたはパスワード変更まで有効）
 * - 端末にはパスワードそのものではなくトークンだけを保存する
 */

export type AuthEnv = { APP_PASSWORD?: string; SYNC_TOKEN?: string }

const enc = new TextEncoder()

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function sign(env: Required<AuthEnv>, issuedAt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SYNC_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`session:${issuedAt}:${env.APP_PASSWORD}`))
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const configured = (env: AuthEnv): env is Required<AuthEnv> => !!env.APP_PASSWORD && !!env.SYNC_TOKEN

/** Authorization: Bearer <token> が有効なセッショントークンか */
export async function verifySession(req: Request, env: AuthEnv): Promise<boolean> {
  if (!configured(env)) return false
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const [issuedAt, sig, ...rest] = token.split('.')
  if (!issuedAt || !sig || rest.length || !/^\d+$/.test(issuedAt)) return false
  return safeEqual(sig, await sign(env, issuedAt))
}

export async function handleLogin(req: Request, env: AuthEnv): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
  if (!configured(env)) return json({ error: 'サーバーに APP_PASSWORD / SYNC_TOKEN が設定されていません' }, 500)

  let password: unknown
  try {
    password = ((await req.json()) as { password?: unknown }).password
  } catch {
    return json({ error: 'invalid json' }, 400)
  }
  if (typeof password !== 'string' || !safeEqual(password, env.APP_PASSWORD)) {
    // 総当たりを遅くする
    await new Promise((r) => setTimeout(r, 1000))
    return json({ error: 'パスワードが違います' }, 401)
  }
  const issuedAt = String(Date.now())
  return json({ token: `${issuedAt}.${await sign(env, issuedAt)}` })
}
