import React from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useGridStore } from '../../store/useGridStore'
import { SectionHeader, secondaryBtn } from './sections/sectionUi'

// Пресеты затрагивают ВСЕ настройки масштаба разом
const PRESETS = [
  {
    label: 'Компактный',
    hint: 'Больше данных на экране',
    values: { rowHeight: 32, headerHeight: 36, fontSize: 11, blockRadius: 3, uiRadius: 4 },
  },
  {
    label: 'Стандарт',
    hint: 'Баланс плотности и читаемости',
    values: { rowHeight: 44, headerHeight: 48, fontSize: 13, blockRadius: 6, uiRadius: 6 },
  },
  {
    label: 'Просторный',
    hint: 'Удобно при сенсорном вводе',
    values: { rowHeight: 60, headerHeight: 56, fontSize: 14, blockRadius: 8, uiRadius: 8 },
  },
  {
    label: 'Крупный',
    hint: 'Большой шрифт и элементы',
    values: { rowHeight: 72, headerHeight: 64, fontSize: 16, blockRadius: 10, uiRadius: 10 },
  },
]

const DAY_PRESETS = [7, 14, 21, 30, 45, 60]

export const VisualSettings: React.FC = () => {
  const { visual, setVisual, resetVisual } = useSettingsStore()

  const applyPreset = (preset: typeof PRESETS[0]) => {
    Object.entries(preset.values).forEach(([k, v]) =>
      setVisual(k as keyof typeof visual, v as never)
    )
  }

  const setVisibleDays = (days: number) => {
    setVisual('visibleDays', days)
    useGridStore.getState().syncDateRange()
  }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <SectionHeader
        title="Внешний вид"
        subtitle="Тема, плотность и размеры интерфейса. Применяется сразу."
      />

      {/* Тема */}
      <Section title="Тема оформления">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <ThemeBtn active={visual.theme === 'light'} onClick={() => setVisual('theme', 'light')} label="Светлая" />
          <ThemeBtn active={visual.theme === 'dark'}  onClick={() => setVisual('theme', 'dark')}  label="Тёмная" />
        </div>
      </Section>

      {/* Быстрые пресеты */}
      <Section title="Быстрые пресеты" hint="Применяют сразу все параметры масштаба">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {PRESETS.map((p) => {
            const isActive =
              visual.rowHeight    === p.values.rowHeight    &&
              visual.headerHeight === p.values.headerHeight &&
              visual.fontSize     === p.values.fontSize
            return (
              <button
                key={p.label}
                onClick={() => applyPreset(p)}
                style={{
                  padding: '10px 12px',
                  background: isActive ? 'var(--accent-bg)' : 'var(--surface)',
                  border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--ui-radius)',
                  fontSize: 'inherit',
                  fontWeight: 600,
                  color: isActive ? 'var(--accent-text)' : 'var(--text)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                  transition: 'all 0.15s',
                }}
              >
                <span>{p.label}</span>
                <span style={{ fontWeight: 400, fontSize: '0.85em', color: isActive ? 'var(--accent-text)' : 'var(--text-faint)' }}>
                  {p.hint}
                </span>
              </button>
            )
          })}
        </div>
      </Section>

      {/* Сетка */}
      <Section title="Сетка" hint="Диапазон и размеры таблицы броней.">
        <Slider label="Дней в сетке" unit=" дн." min={7} max={90} value={visual.visibleDays} onChange={setVisibleDays} />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {DAY_PRESETS.map((days) => (
            <button key={days} onClick={() => setVisibleDays(days)} style={{
              padding: '4px 12px', border: '1px solid',
              borderColor: visual.visibleDays === days ? 'var(--accent)' : 'var(--border)',
              borderRadius: 20, fontSize: '0.9em', fontWeight: 600,
              background: visual.visibleDays === days ? 'var(--accent-bg)' : 'var(--surface)',
              color: visual.visibleDays === days ? 'var(--accent-text)' : 'var(--text-muted)',
              cursor: 'pointer', transition: 'all 0.15s',
            }}>{days} дн.</button>
          ))}
        </div>
        <Slider label="Отступ слева до даты смены" unit=" дн." min={0} max={14} value={visual.daysBeforeShift} onChange={v => setVisual('daysBeforeShift', v)} />
        <div style={{ fontSize: '0.8em', color: 'var(--text-faint)', marginTop: -8 }}>
          Сколько дней истории показывать слева от текущей смены. Применится при нажатии «Сегодня» или перезагрузке.
        </div>
        <Slider label="Высота строки" unit="px" min={28} max={80} value={visual.rowHeight} onChange={v => setVisual('rowHeight', v)} />
        <Slider label="Высота заголовка дат" unit="px" min={32} max={72} value={visual.headerHeight} onChange={v => setVisual('headerHeight', v)} />
      </Section>

      {/* Шрифт и скругления */}
      <Section title="Шрифт и скругления" hint="Влияют на интерфейс и блоки броней.">
        <Slider label="Размер шрифта" unit="px" min={10} max={22} value={visual.fontSize} onChange={v => setVisual('fontSize', v)} />
        <Slider label="Скругление кнопок и полей" unit="px" min={0} max={20} value={visual.uiRadius} onChange={v => setVisual('uiRadius', v)} />
        <Slider label="Скругление блоков броней" unit="px" min={0} max={20} value={visual.blockRadius} onChange={v => setVisual('blockRadius', v)} />
      </Section>

      {/* Отображение */}
      <Section title="Отображение">
        <Toggle
          label="Счётчик удобств у номера"
          hint="Показывать количество дополнительных удобств рядом с категорией"
          value={visual.showFeatureIcons}
          onChange={v => setVisual('showFeatureIcons', v)}
        />
      </Section>

      {/* Сброс */}
      <button onClick={resetVisual} style={{ ...secondaryBtn, alignSelf: 'flex-start' }}>
        Сбросить по умолчанию
      </button>
    </div>
  )
}

// ─── Вспомогательные компоненты ───────────────────────────────────────────────

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div>
    <div style={{ marginBottom: 12 }}>
      <div style={{
        fontSize: '0.85em', fontWeight: 700, color: 'var(--text-faint)',
        textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>
        {title}
      </div>
      {hint && (
        <div style={{ fontSize: '0.85em', color: 'var(--text-faint)', marginTop: 3 }}>
          {hint}
        </div>
      )}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {children}
    </div>
  </div>
)

interface SliderProps {
  label: string; unit: string; min: number; max: number; value: number
  onChange: (v: number) => void
}

const Slider: React.FC<SliderProps> = ({ label, unit, min, max, value, onChange }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 'inherit', color: 'var(--text)', fontWeight: 500 }}>{label}</span>
      <span style={{
        fontSize: '0.9em', fontWeight: 700, color: 'var(--accent-text)',
        background: 'var(--accent-bg)', padding: '2px 10px', borderRadius: 20,
        minWidth: 44, textAlign: 'center',
      }}>
        {value}{unit}
      </span>
    </div>
    <input
      type="range" min={min} max={max} value={value}
      onChange={e => onChange(Number(e.target.value))}
      style={{ width: '100%', accentColor: 'var(--accent)', cursor: 'pointer' }}
    />
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8em', color: 'var(--text-faint)' }}>
      <span>{min}{unit}</span><span>{max}{unit}</span>
    </div>
  </div>
)

interface ToggleProps {
  label: string; hint?: string; value: boolean; onChange: (v: boolean) => void
}

const Toggle: React.FC<ToggleProps> = ({ label, hint, value, onChange }) => (
  <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', gap: 12 }}>
    <div>
      <div style={{ fontSize: 'inherit', fontWeight: 500, color: 'var(--text)' }}>{label}</div>
      {hint && <div style={{ fontSize: '0.85em', color: 'var(--text-faint)', marginTop: 2 }}>{hint}</div>}
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

const ThemeBtn: React.FC<{ active: boolean; onClick: () => void; label: string }> = ({ active, onClick, label }) => (
  <button
    onClick={onClick}
    style={{
      padding: '12px 0',
      background: active ? 'var(--accent-bg)' : 'var(--surface)',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      borderRadius: 'var(--ui-radius)',
      fontSize: 'inherit',
      fontWeight: 600,
      color: active ? 'var(--accent-text)' : 'var(--text)',
      cursor: 'pointer',
      transition: 'all 0.15s',
    }}
  >
    {label}
  </button>
)
