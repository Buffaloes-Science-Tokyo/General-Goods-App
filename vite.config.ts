import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import type { NeonQueryFunction } from '@neondatabase/serverless'

/**
 * 開発時に /api/sync・/api/login を Vercel と同じハンドラで動かす。
 * .env に DATABASE_URL があれば Neon に、無ければ組み込み Postgres（PGlite, .pglite/ に保存）につなぐ。
 */
function devSyncApi(env: Record<string, string>): Plugin {
  return {
    name: 'dev-sync-api',
    configureServer(server: ViteDevServer) {
      const useLocal = !env.DATABASE_URL
      const syncEnv = useLocal
        ? { DATABASE_URL: 'pglite', SYNC_TOKEN: env.SYNC_TOKEN || 'dev-secret', APP_PASSWORD: env.APP_PASSWORD || 'dev' }
        : env
      let localSql: Promise<NeonQueryFunction<false, false>> | null = null
      const getLocalSql = () =>
        (localSql ??= (async () => {
          const { PGlite } = await import('@electric-sql/pglite')
          const { pgliteSql } = (await server.ssrLoadModule('/server/pgliteAdapter.ts')) as typeof import('./server/pgliteAdapter')
          return pgliteSql(new PGlite('./.pglite'))
        })())
      if (useLocal) {
        server.config.logger.info(`  ➜  同期API: 組み込みDB (.pglite/) を使用中。パスワードは "${syncEnv.APP_PASSWORD}"`)
      }

      const toRequest = async (req: import('node:http').IncomingMessage & { originalUrl?: string }) => {
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const headers = new Headers()
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
        return new Request(`http://localhost${req.originalUrl ?? '/'}`, {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        })
      }
      const send = async (res: import('node:http').ServerResponse, response: Response) => {
        res.statusCode = response.status
        response.headers.forEach((v, k) => res.setHeader(k, v))
        res.end(Buffer.from(await response.arrayBuffer()))
      }

      server.middlewares.use('/api/login', async (req, res) => {
        try {
          const { handleLogin } = (await server.ssrLoadModule('/server/auth.ts')) as typeof import('./server/auth')
          await send(res, await handleLogin(await toRequest(req), syncEnv))
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })

      server.middlewares.use('/api/sync', async (req, res) => {
        try {
          const request = await toRequest(req)
          const localSqlResolved = useLocal ? await getLocalSql() : null
          const { handleSync } = (await server.ssrLoadModule('/server/syncHandler.ts')) as typeof import('./server/syncHandler')
          const response = useLocal
            ? await handleSync(request, syncEnv, () => localSqlResolved!)
            : await handleSync(request, syncEnv)
          await send(res, response)
        } catch (e) {
          res.statusCode = 500
          res.end(String(e))
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), devSyncApi(env)],
    server: { host: true },
  }
})
