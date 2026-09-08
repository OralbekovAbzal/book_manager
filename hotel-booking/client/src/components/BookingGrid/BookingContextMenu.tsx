import React, { useEffect, useRef, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'

const MENU_WIDTH = 180

export const BookingContextMenu: React.FC = () => {
  const {
    contextMenu, closeContextMenu, openEditModal, openDeleteConfirm, currentSegment,
  } = useGridStore()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // Удерживаем меню в пределах окна
  useEffect(() => {
    if (!contextMenu) { setPos(null); return }
    const margin = 8
    const el = ref.current
    const h = el?.offsetHeight ?? 96
    const x = Math.min(contextMenu.x, window.innerWidth - MENU_WIDTH - margin)
    const y = Math.min(contextMenu.y, window.innerHeight - h - margin)
    setPos({ x: Math.max(margin, x), y: Math.max(margin, y) })
  }, [contextMenu])

  useEffect(() => {
    if (!contextMenu) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeContextMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeContextMenu() }
    const onScroll = () => closeContextMenu()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [contextMenu, closeContextMenu])

  if (!contextMenu) return null

  const booking = contextMenu.booking

  // Закрытые брони сервер не даёт ни редактировать («Нельзя редактировать закрытую бронь»),
  // ни отменять — пункты не показываем.
  // Исключение: у CHECKED_OUT можно поправить фактическое время заезда/выезда
  // (единственное, что форма позволит изменить у закрытой брони) — открываем «Редактировать».
  // Роль не спрашиваем: ролей две, и обе администраторские (interface.md, 2026-09-08).
  const isClosed = ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(booking.status)
  const canEdit = !isClosed || booking.status === 'CHECKED_OUT'
  // Продолжение переезда отменить нельзя: сервер отвечает 400 «Продолжение брони
  // отменить нельзя — оформите выезд» (data-and-money.md). Пункт, который всегда
  // кончается ошибкой, не показываем — выезд оформляют из формы брони.
  const canDelete = !isClosed && booking.accountBookingId == null

  return (
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        left: pos?.x ?? contextMenu.x,
        top: pos?.y ?? contextMenu.y,
        width: MENU_WIDTH,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: 'var(--shadow-lg)',
        zIndex: 600,
        padding: 4,
        // до измерения позиции прячем, чтобы не было прыжка
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {canEdit && (
        <MenuItem
          label="Редактировать"
          icon="✎"
          // У головы цепочки после переезда правится ТЕКУЩИЙ отрезок: сама она
          // закрыта, и форма закрытой брони почти ничего не даёт изменить.
          onClick={() => openEditModal(currentSegment(booking))}
        />
      )}
      {canDelete && (
        <MenuItem
          label="Удалить"
          icon="🗑"
          danger
          onClick={() => openDeleteConfirm(booking)}
        />
      )}
      {!canEdit && !canDelete && (
        <div style={{ padding: '9px 12px', fontSize: '0.9rem', color: 'var(--text-faint)' }}>
          Бронь закрыта
        </div>
      )}
    </div>
  )
}

const MenuItem: React.FC<{
  label: string; icon: string; danger?: boolean; onClick: () => void
}> = ({ label, icon, danger, onClick }) => {
  const [hover, setHover] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '9px 12px', border: 'none', borderRadius: 6,
        background: hover ? (danger ? '#fef2f2' : 'var(--surface-2)') : 'transparent',
        color: danger ? '#dc2626' : 'var(--text)',
        fontSize: '0.95rem', fontWeight: 500, cursor: 'pointer', textAlign: 'left',
      }}
    >
      <span style={{ width: 16, textAlign: 'center', opacity: 0.85 }}>{icon}</span>
      {label}
    </button>
  )
}
