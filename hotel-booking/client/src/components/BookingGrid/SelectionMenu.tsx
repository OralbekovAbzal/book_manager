import React, { useEffect, useRef } from 'react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { useGridStore } from '../../store/useGridStore'

interface Props {
  roomId: number
  from: string
  checkOut: string
  today: string
  screenX: number
  screenY: number
  onClose: () => void
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

function fmtDate(d: string): string {
  const [, m, day] = d.split('-')
  return `${parseInt(day)} ${MONTHS[parseInt(m) - 1]}`
}

export const SelectionMenu: React.FC<Props> = ({
  roomId, from, checkOut, today, screenX, screenY, onClose,
}) => {
  const { openCreateModal, openMaintenanceModal } = useGridStore()
  const ref = useRef<HTMLDivElement>(null)

  const nights = differenceInCalendarDays(parseISO(checkOut), parseISO(from))
  const isPast     = from < today
  const canCheckIn = from === today && !isPast

  const x = Math.min(screenX, window.innerWidth - 220)
  const y = Math.min(screenY + 8, window.innerHeight - 200)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 50)
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const nightsLabel = nights === 1 ? '1 ночь' : nights < 5 ? `${nights} ночи` : `${nights} ночей`

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        background: 'var(--bg)',
        borderRadius: 10,
        boxShadow: 'var(--shadow-lg)',
        minWidth: 210,
        overflow: 'hidden',
        border: '1px solid var(--border)',
      }}
    >
      {/* Header with date range */}
      <div style={{
        padding: '12px 14px 10px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--surface)',
      }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>
          {fmtDate(from)} → {fmtDate(checkOut)}
        </div>
        <div style={{
          fontSize: '0.85rem',
          color: isPast ? 'var(--status-checked-out)' : 'var(--text-faint)',
          marginTop: 3, fontWeight: 500,
        }}>
          {isPast ? 'Прошедшие даты' : nightsLabel}
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ padding: '4px 0' }}>
        {canCheckIn ? (
          <MenuButton
            label="Заезд"
            accentVar="--status-checked-in"
            onClick={() => { openCreateModal(roomId, from, checkOut, true); onClose() }}
          />
        ) : (
          <MenuButton
            label="Заезд"
            accentVar="--status-checked-in"
            disabled
            hint={isPast ? 'Нельзя оформить заезд задним числом' : 'Только если дата заезда — сегодня'}
            onClick={() => {}}
          />
        )}

        <MenuButton
          label="Бронь"
          accentVar="--status-confirmed"
          disabled={isPast}
          hint={isPast ? 'Нельзя создавать бронь на прошедшие даты' : undefined}
          onClick={() => { openCreateModal(roomId, from, checkOut); onClose() }}
        />

        <MenuButton
          label="Ремонт"
          accentVar="--status-maintenance"
          onClick={() => { openMaintenanceModal(roomId, from, checkOut); onClose() }}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '4px 0' }}>
        <MenuButton label="Отмена" muted onClick={onClose} />
      </div>
    </div>
  )
}

interface MenuButtonProps {
  label: string
  accentVar?: string
  disabled?: boolean
  hint?: string
  muted?: boolean
  onClick: () => void
}

const MenuButton: React.FC<MenuButtonProps> = ({ label, accentVar, disabled, hint, muted, onClick }) => {
  const [hovered, setHovered] = React.useState(false)

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '9px 14px',
        background: hovered && !disabled ? 'var(--surface-2)' : 'transparent',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        textAlign: 'left',
        transition: 'background 0.1s',
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {accentVar && (
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: `var(${accentVar})`, flexShrink: 0,
        }} />
      )}
      <span style={{
        fontSize: '1rem', fontWeight: 600,
        color: muted ? 'var(--text-faint)' : 'var(--text)',
      }}>
        {label}
      </span>
    </button>
  )
}
