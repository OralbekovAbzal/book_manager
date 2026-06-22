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
