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
import { ReferenceWindow } from './components/Reference/ReferenceWindow'
import { RatesScreen } from './components/Rates/RatesScreen'
import { ReportsScreen } from './components/Reports/ReportsScreen'
import { PaymentsScreen } from './components/Payments/PaymentsScreen'
import { NavDrawer, type NavSection } from './components/NavDrawer/NavDrawer'
import type { ActiveSection } from './components/Settings/SettingsPanel'
import { useLicenseStore } from './store/useLicenseStore'
import { LicenseBanner } from './components/License/LicenseBanner'
import { MaintenanceGateScreen } from './components/License/MaintenanceGateScreen'
import { fetchBookingFlags } from './api/bookingFlags'
import { fetchSetupStatus } from './api/setup'
import { fetchHotel } from './api/hotel'
import { fetchRooms } from './api/rooms'
import { SetupWizard } from './components/Setup/SetupWizard'

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Главный администратор',
  ADMIN: 'Администратор',
}

export const App: React.FC = () => {
  const { admin, token, restore, logout, hotelName, setHotelName } = useAuthStore()
  const { visual, setVisual, setRoomFund } = useSettingsStore()
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

  // `section` — единственное состояние навигации: какой экран занимает область
  // под шапкой. Раньше разделы открывались модалками ПОВЕРХ сетки, из-за чего
  // не были настоящими экранами. Теперь шахматка сама заменяется на выбранный
  // раздел, а модалками остаются только действия (бронь, аудит, снапшоты).
  const [section, setSection] = useState<NavSection>('grid')

  // С какого подраздела открыть «Настройки». Нужен ровно одному сценарию —
  // полосе «Лицензия не введена»; из меню разделов сбрасывается в null, иначе
  // настройки навсегда открывались бы на «Лицензии».
  const [settingsSection, setSettingsSection] = useState<ActiveSection | null>(null)

  const handleNavigate = (next: NavSection) => {
    setSection(next)
    setSettingsSection(null)
    setNavOpen(false)
  }

  const openLicenseSettings = () => {
    setSettingsSection('license')
    setSection('settings')
    setNavOpen(false)
  }

  // Лицензия — общее состояние: полоса в шапке, раздел настроек и экран
  // блокировки читают один стор.
  const licenseBlock = useLicenseStore(s => s.block)
  const licenseUnblockedAt = useLicenseStore(s => s.unblockedAt)
  const loadLicense = useLicenseStore(s => s.load)

  // Старт приложения: одновременно узнаём состояние сервера (нужна ли первичная
  // настройка, название отеля) и восстанавливаем сессию по сохранённому токену.
  // 'checking' — заставка; 'setup' — мастер вместо входа; 'ready' — вход/шахматка.
  const [boot, setBoot] = useState<'checking' | 'setup' | 'ready'>('checking')
  const [serverError, setServerError] = useState('')
  // Число активных номеров для шапки; null — ещё не загружено.
  const [roomsCount, setRoomsCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const init = async () => {
      const [status] = await Promise.all([
        fetchSetupStatus()
          .then(s => ({ ok: true as const, status: s }))
          .catch((e: unknown) => ({ ok: false as const, error: e })),
        restore(),
      ])
      if (cancelled) return
      if (status.ok) {
        setHotelName(status.status.hotelName)
        setBoot(status.status.needsSetup ? 'setup' : 'ready')
      } else {
        // Сервер не ответил — пускаем на экран входа с баннером, чтобы можно было
        // открыть системные настройки и поправить адрес подключения.
        setServerError(describeBootError(status.error))
        setBoot('ready')
      }
    }
    init()
    return () => { cancelled = true }
  }, [])
  useSocket(token)

  // Узкое окно (< 900px): название отеля и бейдж номеров в шапке прячем, иначе
  // она переносилась на вторую строку и вылезала за фиксированные 52px.
  const [narrow, setNarrow] = useState<boolean>(() => window.matchMedia('(max-width: 899px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)')
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  // F2 — переключение между шахматкой и справочником. Нужен, когда трубку уже
  // держат в руке, поэтому работает и из полей ввода (F2 ничего не печатает).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault()
        setSection(s => (s === 'reference' ? 'grid' : 'reference'))
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // Состояние лицензии — рядом с остальными стартовыми загрузками. GET /api/license
  // требует входа, поэтому ждём admin.
  useEffect(() => {
    if (!admin) return
    void loadLicense()
  }, [admin, loadLicense])

  // Метки броней — источник истины в БД. Подгружаем в стор, чтобы все потребители
  // (грид, модалка, оптимизатор) читали актуальные определения с эффектами.
  //
  // `licenseUnblockedAt` в зависимостях — не украшение: под гейтом 402 все эти
  // запросы отказали, и после ввода продлённого ключа их надо повторить, иначе
  // шапка и справочники останутся пустыми до перезагрузки страницы.
  useEffect(() => {
    if (!admin) return
    fetchBookingFlags().then(bookingFlags => setRoomFund({ bookingFlags })).catch(() => {})
  }, [admin, setRoomFund, licenseUnblockedAt])

  // Данные для шапки после входа: актуальное название отеля и число активных номеров.
  useEffect(() => {
    if (!admin) return
    fetchHotel().then(h => setHotelName(h.name || null)).catch(() => {})
    fetchRooms({ isActive: true }).then(rooms => setRoomsCount(rooms.length)).catch(() => {})
  }, [admin, setHotelName, licenseUnblockedAt])

  // Apply theme + UI-scale vars to document root
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', visual.theme)
    root.style.setProperty('--ui-font-size', `${visual.fontSize}px`)
    root.style.setProperty('--ui-radius', `${visual.uiRadius}px`)
  }, [visual.theme, visual.fontSize, visual.uiRadius])

  // Гейт обслуживания (402) идёт ПЕРВЫМ и живёт не в `section`, а здесь, рядом
  // с заставкой и входом: под гейтом сервер отвечает 402 на всё, кроме входа и
  // лицензии, — приложения под ним нет, и рисовать шапку с меню разделов,
  // которые все до одного упрутся в 402, было бы обманом.
  //
  // Ключ принимает только SUPER_ADMIN, поэтому до входа показываем обычный вход
  // с текстом сервера в баннере (/api/auth/login гейт пропускает), а после
  // входа — экран блокировки с полем ключа. Так вход и ввод ключа доступны оба.
  if (licenseBlock) {
    return admin ? <MaintenanceGateScreen /> : <Login serverError={licenseBlock.message} />
  }

  // Порядок экранов при старте: заставка, пока сервер не ответил; мастер
  // первичной настройки, если база пустая; иначе — обычный вход.
  if (boot === 'checking') return <BootScreen />
  // Незавершённая настройка важнее сохранённой сессии: иначе вход под сидовым
  // admin/admin123 позволил бы обойти мастер и оставить пароль по умолчанию.
  if (boot === 'setup') return <SetupWizard onComplete={() => setBoot('ready')} />
  if (!admin) return <Login serverError={serverError} />

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
        height: 'var(--topbar-h)',
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
          <span style={{ fontWeight: 600, fontSize: '0.95rem', color: 'var(--text)', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
            Hotel Booking
          </span>
          {!narrow && (
            <>
              <span style={{ width: 1, height: 18, background: 'var(--border-subtle)' }} />
              <span style={{ fontSize: '0.86rem', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{hotelName || 'Отель'}</span>
              {roomsCount !== null && (
                <span style={{
                  fontSize: '0.77rem', color: 'var(--text-faint)', padding: '2px 7px',
                  border: '1px solid var(--border-subtle)', borderRadius: 5, whiteSpace: 'nowrap',
                }}>{roomsCount} {roomsWord(roomsCount)}</span>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <IconBtn onClick={() => setOptimizeOpen(true)} title="Оптимизатор: подсказать перестановки" icon={ICONS.wand} />
            <IconBtn onClick={() => setSnapshotsOpen(true)} title="Откат / снапшоты" icon={ICONS.history} />
            <IconBtn onClick={() => setAuditOpen(true)} title="Аудит" icon={ICONS.audit} />
            <IconBtn onClick={toggleTheme} title="Сменить тему" icon={visual.theme === 'light' ? ICONS.moon : ICONS.sun} />
            {/* Не `onClick={logout}`: событие клика ушло бы в параметр `reason` */}
            <IconBtn onClick={() => logout()} title="Выйти" icon={ICONS.logout} />
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

      {/* Полоса лицензии — под шапкой и над любым разделом: она про программу
          целиком, а не про шахматку, поэтому в обвязку сетки не входит. */}
      <LicenseBanner onOpen={openLicenseSettings} />

      {/* Шахматка со своей обвязкой: панель дат, фильтры и строка состояния
          принадлежат именно ей, поэтому уходят вместе с ней. */}
      {section === 'grid' && (
        <>
          <TodayStats filtersOpen={filtersOpen} onToggleFilters={toggleFilters} />
          <main style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', background: 'var(--bg)' }}>
            <Filters open={filtersOpen} />
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              <BookingGrid />
            </div>
          </main>
          <StatusBar />
        </>
      )}

      {section === 'reference' && <ReferenceWindow open onClose={() => setSection('grid')} />}
      {section === 'settings'  && <SettingsPanel  open onClose={() => setSection('grid')} initialSection={settingsSection} />}

      {section === 'rates'    && <RatesScreen onBack={() => setSection('grid')} />}
      {section === 'payments' && <PaymentsScreen onBack={() => setSection('grid')} />}
      {section === 'reports' && <ReportsScreen onBack={() => setSection('grid')} />}

      {/* Действия остаются модалками: это не места, а операции над бронью. */}
      <BookingModal />
      <BookingViewModal />
      <MoveBookingModal />
      <BookingContextMenu />
      <DeleteBookingDialog />
      <AuditWindow open={auditOpen} onClose={() => setAuditOpen(false)} />
      <OptimizeModal open={optimizeOpen} onClose={() => setOptimizeOpen(false)} />
      <SnapshotsModal open={snapshotsOpen} onClose={() => setSnapshotsOpen(false)} />
      <NavDrawer
        open={navOpen}
        active={section}
        hotelName={hotelName || 'Отель'}
        adminName={admin.name}
        adminRole={ROLE_LABELS[admin.role] ?? admin.role}
        onClose={() => setNavOpen(false)}
        onNavigate={handleNavigate}
      />
    </div>
  )
}

// Заставка на время первого запроса к серверу (состояние настройки + восстановление сессии)
const BootScreen: React.FC = () => (
  <div style={{
    minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 14, background: 'var(--surface)', color: 'var(--text-faint)', fontSize: '0.9rem',
  }}>
    <div style={{
      width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border-subtle)',
      borderTopColor: 'var(--accent)', animation: 'spin 0.8s linear infinite',
    }} />
    Подключение к серверу…
  </div>
)

// Текст баннера на экране входа, если /api/setup/status не ответил.
function describeBootError(e: unknown): string {
  const err = e as { response?: { status?: number } } | undefined
  if (!err?.response) {
    return 'Сервер недоступен. Проверьте, что сервер запущен, и адрес подключения в настройках системы.'
  }
  return `Сервер ответил ошибкой ${err.response.status ?? ''} при проверке состояния. Вход может не работать.`
}

// «1 номер», «2 номера», «5 номеров»
function roomsWord(n: number): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return 'номеров'
  if (last === 1) return 'номер'
  if (last >= 2 && last <= 4) return 'номера'
  return 'номеров'
}

// Иконки топбара (inline-SVG, Lucide/Feather-стиль из дизайн-хендоффа)
const ICONS = {
  // Палочка — тот же значок, что у раздела «Оптимизатор» в настройках
  wand:     <><path d="M15 4V2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5" /></>,
  history:  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />,
  audit:    <><path d="M3 12a9 9 0 1 0 3-7.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  moon:     <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />,
  sun:      <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  settings: <><line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" /><line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" /><line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" /><line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" /></>,
  logout:   <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
}

const IconBtn: React.FC<{
  onClick: () => void
  title: string
  icon: React.ReactNode
  active?: boolean
}> = ({ onClick, title, icon, active = false }) => (
  <button
    onClick={onClick}
    title={title}
    className="chrome-icon-btn"
    style={{
      width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: active ? 'var(--accent-bg)' : 'transparent',
      border: '1px solid transparent', borderRadius: 7,
      color: active ? 'var(--accent-text)' : 'var(--text-muted)',
      cursor: 'pointer', transition: 'background 0.12s, border-color 0.12s, color 0.12s',
    }}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {icon}
    </svg>
  </button>
)
