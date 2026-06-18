import React, { useEffect, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'
import { cancelBooking } from '../../api/bookings'

const fmtDate = (iso?: string) => {
  if (!iso) return ''
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })
}

export const DeleteBookingDialog: React.FC = () => {
  const { deleteTarget, closeDeleteConfirm, fetchGrid, fetchToday } = useGridStore()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!deleteTarget) return
    setError('')
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) closeDeleteConfirm() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [deleteTarget, submitting, closeDeleteConfirm])

  if (!deleteTarget) return null

  const handleDelete = async () => {
    setSubmitting(true)
    setError('')
    try {
      await cancelBooking(deleteTarget.id)
      closeDeleteConfirm()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch {
      setError('Не удалось удалить бронь')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) closeDeleteConfirm() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '90vw', maxWidth: 420,
        background: 'var(--bg)', color: 'var(--text)',
        borderRadius: 12, border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', padding: 24,
      }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: '#fef2f2', color: '#dc2626',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem',
          }}>🗑</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: 6 }}>
              Удалить бронь?
            </div>
            <div style={{ fontSize: '0.95rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Бронь <strong style={{ color: 'var(--text)' }}>{deleteTarget.guestName}</strong>
              {' '}({fmtDate(deleteTarget.checkIn)} → {fmtDate(deleteTarget.checkOut)})
              {' '}будет удалена. Это действие нельзя отменить.
            </div>
          </div>
        </div>

        {error && (
          <div style={{ color: '#dc2626', fontSize: '0.92rem', marginTop: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button onClick={closeDeleteConfirm} disabled={submitting} style={secondaryBtnStyle}>
            Отмена
          </button>
          <button onClick={handleDelete} disabled={submitting} style={dangerBtnStyle}>
            {submitting ? 'Удаление…' : 'Удалить'}
          </button>
        </div>
      </div>
    </div>
  )
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}

const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: '#dc2626', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
