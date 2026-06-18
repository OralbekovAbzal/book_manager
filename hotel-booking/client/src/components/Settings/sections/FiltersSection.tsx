import React from 'react'
import { useSettingsStore } from '../../../store/useSettingsStore'

export const FiltersSection: React.FC = () => {
  const { filterSettings, setFilterSetting, resetFilterSettings } = useSettingsStore()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 540 }}>
      <header>
        <div style={{ fontSize: '1.38rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          Фильтры
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          Настройка панели фильтров над таблицей броней. Можно скрыть ненужные фильтры
          или изменить поведение по умолчанию.
        </div>
      </header>

      <Section title="Видимые фильтры">
        <Toggle
          label="Корпус"
          hint="Фильтр по корпусу/зданию"
          value={filterSettings.showBuilding}
          onChange={(v) => setFilterSetting('showBuilding', v)}
        />
        <Toggle
          label="Категория"
          hint="Фильтр по категории номера"
          value={filterSettings.showCategory}
          onChange={(v) => setFilterSetting('showCategory', v)}
        />
        <Toggle
          label="Этаж"
          hint="Фильтр по этажу"
          value={filterSettings.showFloor}
          onChange={(v) => setFilterSetting('showFloor', v)}
        />
        <Toggle
          label="Вместимость"
          hint="Фильтр по вместимости номера"
          value={filterSettings.showCapacity}
          onChange={(v) => setFilterSetting('showCapacity', v)}
        />
        <Toggle
          label="Особенности"
          hint="Фильтр по особенностям номера"
          value={filterSettings.showFeatures}
          onChange={(v) => setFilterSetting('showFeatures', v)}
        />
      </Section>

      <Section title="Поведение">
        <Toggle
          label="Скрыть фильтры по умолчанию"
          hint="При первом открытии панель фильтров будет свёрнута"
          value={filterSettings.collapsedByDefault}
          onChange={(v) => setFilterSetting('collapsedByDefault', v)}
        />
      </Section>

      <button
        onClick={resetFilterSettings}
        style={{
          padding: '9px 0',
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 8,
          fontSize: '1rem',
          color: 'var(--text-muted)',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        Сбросить по умолчанию
      </button>
    </div>
  )
}

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div style={{
      fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-faint)',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginBottom: 12,
    }}>
      {title}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {children}
    </div>
  </div>
)

interface ToggleProps {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}

const Toggle: React.FC<ToggleProps> = ({ label, hint, value, onChange }) => (
  <label style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    cursor: 'pointer', gap: 12,
    padding: '10px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      {hint && (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
        background: value ? 'var(--accent)' : 'var(--surface-3)',
        position: 'relative', transition: 'background 0.2s', cursor: 'pointer',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: value ? 21 : 3,
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.2s',
      }} />
    </div>
  </label>
)
