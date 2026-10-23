import { handleAttachment } from '../server/attachmentsHandler.js'

// Vercel Functions のエントリポイント（GET・PUT /api/attachments?id=…）
export function GET(request: Request) {
  return handleAttachment(request, process.env)
}

export function PUT(request: Request) {
  return handleAttachment(request, process.env)
}
