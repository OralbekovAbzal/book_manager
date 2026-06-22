import React, { useRef, useMemo, useEffect, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { parseISO, addDays, format } from 'date-fns'
import { useGridStore, type RoomStatusFilter } from '../../store/useGridStore'
import { GridHeader } from './GridHeader'
import { GridRow } from './GridRow'
import { DateSummary } from './DateSummary'
import { GridSettingsProvider, useGridSettings } from './GridSettingsContext'
import { compareRooms } from '../../utils/sortRooms'
import type { FlatRow, GridBooking } from '../../types'

/** Проверка соответствия комнаты выбранному фильтру на дату смены */
function matchesStatusFilter(
  bookings: GridBooking[],
  filter: RoomStatusFilter,
  shiftDate: string,
): boolean {
  if (filter === 'all' || !shiftDate) return true

  const day = (s: string) => s.slice(0, 10)

  switch (filter) {
    case 'living':
      // Заселились и ещё не выезжают сегодня
      return bookings.some(b =>
        b.status === 'CHECKED_IN' &&
        day(b.checkIn) <= shiftDate &&
        day(b.checkOut) > shiftDate
      )
    case 'departing':
      // Должны выехать сегодня но ещё заселены
      return bookings.some(b =>
        b.status === 'CHECKED_IN' &&
        day(b.checkOut) === shiftDate
      )
    case 'departed':
      // Уже выехали сегодня
      return bookings.some(b =>
        b.status === 'CHECKED_OUT' &&
        day(b.checkOut) === shiftDate
      )
    case 'arriving':
      // Должны заехать сегодня но ещё не заехали
      return bookings.some(b =>
        b.status === 'CONFIRMED' &&
        day(b.checkIn) === shiftDate
      )
    case 'arrived':
      // Заехали сегодня
      return bookings.some(b =>
        b.status === 'CHECKED_IN' &&
        day(b.checkIn) === shiftDate
      )
    case 'free':
      // Нет ни одной активной брони на сегодня (checkIn ≤ today < checkOut)
      // и нет ремонта
      return !bookings.some(b =>
        (b.status === 'CONFIRMED' || b.status === 'CHECKED_IN' || b.source === 'ремонт') &&
        day(b.checkIn) <= shiftDate &&
        day(b.checkOut) > shiftDate
      )
  }
  return true
}

export const BookingGrid: React.FC = () => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(() => window.innerWidth)

  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current
    // Инициализация
    setContainerWidth(el.clientWidth)
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? el.clientWidth
      setContainerWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <GridSettingsProvider containerWidth={containerWidth}>
        <BookingGridInner />
      </GridSettingsProvider>
    </div>
  )
}

const BookingGridInner: React.FC = () => {
  const { data, loading, error, dateFrom, dateTo, fetchGrid, roomStatusFilter, shiftDate, hiddenCategoryIds } = useGridStore()
  const { ROW_HEIGHT } = useGridSettings()
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => { fetchGrid() }, [])

  // Дата для фильтрации статуса — берём дату текущей смены, fallback = data.today
  const filterDate = shiftDate ?? data?.today ?? ''

  // Поиск по имени делается на сервере (см. occupancy.fetchGrid с guestSearch).
  // Здесь только клиентский фильтр по статусу комнаты.
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!data) return []
    const day = (s: string) => s.slice(0, 10)
    const covers = (b: GridBooking) =>
      b.status !== 'CANCELLED' && b.status !== 'NO_SHOW' &&
      day(b.checkIn) <= filterDate && filterDate < day(b.checkOut)

    const rows: FlatRow[] = []
    for (const cat of data.categories) {
      if (hiddenCategoryIds.includes(cat.id)) continue
      const sortedRooms = [...cat.rooms].sort(compareRooms)
      const visible = sortedRooms.filter(r => matchesStatusFilter(r.bookings, roomStatusFilter, filterDate))
      if (visible.length === 0) continue
      const occupied = cat.rooms.filter(r => r.bookings.some(covers)).length
      rows.push({ type: 'category', id: cat.id, name: cat.name, color: cat.color, total: cat.rooms.length, occupied })
      for (const room of visible) {
        rows.push({ type: 'room', room, categoryColor: cat.color, categoryName: cat.name })
      }
    }
    return rows
  }, [data, roomStatusFilter, filterDate, hiddenCategoryIds])

  // Dates array for the header
  const dates = useMemo<string[]>(() => {
    const result: string[] = []
    let cur = parseISO(dateFrom)
    const end = parseISO(dateTo)
    while (cur < end) {
      result.push(format(cur, 'yyyy-MM-dd'))
      cur = addDays(cur, 1)
    }
    return result
  }, [dateFrom, dateTo])

  const today = data?.today ?? new Date().toISOString().slice(0, 10)

  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => flatRows[index]?.type === 'category' ? CATEGORY_ROW_H : ROW_HEIGHT,
    overscan: 8,
    // Высоты строк фиксированы по типу — задаём явно, чтобы виртуализатор не
    // перемерял каждую строку через ResizeObserver (это и вызывало рывки).
    getItemKey: (index) => {
      const r = flatRows[index]
      if (!r) return index
      return r.type === 'category' ? `cat-${r.id}` : `room-${r.room.id}`
    },
  })

  if (error) {
    return (
      <div style={centerStyle}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 600, color: 'var(--status-overdue)', marginBottom: 12 }}>
            {error}
          </div>
          <button onClick={() => fetchGrid()} style={retryBtnStyle}>
            Повторить
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Sticky date header */}
      <GridHeader dates={dates} today={today} />

      {/* Scrollable grid body */}
      <div
        ref={parentRef}
        style={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
        }}
      >
        {loading && flatRows.length === 0 && (
          <div style={centerStyle}>
            <Spinner />
          </div>
        )}

        {!loading && flatRows.length === 0 && (
          <div style={centerStyle}>
            <span style={{ color: 'var(--text-faint)' }}>Нет данных</span>
          </div>
        )}

        {/* Обёртка контента: min-height 100% — чтобы сводка всегда прижималась к низу */}
        <div style={{ minHeight: '100%', minWidth: 'max-content', display: 'flex', flexDirection: 'column' }}>

        {/* Virtual rows container */}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: 'relative',
            minWidth: 'max-content',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = flatRows[vRow.index]
            return (
              <div
                key={vRow.key}
                style={{
                  position: 'absolute',
                  top: vRow.start,
                  left: 0,
                  right: 0,
                  height: vRow.size,
                  minWidth: 'max-content',
                  // NB: не используем transform на этой обёртке — иначе она станет
                  // containing block для position:fixed потомков (SelectionMenu,
                  // призрак перетаскивания брони, тултип) и они спозиционируются неверно.
                }}
              >
                {row.type === 'category'
                  ? <CategoryRow row={row} dates={dates} />
                  : <GridRow row={row} dates={dates} dateFrom={dateFrom} today={today} />}
              </div>
            )
          })}
        </div>

        {/* Спейсер — прижимает сводку к низу вьюпорта когда строк мало */}
        <div style={{ flex: 1, minHeight: 0 }} />

        {/* Feature 1 — Сводка по датам (sticky bottom, скроллится с сеткой) */}
        {data && flatRows.length > 0 && (
          <DateSummary data={data} dates={dates} today={today} />
        )}
        </div>

        {/* Loading overlay when refreshing */}
        {loading && flatRows.length > 0 && (
          <div style={{
            position: 'absolute',
            top: 8,
            right: 16,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '4px 12px',
            fontSize: '0.85rem',
            color: 'var(--text-muted)',
            boxShadow: 'var(--shadow-sm)',
          }}>
            Обновление…
          </div>
        )}
      </div>
    </div>
  )
}

const CATEGORY_ROW_H = 30

const CategoryRow: React.FC<{ row: Extract<FlatRow, { type: 'category' }>; dates: string[] }> = ({ row, dates }) => {
  const { DAY_WIDTH, ROOM_COL_WIDTH } = useGridSettings()
  return (
    <div style={{
      display: 'flex', height: CATEGORY_ROW_H, minWidth: 'max-content',
      background: 'var(--surface-2)',
      borderTop: '1px solid var(--border-subtle)',
      borderBottom: '1px solid var(--border-subtle)',
    }}>
      <div style={{
        position: 'sticky', left: 0, zIndex: 5,
        width: ROOM_COL_WIDTH, flexShrink: 0,
        background: 'var(--surface-2)',
        borderRight: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: row.color, flexShrink: 0 }} />
        <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>{row.name}</span>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>· {row.total} номеров</span>
        <span className="mono" style={{
          marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 600,
          color: 'var(--text-muted)', padding: '1px 6px', borderRadius: 4,
          background: 'var(--bg)', border: '1px solid var(--border-subtle)',
        }}>{row.occupied}/{row.total}</span>
      </div>
      <div style={{ width: dates.length * DAY_WIDTH, flexShrink: 0 }} />
    </div>
  )
}

const centerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const retryBtnStyle: React.CSSProperties = {
  padding: '6px 16px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg)',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  fontSize: '1rem',
}

const Spinner: React.FC = () => (
  <div style={{
    width: 28,
    height: 28,
    borderRadius: '50%',
    border: '2px solid var(--border)',
    borderTopColor: 'var(--accent)',
    animation: 'spin 0.7s linear infinite',
  }} />
)
