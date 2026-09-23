import { handleSync } from '../server/syncHandler.js'

// Vercel Functions のエントリポイント（POST /api/sync）
export function POST(request: Request) {
  return handleSync(request, process.env)
}
