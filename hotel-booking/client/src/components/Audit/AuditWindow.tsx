import React, { useEffect, useState, useCallback } from 'react'
import { fetchAuditSummary, type AuditSummary } from '../../api/audit'
import { fetchShifts, fetchCurrentShift, advanceToNextDay, OverdueCheckoutError, type Shift, type OverdueCheckout } from '../../api/shifts'
import { useGridStore } from '../../store/useGridStore'

type SidebarTab = 'today' | 'week' | 'month' | 'shifts'

const TAB_LABELS: Record<SidebarTab, string> = {
  today:  'Сегодня',
  week:   '7 дней',
  month:  'Месяц',
  shifts: 'Смены',
}

const TAB_ICONS: Record<SidebarTab, string> = {
  today:  '📊',
  week:   '📅',
  month:  '🗓️',
  shifts: '🔄',
}

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED:   'Подтверждена',
  CHECKED_IN:  'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED:   'Отменена',
  NO_SHOW:     'Не приехал',
}

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₸'

// Dates from @db.Date come back as UTC midnight (e.g. "2026-05-20T00:00:00.000Z").
// Always render with timeZone:'UTC' so local timezone can't shift the displayed day.

function formatDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
}

/** Day-of-week label in Russian */
function weekday(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'UTC' })
}

/** Is the given ISO date today (compared in UTC)? */
function isToday(iso: string) {
  const d = new Date(iso)
  const t = new Date()
  return d.getUTCFullYear() === t.getUTCFullYear() &&
    d.getUTCMonth()    === t.getUTCMonth() &&
    d.getUTCDate()     === t.getUTCDate()
}

// ─── Summary Card ─────────────────────────────────────────────────────────────

const SummaryCard: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = '#111827' }) => (
  <div style={{
    background: '#fff',
    border: '1px solid #e5e7eb',
    borderRadius: 10,
    padding: '16px 18px',
    flex: 1,
    minWidth: 0,
  }}>
    <div style={{ fontSize: '0.92rem', color: '#6b7280', marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: '1.54rem', fontWeight: 700, color }}>{value}</div>
  </div>
)

// ─── Period Summary ───────────────────────────────────────────────────────────

const PeriodSummary: React.FC<{ period: 'today' | 'week' | 'month'; shiftId?: number }> = ({ period, shiftId }) => {
  const [summary, setSummary] = useState<AuditSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    setError('')
    fetchAuditSummary(shiftId ? { shiftId } : { period })
      .then(setSummary)
      .catch(() => setError('Ошибка загрузки данных'))
      .finally(() => setLoading(false))
  }, [period, shiftId])

  if (loading) return <div style={{ color: '#6b7280', fontSize: '1rem', padding: 20 }}>Загрузка...</div>
  if (error) return <div style={{ color: '#dc2626', fontSize: '1rem', padding: 20 }}>{error}</div>
  if (!summary) return null

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <SummaryCard label="Выручка" value={fmt(summary.totalAmount)} color="#6366f1" />
        <SummaryCard label="Оплачено" value={fmt(summary.totalPaid)} color="#059669" />
        <SummaryCard label="Задолженность" value={fmt(summary.totalDebt)} color="#dc2626" />
      </div>

      {/* Count badge */}
      <div style={{ marginBottom: 16, fontSize: '1rem', color: '#6b7280' }}>
        Всего броней: <strong style={{ color: '#111827' }}>{summary.bookingCount}</strong>
      </div>

      {/* Status breakdown */}
      {summary.byStatus.length > 0 && (
        <div>
          <div style={{
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#9ca3af',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.06em',
            marginBottom: 10,
          }}>По статусам</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={{ textAlign: 'left', padding: '8px 0', fontSize: '0.92rem', color: '#6b7280', fontWeight: 600 }}>Статус</th>
                <th style={{ textAlign: 'right', padding: '8px 0', fontSize: '0.92rem', color: '#6b7280', fontWeight: 600 }}>Броней</th>
                <th style={{ textAlign: 'right', padding: '8px 0', fontSize: '0.92rem', color: '#6b7280', fontWeight: 600 }}>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {summary.byStatus.map((row) => (
                <tr key={row.status} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 0', fontSize: '1rem', color: '#111827' }}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </td>
                  <td style={{ padding: '10px 0', fontSize: '1rem', textAlign: 'right', color: '#374151' }}>
                    {row._count.id}
                  </td>
                  <td style={{ padding: '10px 0', fontSize: '1rem', textAlign: 'right', color: '#374151' }}>
                    {fmt(row._sum.totalAmount ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Shifts Panel ─────────────────────────────────────────────────────────────

const ShiftsPanel: React.FC = () => {
  const [currentShift, setCurrentShift] = useState<Shift | null>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [loading, setLoading] = useState(true)
  const [advancing, setAdvancing] = useState(false)
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [overdueCheckouts, setOverdueCheckouts] = useState<OverdueCheckout[]>([])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [cur, list] = await Promise.all([fetchCurrentShift(), fetchShifts()])
      setCurrentShift(cur)
      setShifts(list)
      // Re-check overdue when data refreshes
      setOverdueCheckouts([])
    } catch {
      setError('Ошибка загрузки данных')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleNextDay = async () => {
    if (!confirm('Перейти на следующий день? Текущий день будет зафиксирован в истории.')) return
    setAdvancing(true)
    setOverdueCheckouts([])
    setError('')
    try {
      await advanceToNextDay()
      await loadData()
      // Сдвигаем сетку и статистику на новый рабочий день
      await useGridStore.getState().fetchShiftDate()
      useGridStore.getState().fetchToday()
    } catch (err) {
      if (err instanceof OverdueCheckoutError) {
        setOverdueCheckouts(err.overdueCheckouts)
      } else {
        setError('Ошибка перехода на следующий день')
      }
    } finally {
      setAdvancing(false)
    }
  }

  if (loading) return <div style={{ color: '#6b7280', fontSize: '1rem', padding: 20 }}>Загрузка...</div>

  // history = all shifts except the current one
  const history = currentShift ? shifts.filter(s => s.id !== currentShift.id) : shifts

  return (
    <div>
      {error && (
        <div style={{ padding: '8px 12px', borderRadius: 6, background: '#fef2f2', color: '#dc2626', fontSize: '0.92rem', marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* Current day card */}
      <div style={{
        background: 'linear-gradient(135deg, #eef2ff 0%, #f0fdf4 100%)',
        border: '1px solid #c7d2fe',
        borderRadius: 14,
        padding: '20px 22px',
        marginBottom: 24,
      }}>
        <div style={{
          fontSize: '0.77rem',
          fontWeight: 700,
          color: '#6366f1',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.08em',
          marginBottom: 8,
        }}>
          Текущий рабочий день
        </div>

        {currentShift ? (
          <>
            <div style={{ fontSize: '1.69rem', fontWeight: 800, color: '#111827', marginBottom: 2 }}>
              {formatDate(currentShift.date)}
            </div>
            <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 16, textTransform: 'capitalize' as const }}>
              {weekday(currentShift.date)}
              {isToday(currentShift.date) && (
                <span style={{
                  marginLeft: 8,
                  fontSize: '0.77rem',
                  fontWeight: 700,
                  background: '#dcfce7',
                  color: '#15803d',
                  padding: '2px 7px',
                  borderRadius: 10,
                }}>Сегодня</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginBottom: 2 }}>Броней</div>
                <div style={{ fontSize: '1.38rem', fontWeight: 700, color: '#111827' }}>
                  {currentShift._count?.bookings ?? 0}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginBottom: 2 }}>Принял</div>
                <div style={{ fontSize: '1.08rem', fontWeight: 600, color: '#374151' }}>
                  {currentShift.createdBy.name}
                </div>
              </div>
            </div>

            {/* Revenue for current day */}
            <PeriodSummary period="today" shiftId={currentShift.id} />
          </>
        ) : (
          <div style={{ fontSize: '1.08rem', color: '#6b7280' }}>Нет данных о текущем дне</div>
        )}

        {/* Overdue checkout warning */}
        {overdueCheckouts.length > 0 && (
          <div style={{
            marginTop: 20,
            background: '#fff7ed',
            border: '1px solid #fed7aa',
            borderRadius: 10,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: '1.38rem' }}>⚠️</span>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: '#92400e' }}>
                  Невозможно перейти на следующий день
                </div>
                <div style={{ fontSize: '0.92rem', color: '#b45309' }}>
                  Следующие гости должны были выехать, но ещё не выселены:
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {overdueCheckouts.map(oc => (
                <div key={oc.id} style={{
                  background: '#fff',
                  border: '1px solid #fde68a',
                  borderRadius: 7,
                  padding: '8px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <div>
                    <span style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                      Номер {oc.room.number}
                    </span>
                    <span style={{ fontSize: '0.92rem', color: '#6b7280', marginLeft: 6 }}>
                      {oc.room.building}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 600, color: '#dc2626' }}>
                      Выезд: {formatDate(oc.checkOut)}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: '#6b7280' }}>{oc.guestName}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: '0.85rem', color: '#92400e', marginTop: 10 }}>
              Оформите выезд в сетке броней, затем повторите переход.
            </div>
          </div>
        )}

        {/* Next day button */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #e0e7ff' }}>
          <button
            onClick={handleNextDay}
            disabled={advancing || overdueCheckouts.length > 0}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              background: overdueCheckouts.length > 0 ? '#f3f4f6' : advancing ? '#e0e7ff' : '#6366f1',
              color: overdueCheckouts.length > 0 ? '#9ca3af' : advancing ? '#6366f1' : '#fff',
              border: overdueCheckouts.length > 0 ? '1px solid #e5e7eb' : 'none',
              borderRadius: 8,
              fontSize: '1.08rem',
              fontWeight: 700,
              cursor: (advancing || overdueCheckouts.length > 0) ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
            }}
          >
            <span style={{ fontSize: '1.23rem' }}>→</span>
            {advancing ? 'Переход...' : 'Следующий день'}
          </button>
          <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginTop: 6 }}>
            {overdueCheckouts.length > 0
              ? 'Сначала оформите выезд отмеченных гостей'
              : 'Зафиксирует текущий день и откроет новый'}
          </div>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <div style={{
            fontSize: '0.85rem',
            fontWeight: 700,
            color: '#9ca3af',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.06em',
            marginBottom: 10,
          }}>
            История дней
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map(s => {
              const expanded = expandedId === s.id
              return (
                <div
                  key={s.id}
                  style={{
                    background: expanded ? '#f8faff' : '#fff',
                    border: `1px solid ${expanded ? '#c7d2fe' : '#e5e7eb'}`,
                    borderRadius: 10,
                    overflow: 'hidden',
                    transition: 'border-color 0.15s',
                  }}
                >
                  <div
                    style={{
                      padding: '12px 16px',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                    onClick={() => setExpandedId(prev => prev === s.id ? null : s.id)}
                  >
                    <div>
                      <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>
                        {formatDate(s.date)}
                        <span style={{ fontSize: '0.92rem', color: '#9ca3af', fontWeight: 400, marginLeft: 8, textTransform: 'capitalize' as const }}>
                          {weekday(s.date)}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.85rem', color: '#6b7280', marginTop: 2 }}>
                        {s._count?.bookings ?? 0} броней · {s.createdBy.name}
                      </div>
                    </div>
                    <span style={{ color: '#9ca3af', fontSize: '0.92rem' }}>{expanded ? '▲' : '▼'}</span>
                  </div>

                  {expanded && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid #f3f4f6' }}>
                      <div style={{ height: 12 }} />
                      <PeriodSummary period="today" shiftId={s.id} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {history.length === 0 && !loading && (
        <div style={{ fontSize: '1rem', color: '#9ca3af', textAlign: 'center', paddingTop: 16 }}>
          История пока пуста — нажмите «Следующий день», чтобы начать вести учёт
        </div>
      )}
    </div>
  )
}

// ─── Main AuditWindow ─────────────────────────────────────────────────────────

interface AuditWindowProps {
  open: boolean
  onClose: () => void
}

export const AuditWindow: React.FC<AuditWindowProps> = ({ open, onClose }) => {
  const [activeTab, setActiveTab] = useState<SidebarTab>('today')

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const tabs: SidebarTab[] = ['today', 'week', 'month', 'shifts']

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        style={{
          width: '90vw',
          maxWidth: 1000,
          height: '88vh',
          background: '#fff',
          borderRadius: 14,
          display: 'flex',
          overflow: 'hidden',
          boxShadow: '0 25px 60px rgba(0,0,0,0.25)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left sidebar */}
        <div style={{
          width: 200,
          flexShrink: 0,
          borderRight: '1px solid #e5e7eb',
          background: '#f9fafb',
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 0',
        }}>
          <div style={{ padding: '0 16px 16px', fontSize: '1rem', fontWeight: 700, color: '#111827', borderBottom: '1px solid #e5e7eb', marginBottom: 8 }}>
            Аудит
          </div>
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '10px 16px',
                textAlign: 'left',
                border: 'none',
                background: activeTab === tab ? '#ede9fe' : 'transparent',
                color: activeTab === tab ? '#6366f1' : '#374151',
                fontWeight: activeTab === tab ? 700 : 400,
                fontSize: '1rem',
                cursor: 'pointer',
                borderRadius: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderLeft: activeTab === tab ? '3px solid #6366f1' : '3px solid transparent',
              }}
            >
              <span>{TAB_ICONS[tab]}</span>
              <span>{TAB_LABELS[tab]}</span>
            </button>
          ))}
        </div>

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Header */}
          <div style={{
            padding: '18px 24px',
            borderBottom: '1px solid #e5e7eb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <div style={{ fontSize: '1.23rem', fontWeight: 700, color: '#111827' }}>
              {TAB_ICONS[activeTab]} {TAB_LABELS[activeTab]}
            </div>
            <button onClick={onClose} style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.38rem',
              color: '#9ca3af',
              padding: '0 4px',
              lineHeight: 1,
            }}>✕</button>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
            {activeTab === 'today' && <PeriodSummary period="today" />}
            {activeTab === 'week'  && <PeriodSummary period="week" />}
            {activeTab === 'month' && <PeriodSummary period="month" />}
            {activeTab === 'shifts' && <ShiftsPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
