import React, { useRef, useMemo, useEffect, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { parseISO, addDays, format } from 'date-fns'
import { useGridStore, type RoomStatusFilter } from '../../store/useGridStore'
import { GridHeader } from './GridHeader'
import { GridRow } from './GridRow'
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
  const { data, loading, error, dateFrom, dateTo, fetchGrid, roomStatusFilter, shiftDate } = useGridStore()
  const { ROW_HEIGHT } = useGridSettings()
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => { fetchGrid() }, [])

  // Дата для фильтрации статуса — берём дату текущей смены, fallback = data.today
  const filterDate = shiftDate ?? data?.today ?? ''

  // Поиск по имени делается на сервере (см. occupancy.fetchGrid с guestSearch).
  // Здесь только клиентский фильтр по статусу комнаты.
  const flatRows = useMemo<FlatRow[]>(() => {
    if (!data) return []
    const rows: FlatRow[] = []
    for (const cat of data.categories) {
      const sortedRooms = [...cat.rooms].sort(compareRooms)
      for (const room of sortedRooms) {
        if (!matchesStatusFilter(room.bookings, roomStatusFilter, filterDate)) continue
        rows.push({ type: 'room', room, categoryColor: cat.color, categoryName: cat.name })
      }
    }
    return rows
  }, [data, roomStatusFilter, filterDate])

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
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Высота строк фиксированная — задаём её явно, чтобы виртуализатор не
    // перемерял каждую строку через ResizeObserver (это и вызывало рывки).
    getItemKey: (index) => flatRows[index]?.room.id ?? index,
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
                  height: ROW_HEIGHT,
                  minWidth: 'max-content',
                  // NB: не используем transform на этой обёртке — иначе она станет
                  // containing block для position:fixed потомков (SelectionMenu,
                  // призрак перетаскивания брони, тултип) и они спозиционируются неверно.
                }}
              >
                <GridRow
                  row={row}
                  dates={dates}
                  dateFrom={dateFrom}
                  today={today}
                />
              </div>
            )
          })}
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
