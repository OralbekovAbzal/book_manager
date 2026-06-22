import React, { useEffect, useState } from 'react'
import { useAuthStore } from './store/useAuthStore'
import { useSettingsStore } from './store/useSettingsStore'
import { useSocket } from './hooks/useSocket'
import { Login } from './components/Login/Login'
import { BookingGrid } from './components/BookingGrid/BookingGrid'
import { BookingModal } from './components/BookingModal/BookingModal'
import { BookingViewModal } from './components/BookingModal/BookingViewModal'
import { DeleteBookingDialog } from './components/BookingModal/DeleteBookingDialog'
import { MoveBookingModal } from './components/BookingModal/MoveBookingModal'
import { BookingContextMenu } from './components/BookingGrid/BookingContextMenu'
import { Filters } from './components/Filters/Filters'
import { TodayStats } from './components/BookingGrid/TodayStats'
import { StatusBar } from './components/BookingGrid/StatusBar'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AuditWindow } from './components/Audit/AuditWindow'
import { OptimizeModal } from './components/Optimize/OptimizeModal'
import { SnapshotsModal } from './components/Snapshots/SnapshotsModal'
import { NavDrawer, type NavSection } from './components/NavDrawer/NavDrawer'
import { fetchBookingFlags } from './api/bookingFlags'

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Главный администратор',
  ADMIN: 'Администратор',
  STAFF: 'Сотрудник',
}

export const App: React.FC = () => {
  const { admin, token, restore, logout } = useAuthStore()
  const { visual, setVisual, setRoomFund } = useSettingsStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [optimizeOpen, setOptimizeOpen] = useState(false)
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => localStorage.getItem('filters_collapsed') !== '1')

  const toggleFilters = () => setFiltersOpen(o => {
    const next = !o
    localStorage.setItem('filters_collapsed', next ? '0' : '1')
    return next
  })
  const [navOpen, setNavOpen] = useState(false)
  const [navActive, setNavActive] = useState<NavSection>('grid')

  // Навигация из drawer: «Настройки» открывает существующую панель,
  // остальные разделы — заглушки под будущие экраны (выделяют пункт и закрывают).
  const handleNavigate = (section: NavSection) => {
    setNavActive(section)
    if (section === 'settings') setSettingsOpen(true)
    setNavOpen(false)
  }

  useEffect(() => { restore() }, [])
  useSocket(token)

  // Метки броней — источник истины в БД. Подгружаем в стор, чтобы все потребители
  // (грид, модалка, оптимизатор) читали актуальные определения с эффектами.
  useEffect(() => {
    if (!admin) return
    fetchBookingFlags().then(bookingFlags => setRoomFund({ bookingFlags })).catch(() => {})
  }, [admin, setRoomFund])

  // Apply theme + UI-scale vars to document root
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', visual.theme)
    root.style.setProperty('--ui-font-size', `${visual.fontSize}px`)
    root.style.setProperty('--ui-radius', `${visual.uiRadius}px`)
  }, [visual.theme, visual.fontSize, visual.uiRadius])

  if (!admin) return <Login />

  const toggleTheme = () => setVisual('theme', visual.theme === 'light' ? 'dark' : 'light')

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden',
      background: 'var(--bg)', color: 'var(--text)',
    }}>
      {/* Top bar */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 20px',
        height: 52,
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        zIndex: 50,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {/* Logo mark — кликабельный, открывает drawer навигации (Feature 2) */}
          <button
            onClick={() => setNavOpen(o => !o)}
            title="Меню разделов"
            style={{
              width: 26, height: 26, borderRadius: 7,
              background: 'var(--accent)', border: 'none', padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#ffffff', fontWeight: 800, fontSize: '1rem',
              letterSpacing: '-0.02em', cursor: 'pointer',
            }}
          >
            H
          </button>
          <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text)', letterSpacing: '-0.01em' }}>
            Hotel Booking
          </span>
          <span style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />
          <span style={{ fontSize: '0.86rem', color: 'var(--text-faint)' }}>Гранд Алатау</span>
          <span style={{
            fontSize: '0.77rem', color: 'var(--text-faint)', padding: '2px 7px',
            border: '1px solid var(--border-subtle)', borderRadius: 5,
          }}>142 номера</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <IconBtn onClick={() => setSnapshotsOpen(true)} title="Откат / снапшоты" icon={ICONS.history} />
            <IconBtn onClick={() => setAuditOpen(true)} title="Аудит" icon={ICONS.audit} />
            <IconBtn onClick={toggleTheme} title="Сменить тему" icon={visual.theme === 'light' ? ICONS.moon : ICONS.sun} />
            <IconBtn onClick={() => setSettingsOpen(true)} title="Настройки" icon={ICONS.settings} />
            <IconBtn onClick={logout} title="Выйти" icon={ICONS.logout} />
          </div>
          <span style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 2 }}>
            <div style={{
              width: 26, height: 26, borderRadius: '50%', background: 'var(--surface-3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.77rem', fontWeight: 600, color: 'var(--text-muted)',
            }}>
              {admin.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span style={{ fontSize: '0.86rem', fontWeight: 500 }}>{admin.name}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>{ROLE_LABELS[admin.role] ?? admin.role}</span>
            </div>
          </div>
        </div>
      </header>

      <TodayStats filtersOpen={filtersOpen} onToggleFilters={toggleFilters} />

      <main style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', background: 'var(--bg)' }}>
        <Filters open={filtersOpen} />
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <BookingGrid />
        </div>
      </main>

      <StatusBar />

      <BookingModal />
      <BookingViewModal />
      <MoveBookingModal />
      <BookingContextMenu />
      <DeleteBookingDialog />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AuditWindow open={auditOpen} onClose={() => setAuditOpen(false)} />
      <OptimizeModal open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
      <SnapshotsModal open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
      <NavDrawer
        open={navOpen}
        active={navActive}
        hotelName="Гранд Алатау"
        adminName={admin.name}
        adminRole={ROLE_LABELS[admin.role] ?? admin.role}
        onClose={() => setNavOpen(false)}
        onNavigate={handleNavigate}
      />
    </div>
  )
}

// Иконки топбара (inline-SVG, Lucide/Feather-стиль из дизайн-хендоффа)
const ICONS = {
  history:  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />,
  audit:    <><path d="M3 12a9 9 0 1 0 3-7.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  moon:     <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  sun:      <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  settings: <><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></>,
  logout:   <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
}

const IconBtn: React.FC<{ onClick: () => void; title: string; icon: React.ReactNode }> = ({ onClick, title, icon }) => (
  <button
    onClick={onClick}
    title={title}
    className="chrome-icon-btn"
    style={{
      width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'transparent', border: '1px solid transparent', borderRadius: 7,
      color: 'var(--text-muted)', cursor: 'pointer', transition: 'background 0.12s, border-color 0.12s',
    }}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icon}
    </svg>
  </button>
)
