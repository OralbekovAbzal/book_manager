import React, { useEffect, useState, useCallback } from 'react'
import { fetchAuditSummary, fetchAuditLog, type AuditSummary, type AuditLogParams } from '../../api/audit'
import { fetchShifts, fetchCurrentShift, advanceToNextDay, OverdueCheckoutError, type Shift, type OverdueCheckout } from '../../api/shifts'
import { fetchUsers } from '../../api/users'
import { useGridStore } from '../../store/useGridStore'
import { useAuthStore } from '../../store/useAuthStore'
import type { AuditLogEntry, User } from '../../types'

// Окно целиком на токенах темы (var(--bg), var(--text) …): раньше было
// захардкожено на #fff/#e5e7eb и в тёмной теме висело белым пятном.

type SidebarTab = 'today' | 'week' | 'month' | 'shifts' | 'actions'

const TAB_LABELS: Record<SidebarTab, string> = {
  today:   'Сегодня',
  week:    '7 дней',
  month:   'Месяц',
  shifts:  'Смены',
  actions: 'Действия',
}

const TAB_ICONS: Record<SidebarTab, string> = {
  today:   '📊',
  week:    '📅',
  month:   '🗓️',
  shifts:  '🔄',
  actions: '📝',
}

// Подписи блоков («По статусам», «История дней»)
const captionStyle: React.CSSProperties = {
  fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-faint)',
  textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
}
const mutedText: React.CSSProperties = { color: 'var(--text-faint)', fontSize: '1rem', padding: 20 }
const errorText: React.CSSProperties = { color: 'var(--s-overdue)', fontSize: '1rem', padding: 20 }

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

const SummaryCard: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color = 'var(--text)' }) => (
  <div style={{
    background: 'var(--surface)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 10,
    padding: '16px 18px',
    flex: 1,
    minWidth: 0,
  }}>
    <div style={{ fontSize: '0.92rem', color: 'var(--text-faint)', marginBottom: 6 }}>{label}</div>
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

  if (loading) return <div style={mutedText}>Загрузка...</div>
  if (error) return <div style={errorText}>{error}</div>
  if (!summary) return null

  const th: React.CSSProperties = { padding: '8px 0', fontSize: '0.92rem', color: 'var(--text-faint)', fontWeight: 600 }

  return (
    <div>
      {/* Summary cards */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
        <SummaryCard label="Выручка" value={fmt(summary.totalAmount)} color="var(--accent)" />
        <SummaryCard label="Оплачено" value={fmt(summary.totalPaid)} color="var(--s-in)" />
        <SummaryCard label="Задолженность" value={fmt(summary.totalDebt)} color="var(--s-overdue)" />
      </div>

      {/* Count badge */}
      <div style={{ marginBottom: 16, fontSize: '1rem', color: 'var(--text-faint)' }}>
        Всего броней: <strong style={{ color: 'var(--text)' }}>{summary.bookingCount}</strong>
      </div>

      {/* Status breakdown */}
      {summary.byStatus.length > 0 && (
        <div>
          <div style={captionStyle}>По статусам</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th style={{ ...th, textAlign: 'left' }}>Статус</th>
                <th style={{ ...th, textAlign: 'right' }}>Броней</th>
                <th style={{ ...th, textAlign: 'right' }}>Сумма</th>
              </tr>
            </thead>
            <tbody>
              {summary.byStatus.map((row) => (
                <tr key={row.status} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ padding: '10px 0', fontSize: '1rem', color: 'var(--text)' }}>
                    {STATUS_LABELS[row.status] ?? row.status}
                  </td>
                  <td style={{ padding: '10px 0', fontSize: '1rem', textAlign: 'right', color: 'var(--text-muted)' }}>
                    {row._count.id}
                  </td>
                  <td style={{ padding: '10px 0', fontSize: '1rem', textAlign: 'right', color: 'var(--text-muted)' }}>
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
  // Переход дня сдвигает рабочую дату всего отеля — только администраторам
  // (сервер проверяет роль тоже: POST /shifts/next-day → 403 для STAFF).
  const role = useAuthStore(s => s.admin?.role)
  const canAdvance = role === 'SUPER_ADMIN' || role === 'ADMIN'
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
    // Подтверждение с конкретной датой: назад вернуться нельзя
    const next = currentShift
      ? new Date(new Date(currentShift.date).getTime() + 86400_000).toISOString()
      : null
    const target = next ? `${formatDate(next)} (${weekday(next)})` : 'следующий день'
    if (!window.confirm(`Перейти на ${target}? Вернуться назад будет нельзя.`)) return
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

  if (loading) return <div style={mutedText}>Загрузка...</div>

  // history = all shifts except the current one
  const history = currentShift ? shifts.filter(s => s.id !== currentShift.id) : shifts
  const blocked = advancing || overdueCheckouts.length > 0

  return (
    <div>
      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--s-overdue)',
          border: '1px solid var(--s-overdue)', fontSize: '0.92rem', marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {/* Current day card */}
      <div style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 14,
        padding: '20px 22px',
        marginBottom: 24,
      }}>
        <div style={{
          fontSize: '0.77rem',
          fontWeight: 700,
          color: 'var(--accent-text)',
          textTransform: 'uppercase' as const,
          letterSpacing: '0.08em',
          marginBottom: 8,
        }}>
          Текущий рабочий день
        </div>

        {currentShift ? (
          <>
            <div style={{ fontSize: '1.69rem', fontWeight: 800, color: 'var(--text)', marginBottom: 2 }}>
              {formatDate(currentShift.date)}
            </div>
            <div style={{ fontSize: '1rem', color: 'var(--text-faint)', marginBottom: 16, textTransform: 'capitalize' as const }}>
              {weekday(currentShift.date)}
              {isToday(currentShift.date) && (
                <span style={{
                  marginLeft: 8,
                  fontSize: '0.77rem',
                  fontWeight: 700,
                  background: 'var(--accent-bg)',
                  color: 'var(--s-in)',
                  padding: '2px 7px',
                  borderRadius: 10,
                }}>Сегодня</span>
              )}
            </div>

            <div style={{ display: 'flex', gap: 24, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginBottom: 2 }}>Броней</div>
                <div style={{ fontSize: '1.38rem', fontWeight: 700, color: 'var(--text)' }}>
                  {currentShift._count?.bookings ?? 0}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginBottom: 2 }}>Принял</div>
                <div style={{ fontSize: '1.08rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                  {currentShift.createdBy.name}
                </div>
              </div>
            </div>

            {/* Revenue for current day */}
            <PeriodSummary period="today" shiftId={currentShift.id} />
          </>
        ) : (
          <div style={{ fontSize: '1.08rem', color: 'var(--text-faint)' }}>Нет данных о текущем дне</div>
        )}

        {/* Overdue checkout warning */}
        {overdueCheckouts.length > 0 && (
          <div style={{
            marginTop: 20,
            background: 'var(--surface-2)',
            border: '1px solid var(--s-out)',
            borderRadius: 10,
            padding: '14px 16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: '1.38rem' }}>⚠️</span>
              <div>
                <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--s-out)' }}>
                  Невозможно перейти на следующий день
                </div>
                <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)' }}>
                  Следующие гости должны были выехать, но ещё не выселены:
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {overdueCheckouts.map(oc => (
                <div key={oc.id} style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 7,
                  padding: '8px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}>
                  <div>
                    <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
                      Номер {oc.room.number}
                    </span>
                    <span style={{ fontSize: '0.92rem', color: 'var(--text-faint)', marginLeft: 6 }}>
                      {oc.room.building}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--s-overdue)' }}>
                      Выезд: {formatDate(oc.checkOut)}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>{oc.guestName}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--s-out)', marginTop: 10 }}>
              Оформите выезд в сетке броней, затем повторите переход.
            </div>
          </div>
        )}

        {/* Next day button — только администраторам */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
          {canAdvance ? (
            <>
              <button
                onClick={handleNextDay}
                disabled={blocked}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 20px',
                  background: blocked ? 'var(--surface-2)' : 'var(--accent)',
                  color: blocked ? 'var(--text-faint)' : '#fff',
                  border: blocked ? '1px solid var(--border-subtle)' : '1px solid transparent',
                  borderRadius: 8,
                  fontSize: '1.08rem',
                  fontWeight: 700,
                  cursor: blocked ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s',
                }}
              >
                <span style={{ fontSize: '1.23rem' }}>→</span>
                {advancing ? 'Переход...' : 'Следующий день'}
              </button>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 6 }}>
                {overdueCheckouts.length > 0
                  ? 'Сначала оформите выезд отмеченных гостей'
                  : 'Зафиксирует текущий день и откроет новый'}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '0.92rem', color: 'var(--text-faint)' }}>
              Переход дня выполняет администратор
            </div>
          )}
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div>
          <div style={captionStyle}>История дней</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map(s => {
              const expanded = expandedId === s.id
              return (
                <div
                  key={s.id}
                  style={{
                    background: expanded ? 'var(--surface)' : 'var(--bg)',
                    border: `1px solid ${expanded ? 'var(--border)' : 'var(--border-subtle)'}`,
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
                      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
                        {formatDate(s.date)}
                        <span style={{ fontSize: '0.92rem', color: 'var(--text-faint)', fontWeight: 400, marginLeft: 8, textTransform: 'capitalize' as const }}>
                          {weekday(s.date)}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 2 }}>
                        {s._count?.bookings ?? 0} броней · {s.createdBy.name}
                      </div>
                    </div>
                    <span style={{ color: 'var(--text-faint)', fontSize: '0.92rem' }}>{expanded ? '▲' : '▼'}</span>
                  </div>

                  {expanded && (
                    <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border-subtle)' }}>
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
        <div style={{ fontSize: '1rem', color: 'var(--text-faint)', textAlign: 'center', paddingTop: 16 }}>
          {canAdvance
            ? 'История пока пуста — нажмите «Следующий день», чтобы начать вести учёт'
            : 'История пока пуста'}
        </div>
      )}
    </div>
  )
}

// ─── Actions Panel (журнал действий) ──────────────────────────────────────────

// Человекочитаемые названия по method + path (числовые id уже нормализованы в ':id').
const ACTION_LABELS: Array<[RegExp, string]> = [
  [/^POST \/bookings$/,                       'Создание брони'],
  [/^PUT \/bookings\/:id$/,                   'Изменение брони'],
  [/^DELETE \/bookings\/:id$/,                'Отмена брони'],
  [/^PATCH \/bookings\/:id\/checkin$/,        'Заезд'],
  [/^PATCH \/bookings\/:id\/checkout$/,       'Выезд'],
  [/^POST \/bookings\/:id\/move$/,            'Переезд'],
  [/^POST \/payments$/,                       'Приём оплаты'],
  [/^POST \/payments\/:id\/refund$/,          'Возврат оплаты'],
  [/^POST \/payments\/:id\/void$/,            'Отмена платежа'],
  [/^POST \/occupancy\/optimize\/apply$/,     'Применение оптимизатора'],
  [/^POST \/shifts\/next-day$/,               'Переход дня'],
  [/^POST \/snapshots\/:id\/restore$/,        'Откат снимка'],
  [/^POST \/users$/,                          'Новый пользователь'],
  [/^PUT \/users\/:id$/,                      'Изменение пользователя'],
  [/^PATCH \/users\/:id\/password$/,          'Сброс пароля'],
  [/^POST \/rooms$/,                          'Новый номер'],
  [/^PUT \/rooms\/:id$/,                      'Изменение номера'],
  [/^DELETE \/rooms\/:id$/,                   'Отключение номера'],
  [/^POST \/categories$/,                     'Новая категория'],
  [/^PUT \/categories\/:id$/,                 'Изменение категории'],
  [/^DELETE \/categories\/:id$/,              'Удаление категории'],
  [/^POST \/partners$/,                       'Новый партнёр'],
  [/^PUT \/partners\/:id$/,                   'Изменение партнёра'],
  [/^DELETE \/partners\/:id$/,                'Удаление партнёра'],
  [/^POST \/allotments$/,                     'Новая квота'],
  [/^PUT \/allotments\/:id$/,                 'Изменение квоты'],
  [/^DELETE \/allotments\/:id$/,              'Удаление квоты'],
  [/^POST \/allotments\/:id\/releases$/,      'Релиз квоты'],
  [/^DELETE \/allotments\/releases\/:id$/,    'Отмена релиза'],
  [/^(PUT|POST) \/rates/,                     'Изменение тарифов'],
  [/^DELETE \/rates/,                         'Очистка тарифов'],
  [/^PUT \/hotel$/,                           'Настройки отеля'],
  [/^POST \/system\/backup\/restore$/,        'Восстановление из копии'],
  [/^POST \/system\/backup$/,                 'Резервная копия'],
]

// Запасные подписи по разделу, если точного правила нет
const ENTITY_LABELS: Record<string, string> = {
  bookings: 'Бронь', users: 'Пользователь', rooms: 'Номер', categories: 'Категория',
  partners: 'Партнёр', allotments: 'Квота', snapshots: 'Снимок', shifts: 'Смена',
  occupancy: 'Оптимизатор', rates: 'Тарифы', hotel: 'Отель', system: 'База',
  payments: 'Платёж',
}
const ENTITY_GROUP_LABELS: Record<string, string> = {
  bookings: 'Брони', users: 'Пользователи', rooms: 'Номера', categories: 'Категории',
  partners: 'Партнёры', allotments: 'Квоты', rates: 'Тарифы', payments: 'Платежи',
}

function describeAction(action: string, entity: string): string {
  const normalized = action.replace(/\/\d+(?=\/|$)/g, '/:id')
  for (const [re, label] of ACTION_LABELS) if (re.test(normalized)) return label
  return ENTITY_GROUP_LABELS[entity] ?? action
}

function describeObject(e: AuditLogEntry): string {
  const label = ENTITY_LABELS[e.entity] ?? e.entity
  return e.entityId != null ? `${label} #${e.entityId}` : label
}

// Краткая строка деталей: для брони — гость и даты, иначе компактный JSON
function briefDetails(details: unknown): string {
  if (!details || typeof details !== 'object') return ''
  const d = details as Record<string, unknown>
  if (typeof d._truncated === 'boolean' && typeof d.preview === 'string') return d.preview.slice(0, 90) + '…'
  if (typeof d.guestName === 'string') {
    const dates = typeof d.checkIn === 'string' && typeof d.checkOut === 'string' ? `, ${d.checkIn} → ${d.checkOut}` : ''
    return `${d.guestName}${dates}`
  }
  if (typeof d.fileName === 'string') return d.fileName
  const s = JSON.stringify(d).replace(/^\{|\}$/g, '').replace(/"/g, '')
  return s.length > 90 ? s.slice(0, 90) + '…' : s
}

function fullDetails(details: unknown): string {
  if (details == null) return ''
  try { return JSON.stringify(details, null, 1) } catch { return String(details) }
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

const filterInput: React.CSSProperties = {
  height: 32, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7,
  background: 'var(--bg)', color: 'var(--text)', fontSize: '0.86rem', fontFamily: 'inherit',
}

const ActionsPanel: React.FC = () => {
  const role = useAuthStore(s => s.admin?.role)
  const canView = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const isSuper = role === 'SUPER_ADMIN'

  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [adminId, setAdminId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    setError('')
    try {
      const params: AuditLogParams = { limit: 200 }
      if (adminId) params.adminId = Number(adminId)
      // Границы местных суток → ISO, сервер сравнивает моменты
      if (dateFrom) params.dateFrom = new Date(`${dateFrom}T00:00:00`).toISOString()
      if (dateTo) params.dateTo = new Date(`${dateTo}T23:59:59.999`).toISOString()
      setEntries(await fetchAuditLog(params))
    } catch {
      setError('Ошибка загрузки журнала')
    } finally {
      setLoading(false)
    }
  }, [canView, adminId, dateFrom, dateTo])

  useEffect(() => { load() }, [load])

  // Фильтр по сотруднику — список из /api/users доступен только SUPER_ADMIN
  useEffect(() => {
    if (isSuper) fetchUsers().then(setUsers).catch(() => setUsers([]))
  }, [isSuper])

  if (!canView) {
    return <div style={mutedText}>Журнал действий доступен администраторам</div>
  }

  const th: React.CSSProperties = {
    textAlign: 'left', padding: '8px 8px', fontSize: '0.82rem', color: 'var(--text-faint)',
    fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--bg)',
  }
  const td: React.CSSProperties = { padding: '8px 8px', fontSize: '0.9rem', verticalAlign: 'top' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        {isSuper && (
          <select value={adminId} onChange={e => setAdminId(e.target.value)} style={filterInput}>
            <option value="">Все сотрудники</option>
            {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={filterInput} title="С даты" />
        <span style={{ color: 'var(--text-faint)' }}>—</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={filterInput} title="По дату" />
        <button onClick={load} disabled={loading} style={{
          ...filterInput, cursor: 'pointer', fontWeight: 600, background: 'var(--surface)',
        }}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: '0.82rem', color: 'var(--text-faint)' }}>
          {entries.length >= 200 ? 'Показаны последние 200' : `Записей: ${entries.length}`}
        </span>
      </div>

      {error && <div style={errorText}>{error}</div>}

      {!error && !loading && entries.length === 0 && (
        <div style={{ ...mutedText, textAlign: 'center' }}>
          Записей нет. Журнал ведётся с момента установки этой версии: создание, изменение и отмена броней,
          переход дня, оптимизатор, пользователи, номера, копии.
        </div>
      )}

      {entries.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              <th style={th}>Время</th>
              <th style={th}>Кто</th>
              <th style={th}>Действие</th>
              <th style={th}>Объект</th>
              <th style={th}>Детали</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td className="mono" style={{ ...td, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{formatDateTime(e.createdAt)}</td>
                <td style={{ ...td, color: 'var(--text)', whiteSpace: 'nowrap' }}>{e.adminName}</td>
                <td style={{ ...td, color: 'var(--text)', fontWeight: 600 }} title={e.action}>{describeAction(e.action, e.entity)}</td>
                <td style={{ ...td, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{describeObject(e)}</td>
                <td style={{ ...td, color: 'var(--text-faint)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={fullDetails(e.details)}>
                  {briefDetails(e.details)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

  const tabs: SidebarTab[] = ['today', 'week', 'month', 'shifts', 'actions']

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
          background: 'var(--bg)',
          color: 'var(--text)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          display: 'flex',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-lg)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left sidebar */}
        <div style={{
          width: 200,
          flexShrink: 0,
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--surface)',
          display: 'flex',
          flexDirection: 'column',
          padding: '20px 0',
        }}>
          <div style={{ padding: '0 16px 16px', fontSize: '1rem', fontWeight: 700, color: 'var(--text)', borderBottom: '1px solid var(--border-subtle)', marginBottom: 8 }}>
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
                background: activeTab === tab ? 'var(--accent-bg)' : 'transparent',
                color: activeTab === tab ? 'var(--accent-text)' : 'var(--text-muted)',
                fontWeight: activeTab === tab ? 700 : 400,
                fontSize: '1rem',
                cursor: 'pointer',
                borderRadius: 0,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderLeft: activeTab === tab ? '3px solid var(--accent)' : '3px solid transparent',
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
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <div style={{ fontSize: '1.23rem', fontWeight: 700, color: 'var(--text)' }}>
              {TAB_ICONS[activeTab]} {TAB_LABELS[activeTab]}
            </div>
            <button onClick={onClose} style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '1.38rem',
              color: 'var(--text-faint)',
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
            {activeTab === 'actions' && <ActionsPanel />}
          </div>
        </div>
      </div>
    </div>
  )
}
