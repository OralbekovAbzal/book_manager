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

interface NavItem { id: ActiveSection; label: string }
interface NavGroup { title: string; items: NavItem[] }

const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Интерфейс',
    items: [{ id: 'visual', label: 'Внешний вид' }],
  },
  {
    title: 'Номерной фонд',
    items: [
      { id: 'buildings', label: 'Корпуса' },
      { id: 'categories', label: 'Категории' },
      { id: 'features', label: 'Особенности' },
      { id: 'capacities', label: 'Вместимость' },
      { id: 'rooms', label: 'Номера' },
    ],
  },
  {
    title: 'Брони',
    items: [{ id: 'bookingFlags', label: 'Метки броней' }],
  },
  {
    title: 'Партнёры',
    items: [
      { id: 'partners',   label: 'Партнёры (бюро)' },
      { id: 'allotments', label: 'Квоты' },
    ],
  },
  {
    title: 'Алгоритмы',
    items: [{ id: 'optimizer', label: 'Оптимизатор' }],
  },
  {
    title: 'Система',
    items: [
      { id: 'filters', label: 'Фильтры' },
      { id: 'backup',  label: 'Резервная копия' },
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
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 500,
          backdropFilter: 'blur(2px)',
        }}
      />

      <div style={{
        position: 'fixed',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '90vw',
        maxWidth: 1200,
        height: '90vh',
        background: 'var(--bg)',
        borderRadius: 12,
        border: '1px solid var(--border)',
        zIndex: 501,
        display: 'flex',
        overflow: 'hidden',
        boxShadow: 'var(--shadow-lg)',
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

          <nav style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
            {NAV_GROUPS.map(group => (
              <div key={group.title}>
                <div style={{
                  fontSize: '0.77rem',
                  fontWeight: 700,
                  color: 'var(--text-faint)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  padding: '16px 16px 8px',
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
                        width: '100%',
                        padding: '9px 16px 9px 13px',
                        border: 'none',
                        background: isActive ? 'var(--accent-bg)' : 'transparent',
                        cursor: 'pointer',
                        fontSize: 'inherit',
                        fontWeight: isActive ? 700 : 500,
                        color: isActive ? 'var(--accent-text)' : 'var(--text)',
                        textAlign: 'left',
                        borderLeft: `3px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                        transition: 'background 0.12s',
                      }}
                      onMouseEnter={e => {
                        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)'
                      }}
                      onMouseLeave={e => {
                        if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                      }}
                    >
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
