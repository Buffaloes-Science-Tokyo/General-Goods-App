import type { NeonQueryFunction } from '@neondatabase/serverless'
import type { PGlite } from '@electric-sql/pglite'

/**
 * 開発用：Neon ドライバと同じ形（query / transaction）で PGlite（組み込み Postgres）を使うためのアダプタ。
 * DATABASE_URL 未設定で `npm run dev` したときに使われる。データは .pglite/ に保存。
 */
type LazyQuery = { text: string; params: unknown[]; then: Promise<unknown[]>['then'] }

export function pgliteSql(db: PGlite): NeonQueryFunction<false, false> {
  const query = (text: string, params: unknown[] = []): LazyQuery => ({
    text,
    params,
    then: (onOk, onErr) => db.query(text, params).then((r) => r.rows).then(onOk, onErr),
  })
  const transaction = (qs: LazyQuery[]) =>
    db.transaction(async (tx) => {
      const out: unknown[][] = []
      for (const q of qs) out.push((await tx.query(q.text, q.params)).rows)
      return out
    })
  return { query, transaction } as unknown as NeonQueryFunction<false, false>
}
