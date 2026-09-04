import React from 'react'
import { inputStyle, labelStyle, primaryBtn, secondaryBtn } from '../Settings/sections/sectionUi'

// UI-примитивы мастера первичной настройки. Всё на токенах темы (тёмная тема
// работает автоматически); базовые стили полей и кнопок берём из разделов
// настроек, чтобы мастер выглядел как остальное приложение.

export const STEP_TITLES = ['Отель', 'Главный администратор', 'Сотрудники', 'Проверка'] as const

export const wizardInput: React.CSSProperties = { ...inputStyle, height: 40, fontSize: '0.92rem' }
export const wizardPrimary: React.CSSProperties = { ...primaryBtn, height: 40, padding: '0 22px', fontSize: '0.9rem' }
export const wizardSecondary: React.CSSProperties = { ...secondaryBtn, height: 40, padding: '0 18px', fontSize: '0.9rem' }

export const hintStyle: React.CSSProperties = { fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: 5, lineHeight: 1.45 }
const fieldErrorStyle: React.CSSProperties = { fontSize: '0.78rem', color: 'var(--s-overdue)', marginTop: 5 }

export const linkBtn: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.8rem', color: 'var(--accent-text)', textDecoration: 'underline',
}

/** Поле формы: подпись, контрол, под ним — ошибка либо подсказка. */
export const Field: React.FC<{ label: string; error?: string; hint?: string; children: React.ReactNode }> = ({ label, error, hint, children }) => (
  <div>
    <label style={labelStyle}>{label}</label>
    {children}
    {error ? <div style={fieldErrorStyle}>{error}</div> : hint ? <div style={hintStyle}>{hint}</div> : null}
  </div>
)

/** Заголовок шага с пояснением. */
export const StepHeading: React.FC<{ title: string; text?: string }> = ({ title, text }) => (
  <div style={{ marginBottom: 20 }}>
    <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)' }}>{title}</h2>
    {text && <p style={{ margin: '6px 0 0', fontSize: '0.88rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>{text}</p>}
  </div>
)

/** Блок ошибки (ответ сервера, общая проверка). */
export const ErrorBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: '10px 14px', borderRadius: 8, fontSize: '0.86rem', lineHeight: 1.5,
    background: 'rgba(204,107,107,0.10)', border: '1px solid var(--s-overdue)', color: 'var(--text)',
  }}>{children}</div>
)

/** Индикатор прогресса: кружок с номером (галочка для пройденных), подпись, соединительные линии. */
export const Stepper: React.FC<{ step: number }> = ({ step }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', marginBottom: 28 }}>
    {STEP_TITLES.map((title, i) => {
      const done = i < step
      const active = i === step
      return (
        <React.Fragment key={title}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, width: 104, flexShrink: 0 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.8rem', fontWeight: 600, transition: 'background 0.15s, color 0.15s',
              background: active ? 'var(--accent)' : done ? 'var(--accent-bg)' : 'var(--surface-2)',
              color: active ? '#fff' : done ? 'var(--accent-text)' : 'var(--text-faint)',
              border: active || done ? 'none' : '1px solid var(--border-subtle)',
            }}>
              {done ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              ) : i + 1}
            </div>
            <div style={{
              fontSize: '0.75rem', textAlign: 'center', lineHeight: 1.3, fontWeight: active ? 600 : 500,
              color: active ? 'var(--text)' : done ? 'var(--text-muted)' : 'var(--text-faint)',
            }}>
              {title}
            </div>
          </div>
          {i < STEP_TITLES.length - 1 && (
            <div style={{
              flex: 1, height: 2, marginTop: 13, borderRadius: 1, transition: 'background 0.15s',
              background: i < step ? 'var(--accent)' : 'var(--border-subtle)',
            }} />
          )}
        </React.Fragment>
      )
    })}
  </div>
)
