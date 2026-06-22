import React, { useMemo, useState } from 'react'
import { useGridSettings } from './GridSettingsContext'
import type { GridData } from '../../types'

interface Props {
  data: GridData
  dates: string[]
  today: string
}

interface DayStat { arr: number; dep: number; occ: number; free: number }

const day = (s: string) => s.slice(0, 10)
const isActive = (st: string) => st !== 'CANCELLED' && st !== 'NO_SHOW'

/** Считаем по-дневную сводку из реальных броней (а не выдуманные числа). */
function computeStats(data: GridData, dates: string[]): { stats: DayStat[]; totalRooms: number } {
  let totalRooms = 0
  const allBookings: { ci: string; co: string; st: string; maint: boolean }[] = []
  for (const cat of data.categories) {
    totalRooms += cat.rooms.length
    for (const room of cat.rooms) {
      for (const b of room.bookings) {
        if (!isActive(b.status)) continue
        allBookings.push({ ci: day(b.checkIn), co: day(b.checkOut), st: b.status, maint: b.source === 'ремонт' })
      }
    }
  }

  const stats = dates.map((d) => {
    let arr = 0, dep = 0, occ = 0, reserved = 0
    for (const b of allBookings) {
      const covers = b.ci <= d && d < b.co
      if (covers) reserved++                                    // номер занят бронью/ремонтом → не свободен
      if (b.ci === d && b.st === 'CONFIRMED' && !b.maint) arr++ // ожидаемый заезд: должен заехать, но ещё не заехал
      if (b.co === d && !b.maint) dep++                         // выезд в этот день
      if (b.st === 'CHECKED_IN' && covers) occ++                // проживает только фактически заехавший
    }
    return { arr, dep, occ, free: Math.max(0, totalRooms - reserved) }
  })
  return { stats, totalRooms }
}

const LEGEND: { key: keyof DayStat; label: string; color: string }[] = [
  { key: 'arr',  label: 'Заезды',    color: 'var(--s-confirmed)' },
  { key: 'dep',  label: 'Выезды',    color: 'var(--s-out)' },
  { key: 'occ',  label: 'Проживает', color: 'var(--s-in)' },
  { key: 'free', label: 'Свободно',  color: 'var(--text-faint)' },
]

// Высоты строк должны совпадать слева (легенда) и в колонках дней (числа),
// иначе числа «уезжают» относительно подписей.
const HEADER_H = 26      // высота кнопки-заголовка «Сводка по датам»
const LEGEND_ROW_H = 18  // высота одной строки метрики

export const DateSummary: React.FC<Props> = ({ data, dates, today }) => {
  const { DAY_WIDTH, ROOM_COL_WIDTH, FONT_SIZE } = useGridSettings()
  const [open, setOpen] = useState(true)
  const { stats } = useMemo(() => computeStats(data, dates), [data, dates])

  return (
    <div style={{
      position: 'sticky', bottom: 0, zIndex: 15,
      display: 'flex', minWidth: 'max-content',
      background: 'var(--surface)',
      borderTop: '1px solid var(--border)',
      boxShadow: '0 -4px 12px rgba(0,0,0,0.06)',
    }}>
      {/* Sticky left column */}
      <div style={{
        position: 'sticky', left: 0, zIndex: 16,
        width: ROOM_COL_WIDTH, flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
      }}>
        <button
          onClick={() => setOpen(o => !o)}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            height: HEADER_H, padding: '0 14px', border: 'none', background: 'transparent',
            cursor: 'pointer', color: 'var(--text-muted)', fontFamily: 'inherit',
            fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.08em',
            textTransform: 'uppercase', textAlign: 'left',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: open ? 'none' : 'rotate(180deg)', transition: 'transform 0.15s', flexShrink: 0 }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
          Сводка по датам
        </button>
        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>
            {LEGEND.map(l => (
              <div key={l.key} style={{
                display: 'flex', alignItems: 'center', gap: 8, height: LEGEND_ROW_H, padding: '0 14px',
              }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: l.color, flexShrink: 0 }} />
                <span style={{ fontSize: Math.max(9, FONT_SIZE - 3), color: 'var(--text-muted)' }}>{l.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-day columns */}
      <div style={{ display: 'flex', minWidth: 'max-content' }}>
        {dates.map((d, i) => {
          const s = stats[i]
          const dow = new Date(d + 'T12:00:00Z').getUTCDay()
          const isWeekend = dow === 0 || dow === 6
          const isToday = d === today
          const bg = isToday ? 'var(--today-bg)' : isWeekend ? 'var(--weekend-bg)' : 'transparent'

          return (
            <div key={d} style={{
              width: DAY_WIDTH, flexShrink: 0, position: 'relative',
              background: bg, borderRight: '1px solid var(--border-subtle)',
              display: 'flex', flexDirection: 'column', alignItems: 'center',
            }}>
              {isToday && <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: 'var(--today-line)' }} />}
              {/* Отступ под высоту шапки слева — чтобы числа встали ровно на строки легенды */}
              <div style={{ height: HEADER_H }} />
              {open && LEGEND.map(l => {
                const v = s[l.key]
                const isFree = l.key === 'free'
                const positive = v > 0
                const color = isFree
                  ? (v <= 1 ? 'var(--s-overdue)' : 'var(--text)')
                  : (positive ? l.color : 'var(--text-faint)')
                return (
                  <div key={l.key} style={{ height: LEGEND_ROW_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="mono" style={{
                      fontSize: 11.5, lineHeight: 1,
                      fontWeight: isFree || positive ? 700 : 400,
                      color,
                    }}>{v}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
