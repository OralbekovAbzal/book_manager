import React, { useEffect, useRef, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'
import { useAuthStore } from '../../store/useAuthStore'

const MENU_WIDTH = 180

export const BookingContextMenu: React.FC = () => {
  const { contextMenu, closeContextMenu, openEditModal, openDeleteConfirm } = useGridStore()
  const role = useAuthStore(s => s.admin?.role)
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
  // ни отменять — пункты не показываем. Отмена заселённого гостя — только администраторам (403).
  const isClosed = ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(booking.status)
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const canEdit = !isClosed
  const canDelete = !isClosed && (booking.status !== 'CHECKED_IN' || isAdmin)

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
          onClick={() => openEditModal(booking)}
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
