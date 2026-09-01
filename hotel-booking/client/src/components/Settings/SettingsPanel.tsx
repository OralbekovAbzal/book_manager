import React, { useState, useEffect } from 'react'
import { VisualSettings } from './VisualSettings'
import { BuildingsSection } from './sections/BuildingsSection'
import { CategoriesSection } from './sections/CategoriesSection'
import { FeaturesSection } from './sections/FeaturesSection'
import { CapacitiesSection } from './sections/CapacitiesSection'
import { RoomsSection } from './sections/RoomsSection'
import { FiltersSection } from './sections/FiltersSection'
import { BookingFlagsSection } from './sections/BookingFlagsSection'
import { OptimizerSection } from './sections/OptimizerSection'
import { PartnersSection } from './sections/PartnersSection'
import { AllotmentsSection } from './sections/AllotmentsSection'
import { BackupSection } from './sections/BackupSection'

interface Props {
  open: boolean
  onClose: () => void
}

type ActiveSection = 'visual' | 'buildings' | 'categories' | 'features' | 'capacities' | 'rooms' | 'filters' | 'bookingFlags' | 'optimizer' | 'partners' | 'allotments' | 'backup'

interface NavItem { id: ActiveSection; label: string; icon: string }
interface NavGroup { title: string; items: NavItem[] }

// Иконки разделов настроек (SVG path, Lucide-стиль) — из дизайн-хендоффа.
const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Объект',
    items: [
      { id: 'buildings',  label: 'Корпуса',     icon: 'M3 21h18 M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16 M19 21v-8a1 1 0 0 0-1-1h-3 M9 7h2 M9 11h2 M9 15h2' },
      { id: 'categories', label: 'Категории',   icon: 'M3 3h7v7H3z M14 3h7v7h-7z M14 14h7v7h-7z M3 14h7v7H3z' },
      { id: 'features',   label: 'Особенности', icon: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z' },
      { id: 'capacities', label: 'Вместимость', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75' },
      { id: 'rooms',      label: 'Номера',      icon: 'M2 4v16 M2 8h18a2 2 0 0 1 2 2v10 M2 17h20 M6 8v9' },
    ],
  },
  {
    title: 'Тарифы и брони',
    items: [
      { id: 'bookingFlags', label: 'Метки броней',       icon: 'M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z M7.5 7.5h.01' },
      { id: 'partners',     label: 'Партнёры',           icon: 'M9 17H7A5 5 0 0 1 7 7h2 M15 7h2a5 5 0 1 1 0 10h-2 M8 12h8' },
      { id: 'allotments',   label: 'Квоты и аллотменты',  icon: 'M12 2 2 7l10 5 10-5z M2 17l10 5 10-5 M2 12l10 5 10-5' },
      { id: 'optimizer',    label: 'Оптимизатор',        icon: 'M15 4V2 M8 9h2 M20 9h2 M17.8 11.8 19 13 M17.8 6.2 19 5 M3 21l9-9 M12.2 6.2 11 5' },
    ],
  },
  {
    title: 'Система',
    items: [
      { id: 'filters', label: 'Фильтры',     icon: 'M22 3H2l8 9.46V19l4 2v-8.54z' },
      { id: 'backup',  label: 'Бэкап',       icon: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3 M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5 M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' },
      { id: 'visual',  label: 'Внешний вид', icon: 'M12 22a10 10 0 1 1 10-10c0 2-2 3-4 3h-2a2 2 0 0 0-1 4 1 1 0 0 1-1 1z M13.5 6.5h.01 M17.5 10.5h.01 M8.5 7.5h.01 M6.5 12.5h.01' },
    ],
  },
]

export const SettingsPanel: React.FC<Props> = ({ open, onClose }) => {
  const [activeSection, setActiveSection] = useState<ActiveSection>('visual')

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      {/* Обычный экран в потоке приложения, а не окно поверх сетки: шахматка
          заменяется этим разделом, шапка остаётся общей для всех разделов. */}
      <div style={{
        flex: 1,
        minHeight: 0,
        background: 'var(--bg)',
        display: 'flex',
        overflow: 'hidden',
        color: 'var(--text)',
      }}>

        {/* SIDEBAR */}
        <div style={{
          width: 240,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 16px 16px',
            borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: '1.08rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
              Настройки
            </span>
            <button
              onClick={onClose}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '1.38rem', color: 'var(--text-faint)', padding: '0 4px',
                lineHeight: 1, fontWeight: 300,
              }}
            >×</button>
          </div>

          <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 12px 16px' }}>
            {NAV_GROUPS.map(group => (
              <div key={group.title} style={{ marginBottom: 14 }}>
                <div style={{
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: 'var(--text-faint)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  padding: '4px 10px',
                }}>
                  {group.title}
                </div>
                {group.items.map(item => {
                  const isActive = activeSection === item.id
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveSection(item.id)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        height: 34,
                        padding: '0 10px',
                        border: 'none',
                        borderRadius: 8,
                        background: isActive ? 'var(--accent-bg)' : 'transparent',
                        cursor: 'pointer',
                        fontSize: '0.86rem',
                        fontWeight: isActive ? 600 : 500,
                        color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                        textAlign: 'left',
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => {
                        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)'
                      }}
                      onMouseLeave={e => {
                        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                        stroke={isActive ? 'var(--accent)' : 'currentColor'}
                        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d={item.icon} />
                      </svg>
                      {item.label}
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        </div>

        {/* CONTENT */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 32, background: 'var(--bg)' }}>
          {activeSection === 'visual'     && <VisualSettings />}
          {activeSection === 'buildings'  && <BuildingsSection />}
          {activeSection === 'categories' && <CategoriesSection />}
          {activeSection === 'features'   && <FeaturesSection />}
          {activeSection === 'capacities' && <CapacitiesSection />}
          {activeSection === 'rooms'      && <RoomsSection />}
          {activeSection === 'filters'     && <FiltersSection />}
          {activeSection === 'bookingFlags' && <BookingFlagsSection />}
          {activeSection === 'optimizer'    && <OptimizerSection />}
          {activeSection === 'partners'     && <PartnersSection />}
          {activeSection === 'allotments'   && <AllotmentsSection />}
          {activeSection === 'backup'       && <BackupSection />}
        </div>
      </div>
    </>
  )
}
