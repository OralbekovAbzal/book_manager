import React, { useCallback, useRef, useState, useEffect } from 'react'
import { differenceInCalendarDays, parseISO, addDays, format } from 'date-fns'
import { BookingBlock } from './BookingBlock'
import { SelectionMenu } from './SelectionMenu'
import { dateFromX, nightFromX } from './utils'
import { useGridSettings } from './GridSettingsContext'
import { useGridStore } from '../../store/useGridStore'
import type { FlatRow, GridBooking, GridAllotment } from '../../types'

interface Props {
  row: Extract<FlatRow, { type: 'room' }>
  dates: string[]
  dateFrom: string
  today: string
}

interface Selection {
  from: string
  to: string
}

interface PendingMenu {
  from: string
  checkOut: string
  roomId: number
  screenX: number
  screenY: number
}

// Порог движения мыши (px): выделение дат начинается только когда курсор сдвинулся
// на столько от точки нажатия. Быстрый клик без движения ничего не выделяет.
const SELECT_MOVE_THRESHOLD = 4

const GridRowImpl: React.FC<Props> = ({ row, dates, dateFrom, today }) => {
  const openViewModal = useGridStore(s => s.openViewModal)
  const openContextMenu = useGridStore(s => s.openContextMenu)
  const { DAY_WIDTH, ROW_HEIGHT, ROOM_COL_WIDTH, FONT_SIZE, SHOW_FEATURE_ICONS } = useGridSettings()

  // Refs — не вызывают re-render, доступны в document-обработчиках
  const dragging     = useRef(false)
  const dragAnchor   = useRef<string | null>(null)
  const areaRef      = useRef<HTMLDivElement>(null)   // ссылка на booking-area div
  const selectionRef = useRef<Selection | null>(null) // актуальное выделение для mouseup
  const roomIdRef    = useRef<number | null>(null)
  // DAY_WIDTH меняется при ресайзе/смене диапазона — храним в ref чтобы
  // document-обработчики всегда читали актуальное значение без пересоздания
  const dayWidthRef  = useRef(DAY_WIDTH)
  dayWidthRef.current = DAY_WIDTH
  const downPos      = useRef<{ x: number; y: number } | null>(null)
  // Брони комнаты — чтобы выделение упиралось в них день-в-день (без наложения).
  // Через ref, чтобы document-обработчик всегда видел актуальный список.
  const bookingsRef  = useRef(row.room.bookings)
  bookingsRef.current = row.room.bookings

  const [selection,   setSelectionState] = useState<Selection | null>(null)
  const [pendingMenu, setPendingMenu]    = useState<PendingMenu | null>(null)

  // Синхронно обновляем ref + state
  const setSelection = useCallback((sel: Selection | null) => {
    selectionRef.current = sel
    setSelectionState(sel)
  }, [])

  // ─── Document-level обработчики drag (вешаем один раз) ───────────────────
  useEffect(() => {
    if (row.type !== 'room') return

    const beginDrag = () => {
      if (dragging.current || !dragAnchor.current) return
      dragging.current = true
      setSelection({ from: dragAnchor.current, to: dragAnchor.current })
    }

    const onMove = (e: MouseEvent) => {
      // Ещё не выделяем: заметный сдвиг мыши = явное протягивание → стартуем сразу,
      // не дожидаясь задержки удержания.
      if (!dragging.current) {
        if (downPos.current) {
          const dist = Math.hypot(e.clientX - downPos.current.x, e.clientY - downPos.current.y)
          if (dist > SELECT_MOVE_THRESHOLD) {
            beginDrag()
          }
        }
        if (!dragging.current) return
      }
      if (!dragAnchor.current || !areaRef.current) return

      // Пересчитываем rect на каждом шаге чтобы учесть горизонтальный скролл
      const rect = areaRef.current.getBoundingClientRect()
      const x    = Math.max(0, e.clientX - rect.left)
      // Ночь по «полуячеечной» схеме (как рисуются блоки) + не левее видимого начала
      let date = nightFromX(x, dateFrom, dayWidthRef.current)
      if (date < dateFrom) date = dateFrom

      const anchor  = dragAnchor.current
      const rawFrom = anchor <= date ? anchor : date
      const rawTo   = anchor <= date ? date   : anchor
      // Не даём выделению наехать на существующую бронь — упираем в неё день-в-день.
      const newSel: Selection = clampToFreeGap(anchor, rawFrom, rawTo, bookingsRef.current)
      selectionRef.current = newSel
      setSelectionState(newSel)
    }

    const onUp = (e: MouseEvent) => {
      downPos.current = null

      // Быстрый клик без удержания и без движения — выделение не началось, меню не показываем.
      if (!dragging.current) {
        dragAnchor.current = null
        return
      }
      dragging.current = false

      const sel    = selectionRef.current
      const roomId = roomIdRef.current

      dragAnchor.current   = null
      selectionRef.current = null
      setSelectionState(null)

      if (!sel || !roomId) return

      const checkOut = format(addDays(parseISO(sel.to), 1), 'yyyy-MM-dd')
      setPendingMenu({ from: sel.from, checkOut, roomId, screenX: e.clientX, screenY: e.clientY })
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
    }
  }, [row.type, dateFrom, setSelection])

  // ─── Начало drag ─────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (row.type !== 'room') return
    if (e.button !== 0) return
    e.preventDefault()

    roomIdRef.current = row.room.id
    const rect = e.currentTarget.getBoundingClientRect()
    const x    = Math.max(0, e.clientX - rect.left)
    let date = nightFromX(x, dateFrom, dayWidthRef.current)
    if (date < dateFrom) date = dateFrom

    dragging.current   = false
    dragAnchor.current = date
    downPos.current    = { x: e.clientX, y: e.clientY }
    setPendingMenu(null)
    // Выделение начнётся только когда курсор сдвинётся (см. onMove).
    // Быстрый клик без движения ничего не выделяет — нет ложных нажатий.
  }, [row, dateFrom, setSelection])

  // Determine cursor based on mouse position (past date → default, future → crosshair)
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!areaRef.current) return
    const rect = areaRef.current.getBoundingClientRect()
    const x    = Math.max(0, e.clientX - rect.left)
    const date = dateFromX(x, dateFrom, dayWidthRef.current)
    areaRef.current.style.cursor = date < today ? 'default' : 'crosshair'
  }, [dateFrom, today])

  const handleBookingView = useCallback((booking: GridBooking) => {
    openViewModal(booking)
  }, [openViewModal])

  const handleBookingContextMenu = useCallback((booking: GridBooking, x: number, y: number) => {
    openContextMenu(booking, x, y)
  }, [openContextMenu])

  const totalWidth = dates.length * DAY_WIDTH

  // ─── Room row ─────────────────────────────────────────────────────────────
  const { room, categoryColor, categoryName } = row

  // Overlay: от середины первой ячейки до середины (last + 1)
  const selectionOverlay = selection ? (() => {
    const fromOffset = differenceInCalendarDays(parseISO(selection.from), parseISO(dateFrom))
    const nights     = differenceInCalendarDays(parseISO(selection.to), parseISO(selection.from)) + 1
    // От СЕРЕДИНЫ стартовой ячейки до СЕРЕДИНЫ конечной (выезд) — половинки на концах,
    // чтобы день-в-день стыковать выезд/заезд (на том же дне может начаться другая бронь).
    return { left: fromOffset * DAY_WIDTH + DAY_WIDTH / 2, width: nights * DAY_WIDTH }
  })() : null

  return (
    <div style={{
      display: 'flex', height: ROW_HEIGHT,
      borderBottom: '1px solid var(--border-subtle)',
      minWidth: 'max-content', position: 'relative',
      background: 'var(--bg)',
    }}>
      {/* Sticky room name */}
      <div style={{
        position: 'sticky', left: 0, zIndex: 5,
        width: ROOM_COL_WIDTH, flexShrink: 0,
        background: 'var(--bg)',
        height: '100%',
        display: 'flex', alignItems: 'center',
        paddingLeft: 14, paddingRight: 10, gap: 10,
        borderRight: '1px solid var(--border)',
      }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: categoryColor, flexShrink: 0,
        }} />
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0, flex: 1 }}>
          <span className="mono" style={{ fontSize: FONT_SIZE, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3, letterSpacing: '-0.01em' }}>
            {room.number}
          </span>
          <span style={{
            fontSize: Math.max(9, FONT_SIZE - 3),
            color: 'var(--text-faint)',
            fontWeight: 500,
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {categoryName}{SHOW_FEATURE_ICONS && room.features.length > 0 ? ` · ${room.features.length}` : ''}
          </span>
        </div>
      </div>

      {/* Booking area */}
      <div
        ref={areaRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        data-booking-area="1"
        data-room-id={row.type === 'room' ? row.room.id : ''}
        data-date-from={dateFrom}
        style={{
          position: 'relative', width: totalWidth, height: '100%',
          cursor: 'crosshair', flexShrink: 0, userSelect: 'none',
          overflow: 'hidden',  // блоки, торчащие за пределы видимого диапазона, обрезаются
        }}
      >
        {/* Column backgrounds: past / today / weekend */}
        {dates.map((date, i) => {
          const dow = new Date(date + 'T12:00:00Z').getUTCDay()
          const isWeekend = dow === 0 || dow === 6
          const isPastDate = date < today
          const isTodayDate = date === today

          let bg = 'transparent'
          if (isWeekend && !isTodayDate) bg = 'var(--weekend-bg)'
          if (isPastDate && !isTodayDate) bg = 'var(--past-bg)'
          if (isTodayDate) bg = 'var(--today-bg)'

          return (
            <div key={`bg-${date}`} style={{
              position: 'absolute', left: i * DAY_WIDTH, width: DAY_WIDTH,
              top: 0, bottom: 0, background: bg, pointerEvents: 'none',
            }} />
          )
        })}

        {/* Day column separators */}
        {dates.map((date, i) => {
          const isTodayDate = date === today
          return (
            <div key={`sep-${date}`} style={{
              position: 'absolute', left: i * DAY_WIDTH, width: isTodayDate ? 2 : 1,
              top: 0, bottom: 0,
              background: isTodayDate ? 'var(--today-line)' : 'var(--border-subtle)',
              pointerEvents: 'none',
              opacity: isTodayDate ? 0.5 : 1,
            }} />
          )
        })}

        {/* Allotment background overlay (под бронями) */}
        {(room.allotments ?? []).flatMap(allot => {
          const segments = computeAllotmentSegments(allot, dateFrom, dates)
          return segments.map((seg, i) => (
            <div key={`allot-${allot.id}-${i}`} style={{
              position: 'absolute',
              left: seg.left * DAY_WIDTH,
              width: seg.width * DAY_WIDTH,
              top: 2, bottom: 2,
              background: hexWithAlpha(allot.partner.color, 0.14),
              borderTop: `2px solid ${allot.partner.color}`,
              borderBottom: `2px solid ${allot.partner.color}`,
              pointerEvents: 'none',
              zIndex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}>
              {seg.width * DAY_WIDTH > 70 && (
                <span style={{
                  color: allot.partner.color,
                  fontSize: Math.max(9, FONT_SIZE - 3),
                  fontWeight: 800,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  textShadow: '0 1px 0 rgba(255,255,255,0.6)',
                }}>
                  🅰 {allot.partner.name}
                </span>
              )}
            </div>
          ))
        })}

        {/* Drag selection overlay */}
        {selectionOverlay && (
          <div style={{
            position: 'absolute',
            left: selectionOverlay.left,
            width: selectionOverlay.width,
            top: 4, bottom: 4,
            background: 'var(--accent-bg)',
            border: '2px solid var(--accent)',
            borderRadius: 5,
            pointerEvents: 'none',
            zIndex: 3,
          }} />
        )}

        {/* Booking blocks */}
        {room.bookings.map((booking) => (
          <BookingBlock
            key={booking.id}
            booking={booking}
            dateFrom={dateFrom}
            today={today}
            onView={handleBookingView}
            onContextMenu={handleBookingContextMenu}
          />
        ))}
      </div>

      {/* Popup меню */}
      {pendingMenu && (
        <SelectionMenu
          roomId={pendingMenu.roomId}
          from={pendingMenu.from}
          checkOut={pendingMenu.checkOut}
          today={today}
          screenX={pendingMenu.screenX}
          screenY={pendingMenu.screenY}
          onClose={() => setPendingMenu(null)}
        />
      )}
    </div>
  )
}

// Мемоизация: строки, которые остаются в DOM при скролле, не перерисовываются
// (props row/dates/dateFrom/today стабильны между тиками виртуализатора).
export const GridRow = React.memo(GridRowImpl)

// ─── Helpers ─────────────────────────────────────────────────────────────────

const dayStr = (s: string) => s.slice(0, 10)
// Активные брони (как в findOverlap на сервере) — только они блокируют даты.
const isBlocking = (st: string) => st === 'CONFIRMED' || st === 'CHECKED_IN'

/**
 * Ограничивает выделение свободным окном вокруг точки старта (anchor — всегда
 * свободная ячейка). Выделение не может перекрыть активную бронь — упирается в
 * неё день-в-день: справа — до дня заезда брони (становится выездом), слева —
 * до дня выезда брони (становится заездом).
 */
function clampToFreeGap(
  anchor: string,
  rawFrom: string,
  rawTo: string,
  bookings: GridBooking[],
): { from: string; to: string } {
  let gapStart: string | null = null  // самая левая допустимая ячейка (выезд левой брони)
  let gapEnd:   string | null = null  // первая ЗАНЯТАЯ ячейка справа (заезд правой брони)

  for (const b of bookings) {
    if (!isBlocking(b.status)) continue
    const ci = dayStr(b.checkIn)
    const co = dayStr(b.checkOut)   // бронь занимает ячейки-ночи [ci .. co-1]
    if (co <= ci) continue          // нулевая длительность (точка) дат не блокирует
    if (co <= anchor) {
      if (gapStart === null || co > gapStart) gapStart = co
    } else if (ci > anchor) {
      if (gapEnd === null || ci < gapEnd) gapEnd = ci
    }
  }

  let from = rawFrom
  let to = rawTo
  if (gapStart !== null && from < gapStart) from = gapStart
  if (gapEnd !== null && to >= gapEnd) to = format(addDays(parseISO(gapEnd), -1), 'yyyy-MM-dd')
  return { from, to }
}

/** Возвращает сегменты аллокации (после вычета релизов) в "днях от dateFrom". */
function computeAllotmentSegments(
  allot: GridAllotment,
  gridDateFrom: string,
  dates: string[],
): { left: number; width: number }[] {
  if (dates.length === 0) return []
  const gridStart = parseISO(gridDateFrom)
  // Сетка покрывает dates.length дней начиная с gridDateFrom (exclusive end)
  const gridEnd = addDays(gridStart, dates.length)

  const aStart = parseISO(allot.dateFrom.slice(0, 10))
  const aEnd   = parseISO(allot.dateTo.slice(0, 10))

  const start = aStart > gridStart ? aStart : gridStart
  const end   = aEnd   < gridEnd   ? aEnd   : gridEnd
  if (start >= end) return []

  // Вычитаем релизы, пересекающиеся с visible range
  const releases = (allot.releases ?? [])
    .map(r => ({
      start: parseISO(r.dateFrom.slice(0, 10)),
      end:   parseISO(r.dateTo.slice(0, 10)),
    }))
    .filter(r => r.start < end && r.end > start)
    .sort((a, b) => a.start.getTime() - b.start.getTime())

  const segments: { from: Date; to: Date }[] = []
  let cursor = start
  for (const r of releases) {
    const rs = r.start < start ? start : r.start
    const re = r.end > end ? end : r.end
    if (rs > cursor) segments.push({ from: cursor, to: rs })
    if (re > cursor) cursor = re
  }
  if (cursor < end) segments.push({ from: cursor, to: end })

  return segments.map(seg => ({
    left:  differenceInCalendarDays(seg.from, gridStart),
    width: differenceInCalendarDays(seg.to, seg.from),
  }))
}

/** Конвертирует #RRGGBB в rgba с заданной прозрачностью. */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

