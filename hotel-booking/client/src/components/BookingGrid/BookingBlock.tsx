import React, { useState, useRef, useMemo } from 'react'
import { differenceInCalendarDays, parseISO, addDays, format } from 'date-fns'
import { getBookingLabel, getBlockGeometry, getBookingStatusVar } from './utils'
import { useGridSettings } from './GridSettingsContext'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import type { GridBooking, GridData } from '../../types'

interface Props {
  booking: GridBooking
  dateFrom: string
  today: string
  /** Двойной левый клик — открыть просмотр (только чтение) */
  onView: (booking: GridBooking) => void
  /** Правый клик — контекстное меню (Редактировать / Удалить) */
  onContextMenu: (booking: GridBooking, x: number, y: number) => void
}

interface DragState {
  active: boolean
  cursorX: number
  cursorY: number
  ghostScreenX: number       // snap-to-grid X (последняя ВАЛИДНАЯ позиция)
  ghostScreenY: number       // snap-to-row Y (последняя ВАЛИДНАЯ позиция)
  targetRoomId: number       // последний валидный target
  targetDate: string
  targetCheckOut: string
  hoverInvalid: boolean      // курсор сейчас над невалидной зоной (collision / вне сетки)
}

const DRAG_THRESHOLD = 5

/**
 * Шеврон (мыс слева и справа) с мягко скруглённым, а не острым, кончиком.
 * Геометрия — 1:1 с дизайн-хендоффом (taper=7px), меняется только то, как
 * рисуется сам кончик: вместо одной острой вершины — квадратичная кривая,
 * идущая от точки на скошенном ребре ДО кончика (control point — сам
 * исходный острый угол) к симметричной точке ПОСЛЕ кончика.
 */
function roundedChevronPath(w: number, h: number, taper: number, round: number): string {
  const halfH = h / 2
  const edgeLen = Math.sqrt(taper * taper + halfH * halfH) || 1
  const rx = (round * taper) / edgeLen
  const ry = (round * halfH) / edgeLen
  const n = (v: number) => Math.round(v * 100) / 100

  return `path('M ${n(taper)} 0 ` +
    `L ${n(w - taper)} 0 ` +
    `L ${n(w - rx)} ${n(halfH - ry)} ` +
    `Q ${n(w)} ${n(halfH)} ${n(w - rx)} ${n(halfH + ry)} ` +
    `L ${n(w - taper)} ${n(h)} ` +
    `L ${n(taper)} ${n(h)} ` +
    `L ${n(rx)} ${n(halfH + ry)} ` +
    `Q 0 ${n(halfH)} ${n(rx)} ${n(halfH - ry)} ` +
    `Z')`
}

/** Две брони пересекаются, если их интервалы [checkIn, checkOut) перекрываются */
function hasCollision(
  data: GridData | null,
  roomId: number,
  checkIn: string,
  checkOut: string,
  excludeBookingId: number,
): boolean {
  if (!data) return false
  for (const cat of data.categories) {
    for (const room of cat.rooms) {
      if (room.id !== roomId) continue
      for (const b of room.bookings) {
        if (b.id === excludeBookingId) continue
        const bIn  = b.checkIn.slice(0, 10)
        const bOut = b.checkOut.slice(0, 10)
        // Стандартная проверка пересечения интервалов:
        if (checkIn < bOut && bIn < checkOut) return true
      }
      return false
    }
  }
  return false
}

export const BookingBlock: React.FC<Props> = ({ booking, dateFrom, today, onView, onContextMenu }) => {
  const [hovered, setHovered] = useState(false)
  const [drag, setDrag] = useState<DragState | null>(null)
  const { DAY_WIDTH, ROW_HEIGHT, BLOCK_PADDING, FONT_SIZE } = useGridSettings()
  const { openEditModal, openMoveModal, data } = useGridStore()
  const { roomFund } = useSettingsStore()

  // Собираем человекочитаемые метки
  const flagLabels = useMemo(() => {
    const flags = booking.flags ?? []
    if (flags.length === 0) return []
    const knownMap = new Map((roomFund.bookingFlags ?? []).map(f => [f.id, f.label]))
    return flags.map(f => knownMap.get(f) ?? f)
  }, [booking.flags, roomFund.bookingFlags])

  const hasFlags = flagLabels.length > 0

  // ─── Правила drag по статусу ──────────────────────────────────────────
  // CONFIRMED        — полный drag (дата и комната)
  // CHECKED_IN       — drag разрешён → открывает модал «Переезд» (комната + дата переезда)
  // CHECKED_OUT      — нельзя двигать (закрытая бронь)
  // CANCELLED/NO_SHOW — нельзя двигать
  const isCheckedIn   = booking.status === 'CHECKED_IN'
  const isImmutable   = booking.status === 'CHECKED_OUT' ||
                        booking.status === 'CANCELLED'  ||
                        booking.status === 'NO_SHOW'
  const dragEnabled   = !isImmutable

  const startRef = useRef<{
    x: number; y: number; offsetX: number
    initialGhostX: number; initialGhostY: number
  } | null>(null)
  const dragRef  = useRef<DragState | null>(null)
  const dataRef  = useRef<GridData | null>(data)
  dataRef.current = data

  const updateDrag = (s: DragState | null) => {
    dragRef.current = s
    setDrag(s)
  }

  const duration = differenceInCalendarDays(
    parseISO(booking.checkOut.slice(0, 10)),
    parseISO(booking.checkIn.slice(0, 10)),
  )

  const { left, width, visible, isPoint } = getBlockGeometry(booking, dateFrom, DAY_WIDTH, BLOCK_PADDING)
  if (!visible) return null

  const colorVar = getBookingStatusVar(booking)
  const label    = getBookingLabel(booking)
  void today

  // Штриховка поверх цвета когда есть метки
  const stripeOverlay = hasFlags
    ? 'repeating-linear-gradient(-45deg, rgba(0,0,0,0) 0px, rgba(0,0,0,0) 5px, rgba(0,0,0,0.18) 5px, rgba(0,0,0,0.18) 7px)'
    : undefined

  const blockHeight = ROW_HEIGHT - BLOCK_PADDING * 4 - 4

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()

    // Закрытые брони — не перетаскиваются. Просмотр/меню — через dblclick / правый клик.
    if (!dragEnabled) return

    const blockRect = e.currentTarget.getBoundingClientRect()
    const offsetX   = e.clientX - blockRect.left

    startRef.current = {
      x: e.clientX, y: e.clientY,
      offsetX,
      initialGhostX: blockRect.left,
      initialGhostY: blockRect.top,
    }
    dragRef.current = null

    const onMove = (ev: MouseEvent) => {
      const start = startRef.current
      if (!start) return

      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const distance = Math.hypot(dx, dy)

      if (!dragRef.current?.active && distance < DRAG_THRESHOLD) return

      // ─── Найти target row под курсором ─────────────────────────────
      const el = document.elementFromPoint(ev.clientX, ev.clientY)
      const areaEl = el?.closest('[data-booking-area="1"]') as HTMLElement | null

      let proposed: {
        roomId: number; date: string; checkOut: string
        ghostX: number; ghostY: number
      } | null = null

      if (areaEl) {
        const roomIdStr    = areaEl.getAttribute('data-room-id') || ''
        const areaDateFrom = areaEl.getAttribute('data-date-from') || dateFrom
        const areaRect     = areaEl.getBoundingClientRect()

        if (roomIdStr) {
          // X-координата левого края блока с учётом offset внутри блока
          const blockLeftX = ev.clientX - start.offsetX
          const naturalAtDay0 = DAY_WIDTH / 2 + BLOCK_PADDING
          let dayOffset = Math.round(
            (blockLeftX - areaRect.left - naturalAtDay0) / DAY_WIDTH
          )

          const roomId = parseInt(roomIdStr, 10)
          let date: string
          let checkOut: string

          if (isCheckedIn) {
            // CHECKED_IN: targetDate = moveDate, clamp в [checkIn, checkOut-1]
            const origCheckIn  = booking.checkIn.slice(0, 10)
            const origCheckOut = booking.checkOut.slice(0, 10)
            const maxMove      = format(addDays(parseISO(origCheckOut), -1), 'yyyy-MM-dd')

            let proposedDate = format(addDays(parseISO(areaDateFrom), dayOffset), 'yyyy-MM-dd')
            if (proposedDate < origCheckIn) proposedDate = origCheckIn
            if (proposedDate > maxMove)     proposedDate = maxMove

            date     = proposedDate
            checkOut = origCheckOut

            // пересчитываем dayOffset из clamped даты — чтобы ghost снапился корректно
            dayOffset = differenceInCalendarDays(parseISO(date), parseISO(areaDateFrom))
          } else {
            // CONFIRMED: обычный перенос — длительность сохраняется
            date     = format(addDays(parseISO(areaDateFrom), dayOffset), 'yyyy-MM-dd')
            checkOut = format(addDays(parseISO(date),         duration), 'yyyy-MM-dd')
          }

          proposed = {
            roomId, date, checkOut,
            ghostX: areaRect.left + dayOffset * DAY_WIDTH + naturalAtDay0,
            ghostY: areaRect.top  + BLOCK_PADDING * 2 + 2,
          }
        }
      }

      // ─── Проверить коллизию ─────────────────────────────────────────
      const valid = proposed
        ? !hasCollision(dataRef.current, proposed.roomId, proposed.date, proposed.checkOut, booking.id)
        : false

      const prev = dragRef.current

      if (valid && proposed) {
        // Новая валидная позиция — обновляем ghost
        updateDrag({
          active: true,
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          ghostScreenX:   proposed.ghostX,
          ghostScreenY:   proposed.ghostY,
          targetRoomId:   proposed.roomId,
          targetDate:     proposed.date,
          targetCheckOut: proposed.checkOut,
          hoverInvalid:   false,
        })
      } else if (prev) {
        // Невалидно — оставляем ghost на последней валидной позиции
        updateDrag({
          ...prev,
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          hoverInvalid: true,
        })
      } else {
        // Первое движение и сразу невалидно — ghost остаётся в исходной позиции
        updateDrag({
          active: true,
          cursorX: ev.clientX,
          cursorY: ev.clientY,
          ghostScreenX:   start.initialGhostX,
          ghostScreenY:   start.initialGhostY,
          targetRoomId:   booking.roomId,
          targetDate:     booking.checkIn.slice(0, 10),
          targetCheckOut: booking.checkOut.slice(0, 10),
          hoverInvalid:   true,
        })
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)

      const start = startRef.current
      const dropInfo = dragRef.current
      startRef.current = null
      updateDrag(null)

      if (!start) return

      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      const wasDragging = dropInfo?.active === true || Math.hypot(dx, dy) > DRAG_THRESHOLD

      // Одиночный клик больше ничего не открывает (просмотр — dblclick, меню — правый клик)
      if (!wasDragging) return

      // Drop на валидной позиции, отличной от исходной
      if (dropInfo) {
        const origCheckIn = booking.checkIn.slice(0, 10)
        const changedRoom = dropInfo.targetRoomId !== booking.roomId
        const changedDate = dropInfo.targetDate   !== origCheckIn

        // CHECKED_IN — переезд гостя (открывается MoveBookingModal)
        if (isCheckedIn) {
          if (changedRoom) {
            // moveDate — это та дата, куда уронили блок (но не раньше checkIn, не позже checkOut-1)
            const origCheckOut = booking.checkOut.slice(0, 10)
            let moveDate = dropInfo.targetDate
            if (moveDate < origCheckIn) moveDate = origCheckIn
            // максимально допустимая moveDate — день до checkOut
            const maxMoveDate = format(addDays(parseISO(origCheckOut), -1), 'yyyy-MM-dd')
            if (moveDate > maxMoveDate) moveDate = maxMoveDate
            openMoveModal(booking, dropInfo.targetRoomId, moveDate)
            return
          }
          // Тот же номер — для CHECKED_IN ничего не делаем (дата заезда фиксирована)
          return
        }

        // CONFIRMED — обычный перенос брони (edit-модал)
        if (changedRoom || changedDate) {
          openEditModal({
            ...booking,
            roomId:   dropInfo.targetRoomId,
            checkIn:  dropInfo.targetDate,
            checkOut: dropInfo.targetCheckOut,
          })
          return
        }
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const isDragging = drag?.active === true

  // ─── Point-блок (заезд и выезд в один день) ─────────────────────────
  // Компактный ромб по центру дня. Не перетаскивается. Только клик для просмотра.
  if (isPoint) {
    const pointSize = Math.min(width, blockHeight)
    const topOffset = (blockHeight - pointSize) / 2 + BLOCK_PADDING * 2 + 2
    const leftOffset = left + (width - pointSize) / 2

    return (
      <div
        role="button"
        tabIndex={0}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          e.preventDefault()
        }}
        onDoubleClick={(e) => { e.stopPropagation(); onView(booking) }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(booking, e.clientX, e.clientY) }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={`${booking.guestName}\nЗаезд и выезд: ${booking.checkIn.slice(0, 10)}`}
        style={{
          position: 'absolute',
          left: leftOffset,
          top:  topOffset,
          width:  pointSize,
          height: pointSize,
          background: `var(${colorVar})`,
          clipPath: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)',
          cursor: 'pointer',
          filter: hovered
            ? 'drop-shadow(0 2px 5px rgba(0,0,0,0.22)) brightness(1.10)'
            : 'drop-shadow(0 1px 2px rgba(0,0,0,0.18))',
          transform: hovered ? 'scale(1.12)' : 'none',
          transformOrigin: 'center',
          transition: 'filter 0.15s, transform 0.15s',
          zIndex: hovered ? 2 : 1,
        }}
      />
    )
  }

  // Треугольные мысы по краям — фиксированные 7px (1:1 с дизайн-хендоффом).
  // Кончик мыса скруглён (round=3px) — острая вершина смотрелась грубовато.
  const taperPx = 7
  const clipPath = roundedChevronPath(width, blockHeight, taperPx, 3)
  // padding учитывает обрезаемые мысы — текст не должен наезжать на скос
  const padX = taperPx + 6

  return (
    <>
      {/* Original block */}
      <div
        role="button"
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onDoubleClick={(e) => { e.stopPropagation(); onView(booking) }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(booking, e.clientX, e.clientY) }}
        onKeyDown={(e) => e.key === 'Enter' && onView(booking)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={`${booking.guestName}\n${booking.checkIn.slice(0, 10)} → ${booking.checkOut.slice(0, 10)}\n\nДвойной клик — просмотр · Правый клик — меню · Перетащите чтобы перенести`}
        style={{
          position: 'absolute',
          left: left + BLOCK_PADDING,
          width,
          top: BLOCK_PADDING * 2 + 2,
          height: blockHeight,
          background: `var(${colorVar})`,
          clipPath,
          cursor: isDragging ? 'grabbing' : 'grab',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'center',
          paddingLeft: padX,
          paddingRight: padX,
          filter: hovered && !isDragging
            ? `drop-shadow(0 2px 4px rgba(0,0,0,0.18)) brightness(1.08)`
            : isDragging
            ? 'none'
            : `drop-shadow(0 1px 2px rgba(0,0,0,0.15))`,
          transform: hovered && !isDragging ? 'translateY(-1px)' : 'none',
          transition: 'filter 0.15s, transform 0.15s, opacity 0.1s',
          opacity: isDragging ? 0.35 : 1,
          zIndex: hovered ? 2 : 1,
        }}
      >
        {/* Штриховка поверх блока при наличии меток */}
        {hasFlags && (
          <div style={{
            position: 'absolute', inset: 0,
            background: stripeOverlay,
            pointerEvents: 'none',
          }} />
        )}

        <span style={{
          fontSize: Math.max(10, FONT_SIZE - 1),
          fontWeight: 600,
          color: '#ffffff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          userSelect: 'none',
          letterSpacing: '-0.005em',
          pointerEvents: 'none',
          position: 'relative',
          maxWidth: '100%',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
        }}>
          {booking.partner && (
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '1px 5px',
              borderRadius: 3,
              background: 'rgba(255,255,255,0.92)',
              color: booking.partner.color,
              fontSize: Math.max(8, FONT_SIZE - 3),
              fontWeight: 800,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              flexShrink: 0,
            }}>
              🅰 {booking.partner.name}
            </span>
          )}
          {label}
        </span>

        {hasFlags && (
          <span style={{
            fontSize: Math.max(8, FONT_SIZE - 3),
            fontWeight: 500,
            color: 'rgba(255,255,255,0.88)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            userSelect: 'none',
            pointerEvents: 'none',
            position: 'relative',
            maxWidth: '100%',
            lineHeight: 1.2,
          }}>
            {flagLabels.join(' · ')}
          </span>
        )}
      </div>

      {/* Ghost — snap to grid */}
      {isDragging && drag && (
        <div
          style={{
            position: 'fixed',
            left: drag.ghostScreenX,
            top:  drag.ghostScreenY,
            width,
            height: blockHeight,
            background: `var(${colorVar})`,
            clipPath,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingLeft: padX,
            paddingRight: padX,
            overflow: 'hidden',
            filter: 'drop-shadow(0 6px 14px rgba(0,0,0,0.25)) drop-shadow(0 2px 4px rgba(0,0,0,0.18))',
            pointerEvents: 'none',
            zIndex: 9999,
            transition: 'left 0.13s cubic-bezier(0.2, 0.8, 0.2, 1), top 0.13s cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        >
          {hasFlags && (
            <div style={{ position: 'absolute', inset: 0, background: stripeOverlay, pointerEvents: 'none' }} />
          )}
          <span style={{
            fontSize: Math.max(10, FONT_SIZE - 1),
            fontWeight: 600, color: '#ffffff',
            whiteSpace: 'nowrap', overflow: 'hidden',
            textOverflow: 'ellipsis', userSelect: 'none',
            position: 'relative',
          }}>
            {label}
          </span>
        </div>
      )}

      {/* Tooltip — показывает финальные даты + статус (валидно / занято) */}
      {isDragging && drag && (
        <div
          style={{
            position: 'fixed',
            left: drag.cursorX + 16,
            top:  drag.cursorY + 16,
            background: drag.hoverInvalid ? 'var(--status-overdue)' : 'var(--text)',
            color: 'var(--bg)',
            padding: '6px 10px',
            borderRadius: 6,
            fontSize: '0.92rem',
            fontWeight: 600,
            pointerEvents: 'none',
            zIndex: 10000,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}
        >
          {drag.hoverInvalid
            ? 'Занято'
            : `${drag.targetDate} → ${drag.targetCheckOut}`
          }
        </div>
      )}
    </>
  )
}
