import React, { useMemo } from 'react'
import { useGridStore } from '../../store/useGridStore'

const day = (s: string) => s.slice(0, 10)
const isActive = (st: string) => st !== 'CANCELLED' && st !== 'NO_SHOW'

const LEGEND = [
  { label: 'Заезды',    color: 'var(--s-confirmed)' },
  { label: 'Выезды',    color: 'var(--s-out)' },
  { label: 'Проживает', color: 'var(--s-in)' },
  { label: 'Свободно',  color: 'var(--text-faint)' },
]

export const StatusBar: React.FC = () => {
  const { data, shiftDate } = useGridStore()

  const { occ, total } = useMemo(() => {
    if (!data) return { occ: 0, total: 0 }
    const d = shiftDate ?? data.today
    let total = 0, occ = 0
    for (const cat of data.categories) {
      for (const room of cat.rooms) {
        total++
        if (room.bookings.some(b => isActive(b.status) && day(b.checkIn) <= d && d < day(b.checkOut))) occ++
      }
    }
    return { occ, total }
  }, [data, shiftDate])

  const pct = total > 0 ? Math.round((occ / total) * 100) : 0

  return (
    <footer style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      height: 30, flexShrink: 0, padding: '0 16px',
      background: 'var(--surface)', borderTop: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          Сводка по датам
        </span>
        {LEGEND.map(l => (
          <span key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Загрузка</span>
        <span className="mono" style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>{occ} / {total}</span>
        <div style={{ width: 90, height: 6, borderRadius: 3, background: 'var(--surface-3)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
        </div>
      </div>
    </footer>
  )
}
