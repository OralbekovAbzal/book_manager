import React, { useMemo } from 'react'
import { format, parseISO } from 'date-fns'
import { ru } from 'date-fns/locale'
import { useGridSettings } from './GridSettingsContext'

interface Props {
  dates: string[]
  today: string
  /** Ширина вертикальной полосы прокрутки тела сетки — добавляется отступом справа,
   *  чтобы предельный scrollLeft шапки совпадал с телом (см. BookingGrid) */
  scrollbarWidth?: number
}

interface MonthGroup {
  label: string
  count: number
}

// 30 → 22 (12.09.2026): строка месяца — подпись, а не панель; экран стойки дороже.
const MONTH_ROW_H = 22

export const GridHeader: React.FC<Props> = ({ dates, today, scrollbarWidth = 0 }) => {
  const { DAY_WIDTH, ROOM_COL_WIDTH, HEADER_HEIGHT, FONT_SIZE } = useGridSettings()

  const monthGroups = useMemo<MonthGroup[]>(() => {
    const groups: MonthGroup[] = []
    for (const date of dates) {
      const label = format(parseISO(date), 'LLLL yyyy', { locale: ru })
      if (groups.length === 0 || groups[groups.length - 1].label !== label) {
        groups.push({ label, count: 1 })
      } else {
        groups[groups.length - 1].count++
      }
    }
    return groups
  }, [dates])

  const totalHeight = HEADER_HEIGHT + MONTH_ROW_H

  return (
    <div style={{
      position: 'sticky',
      top: 0,
      zIndex: 20,
      display: 'flex',
      flexDirection: 'column',
      minWidth: 'max-content',
      height: totalHeight,
      paddingRight: scrollbarWidth,
      background: 'var(--bg)',
      borderBottom: '1px solid var(--border)',
    }}>

      {/* ── Month row ──────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        height: MONTH_ROW_H,
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border-subtle)',
        minWidth: 'max-content',
      }}>
        {/* Sticky spacer над колонкой «Номер» (навигация перенесена в строку фильтров) */}
        <div style={{
          position: 'sticky', left: 0, zIndex: 30,
          width: ROOM_COL_WIDTH, flexShrink: 0,
          background: 'var(--surface)',
          borderRight: '1px solid var(--border)',
        }} />

        {/* Month labels */}
        {monthGroups.map((g, idx) => (
          <div key={idx} style={{
            width: g.count * DAY_WIDTH,
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRight: '1px solid var(--border-subtle)',
          }}>
            <span style={{
              fontSize: '0.85rem',
              fontWeight: 700,
              color: 'var(--text)',
              letterSpacing: '0.01em',
              textTransform: 'capitalize',
              whiteSpace: 'nowrap',
            }}>
              {g.label}
            </span>
          </div>
        ))}
      </div>

      {/* ── Day row ────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        height: HEADER_HEIGHT,
        background: 'var(--bg)',
        minWidth: 'max-content',
      }}>
        <div style={{
          position: 'sticky', left: 0, zIndex: 30,
          width: ROOM_COL_WIDTH, flexShrink: 0,
          background: 'var(--bg)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRight: '1px solid var(--border)',
        }}>
          <span style={{
            fontSize: '0.77rem', fontWeight: 700,
            color: 'var(--text-faint)',
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
          }}>
            Номер
          </span>
        </div>

        {dates.map((date) => {
          const d         = parseISO(date)
          const isToday   = date === today
          // День недели считаем как в GridRow/DateSummary — от полудня UTC.
          // parseISO даёт локальную полночь, и getUTCDay() в UTC+ сдвигал выходные на день назад.
          const dow       = new Date(date + 'T12:00:00Z').getUTCDay()
          const isWeekend = dow === 0 || dow === 6

          return (
            <div
              key={date}
              style={{
                width: DAY_WIDTH,
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'relative',
                background: isToday
                  ? 'var(--today-bg)'
                  : isWeekend
                  ? 'var(--weekend-bg)'
                  : 'transparent',
                borderRight: '1px solid var(--border-subtle)',
              }}
            >
              {isToday && (
                <div style={{
                  position: 'absolute',
                  bottom: 0, left: 0, right: 0,
                  height: 2,
                  background: 'var(--today-line)',
                }} />
              )}

              <span style={{
                fontSize: Math.max(9, FONT_SIZE - 4),
                color: isToday ? 'var(--accent-text)' : 'var(--text-faint)',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                lineHeight: 1,
                marginBottom: 3,
              }}>
                {format(d, 'EEE', { locale: ru })}
              </span>

              <span className="mono" style={{
                fontSize: isToday ? FONT_SIZE + 1 : FONT_SIZE,
                fontWeight: isToday ? 700 : 500,
                color: isToday ? 'var(--accent-text)' : isWeekend ? 'var(--text-faint)' : 'var(--text)',
                lineHeight: 1,
              }}>
                {format(d, 'd')}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
