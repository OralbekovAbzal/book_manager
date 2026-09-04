import React from 'react'

/**
 * Примитивы формы конструктора. Мелкие и плотные — в конструкторе на экране
 * одновременно десятки полей, и обычные 38-пиксельные инпуты его раздувают.
 */

export const ctl: React.CSSProperties = {
  height: 30, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 7,
  fontSize: '0.8rem', fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--text)',
  outline: 'none', boxSizing: 'border-box', minWidth: 0,
}

export const Row: React.FC<{ children: React.ReactNode; gap?: number; align?: string; wrap?: boolean; style?: React.CSSProperties }> =
  ({ children, gap = 8, align = 'flex-end', wrap = true, style }) => (
    <div style={{ display: 'flex', gap, alignItems: align, flexWrap: wrap ? 'wrap' : 'nowrap', ...style }}>{children}</div>
  )

// Растущее поле не сжимается ниже basis: пусть лучше перенесётся на новую строку,
// чем схлопнется в полоску шириной с курсор (так было с «Заголовком» колонки).
export const Field: React.FC<{ label: string; children: React.ReactNode; grow?: number; width?: number; basis?: number; hint?: string }> =
  ({ label, children, grow, width, basis = 150, hint }) => (
    <label title={hint} style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: grow ? `${grow} 1 ${basis}px` : undefined, width, minWidth: 0 }}>
      <span style={{ fontSize: '0.68rem', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{label}</span>
      {children}
    </label>
  )

export const TextInput: React.FC<{
  value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; style?: React.CSSProperties; disabled?: boolean
}> = ({ value, onChange, placeholder, mono, style, disabled }) => (
  <input
    value={value}
    disabled={disabled}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value)}
    className={mono ? 'mono' : undefined}
    style={{ ...ctl, width: '100%', ...style }}
  />
)

export const NumInput: React.FC<{
  value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string; style?: React.CSSProperties; min?: number
}> = ({ value, onChange, placeholder, style, min }) => (
  <input
    type="number"
    min={min}
    value={value === undefined || value === null ? '' : value}
    placeholder={placeholder}
    onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
    style={{ ...ctl, width: '100%', ...style }}
  />
)

export const Select: React.FC<{
  value: string; onChange: (v: string) => void
  options: { value: string | number; label: string }[]
  placeholder?: string; style?: React.CSSProperties; disabled?: boolean
}> = ({ value, onChange, options, placeholder, style, disabled }) => (
  <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ ...ctl, width: '100%', cursor: 'pointer', ...style }}>
    {placeholder !== undefined && <option value="">{placeholder}</option>}
    {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
  </select>
)

export const Seg: React.FC<{ value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }> =
  ({ value, onChange, options }) => (
    <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden', height: 30 }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            style={{
              padding: '0 10px', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.78rem',
              fontWeight: active ? 600 : 500,
              background: active ? 'var(--accent-bg)' : 'var(--bg)',
              color: active ? 'var(--accent-text)' : 'var(--text-muted)',
            }}
          >{o.label}</button>
        )
      })}
    </div>
  )

export const Chip: React.FC<{ active: boolean; onClick: () => void; children: React.ReactNode; title?: string }> =
  ({ active, onClick, children, title }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        height: 26, padding: '0 9px', borderRadius: 6, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'var(--accent-bg)' : 'var(--bg)',
        color: active ? 'var(--accent-text)' : 'var(--text-muted)',
        fontSize: '0.76rem', fontWeight: active ? 600 : 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  )

export const Check: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; title?: string }> =
  ({ checked, onChange, label, title }) => (
    <label title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 30, fontSize: '0.79rem', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )

export const IconBtn: React.FC<{ title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; danger?: boolean }> =
  ({ title, onClick, children, disabled, danger }) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', borderRadius: 6, background: 'transparent', cursor: disabled ? 'default' : 'pointer',
        color: danger ? 'var(--s-overdue)' : 'var(--text-faint)', opacity: disabled ? 0.35 : 1,
        fontSize: '0.9rem', lineHeight: 1, fontFamily: 'inherit',
      }}
    >{children}</button>
  )

export const Card: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div style={{
    padding: '10px 12px', border: '1px solid var(--border-subtle)', borderRadius: 9,
    background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 8, ...style,
  }}>{children}</div>
)

export const AddBtn: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      height: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer',
      border: '1px dashed var(--border)', background: 'transparent', color: 'var(--accent-text)',
      fontSize: '0.79rem', fontWeight: 600, fontFamily: 'inherit', alignSelf: 'flex-start',
    }}
  >+ {label}</button>
)

export const Hint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>{children}</div>
)

/** Секция конструктора со сворачиванием и счётчиком элементов в заголовке. */
export const Section: React.FC<{
  title: string; count?: number; open: boolean; onToggle: () => void; children: React.ReactNode; hint?: string
}> = ({ title, count, open, onToggle, children, hint }) => (
  <div style={{ borderBottom: '1px solid var(--border-subtle)' }}>
    <button
      type="button"
      onClick={onToggle}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 16px',
        border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
        color: 'var(--text)',
      }}
    >
      <span style={{ fontSize: '0.7rem', color: 'var(--text-faint)', width: 10 }}>{open ? '▾' : '▸'}</span>
      <span style={{ fontSize: '0.86rem', fontWeight: 600 }}>{title}</span>
      {count !== undefined && (
        <span className="mono" style={{ fontSize: '0.7rem', color: 'var(--text-faint)', background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5 }}>{count}</span>
      )}
      {hint && <span style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginLeft: 'auto', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{hint}</span>}
    </button>
    {open && <div style={{ padding: '2px 16px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>{children}</div>}
  </div>
)
