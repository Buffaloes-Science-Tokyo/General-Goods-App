const yenFmt = new Intl.NumberFormat('ja-JP')

export const yen = (n: number) => `¥${yenFmt.format(Math.round(n))}`
export const num = (n: number) => yenFmt.format(n)
export const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—')

/** ローカル日付の YYYY-MM-DD */
export function dayKey(d: Date | string) {
  const x = typeof d === 'string' ? new Date(d) : d
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
}

export function dateTime(iso: string) {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function downloadText(filename: string, text: string, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Excel で文字化けしないよう BOM 付き CSV */
export function toCsv(rows: (string | number)[][]) {
  const esc = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
}

type Attrs = { name: string; type?: string; size?: string }

/** 「ブラック・M」のような属性表記（無ければ空文字） */
export const attrText = (x: Omit<Attrs, 'name'>) => [x.type, x.size].filter(Boolean).join('・')

/** 「Tシャツ（ブラック・M）」のような商品のフル表記 */
export function fullName(x: Attrs) {
  const a = attrText(x)
  return a ? `${x.name}（${a}）` : x.name
}

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', '3XL', 'XXXL', 'F', 'FREE']

/** サイズの並び順（S→M→L…。数値は小さい順、それ以外は文字順） */
export function compareSize(a: string, b: string) {
  const ia = SIZE_ORDER.indexOf(a.toUpperCase())
  const ib = SIZE_ORDER.indexOf(b.toUpperCase())
  if (ia >= 0 && ib >= 0) return ia - ib
  if (ia >= 0 !== ib >= 0) return ia >= 0 ? -1 : 1
  const na = parseFloat(a)
  const nb = parseFloat(b)
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return a.localeCompare(b, 'ja')
}

/** 商品名が同じ（タイプ・サイズ違い）の商品のまとまり */
export type NameGroup<T> = { name: string; items: T[] }

/** 商品名でまとめる。グループは最初に出てきた順、中身はタイプ→サイズ順 */
export function groupByName<T extends Attrs>(list: T[]): NameGroup<T>[] {
  const map = new Map<string, T[]>()
  for (const x of list) {
    const k = x.name.trim()
    const g = map.get(k)
    if (g) g.push(x)
    else map.set(k, [x])
  }
  return [...map].map(([name, items]) => ({
    name,
    items: items.sort((a, b) => (a.type ?? '').localeCompare(b.type ?? '', 'ja') || compareSize(a.size ?? '', b.size ?? '')),
  }))
}
