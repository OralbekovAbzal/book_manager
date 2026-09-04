import React from 'react'

// Общие UI-примитивы для разделов настроек — единый стиль на токенах (как «Номера»).

export const SectionHeader: React.FC<{ title: string; subtitle?: string; action?: React.ReactNode }> = ({ title, subtitle, action }) => (
  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18 }}>
    <div>
      <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>{title}</h1>
      {subtitle && <p style={{ margin: '5px 0 0', fontSize: '0.86rem', color: 'var(--text-faint)' }}>{subtitle}</p>}
    </div>
    {action}
  </div>
)

export const AddButton: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button onClick={onClick} style={{
    display: 'flex', alignItems: 'center', gap: 7, height: 36, padding: '0 15px',
    background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer',
    fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600, whiteSpace: 'nowrap', boxShadow: 'var(--shadow-sm)',
  }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M12 5v14" /></svg>
    {label}
  </button>
)

export const EmptyBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: 28, textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.9rem',
    background: 'var(--surface)', borderRadius: 10, border: '1px dashed var(--border-subtle)',
  }}>{children}</div>
)

export const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1rem',
  color: 'var(--text-faint)', padding: '4px 6px', borderRadius: 6, lineHeight: 1,
}

export const listRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px',
  background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border-subtle)',
}

export const itemTitle: React.CSSProperties = { fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }
export const itemSub: React.CSSProperties = { fontSize: '0.8rem', color: 'var(--text-faint)', marginTop: 2 }

export const formCard: React.CSSProperties = {
  padding: 16, background: 'var(--bg)', border: '1px solid var(--border)',
  borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4,
}

export const formTitle: React.CSSProperties = { fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)' }

export const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: '0.86rem', boxSizing: 'border-box', fontFamily: 'inherit',
  outline: 'none', background: 'var(--bg)', color: 'var(--text)',
}

export const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-muted)', marginBottom: 5,
}

export const errorStyle: React.CSSProperties = { fontSize: '0.85rem', color: 'var(--s-overdue)' }

export const primaryBtn: React.CSSProperties = {
  height: 36, padding: '0 18px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 8, fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}

export const secondaryBtn: React.CSSProperties = {
  height: 36, padding: '0 16px', background: 'var(--bg)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: '0.86rem', cursor: 'pointer', color: 'var(--text)', fontFamily: 'inherit',
}

export const dashedBtn: React.CSSProperties = {
  padding: '10px 0', background: 'transparent', border: '1px dashed var(--border)',
  borderRadius: 8, fontSize: '0.86rem', color: 'var(--text-muted)', cursor: 'pointer', fontWeight: 600,
  fontFamily: 'inherit', marginTop: 4,
}

// ─── Общее для справочников номерного фонда ───────────────────────────────────
// Корпуса, особенности и вместимости живут в БД и ведут себя одинаково:
// «удалить» — это скрыть, у записи виден счётчик «стоит у N номеров», а
// переименование корпуса/особенности переписывает и сами номера.

// Счётчики номеров пишем как «Номеров с этим корпусом: 51», а не «стоит у 51
// номера»: тексты здесь разных падежей («обновлён 51 номер», «обновит 23
// номера», «у 17 номеров»), и одна функция склонения всё равно где-нибудь
// соврёт. Число после двоеточия читается нормально и не врёт никогда.

/** Результат последнего действия: «переименовано, обновлён 51 номер» и т.п. */
export const StatusNote: React.FC<{ kind: 'ok' | 'err'; children: React.ReactNode }> = ({ kind, children }) => (
  <div style={{
    padding: '9px 13px', borderRadius: 8, fontSize: '0.86rem', lineHeight: 1.45,
    background: kind === 'ok' ? 'var(--accent-bg)' : 'var(--surface-2)',
    color: kind === 'ok' ? 'var(--accent-text)' : 'var(--s-overdue)',
    border: `1px solid ${kind === 'ok' ? 'var(--accent)' : 'var(--s-overdue)'}`,
    marginBottom: 12,
  }}>{children}</div>
)

/** Справочник общий для всех рабочих мест — сотруднику он доступен только на чтение. */
export const ReadOnlyNote: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <div style={{
    padding: '9px 13px', borderRadius: 8, fontSize: '0.86rem', lineHeight: 1.45,
    background: 'var(--surface-2)', color: 'var(--text-faint)',
    border: '1px solid var(--border-subtle)', marginBottom: 12,
  }}>
    {children ?? 'Справочник общий для всех рабочих мест — менять его могут только администраторы.'}
  </div>
)

const EYE_OPEN = <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>
const EYE_OFF = <path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-2.3 3M6.6 6.6A13 13 0 0 0 2 11s3.5 7 10 7a10 10 0 0 0 3.4-.6M2 2l20 20" />

/**
 * Скрыть / показать запись справочника. Именно скрытие, а не удаление:
 * связь с номерами держится строкой (название корпуса, код вместимости),
 * и удалённая запись не исчезла бы из номеров — просто перестала бы
 * расшифровываться.
 */
export const VisibilityButton: React.FC<{
  hidden: boolean
  onClick: () => void
  disabled?: boolean
  compact?: boolean
}> = ({ hidden, onClick, disabled, compact }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={hidden ? 'Показывать в списках' : 'Скрыть из списков (номера не изменятся)'}
    style={{
      display: 'flex', alignItems: 'center', gap: 6, height: compact ? 24 : 30,
      padding: compact ? '0 7px' : '0 11px', borderRadius: 7,
      cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
      fontSize: compact ? '0.75rem' : '0.8rem', fontWeight: 500,
      border: `1px solid ${hidden ? 'var(--border)' : 'var(--accent)'}`,
      background: hidden ? 'transparent' : 'var(--accent-bg)',
      color: hidden ? 'var(--text-faint)' : 'var(--accent-text)',
      opacity: disabled ? 0.5 : 1, whiteSpace: 'nowrap',
    }}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {hidden ? EYE_OFF : EYE_OPEN}
    </svg>
    {/* Формулировки бесполые: одна кнопка на корпус, особенность и вместимость. */}
    {hidden ? 'Скрыто' : 'В списках'}
  </button>
)

/**
 * Удалить насовсем. Показывается только у записи, которой не пользуется ни один
 * номер: она нужна, чтобы убрать опечатку, а не копить мусор в скрытых.
 */
export const PurgeButton: React.FC<{ onClick: () => void; disabled?: boolean }> = ({ onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title="Удалить насовсем — этой записью не пользуется ни один номер"
    style={{ ...iconBtn, color: 'var(--s-overdue)', opacity: disabled ? 0.5 : 1 }}
  >✕</button>
)
