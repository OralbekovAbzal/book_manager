import React, { useEffect, useRef, useState } from 'react'
import {
  format, parseISO, addMonths, startOfMonth, endOfMonth,
  startOfWeek, endOfWeek, eachDayOfInterval, isSameMonth, isSameDay, isToday,
} from 'date-fns'
import { ru } from 'date-fns/locale'

interface Props {
  value: string                 // 'YYYY-MM-DD' или ''
  onChange: (v: string) => void
  min?: string                  // 'YYYY-MM-DD' — дни раньше недоступны
  disabled?: boolean
  placeholder?: string
  style?: React.CSSProperties   // переопределение стиля триггера
}

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

const triggerBase: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
  border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg)',
  color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.86rem',
}

export const DatePicker: React.FC<Props> = ({ value, onChange, min, disabled, placeholder = 'дд.мм.гггг', style }) => {
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState<Date>(() => (value ? parseISO(value) : new Date()))
  const wrapRef = useRef<HTMLDivElement>(null)

  const selected = value ? parseISO(value) : null
  const minDate = min ? parseISO(min) : null

  // При открытии — показываем месяц выбранной даты (или текущий)
  useEffect(() => {
    if (open) setViewMonth(value ? parseISO(value) : new Date())
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // Закрытие по клику вне / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const days = eachDayOfInterval({
    start: startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 1 }),
    end: endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 1 }),
  })

  const pick = (d: Date) => {
    onChange(format(d, 'yyyy-MM-dd'))
    setOpen(false)
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen(o => !o)}
        style={{ ...triggerBase, ...style, opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        <span className={value ? 'mono' : undefined} style={{ color: value ? 'var(--text)' : 'var(--text-faint)' }}>
          {value ? format(parseISO(value), 'd MMM yyyy', { locale: ru }) : placeholder}
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2v4M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" />
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', left: 0, bottom: 'calc(100% + 6px)', width: '100%', zIndex: 50,
          background: 'var(--bg)', border: '1px solid var(--border)',
          borderRadius: 12, boxShadow: 'var(--shadow-lg)', padding: 10,
        }}>
          {/* Месяц + навигация */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <NavBtn onClick={() => setViewMonth(m => addMonths(m, -1))} dir="left" />
            <span style={{ fontSize: '0.84rem', fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>
              {format(viewMonth, 'LLLL yyyy', { locale: ru })}
            </span>
            <NavBtn onClick={() => setViewMonth(m => addMonths(m, 1))} dir="right" />
          </div>

          {/* Дни недели */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {WEEKDAYS.map(w => (
              <span key={w} style={{ textAlign: 'center', fontSize: '0.62rem', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase' }}>{w}</span>
            ))}
          </div>

          {/* Сетка дней */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {days.map(d => {
              const outside = !isSameMonth(d, viewMonth)
              const isSel = selected && isSameDay(d, selected)
              const isDisabled = minDate ? d < minDate && !isSameDay(d, minDate) : false
              const today = isToday(d)
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => pick(d)}
                  className="mono"
                  style={{
                    height: 28, border: 'none', borderRadius: 7, cursor: isDisabled ? 'not-allowed' : 'pointer',
                    fontFamily: "'Geist Mono Variable', monospace", fontSize: '0.78rem',
                    background: isSel ? 'var(--accent)' : 'transparent',
                    color: isSel ? '#fff' : isDisabled ? 'var(--text-faint)' : outside ? 'var(--text-faint)' : 'var(--text)',
                    fontWeight: isSel || today ? 700 : 400,
                    opacity: isDisabled ? 0.4 : 1,
                    outline: today && !isSel ? '1px solid var(--accent)' : 'none', outlineOffset: -1,
                  }}
                >
                  {format(d, 'd')}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const NavBtn: React.FC<{ onClick: () => void; dir: 'left' | 'right' }> = ({ onClick, dir }) => (
  <button type="button" onClick={onClick} style={{
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 7,
    color: 'var(--text-muted)', cursor: 'pointer',
  }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={dir === 'left' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
    </svg>
  </button>
)
