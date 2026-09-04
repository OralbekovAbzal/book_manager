import React, { useState } from 'react'

/**
 * Общие примитивы кассы: форматирование денег и дат плюс карточки, из которых
 * сложены и раздел «Касса», и панель денег внутри брони.
 *
 * Вынесено отдельно, чтобы приём оплаты выглядел одинаково в обоих местах:
 * два набора стилей для одних и тех же цифр разъезжаются на первой же правке.
 */

export const money = (n: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n ?? 0)

/** Даты `@db.Date` — UTC-полночь, рендерим в UTC, иначе съезжает на день. */
export const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

/** Время приёма денег — реальные часы, местная зона. */
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  })

/** Текст ошибки от сервера, если он есть. */
export const apiErrorText = (e: unknown, fallback: string): string => {
  const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
  return msg || fallback
}

export const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border-subtle)',
  borderRadius: 12, padding: 14,
}

export const th: React.CSSProperties = {
  textAlign: 'left', fontSize: '0.74rem', fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.03em', color: 'var(--text-faint)', padding: '6px 10px', whiteSpace: 'nowrap',
}

export const td: React.CSSProperties = {
  padding: '9px 10px', fontSize: '0.85rem', color: 'var(--text)',
  borderTop: '1px solid var(--border-subtle)',
}

export const Stat: React.FC<{
  label: string
  value: string
  tone?: 'plus' | 'minus' | 'plain'
  hint?: string
}> = ({ label, value, tone = 'plain', hint }) => (
  <div style={{ ...card, flex: '1 1 160px', minWidth: 150 }}>
    <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
    <div style={{
      fontSize: '1.32rem', fontWeight: 600, letterSpacing: '-0.02em',
      color: tone === 'plus' ? 'var(--s-in)' : tone === 'minus' ? 'var(--s-overdue)' : 'var(--text)',
    }}>{value}</div>
    {hint && <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginTop: 3 }}>{hint}</div>}
  </div>
)

const inlineInput: React.CSSProperties = {
  flex: 1, minWidth: 90, height: 30, padding: '0 9px', border: '1px solid var(--border)',
  borderRadius: 7, fontSize: '0.82rem', fontFamily: 'inherit', boxSizing: 'border-box',
  outline: 'none', background: 'var(--bg)', color: 'var(--text)',
}

const inlineBtn: React.CSSProperties = {
  height: 30, padding: '0 11px', borderRadius: 7, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: '0.8rem',
  fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
}

/**
 * Маленькая форма вместо `window.prompt`.
 *
 * Electron `prompt()` не поддерживает вовсе — в упакованной программе кнопка
 * «Возврат» из журнала просто ничего не делала бы. Плюс родное окно браузера
 * не знает про тёмную тему.
 */
export const InlinePrompt: React.FC<{
  label: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}> = ({ label, initial = '', placeholder, confirmLabel = 'Подтвердить', onConfirm, onCancel }) => {
  const [value, setValue] = useState(initial)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 6, padding: 9, marginTop: 6,
      border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)',
    }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          // Escape гасим здесь: выше по документу его слушают форма брони и
          // просмотр брони — иначе одно нажатие закрывало бы всё окно целиком.
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onConfirm(value) }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
          }}
          style={inlineInput}
        />
        <button type="button" onClick={onCancel} style={inlineBtn}>Отмена</button>
        <button
          type="button"
          onClick={() => onConfirm(value)}
          style={{ ...inlineBtn, background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)', fontWeight: 600 }}
        >{confirmLabel}</button>
      </div>
    </div>
  )
}
