import React, { useEffect } from 'react'
import { format, parseISO, addDays } from 'date-fns'
import { useGridStore, type RoomStatusFilter } from '../../store/useGridStore'

interface FilterItem {
  key: RoomStatusFilter
  label: string
  dotColor?: string  // CSS variable
}

const FILTERS: FilterItem[] = [
  { key: 'all',       label: 'Все' },
  { key: 'living',    label: 'Проживают',  dotColor: 'var(--status-checked-in)' },
  { key: 'departing', label: 'Выезжают',   dotColor: 'var(--status-checked-out)' },
  { key: 'departed',  label: 'Выехали',    dotColor: 'var(--text-faint)' },
  { key: 'arriving',  label: 'Заезжают',   dotColor: 'var(--status-confirmed)' },
  { key: 'arrived',   label: 'Заехали',    dotColor: 'var(--status-checked-in)' },
  { key: 'free',      label: 'Свободные',  dotColor: 'var(--text-faint)' },
]

export const TodayStats: React.FC = () => {
  const { roomStatusFilter, setRoomStatusFilter, fetchShiftDate, navigate, jumpToDate, data, shiftDate } = useGridStore()

  useEffect(() => { fetchShiftDate() }, [])

  // Перейти к рабочему дню: он будет ≈ в 3-х днях от начала видимого диапазона
  const goToToday = () => {
    const anchorDate = shiftDate ?? data?.today
    if (!anchorDate) return
    jumpToDate(format(addDays(parseISO(anchorDate), -3), 'yyyy-MM-dd'))
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '10px 20px',
      background: 'var(--bg)',
      borderBottom: '1px solid var(--border)',
      flexWrap: 'wrap',
    }}>
      {FILTERS.map(f => {
        const active = roomStatusFilter === f.key
        return (
          <FilterButton
            key={f.key}
            active={active}
            label={f.label}
            dotColor={f.dotColor}
            onClick={() => setRoomStatusFilter(f.key)}
          />
        )
      })}

      {/* Навигация по датам — прижата к правому краю */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 3 }}>
        <NavBtn onClick={() => navigate(-7)} title="−7 дней">‹‹</NavBtn>
        <NavBtn onClick={() => navigate(-1)} title="−1 день">‹</NavBtn>
        <TodayBtn onClick={goToToday} />
        <NavBtn onClick={() => navigate(1)} title="+1 день">›</NavBtn>
        <NavBtn onClick={() => navigate(7)} title="+7 дней">››</NavBtn>
      </div>
    </div>
  )
}

// ─── Navigation buttons ─────────────────────────────────────────────────────────

const NavBtn: React.FC<{
  onClick: () => void
  title: string
  children: React.ReactNode
}> = ({ onClick, title, children }) => {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'var(--surface-3)' : 'var(--surface-2)',
        border: '1px solid var(--border)',
        cursor: 'pointer',
        padding: '6px 10px',
        fontSize: '1rem',
        color: 'var(--text)',
        borderRadius: 'var(--ui-radius)',
        lineHeight: 1,
        fontWeight: 700,
        transition: 'background 0.1s',
        minWidth: 30,
        textAlign: 'center',
      }}
    >
      {children}
    </button>
  )
}

const TodayBtn: React.FC<{ onClick: () => void }> = ({ onClick }) => {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      title="Перейти к рабочему дню"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'var(--accent-bg)' : 'var(--surface)',
        border: `1px solid ${hover ? 'var(--accent)' : 'var(--border)'}`,
        cursor: 'pointer',
        padding: '6px 14px',
        fontSize: 'inherit',
        color: hover ? 'var(--accent-text)' : 'var(--text-muted)',
        borderRadius: 'var(--ui-radius)',
        lineHeight: 1,
        fontWeight: 700,
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
    >
      Сегодня
    </button>
  )
}

const FilterButton: React.FC<{
  active: boolean
  label: string
  dotColor?: string
  onClick: () => void
}> = ({ active, label, dotColor, onClick }) => {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 12px',
        borderRadius: 'var(--ui-radius)',
        background: active
          ? 'var(--accent-bg)'
          : hover
          ? 'var(--surface-2)'
          : 'var(--surface)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        fontSize: 'inherit',
        fontWeight: active ? 700 : 500,
        color: active ? 'var(--accent-text)' : 'var(--text)',
        cursor: 'pointer',
        transition: 'all 0.12s',
        lineHeight: 1,
      }}
    >
      {dotColor && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: dotColor, flexShrink: 0,
        }} />
      )}
      {label}
    </button>
  )
}
