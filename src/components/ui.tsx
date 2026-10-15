import { useEffect, useState, type ReactNode } from 'react'
import { compareSize } from '../format'

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  )
}

type ToastMsg = { text: string; error?: boolean; key: number }
let pushToast: (m: Omit<ToastMsg, 'key'>) => void = () => {}

export const toast = (text: string) => pushToast({ text })
export const toastError = (text: string) => pushToast({ text, error: true })

export function ToastHost() {
  const [msg, setMsg] = useState<ToastMsg | null>(null)
  useEffect(() => {
    pushToast = (m) => setMsg({ ...m, key: Date.now() })
  }, [])
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), msg.error ? 4000 : 2200)
    return () => clearTimeout(t)
  }, [msg])
  if (!msg) return null
  return (
    <div key={msg.key} className={`toast${msg.error ? ' error' : ''}`} role="status">
      {msg.text}
    </div>
  )
}

/** 数値入力（空欄を許し、確定時に数値化） */
export function NumberInput({
  value,
  onChange,
  min,
  className = '',
  ...rest
}: {
  value: number
  onChange: (n: number) => void
  min?: number
  className?: string
  placeholder?: string
  autoFocus?: boolean
  'aria-label'?: string
  style?: React.CSSProperties
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText((t) => (Number(t) === value && t !== '' ? t : String(value)))
  }, [value])
  return (
    <input
      {...rest}
      className={`input num ${className}`}
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d-]/g, '')
        setText(v)
        const n = Number(v)
        if (v !== '' && v !== '-' && Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, n) : n)
        else if (v === '') onChange(0)
      }}
      onBlur={() => setText(String(value))}
      onFocus={(e) => e.target.select()}
    />
  )
}

export function StockBadge({ stock, low }: { stock: number; low: number }) {
  if (stock <= 0) return <span className="badge out">在庫切れ</span>
  if (stock <= low) return <span className="badge low">残り{stock}</span>
  return null
}

/** 同名商品のまとまりに含まれるタイプ・サイズの一覧 */
export function VariantSummary({ items }: { items: { type: string; size: string }[] }) {
  const types = [...new Set(items.map((p) => p.type).filter(Boolean))]
  const sizes = [...new Set(items.map((p) => p.size).filter(Boolean))].sort(compareSize)
  if (!types.length && !sizes.length) return null
  return (
    <span className="attrs">
      {types.map((t) => <span key={`t:${t}`} className="attr">{t}</span>)}
      {sizes.map((s) => <span key={`s:${s}`} className="attr size">{s}</span>)}
    </span>
  )
}
