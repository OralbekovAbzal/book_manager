import React, { useEffect, useRef, useState } from 'react'
import type { DatasetField, FunctionInfo } from '../../../api/reports'
import { ctl, Chip, Hint } from './ui'

/**
 * Поле формулы с палитрой: клик по полю/колонке/параметру/функции вставляет
 * имя в позицию курсора. Формулу можно и просто напечатать — палитра лишь
 * избавляет от угадывания ключей вроде `isAvailable`.
 *
 * Пишет в определение по blur/Enter, а не на каждую букву: незаконченная
 * формула на каждую букву дёргала бы валидацию и мигала ошибками.
 */

interface Props {
  value: string
  onCommit: (v: string) => void
  fields: DatasetField[]
  /** Другие колонки отчёта, на которые можно ссылаться по ключу */
  columns?: { key: string; title: string }[]
  params?: { key: string; label: string }[]
  functions: FunctionInfo[]
  /** В условиях фильтра агрегаты недоступны — не показываем их в палитре */
  aggAllowed: boolean
  placeholder?: string
  rows?: number
}

export const ExprEditor: React.FC<Props> = ({
  value, onCommit, fields, columns = [], params = [], functions, aggAllowed, placeholder, rows = 2,
}) => {
  const [text, setText] = useState(value)
  const [palette, setPalette] = useState<'fields' | 'columns' | 'params' | 'functions' | null>('fields')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setText(value) }, [value])

  const commit = (t = text) => { if (t !== value) onCommit(t) }

  /** Вставка в позицию курсора с пробелами по краям, где их не хватает. */
  const insert = (snippet: string) => {
    const el = ref.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const before = text.slice(0, start)
    const after = text.slice(end)
    const pad = (s: string, side: 'l' | 'r') => (s && !/\s|\($/.test(side === 'l' ? s.slice(-1) : s[0]) && !/^[,)]/.test(side === 'r' ? s : '') ? ' ' : '')
    const next = `${before}${pad(before, 'l')}${snippet}${pad(after, 'r')}${after}`
    setText(next)
    onCommit(next)
    requestAnimationFrame(() => {
      if (!el) return
      const pos = before.length + pad(before, 'l').length + snippet.length
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  const visibleFields = fields.filter((f) => !f.synthetic)
  const syntheticFields = fields.filter((f) => f.synthetic)
  const fns = functions.filter((f) => aggAllowed || !f.agg)

  const tab = (key: NonNullable<typeof palette>, label: string, count: number) => (
    <button
      key={key}
      type="button"
      onClick={() => setPalette(palette === key ? null : key)}
      disabled={count === 0}
      style={{
        height: 22, padding: '0 8px', border: 'none', borderRadius: 5, cursor: count ? 'pointer' : 'default',
        background: palette === key ? 'var(--surface-2)' : 'transparent',
        color: palette === key ? 'var(--text)' : 'var(--text-faint)', opacity: count ? 1 : 0.4,
        fontSize: '0.72rem', fontWeight: 600, fontFamily: 'inherit',
      }}
    >{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea
        ref={ref}
        value={text}
        rows={rows}
        placeholder={placeholder}
        spellCheck={false}
        className="mono"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() } }}
        style={{ ...ctl, height: 'auto', padding: '6px 8px', width: '100%', resize: 'vertical', lineHeight: 1.45, fontSize: '0.78rem' }}
      />
      <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        {tab('fields', 'Поля', fields.length)}
        {tab('columns', 'Колонки', columns.length)}
        {tab('params', 'Параметры', params.length)}
        {tab('functions', 'Функции', fns.length)}
      </div>
      {palette === 'fields' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {visibleFields.map((f) => <Chip key={f.key} active={false} onClick={() => insert(f.key)} title={f.key}>{f.label}</Chip>)}
          {syntheticFields.map((f) => <Chip key={f.key} active={false} onClick={() => insert(f.key)} title={`${f.key} — служебный счётчик, для sum()`}><span className="mono">{f.key}</span></Chip>)}
        </div>
      )}
      {palette === 'columns' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {columns.map((c) => <Chip key={c.key} active={false} onClick={() => insert(c.key)} title={c.key}>{c.title}</Chip>)}
          {columns.length === 0 && <Hint>Формула видит колонки, стоящие выше неё.</Hint>}
        </div>
      )}
      {palette === 'params' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {params.map((p) => <Chip key={p.key} active={false} onClick={() => insert(`@${p.key}`)} title={`@${p.key}`}>{p.label}</Chip>)}
        </div>
      )}
      {palette === 'functions' && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {fns.map((f) => (
            <Chip key={f.name} active={false} onClick={() => insert(f.sig)} title={f.label}>
              <span className="mono">{f.sig}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  )
}
