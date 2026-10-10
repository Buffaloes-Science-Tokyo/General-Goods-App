import { handleLogin } from '../server/auth.js'

// Vercel Functions のエントリポイント（POST /api/login）
export function POST(request: Request) {
  return handleLogin(request, process.env)
}
