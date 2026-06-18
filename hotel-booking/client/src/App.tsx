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
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AuditWindow } from './components/Audit/AuditWindow'
import { OptimizeModal } from './components/Optimize/OptimizeModal'
import { SnapshotsModal } from './components/Snapshots/SnapshotsModal'
import { fetchBookingFlags } from './api/bookingFlags'

export const App: React.FC = () => {
  const { admin, token, restore, logout } = useAuthStore()
  const { visual, setVisual, setRoomFund } = useSettingsStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [optimizeOpen, setOptimizeOpen] = useState(false)
  const [snapshotsOpen, setSnapshotsOpen] = useState(false)

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
          {/* Logo mark */}
          <div style={{
            width: 26, height: 26, borderRadius: 7,
            background: 'var(--accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#ffffff', fontWeight: 800, fontSize: '1rem',
            letterSpacing: '-0.02em',
          }}>
            H
          </div>
          <span style={{ fontWeight: 600, fontSize: '1.08rem', color: 'var(--text)', letterSpacing: '-0.01em' }}>
            Hotel Booking
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '1rem', color: 'var(--text-muted)', marginRight: 8 }}>
            {admin.name}
            <span style={{
              marginLeft: 8, padding: '2px 7px', borderRadius: 4,
              background: 'var(--surface-2)', fontSize: '0.77rem',
              color: 'var(--text-faint)', fontWeight: 600,
              letterSpacing: '0.04em',
            }}>
              {admin.role}
            </span>
          </span>

          {/* Оптимизатор временно скрыт с фронта (бэкенд работает). Чтобы вернуть — раскомментируй: */}
          {/* <ToolbarButton onClick={() => setOptimizeOpen(true)} label="🪄 Подсказать" /> */}
          <ToolbarButton onClick={() => setSnapshotsOpen(true)} label="⟲ Откат" />
          <ToolbarButton onClick={() => setAuditOpen(true)} label="Аудит" />
          <ToolbarButton onClick={toggleTheme} label={visual.theme === 'light' ? 'Тёмная' : 'Светлая'} />
          <ToolbarButton onClick={() => setSettingsOpen(true)} label="Настройки" />
          <ToolbarButton onClick={logout} label="Выйти" variant="muted" />
        </div>
      </header>

      <TodayStats />

      <main style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', background: 'var(--bg)' }}>
        <Filters />
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <BookingGrid />
        </div>
      </main>

      <BookingModal />
      <BookingViewModal />
      <MoveBookingModal />
      <BookingContextMenu />
      <DeleteBookingDialog />
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AuditWindow open={auditOpen} onClose={() => setAuditOpen(false)} />
      <OptimizeModal open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
      <SnapshotsModal open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
    </div>
  )
}

const ToolbarButton: React.FC<{
  onClick: () => void
  label: string
  variant?: 'default' | 'muted'
}> = ({ onClick, label, variant = 'default' }) => {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '6px 12px',
        background: hover ? 'var(--surface-2)' : 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 'var(--ui-radius)',
        fontSize: 'inherit',
        fontWeight: 600,
        cursor: 'pointer',
        color: variant === 'muted' ? 'var(--text-faint)' : 'var(--text)',
        transition: 'background 0.12s',
        lineHeight: 1,
      }}
    >
      {label}
    </button>
  )
}
