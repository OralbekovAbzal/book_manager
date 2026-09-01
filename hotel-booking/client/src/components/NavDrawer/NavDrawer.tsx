import React, { useEffect } from 'react'

/**
 * Feature 2 — Навигация по разделам (drawer).
 * Открывается кликом по эмблеме «H» в шапке (без отдельной кнопки-бургера).
 * Выезжает слева, бэкдроп закрывает. Точная реализация дизайн-хендоффа.
 */

export type NavSection = 'grid' | 'reference' | 'rates' | 'reports' | 'settings'

interface Props {
  open: boolean
  active: NavSection
  hotelName: string
  adminName: string
  adminRole: string
  onClose: () => void
  onNavigate: (section: NavSection) => void
}

interface NavItemDef {
  id: NavSection
  label: string
  icon: string
  badge?: string
}

interface NavGroupDef {
  heading: string
  items: NavItemDef[]
}

const NAV_GROUPS: NavGroupDef[] = [
  {
    heading: 'Основное',
    items: [
      { id: 'grid', label: 'Шахматка', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
      { id: 'reference', label: 'Справочник', icon: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5z', badge: 'F2' },
    ],
  },
  {
    heading: 'Управление',
    items: [
      { id: 'rates', label: 'Тарифы и наличие', icon: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01' },
      { id: 'reports', label: 'Отчёты', icon: 'M3 3v18h18M7 16v-5M12 16V8M17 16v-3' },
      { id: 'settings', label: 'Настройки', icon: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' },
    ],
  },
]

const CloseIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
)

export const NavDrawer: React.FC<Props> = ({ open, active, hotelName, adminName, adminRole, onClose, onNavigate }) => {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const initials = adminName.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex' }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.34)', animation: 'fadeIn 0.15s ease' }} />
      <aside style={{
        position: 'relative', width: 248, flexShrink: 0, height: '100%',
        background: 'var(--bg)', borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', boxShadow: 'var(--shadow-lg)',
        animation: 'navIn 0.2s cubic-bezier(0.32,0.72,0,1)',
      }}>
        {/* Шапка панели */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, height: 52, flexShrink: 0, padding: '0 16px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14 }}>H</div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '-0.01em' }}>Hotel Booking</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{hotelName}</span>
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} title="Закрыть" className="nav-close-btn" style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', borderRadius: 6, color: 'var(--text-faint)', cursor: 'pointer' }}>
            <CloseIcon />
          </button>
        </div>

        {/* Список разделов */}
        <nav style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 10px 16px' }}>
          {NAV_GROUPS.map(group => (
            <div key={group.heading}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', padding: '14px 10px 6px' }}>
                {group.heading}
              </div>
              {group.items.map(item => {
                const isActive = active === item.id
                return (
                  <button
                    key={item.id}
                    onClick={() => onNavigate(item.id)}
                    className="nav-item-btn"
                    data-active={isActive}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 11, height: 38,
                      padding: '0 11px', marginBottom: 1, border: 'none', borderRadius: 8,
                      background: isActive ? 'var(--accent-bg)' : 'transparent',
                      color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                      fontFamily: 'inherit', fontSize: 13, fontWeight: isActive ? 600 : 500,
                      cursor: 'pointer', textAlign: 'left',
                    }}
                  >
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d={item.icon} /></svg>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {item.badge && (
                      <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--surface-2)', padding: '1px 6px', borderRadius: 5 }}>{item.badge}</span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </nav>

        {/* Подвал панели */}
        <div style={{ flexShrink: 0, padding: '12px 16px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--surface-3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>{initials}</div>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, flex: 1 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>{adminName}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{adminRole}</span>
          </div>
        </div>
      </aside>
    </div>
  )
}
