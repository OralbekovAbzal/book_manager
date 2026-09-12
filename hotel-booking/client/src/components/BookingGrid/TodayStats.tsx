import React from 'react'
import { format, parseISO, addDays } from 'date-fns'
import { useGridStore, type RoomStatusFilter } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'

interface FilterItem {
  key: RoomStatusFilter
  label: string
  dotColor?: string  // CSS variable
}

const FILTERS: FilterItem[] = [
  { key: 'all',       label: 'Все' },
  { key: 'living',    label: 'Проживающие', dotColor: 'var(--s-in)' },
  { key: 'departing', label: 'Выезжают',    dotColor: 'var(--s-out)' },
  { key: 'departed',  label: 'Выбывшие',    dotColor: 'var(--text-faint)' },
  { key: 'arriving',  label: 'Прибывающие', dotColor: 'var(--s-confirmed)' },
  { key: 'arrived',   label: 'Прибывшие',   dotColor: 'var(--s-in)' },
  { key: 'free',      label: 'Свободные',   dotColor: 'var(--text-faint)' },
]

// Иконки навигации по датам (chevron, Lucide-стиль)
const chevLeft   = <path d="m15 18-6-6 6-6" />
const chevRight  = <path d="m9 18 6-6-6-6" />
const chevLeft2  = <path d="m11 17-5-5 5-5M18 17l-5-5 5-5" />
const chevRight2 = <path d="m6 17 5-5-5-5M13 17l5-5-5-5" />

interface Props {
  filtersOpen: boolean
  onToggleFilters: () => void
}

export const TodayStats: React.FC<Props> = ({ filtersOpen, onToggleFilters }) => {
  const { roomStatusFilter, setRoomStatusFilter, fetchShiftDate, navigate, jumpToDate, data, shiftDate } = useGridStore()

  React.useEffect(() => { fetchShiftDate() }, [])

  // Перейти к рабочему дню: смена будет в daysBeforeShift днях от левого края
  const goToToday = () => {
    const anchorDate = shiftDate ?? data?.today
    if (!anchorDate) return
    const before = useSettingsStore.getState().visual.daysBeforeShift ?? 3
    jumpToDate(format(addDays(parseISO(anchorDate), -before), 'yyyy-MM-dd'))
  }

  return (
    // 52 → 40 px (12.09.2026): вместе с шапкой и заголовком дат полосы над
    // сеткой съедали ~180 px — на ноутбуке стойки это два-три номера.
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      height: 40, flexShrink: 0, padding: '0 12px',
      background: 'var(--bg)', borderBottom: '1px solid var(--border-subtle)',
    }}>
      {/* Filter rail toggle */}
      <button
        onClick={onToggleFilters}
        title={filtersOpen ? 'Скрыть фильтры' : 'Показать фильтры'}
        className="tb-btn"
        style={{
          width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7,
          color: 'var(--text-muted)', cursor: 'pointer', transition: 'background 0.12s',
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {filtersOpen ? chevLeft2 : chevRight2}
        </svg>
      </button>

      {/* Room-status pills — общий серый контейнер, активная белая */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
        padding: 2, background: 'var(--surface-2)',
        border: '1px solid var(--border-subtle)', borderRadius: 8,
      }}>
        {FILTERS.map(f => (
          <FilterPill
            key={f.key}
            active={roomStatusFilter === f.key}
            label={f.label}
            dotColor={f.dotColor}
            onClick={() => setRoomStatusFilter(f.key)}
          />
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {/* Date navigation — icon buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
        <NavBtn onClick={() => navigate(-7)} title="−7 дней" icon={chevLeft2} />
        <NavBtn onClick={() => navigate(-1)} title="−1 день" icon={chevLeft} />
        <button onClick={goToToday} title="Перейти к рабочему дню" className="tb-today" style={{
          height: 26, padding: '0 12px', background: 'var(--bg)',
          border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.84rem', fontWeight: 600,
          whiteSpace: 'nowrap', transition: 'background 0.12s, border-color 0.12s',
        }}>Сегодня</button>
        <NavBtn onClick={() => navigate(1)} title="+1 день" icon={chevRight} />
        <NavBtn onClick={() => navigate(7)} title="+7 дней" icon={chevRight2} />
      </div>
    </div>
  )
}

const NavBtn: React.FC<{ onClick: () => void; title: string; icon: React.ReactNode }> = ({ onClick, title, icon }) => (
  <button onClick={onClick} title={title} className="tb-btn" style={{
    width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
    color: 'var(--text-muted)', cursor: 'pointer', transition: 'background 0.12s',
  }}>
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
  </button>
)

const FilterPill: React.FC<{
  active: boolean
  label: string
  dotColor?: string
  onClick: () => void
}> = ({ active, label, dotColor, onClick }) => (
  <button
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px',
      borderRadius: 6, fontFamily: 'inherit', fontSize: '0.84rem',
      cursor: 'pointer', whiteSpace: 'nowrap', border: 'none',
      background: active ? 'var(--bg)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-muted)',
      fontWeight: active ? 600 : 500,
      boxShadow: active ? 'var(--shadow-sm)' : 'none',
      transition: 'background 0.12s',
    }}
  >
    {dotColor && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />}
    {label}
  </button>
)
