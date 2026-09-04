import React, { useEffect, useState, useMemo, useRef } from 'react'
import { format } from 'date-fns'
import { useForm, Controller } from 'react-hook-form'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore, BookingFlagItem } from '../../store/useSettingsStore'
import { fetchRooms } from '../../api/rooms'
import { compareRooms } from '../../utils/sortRooms'
import {
  createBooking,
  updateBooking,
  cancelBooking,
  checkInBooking,
  checkOutBooking,
  checkAvailability,
  fetchBooking,
} from '../../api/bookings'
import type { Room, GridBooking, Booking, RatePrice, Service, MealPlan, PricingBase } from '../../types'
import { fetchRoomAvailability } from '../../api/occupancy'
import { fetchRates } from '../../api/rates'
import { fetchServices, fetchMealPlans } from '../../api/services'
import { fetchHotel } from '../../api/hotel'
import { calculate, buildCalcKey, nightsOf } from '../../utils/calculator'
import type { CalcInput, CalcResult, RateContext, BreakdownLine } from '../../utils/calculator'
import { ChargesPanel } from './ChargesPanel'
import {
  defaultLinks, linksFromBooking, linksKey, linksToPayload, newLink, isPerPerson,
  servicePreviewLines, syncLinksWithGuests,
} from './serviceLines'
import type { ServiceLink, GuestTotals } from './serviceLines'
import { DatePicker } from '../ui/DatePicker'

interface FormValues {
  roomId: number
  guestName: string
  guestPhone: string
  checkIn: string
  checkOut: string
  source: string
  notes: string
  immediateCheckIn: boolean
}

const SOURCES = ['телефон', 'стойка', 'онлайн', 'Каспи']

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED:   'Подтверждена',
  CHECKED_IN:  'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED:   'Отменена',
  NO_SHOW:     'Не приехал',
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; error?: string; children: React.ReactNode }> = ({ label, error, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: '0.9em', fontWeight: 600, color: 'var(--text)' }}>{label}</label>
    {children}
    {error && <span style={{ fontSize: '0.85rem', color: '#dc2626' }}>{error}</span>}
  </div>
)

const counterBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 6,
  border: '1px solid #e5e7eb',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '1.23rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#374151',
  lineHeight: 1,
  padding: 0,
}

const GuestCounter: React.FC<{
  label: string
  value: number
  onChange: (v: number) => void
  /** Потолок (число едоков не бывает больше числа гостей). Без него — без ограничения. */
  max?: number
  small?: boolean
}> = ({ label, value, onChange, max, small }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: small ? '4px 4px' : '7px 4px' }}>
    <span style={{ fontSize: small ? '0.85rem' : '0.95rem', color: 'var(--text-muted)' }}>{label}</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <button type="button" onClick={() => onChange(Math.max(0, value - 1))} style={counterBtnStyle}>−</button>
      <span className="mono" style={{ minWidth: 22, textAlign: 'center', fontSize: '0.95rem', fontWeight: 600 }}>{value}</span>
      <button
        type="button"
        onClick={() => onChange(max != null ? Math.min(max, value + 1) : value + 1)}
        disabled={max != null && value >= max}
        style={{ ...counterBtnStyle, opacity: max != null && value >= max ? 0.4 : 1 }}
      >+</button>
    </div>
  </div>
)

// ─── Строка услуги в форме брони ──────────────────────────────────────────────
// Питание и доп. услуги устроены одинаково: услуга + сколько людей ей пользуется
// (или сколько раз). Разница только в том, как строка появляется: питание —
// галочкой из списка, доп. услуга — выбором из справочника.

const UNIT_HINTS: Record<string, string> = {
  per_person_night: 'за человека в сутки',
  per_night: 'за сутки',
  per_person: 'за человека',
  per_booking: 'разово',
}

const ServiceRow: React.FC<{
  service: Service
  link?: ServiceLink
  guests: GuestTotals
  disabled?: boolean
  onToggle: () => void
  onPatch: (patch: Partial<ServiceLink>) => void
}> = ({ service, link, guests, disabled, onToggle, onPatch }) => {
  const on = !!link
  const isMeal = service.kind === 'meal'
  const perPerson = isPerPerson(service.unit)
  const maxAdults = guests.adults + guests.extraBeds
  // Детей показываем, только если они есть — иначе счётчик-пустышка в каждой строке
  const showChildren = guests.children > 0 || (link?.children ?? 0) > 0

  return (
    <div style={{
      borderTop: '1px solid var(--border-subtle)', padding: '6px 0',
    }}>
      {/* Название на своей строке: цена с единицей начисления рядом с ним съедала
          его до одной буквы («З 3 500 ₸ · за человека в сутки»). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, cursor: disabled ? 'default' : 'pointer' }}>
          <input type="checkbox" checked={on} disabled={disabled} onChange={onToggle} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: '0.92rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {service.name}
          </span>
        </label>
        {!isMeal && on && (
          <button type="button" disabled={disabled} onClick={onToggle} title="Убрать услугу"
            style={{ ...counterBtnStyle, width: 24, height: 24, fontSize: '0.9rem', flexShrink: 0 }}>×</button>
        )}
      </div>
      <div style={{ paddingLeft: 22, fontSize: '0.75rem', color: 'var(--text-faint)' }}>
        {service.price > 0
          ? `${service.price.toLocaleString('ru-RU')} ₸${service.childPrice != null ? ` · дети ${service.childPrice.toLocaleString('ru-RU')} ₸` : ''}`
          : 'цена не задана'}
        {' · '}{UNIT_HINTS[service.unit] ?? service.unit}
      </div>

      {on && link && (
        <div style={{ paddingLeft: 22 }}>
          {perPerson ? (
            <>
              <GuestCounter
                small
                label={showChildren ? 'Взрослых' : 'Человек'}
                value={link.adults}
                max={maxAdults}
                onChange={(v) => onPatch({ adults: v })}
              />
              {showChildren && (
                <GuestCounter
                  small
                  label="Детей"
                  value={link.children}
                  max={guests.children}
                  onChange={(v) => onPatch({ children: v })}
                />
              )}
            </>
          ) : (
            <GuestCounter
              small
              label={service.unit === 'per_night' ? 'Штук на ночь' : 'Количество'}
              value={link.quantity}
              onChange={(v) => onPatch({ quantity: v })}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Выбор услуги из справочника — вторая половина блока «Доп. услуги». */
const AddServiceRow: React.FC<{
  services: Service[]
  disabled?: boolean
  onAdd: (serviceId: number) => void
}> = ({ services, disabled, onAdd }) => {
  const [value, setValue] = useState(0)
  if (services.length === 0) {
    return (
      <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)', padding: '8px 4px 4px', lineHeight: 1.4 }}>
        Все услуги из справочника уже добавлены. Новые заводятся в разделе
        «Тарифы и наличие» → вкладка «Услуги».
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', gap: 6, padding: '10px 0 4px' }}>
      <select
        value={value}
        disabled={disabled}
        onChange={e => setValue(Number(e.target.value))}
        style={{ ...selectStyle, flex: 1, minWidth: 0, fontSize: '0.88rem' }}
      >
        <option value={0}>— добавить услугу —</option>
        {services.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button
        type="button"
        disabled={disabled || value === 0}
        onClick={() => { onAdd(value); setValue(0) }}
        style={{ ...cancelBtnStyle, padding: '6px 12px', fontSize: '0.88rem', opacity: value === 0 ? 0.5 : 1 }}
      >
        Добавить
      </button>
    </div>
  )
}

// Сворачиваемая секция (прогрессивное раскрытие) — по дизайну «Бронь».
// Редко используемые группы свёрнуты по умолчанию; в свёрнутом виде показывают итог.
const CalcSection: React.FC<{ title: string; defaultOpen?: boolean; badge?: number; children: React.ReactNode }> = ({ title, defaultOpen = true, badge, children }) => {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
      <button type="button" onClick={() => setOpen(o => !o)} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 10, height: 44, padding: '0 14px',
        background: 'var(--surface)', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
      }}>
        <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ flex: 1 }} />
        {!open && badge ? (
          <span className="mono" style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>{badge}</span>
        ) : null}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform 0.18s', flexShrink: 0 }}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div style={{ padding: '4px 14px 8px', borderTop: '1px solid var(--border-subtle)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₸'

// Сохранённые суммы брони (edit без пересчёта). totalAmount/prepaidAmount могут отсутствовать,
// если полную версию с сервера загрузить не удалось.
interface SavedTotals {
  totalAmount?: number
  prepaidAmount?: number
  paidAmount: number
}

interface ResultCardProps {
  result: CalcResult
  discountPercent: number
  prepaymentPercent: number
  categoryName: string
  loading?: boolean
  saved?: SavedTotals | null   // edit: показать сохранённые суммы вместо расчёта
  onRecalc?: () => void        // кнопка «Пересчитать по тарифу»
  willRecalc?: boolean         // edit: итог уйдёт на сервер при сохранении
}

const resultRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: '#6b7280', marginBottom: 4,
}

const ResultCard: React.FC<ResultCardProps> = ({
  result, discountPercent, prepaymentPercent, categoryName, loading, saved, onRecalc, willRecalc,
}) => {
  if (loading) {
    return (
      <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '1rem', padding: '12px 0' }}>
        Загрузка…
      </div>
    )
  }

  // Edit без изменения входов калькулятора: итог не пересчитываем, показываем сохранённый
  if (saved) {
    const fmtOpt = (n?: number) => (n != null ? fmt(n) : '—')
    const remaining = saved.totalAmount != null ? saved.totalAmount - saved.paidAmount : undefined
    return (
      <div>
        <div style={{ fontSize: '0.8rem', color: '#9ca3af', marginBottom: 6 }}>Сохранённая сумма брони</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.15rem', fontWeight: 700, color: '#111827', marginBottom: 6 }}>
          <span>Итого</span>
          <span style={{ color: '#6366f1' }}>{fmtOpt(saved.totalAmount)}</span>
        </div>
        <div style={resultRowStyle}>
          <span>Предоплата</span>
          <span style={{ color: '#059669', fontWeight: 600 }}>{fmtOpt(saved.prepaidAmount)}</span>
        </div>
        <div style={resultRowStyle}>
          <span>Оплачено</span>
          <span style={{ fontWeight: 600 }}>{fmt(saved.paidAmount)}</span>
        </div>
        <div style={{ ...resultRowStyle, marginBottom: 10 }}>
          <span>Остаток</span>
          <span style={{ color: '#dc2626', fontWeight: 600 }}>{fmtOpt(remaining)}</span>
        </div>
        <button type="button" onClick={onRecalc} style={{ ...cancelBtnStyle, width: '100%', fontSize: '0.9rem' }}>
          Пересчитать по тарифу
        </button>
      </div>
    )
  }

  // Ни на одну ночь нет цены в календаре: 0 из калькулятора — это не цена
  if (result.nights > 0 && result.noRates && categoryName) {
    // Питание и услуги свою цену имеют и начислятся всё равно. Молчать о них
    // нельзя: администратор увидел бы «итог не рассчитан», сохранил — и в брони
    // появилась бы сумма из ниоткуда.
    const svcTotal = result.breakdown
      .filter(l => l.kind !== 'stay')
      .reduce((sum, l) => sum + l.amount, 0)
    return (
      <div style={{ textAlign: 'center', color: '#b45309', fontSize: '0.95rem', padding: '12px 0' }}>
        Для категории «{categoryName}» на эти даты нет цен в календаре — проживание не рассчитано.
        <div style={{ fontSize: '0.82rem', color: '#9ca3af', marginTop: 4 }}>
          Цены заполняются в разделе «Тарифы и наличие».
        </div>
        {svcTotal > 0 && (
          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #e5e7eb', color: '#374151', fontSize: '0.9rem' }}>
            Питание и услуги начислятся: <strong>{fmt(svcTotal)}</strong>
          </div>
        )}
      </div>
    )
  }

  const hasGuests = result.nights > 0 && result.total !== 0
  if (!hasGuests) {
    return (
      <div style={{ textAlign: 'center', color: '#9ca3af', fontSize: '1rem', padding: '12px 0' }}>
        Нет данных для расчёта
      </div>
    )
  }

  return (
    <div>
      {result.missingNights > 0 && (
        <div style={{ ...infoBoxStyle('#fffbeb', '#b45309'), fontSize: '0.85rem', marginBottom: 8 }}>
          На {result.missingNights} ноч. цена не задана — итог неполный.
          <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
            {result.missingDates.slice(0, 6).join(', ')}
            {result.missingDates.length > 6 ? ` и ещё ${result.missingDates.length - 6}` : ''}
          </div>
        </div>
      )}
      {result.breakdown.map((line, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.92rem', color: line.kind === 'stay' ? '#374151' : '#6b7280', marginBottom: 4 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={line.label}>
            {line.label}
            {line.kind === 'stay'
              ? ` (${line.nights} н.)`
              : line.quantity && line.quantity !== 1
                ? ` (${line.quantity} × ${line.unitPrice?.toLocaleString('ru-RU')})`
                : ''}
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>{fmt(line.amount)}</span>
        </div>
      ))}
      <div style={{ borderTop: '1px solid #e5e7eb', marginTop: 8, paddingTop: 8 }}>
        {discountPercent > 0 && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: '#6b7280', marginBottom: 4 }}>
              <span>Итого (до скидки)</span>
              <span>{fmt(result.total)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: '#d97706', marginBottom: 4 }}>
              <span>Скидка ({discountPercent}%)</span>
              <span>−{fmt(result.total - result.totalAfterDiscount)}</span>
            </div>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.15rem', fontWeight: 700, color: '#111827', marginBottom: 6 }}>
          <span>Итого{discountPercent > 0 ? ' со скидкой' : ''}</span>
          <span style={{ color: '#6366f1' }}>{fmt(result.totalAfterDiscount)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: '#6b7280', marginBottom: 4 }}>
          <span>Предоплата ({prepaymentPercent}%)</span>
          <span style={{ color: '#059669', fontWeight: 600 }}>{fmt(result.prepaidAmount)}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: '#6b7280' }}>
          <span>Остаток</span>
          <span style={{ color: '#dc2626', fontWeight: 600 }}>{fmt(result.remaining)}</span>
        </div>
        {willRecalc && (
          <div style={{ marginTop: 8, fontSize: '0.8rem', color: '#9ca3af', textAlign: 'center' }}>
            Итог будет пересчитан при сохранении
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export const BookingModal: React.FC = () => {
  const { modal, closeModal, fetchGrid, fetchToday, shiftDate } = useGridStore()
  const { roomFund, hiddenFlagCodes } = useSettingsStore()
  const [rooms, setRooms] = useState<Room[]>([])
  const [conflict, setConflict] = useState<GridBooking | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState('')
  const [earlyCheckoutConfirm, setEarlyCheckoutConfirm] = useState(false)
  const [roomOccupied, setRoomOccupied] = useState(false)
  // Квота партнёра: сервер вернул 409 ALLOTMENT_CONFLICT, ждём осознанного подтверждения
  const [allotmentWarning, setAllotmentWarning] = useState<string | null>(null)
  const pendingValues = useRef<FormValues | null>(null)
  // Подставили ли в НОВУЮ бронь услуги «включено в тариф». Отметка нужна, потому что
  // справочник услуг грузится асинхронно: без неё повторная загрузка вернула бы
  // снятые галочки обратно.
  const linksSeeded = useRef(false)

  // Цены — из календаря RatePrice, а не из localStorage: одна цена на каждую ночь
  const [pricingBase, setPricingBase] = useState<PricingBase>('person')
  const [allServices, setAllServices] = useState<Service[]>([])
  const [mealPlans, setMealPlans] = useState<MealPlan[]>([])
  const [ratesByDate, setRatesByDate] = useState<Record<string, RatePrice>>({})
  const [ratesLoading, setRatesLoading] = useState(false)

  // Гости — три счётчика, а не шесть. Деление «с питанием / без питания» ушло:
  // на проживание оно не влияло (счётчики складывались), а кому начислять питание,
  // теперь говорит блок «Питание» — по каждой услуге отдельно.
  const [adults, setAdults] = useState(0)
  const [children, setChildren] = useState(0)
  const [extraBeds, setExtraBeds] = useState(0)
  // Питание и услуги этой брони
  const [serviceLinks, setServiceLinks] = useState<ServiceLink[]>([])
  const [disabledAdults, setDisabledAdults] = useState(0)
  const [disabledChildren, setDisabledChildren] = useState(0)
  const [discountPercent, setDiscountPercent] = useState(0)
  const [prepaymentPercent, setPrepaymentPercent] = useState(50)
  const [paidAmount, setPaidAmount] = useState(0)
  const [selectedFlags, setSelectedFlags] = useState<string[]>([])
  const [customFlag, setCustomFlag] = useState('')

  // Edit: полная бронь с сервера (объект из сетки может быть частичным) и её загрузка
  const [serverBooking, setServerBooking] = useState<Booking | null>(null)
  const [loadingBooking, setLoadingBooking] = useState(false)
  // Edit: админ явно нажал «Пересчитать по тарифу»
  const [recalc, setRecalc] = useState(false)

  const isEdit        = modal.mode === 'edit'
  const isMaintenance = modal.mode === 'maintenance' ||
    (modal.mode === 'edit' && modal.booking?.source === 'ремонт')
  const booking       = modal.booking

  const { register, handleSubmit, watch, reset, control, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      roomId: modal.prefillRoomId ?? 0,
      guestName: '',
      guestPhone: '',
      checkIn: modal.prefillCheckIn ?? '',
      checkOut: modal.prefillCheckOut ?? '',
      source: 'стойка',
      notes: '',
      immediateCheckIn: false,
    },
  })

  // Load rooms once (натуральная сортировка номеров)
  useEffect(() => {
    fetchRooms({ isActive: true }).then(r => setRooms([...r].sort(compareRooms)))
  }, [])

  // Настройки объекта, справочник услуг и пресеты пансиона — общие для всей формы.
  // pricingBase решает, какие поля цены значимы: 'room' — за номер, 'person' — за место.
  // Услуги берём ВСЕ активные: питание выбирается галочками, а не флагом в справочнике.
  useEffect(() => {
    fetchHotel().then(h => setPricingBase(h.pricingBase)).catch(() => {})
    fetchServices()
      .then(list => setAllServices(list.filter(s => s.isActive)))
      .catch(() => setAllServices([]))
    fetchMealPlans().then(setMealPlans).catch(() => setMealPlans([]))
  }, [])

  const servicesById = useMemo(
    () => new Map(allServices.map(s => [s.id, s])),
    [allServices],
  )
  const mealServices = useMemo(() => allServices.filter(s => s.kind === 'meal'), [allServices])
  const extraServices = useMemo(() => allServices.filter(s => s.kind !== 'meal'), [allServices])

  // Счётчики гостей, скидка, предоплата, «Оплачено» — из брони; {} даёт сброс для create.
  // Старые брони держат гостей в ДВУХ колонках («с питанием» / «без питания») —
  // складываем: в форме тип гостя один, а питание живёт отдельным блоком.
  const applyCalcFields = (b: Partial<Booking>) => {
    setAdults((b.adultsWithMeals ?? 0) + (b.adultsNoMeals ?? 0))
    setChildren((b.childrenWithMeals ?? 0) + (b.childrenNoMeals ?? 0))
    setExtraBeds((b.extraBedsWithMeals ?? 0) + (b.extraBedsNoMeals ?? 0))
    setDisabledAdults(b.disabledAdults ?? 0)
    setDisabledChildren(b.disabledChildren ?? 0)
    setDiscountPercent(b.discountPercent ?? 0)
    setPrepaymentPercent(b.prepaymentPercent ?? 50)
    setPaidAmount(b.paidAmount ?? 0)
  }

  // Pre-fill form for edit/create mode
  useEffect(() => {
    if (!modal.open) return
    let cancelled = false
    if (isEdit && booking) {
      // Форма — из объекта сетки: при перетаскивании в него уже подмешаны новые roomId/checkIn/checkOut
      reset({
        roomId: booking.roomId,
        guestName: booking.guestName,
        guestPhone: booking.guestPhone ?? '',
        checkIn: booking.checkIn.slice(0, 10),
        checkOut: booking.checkOut.slice(0, 10),
        source: booking.source ?? 'стойка',
        notes: booking.notes ?? '',
        immediateCheckIn: false,
      })
      // Предварительно — из объекта сетки; ниже перезапишем полной серверной версией
      applyCalcFields(booking)
      // Флаги: предустановленные отдельно, произвольный текст отдельно
      const allFlags = booking.flags ?? []
      const knownIds = new Set((roomFund.bookingFlags ?? []).map((f: BookingFlagItem) => f.id))
      setSelectedFlags(allFlags.filter((f: string) => knownIds.has(f)))
      setCustomFlag(allFlags.find((f: string) => !knownIds.has(f)) ?? '')

      // Гостей и деньги ВСЕГДА берём с сервера: объект из сетки может быть частичным,
      // и раньше `?? 0` обнулял их при сохранении. Пока грузится — «Сохранить» заблокирована.
      setServerBooking(null)
      setServiceLinks([])
      setRecalc(false)
      setLoadingBooking(true)
      fetchBooking(booking.id)
        .then(full => {
          if (cancelled) return
          setServerBooking(full)
          applyCalcFields(full)
          // Питание и услуги приходят только из GET /bookings/:id — в объекте сетки их нет
          setServiceLinks(linksFromBooking(full.services))
        })
        .catch(() => {
          if (!cancelled) setApiError('Не удалось загрузить бронь целиком, суммы могут быть неточными')
        })
        .finally(() => {
          if (!cancelled) setLoadingBooking(false)
        })
    } else {
      reset({
        roomId: modal.prefillRoomId ?? 0,
        guestName: isMaintenance ? 'Ремонт' : '',
        guestPhone: '',
        checkIn: modal.prefillCheckIn ?? '',
        checkOut: modal.prefillCheckOut ?? '',
        source: 'стойка',
        notes: '',
        immediateCheckIn: modal.prefillImmediateCheckIn ?? false,
      })
      // Reset calculator
      applyCalcFields({})
      setSelectedFlags([])
      setCustomFlag('')
      setServerBooking(null)
      setRecalc(false)
      setLoadingBooking(false)
      // Новая бронь получает услуги «включено в тариф». Справочник мог ещё не
      // загрузиться — тогда набор подставит эффект ниже, поэтому снимаем отметку.
      linksSeeded.current = false
      setServiceLinks(defaultLinks(allServices, { adults: 0, children: 0, extraBeds: 0 }))
      if (allServices.length > 0) linksSeeded.current = true
    }
    setConflict(null)
    setApiError('')
    setRoomOccupied(false)
    // Диалог «Ранний выезд» не должен переживать закрытие формы и всплывать на другой брони
    setEarlyCheckoutConfirm(false)
    setAllotmentWarning(null)
    pendingValues.current = null
    // Закрыли модалку (или открыли другую бронь) до ответа сервера — ответ игнорируем
    return () => { cancelled = true }
  }, [modal.open, modal.mode, booking?.id])

  const guestTotals = useMemo<GuestTotals>(
    () => ({ adults, children, extraBeds }),
    [adults, children, extraBeds],
  )

  // Справочник услуг мог догрузиться уже после открытия формы — подставляем
  // «включено в тариф» тогда. Только для новой брони: у сохранённой набор свой.
  useEffect(() => {
    if (!modal.open || isEdit || linksSeeded.current || allServices.length === 0) return
    linksSeeded.current = true
    setServiceLinks(defaultLinks(allServices, guestTotals))
  }, [modal.open, isEdit, allServices, guestTotals])

  // Число едоков едет за счётчиками гостей, пока его не задали руками.
  // Иначе «добавил третьего гостя» молча оставляло бы завтрак на двоих.
  useEffect(() => {
    setServiceLinks(prev => syncLinksWithGuests(prev, servicesById, guestTotals))
  }, [guestTotals, servicesById])

  // ── Действия над питанием и услугами ───────────────────────────────────────
  const linkOf = (serviceId: number) => serviceLinks.find(l => l.serviceId === serviceId)

  const toggleService = (serviceId: number) => {
    setServiceLinks(prev => prev.some(l => l.serviceId === serviceId)
      ? prev.filter(l => l.serviceId !== serviceId)
      : [...prev, newLink(serviceId, guestTotals)])
  }

  const removeService = (serviceId: number) => {
    setServiceLinks(prev => prev.filter(l => l.serviceId !== serviceId))
  }

  // Правка вручную помечает строку `custom`: дальше она за счётчиками гостей не едет,
  // иначе «завтрак на двоих из троих» сбрасывался бы при любой правке состава.
  const patchLink = (serviceId: number, patch: Partial<ServiceLink>) => {
    setServiceLinks(prev => prev.map(l => (
      l.serviceId === serviceId ? { ...l, ...patch, custom: true } : l
    )))
  }

  /** Пресет пансиона: включает ровно свой набор питания, остальное снимает. */
  const applyMealPlan = (plan: MealPlan) => {
    const wanted = new Set(plan.serviceCodes)
    const mealIds = new Set(mealServices.filter(s => wanted.has(s.code)).map(s => s.id))
    setServiceLinks(prev => [
      // Доп. услуги пресет питания не трогает — это разные блоки формы
      ...prev.filter(l => servicesById.get(l.serviceId)?.kind !== 'meal'),
      ...[...mealIds].map(id => prev.find(l => l.serviceId === id) ?? newLink(id, guestTotals)),
    ])
  }

  const activeMealCodes = useMemo(() => {
    const codes = serviceLinks
      .map(l => servicesById.get(l.serviceId))
      .filter((s): s is Service => !!s && s.kind === 'meal')
      .map(s => s.code)
    return new Set(codes)
  }, [serviceLinks, servicesById])

  const isPlanActive = (plan: MealPlan) =>
    plan.serviceCodes.length === activeMealCodes.size
    && plan.serviceCodes.every(c => activeMealCodes.has(c))

  // Watched form fields
  const watchedRoomId  = watch('roomId')
  const watchedCheckIn = watch('checkIn')
  const watchedCheckOut = watch('checkOut')

  // Find selected room for category name
  const selectedRoom = useMemo(
    () => rooms.find(r => r.id === Number(watchedRoomId)),
    [rooms, watchedRoomId]
  )
  const categoryName = selectedRoom?.category?.name ?? ''
  const categoryId = selectedRoom?.category?.id ?? 0

  // Цены на ночи брони. Спрашиваем ровно ночи [checkIn, checkOut): последняя ночь —
  // это checkOut минус день, за сам день выезда не платят.
  useEffect(() => {
    const dates = nightsOf(watchedCheckIn, watchedCheckOut)
    if (!categoryId || dates.length === 0) {
      setRatesByDate({})
      setRatesLoading(false)
      return
    }
    let cancelled = false
    setRatesLoading(true)
    fetchRates(dates[0], dates[dates.length - 1], categoryId)
      .then(list => {
        if (cancelled) return
        const map: Record<string, RatePrice> = {}
        for (const r of list) map[String(r.date).slice(0, 10)] = r
        setRatesByDate(map)
      })
      .catch(() => { if (!cancelled) setRatesByDate({}) })
      .finally(() => { if (!cancelled) setRatesLoading(false) })
    return () => { cancelled = true }
  }, [categoryId, watchedCheckIn, watchedCheckOut])

  // services: [] — услуги калькулятор больше не считает сам. Он не знает, скольким
  // гостям начислено питание: это сказано строками BookingService, и предпросмотр
  // по ним собирается ниже (servicePreviewLines).
  const rateCtx = useMemo<RateContext>(
    () => ({ pricingBase, ratesByDate, services: [] }),
    [pricingBase, ratesByDate],
  )

  // Входы калькулятора — общие для расчёта и для ключа «изменились ли входы».
  // Три счётчика формы кладём в поля `*WithMeals`: на проживание деление не влияет,
  // а старые поля остаются ради 107 существующих броней (см. NOTES).
  const calcInput = useMemo<CalcInput>(() => ({
    checkIn: watchedCheckIn,
    checkOut: watchedCheckOut,
    categoryId,
    categoryName,
    adultsWithMeals: adults,
    childrenWithMeals: children,
    adultsNoMeals: 0,
    childrenNoMeals: 0,
    extraBedsWithMeals: extraBeds,
    extraBedsNoMeals: 0,
    disabledAdults,
    disabledChildren,
    discountPercent,
    prepaymentPercent,
  }), [
    watchedCheckIn, watchedCheckOut, categoryId, categoryName,
    adults, children, extraBeds, disabledAdults, disabledChildren,
    discountPercent, prepaymentPercent,
  ])

  // Проживание — из калькулятора, услуги — из выбранных строк. Складываем здесь,
  // потому что скидка считается от ВСЕГО счёта: так же, как её пишет сервер.
  const calcResult = useMemo<CalcResult>(() => {
    const base = calculate(calcInput, rateCtx)
    const svc: BreakdownLine[] = servicePreviewLines(serviceLinks, servicesById, base.nights)
    if (svc.length === 0) return base

    const total = base.total + svc.reduce((s, l) => s + l.amount, 0)
    const discount = discountPercent > 0 ? Math.round(total * discountPercent / 100) : 0
    const totalAfterDiscount = total - discount
    const prepaid = Math.round(totalAfterDiscount * (prepaymentPercent / 100))
    return {
      ...base,
      breakdown: [...base.breakdown, ...svc],
      total,
      totalAfterDiscount,
      prepaidAmount: prepaid,
      remaining: totalAfterDiscount - prepaid,
    }
  }, [calcInput, rateCtx, serviceLinks, servicesById, discountPercent, prepaymentPercent])

  // Базовый ключ входов — из СЕРВЕРНОЙ версии брони (категория: room.category.name из BOOKING_SELECT)
  const baseCalcKey = useMemo(() => {
    if (!serverBooking) return null
    return buildCalcKey({
      checkIn: serverBooking.checkIn.slice(0, 10),
      checkOut: serverBooking.checkOut.slice(0, 10),
      categoryId: serverBooking.room?.category?.id ?? 0,
      categoryName: serverBooking.room?.category?.name ?? '',
      // Сравниваем в той же системе координат, что и форма: гости сложены по типам,
      // иначе открытие старой брони «с питанием + без питания» само выглядело бы
      // как изменение и переоценивало её по сегодняшнему тарифу.
      adultsWithMeals: (serverBooking.adultsWithMeals ?? 0) + (serverBooking.adultsNoMeals ?? 0),
      childrenWithMeals: (serverBooking.childrenWithMeals ?? 0) + (serverBooking.childrenNoMeals ?? 0),
      adultsNoMeals: 0,
      childrenNoMeals: 0,
      extraBedsWithMeals: (serverBooking.extraBedsWithMeals ?? 0) + (serverBooking.extraBedsNoMeals ?? 0),
      extraBedsNoMeals: 0,
      disabledAdults: serverBooking.disabledAdults ?? 0,
      disabledChildren: serverBooking.disabledChildren ?? 0,
      discountPercent: serverBooking.discountPercent ?? 0,
      prepaymentPercent: serverBooking.prepaymentPercent ?? 50,
    })
  }, [serverBooking])

  // Питание — такой же вход тарифа, как даты и гости: сняли обед — итог обязан
  // пересчитаться, иначе форма показывала бы старую сохранённую сумму.
  const baseServicesKey = useMemo(
    () => (serverBooking ? linksKey(linksFromBooking(serverBooking.services)) : null),
    [serverBooking],
  )

  // В edit итог пересчитываем только если изменились входы калькулятора (даты, категория, гости,
  // скидка, предоплата) или админ нажал «Пересчитать по тарифу». Иначе правка заметки на ноутбуке
  // с другим тарифом в localStorage молча переоценивала бронь.
  // rooms.length > 0: пока номера не загружены, categoryName пустой и ключи различались бы ложно.
  const inputsChanged = isEdit && baseCalcKey !== null && rooms.length > 0
    && (baseCalcKey !== buildCalcKey(calcInput) || baseServicesKey !== linksKey(serviceLinks))
  const sendTotals = !isEdit || recalc || inputsChanged
  // Цен на эти даты нет (или ещё грузятся): 0 из калькулятора — не цена, суммы не отправляем.
  // Итог всё равно соберёт сервер из строк начислений — он и есть источник истины.
  const includeTotals = sendTotals && !calcResult.noRates && !ratesLoading

  // Real-time availability check
  useEffect(() => {
    if (!watchedRoomId || !watchedCheckIn || !watchedCheckOut) return
    if (watchedCheckOut <= watchedCheckIn) return

    const timer = setTimeout(async () => {
      setChecking(true)
      try {
        const result = await checkAvailability({
          roomId: Number(watchedRoomId),
          checkIn: watchedCheckIn,
          checkOut: watchedCheckOut,
          excludeBookingId: isEdit ? booking?.id : undefined,
        })
        setConflict(result.conflict)
      } finally {
        setChecking(false)
      }
    }, 400)

    return () => clearTimeout(timer)
  }, [watchedRoomId, watchedCheckIn, watchedCheckOut])

  // Escape закрывает сначала диалог подтверждения, и только потом саму форму —
  // иначе одно нажатие выбрасывало бы из недописанной брони.
  useEffect(() => {
    if (!modal.open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (allotmentWarning) { setAllotmentWarning(null); return }
      if (earlyCheckoutConfirm) { setEarlyCheckoutConfirm(false); return }
      closeModal()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [modal.open, allotmentWarning, earlyCheckoutConfirm])

  const todayStr = format(new Date(), 'yyyy-MM-dd')
  const effectiveToday = shiftDate ?? todayStr

  const submitValues = async (values: FormValues, allowAllotmentOverride = false) => {
    if (conflict) return
    // Enter в поле формы обходит disabled-кнопку — не отправляем нули, пока бронь не загружена
    if (isEdit && loadingBooking) return

    // Block past-date bookings and check-ins (only maintenance allowed retroactively).
    // Сравниваем с датой рабочей смены (effectiveToday), а не с датой устройства —
    // иначе при вводе исторических данных всё считается «прошедшим».
    if (!isMaintenance && !isEdit && values.checkIn < effectiveToday) {
      setApiError('Нельзя создавать бронь или заезд на прошедшие даты. Для закрытия номера используйте «Ремонт».')
      return
    }

    setSubmitting(true)
    setApiError('')
    try {
      const payload = {
        roomId: Number(values.roomId),
        guestName: values.guestName.trim() || (isMaintenance ? 'Ремонт' : ''),
        guestPhone: isMaintenance ? undefined : (values.guestPhone.trim() || undefined),
        checkIn: values.checkIn,
        checkOut: values.checkOut,
        source: isMaintenance ? 'ремонт' : (values.source || undefined),
        notes: values.notes.trim() || undefined,
        status: (!isEdit && values.immediateCheckIn) ? ('CHECKED_IN' as const) : undefined,
        // Гости. Форма считает их по типам один раз, поэтому всех пишем в поля
        // `*WithMeals`, а парные `*NoMeals` обнуляем: колонки остались ради 107
        // старых броней, но новые данные больше не разбиваются надвое —
        // кому начислять питание, сказано в `services`.
        adultsWithMeals: adults,
        childrenWithMeals: children,
        adultsNoMeals: 0,
        childrenNoMeals: 0,
        extraBedsWithMeals: extraBeds,
        extraBedsNoMeals: 0,
        // Питание и услуги — целиком: сервер заменяет набор, снятая галочка = удаление.
        // Но если полную бронь загрузить не удалось, набор в форме пустой не потому,
        // что питание сняли, а потому что его не показали — тогда поле не отправляем
        // вовсе, и сервер оставляет услуги брони как есть.
        ...(!isEdit || serverBooking ? { services: linksToPayload(serviceLinks) } : {}),
        disabledAdults,
        disabledChildren,
        discountPercent,
        prepaymentPercent,
        // Итог и предоплата — только при создании, изменении входов или явном «Пересчитать»
        ...(includeTotals
          ? { totalAmount: calcResult.totalAfterDiscount, prepaidAmount: calcResult.prepaidAmount }
          : {}),
        paidAmount,
        flags: [...selectedFlags, ...(customFlag.trim() ? [customFlag.trim()] : [])],
        // Строки начислений сервер пересобирает сам при изменении дат/гостей/скидки;
        // здесь просим это явно, когда админ нажал «Пересчитать по тарифу».
        ...(recalc ? { recalcCharges: true } : {}),
        ...(allowAllotmentOverride ? { allowAllotmentOverride: true } : {}),
      }

      if (isEdit && booking) {
        await updateBooking(booking.id, payload)
      } else {
        await createBooking(payload)
      }

      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (err: unknown) {
      const res = (err as { response?: { status?: number; data?: { error?: string; code?: string } } })?.response
      // Номер выделен партнёру. Это не запрет: отель вправе его продать, но осознанно —
      // поэтому спрашиваем подтверждение, а не упираемся в красную ошибку.
      if (res?.status === 409 && res?.data?.code === 'ALLOTMENT_CONFLICT') {
        pendingValues.current = values
        setAllotmentWarning(res.data.error ?? 'Номер выделен партнёру по квоте')
        return
      }
      setApiError(res?.data?.error ?? 'Ошибка сохранения')
    } finally {
      setSubmitting(false)
    }
  }

  const onSubmit = (values: FormValues) => submitValues(values, false)

  const confirmAllotmentOverride = () => {
    const values = pendingValues.current
    setAllotmentWarning(null)
    if (values) submitValues(values, true)
  }

  const handleCancel = async () => {
    if (!booking || !confirm('Отменить бронь?')) return
    setSubmitting(true)
    try {
      await cancelBooking(booking.id)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch {
      setApiError('Ошибка отмены')
    } finally {
      setSubmitting(false)
    }
  }

  const handleCheckIn = async () => {
    if (!booking) return
    setSubmitting(true)
    try {
      await checkInBooking(booking.id)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch {
      setApiError('Ошибка отметки заезда')
    } finally {
      setSubmitting(false)
    }
  }

  const isSameDayCheckout = !!booking && booking.checkIn.slice(0, 10) === effectiveToday

  const handleCheckOut = async () => {
    if (!booking) return

    // Если выезд раньше запланированной даты — показываем подтверждение
    const plannedCheckOut = booking.checkOut.slice(0, 10)
    if (effectiveToday < plannedCheckOut && !earlyCheckoutConfirm) {
      setEarlyCheckoutConfirm(true)
      return
    }

    setEarlyCheckoutConfirm(false)
    setSubmitting(true)
    try {
      await checkOutBooking(booking.id)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch {
      setApiError('Ошибка отметки выезда')
    } finally {
      setSubmitting(false)
    }
  }

  if (!modal.open) return null
  if (modal.mode === 'move') return null  // Move-режим обрабатывает MoveBookingModal
  if (modal.mode === 'view') return null  // View-режим обрабатывает BookingViewModal

  const isClosed = booking?.status === 'CANCELLED' || booking?.status === 'CHECKED_OUT'
  const isCheckedIn = booking?.status === 'CHECKED_IN'

  // Заезд доступен только если дата заезда брони не позже сегодняшней даты смены
  const canCheckIn = isEdit && booking?.status === 'CONFIRMED' &&
    !!booking?.checkIn && booking.checkIn.slice(0, 10) <= effectiveToday
  const canCheckOut = isEdit && isCheckedIn

  const title = isMaintenance
    ? '🔧 Ремонт / Блокировка'
    : isEdit
      ? 'Бронь'
      : 'Новая бронь'

  const nightsLabel = watchedCheckIn && watchedCheckOut && watchedCheckOut > watchedCheckIn
    ? `${calcResult.nights} ночей · ${watchedCheckIn} – ${watchedCheckOut}`
    : 'Выберите даты'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '28px 24px',
        overflow: 'auto',
      }}
    >
      <div
        style={{
          // relative — чтобы диалог «Ранний выезд» (absolute; inset: 0) накрывал только форму
          position: 'relative',
          width: 960,
          maxWidth: '100%',
          maxHeight: 'calc(100vh - 56px)',
          background: 'var(--bg)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 14,
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        {/* ── LEFT: Guest info ── */}
        <div style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--border-subtle)',
          background: 'var(--bg)',
        }}>
          {/* Header */}
          <div style={{
            padding: '18px 22px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 9, background: 'var(--accent-bg)', flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-text)',
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v4M16 2v4" /><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M3 10h18" />
                </svg>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3, minWidth: 0 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '1rem', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>
                  {title}
                  {isEdit && booking && (
                    <span style={{
                      padding: '2px 9px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600,
                      background: 'var(--surface-2)', color: 'var(--text-muted)',
                    }}>{STATUS_LABELS[booking.status]}</span>
                  )}
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {categoryName ? `${categoryName} · ` : ''}{nightsLabel}
                </span>
              </div>
            </div>
            <button onClick={closeModal} title="Закрыть" style={{
              width: 32, height: 32, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'transparent', border: '1px solid var(--border-subtle)', borderRadius: 8,
              color: 'var(--text-muted)', cursor: 'pointer',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>

          {/* Form (scrollable) */}
          <form
            id="booking-form"
            onSubmit={handleSubmit(onSubmit)}
            style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: 14 }}
          >
            {/* Guest name / Reason — самым первым */}
            <Field label={isMaintenance ? 'Причина' : 'Имя гостя'} error={errors.guestName?.message}>
              <input
                type="text"
                placeholder={isMaintenance ? 'Ремонт, замена сантехники...' : 'Иванов Иван'}
                {...register('guestName', { required: isMaintenance ? 'Укажите причину' : 'Укажите имя гостя' })}
                disabled={isClosed}
                style={inputStyle}
              />
            </Field>

            {/* Phone — вторым */}
            {!isMaintenance && (
              <Field label="Телефон">
                <input
                  type="tel"
                  placeholder="+7 (___) ___-__-__"
                  {...register('guestPhone')}
                  disabled={isClosed}
                  style={inputStyle}
                />
              </Field>
            )}

            {/* Room */}
            <Field label="Номер комнаты" error={errors.roomId?.message}>
              <Controller
                name="roomId"
                control={control}
                rules={{ validate: v => Number(v) > 0 || 'Выберите номер' }}
                render={({ field }) => (
                  <RoomPicker
                    rooms={rooms}
                    value={Number(field.value)}
                    onChange={(id) => field.onChange(id)}
                    checkIn={watchedCheckIn}
                    checkOut={watchedCheckOut}
                    excludeBookingId={isEdit ? booking?.id : undefined}
                    disabled={isClosed}
                    onOccupied={setRoomOccupied}
                  />
                )}
              />
            </Field>

            {/* Dates */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Дата заезда" error={errors.checkIn?.message}>
                <Controller
                  name="checkIn"
                  control={control}
                  rules={{ required: 'Укажите дату заезда' }}
                  render={({ field }) => (
                    <DatePicker value={field.value} onChange={field.onChange} disabled={isClosed} />
                  )}
                />
              </Field>
              <Field label="Дата выезда" error={errors.checkOut?.message}>
                <Controller
                  name="checkOut"
                  control={control}
                  rules={{
                    required: 'Укажите дату выезда',
                    validate: (v) => v > watchedCheckIn || 'Выезд должен быть позже заезда',
                  }}
                  render={({ field }) => (
                    <DatePicker value={field.value} onChange={field.onChange} min={watchedCheckIn} disabled={isClosed} />
                  )}
                />
              </Field>
            </div>

            {/* Availability feedback */}
            {checking && (
              <div style={infoBoxStyle('#f0f9ff', '#0369a1')}>Проверяем доступность...</div>
            )}
            {conflict && !checking && (
              <div style={{
                ...infoBoxStyle('#fef2f2', '#dc2626'),
                fontWeight: 600,
                border: '1px solid #fca5a5',
              }}>
                🚫 Номер занят: <strong>{conflict.guestName}</strong>{' '}
                ({conflict.checkIn.slice(0, 10)} — {conflict.checkOut.slice(0, 10)})<br />
                <span style={{ fontWeight: 400, fontSize: '0.88rem' }}>Сохранение заблокировано — выберите другой номер или измените даты.</span>
              </div>
            )}
            {!conflict && !checking && roomOccupied && watchedCheckIn && watchedCheckOut && (
              <div style={{
                ...infoBoxStyle('#fef2f2', '#dc2626'),
                fontWeight: 600,
                border: '1px solid #fca5a5',
              }}>
                🚫 Выбранный номер занят на эти даты.<br />
                <span style={{ fontWeight: 400, fontSize: '0.88rem' }}>Сохранение заблокировано — выберите другой номер или измените даты.</span>
              </div>
            )}
            {!conflict && !checking && !roomOccupied && watchedCheckIn && watchedCheckOut && watchedCheckOut > watchedCheckIn && (
              <div style={infoBoxStyle('#f0fdf4', '#15803d')}>
                ✓ Номер свободен на выбранные даты
              </div>
            )}


            {/* Source */}
            {!isMaintenance && (
              <Field label="Источник брони">
                <select {...register('source')} disabled={isClosed} style={selectStyle}>
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </Field>
            )}

            {/* Booking flags — только видимые (скрытые настраиваются в Настройки → Метки броней) */}
            {!isMaintenance && (
              <FlagsField
                flags={(roomFund.bookingFlags ?? []).filter(f => !hiddenFlagCodes.includes(f.id))}
                selected={selectedFlags}
                customFlag={customFlag}
                onToggle={(id) => setSelectedFlags(prev =>
                  prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
                )}
                onCustomChange={setCustomFlag}
                disabled={isClosed}
              />
            )}

            {/* Notes */}
            <Field label="Примечания">
              <textarea
                rows={2}
                placeholder="Особые пожелания..."
                {...register('notes')}
                disabled={isClosed}
                style={{ ...inputStyle, resize: 'vertical', height: 56 }}
              />
            </Field>

            {/* immediateCheckIn управляется программно через prefillImmediateCheckIn */}
            <input type="hidden" {...register('immediateCheckIn')} />

            {apiError && (
              <div style={infoBoxStyle('#fef2f2', '#dc2626')}>{apiError}</div>
            )}
          </form>

          {/* Action buttons (bottom, fixed) */}
          <div style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
            justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {canCheckIn && (
                <button type="button" onClick={handleCheckIn} disabled={submitting} style={actionBtn('#059669')}>
                  ✓ Заезд
                </button>
              )}
              {canCheckOut && (
                <button type="button" onClick={handleCheckOut} disabled={submitting} style={actionBtn('#d97706')}>
                  ✓ Выезд
                </button>
              )}
              {isEdit && !isClosed && !isCheckedIn && (
                <button type="button" onClick={handleCancel} disabled={submitting} style={actionBtn('#dc2626')}>
                  Отменить бронь
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={closeModal} style={cancelBtnStyle}>
                Закрыть
              </button>
              {!isClosed && (
                <button
                  form="booking-form"
                  type="submit"
                  disabled={submitting || loadingBooking || !!conflict || roomOccupied}
                  title={conflict || roomOccupied ? 'Номер занят на выбранные даты' : undefined}
                  style={submitBtnStyle(!!conflict || roomOccupied || submitting || loadingBooking)}
                >
                  {submitting ? 'Сохранение...' : loadingBooking ? 'Загрузка…' : isEdit ? 'Сохранить' : 'Создать бронь'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Early checkout confirmation dialog ── */}
        {earlyCheckoutConfirm && booking && (
          <div style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{
              background: 'var(--bg)',
              borderRadius: 14,
              padding: '32px 28px',
              maxWidth: 420,
              width: '90%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              display: 'flex',
              flexDirection: 'column',
              gap: 20,
            }}>
              {/* Icon + title */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: isSameDayCheckout ? '#fee2e2' : '#fef3c7',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.69rem', flexShrink: 0,
                }}>{isSameDayCheckout ? '🗑' : '⚠'}</div>
                <div>
                  <div style={{ fontSize: '1.23rem', fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
                    {isSameDayCheckout ? 'Выезд день в день' : 'Ранний выезд'}
                  </div>
                  <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)' }}>
                    Требуется подтверждение
                  </div>
                </div>
              </div>

              {/* Info */}
              <div style={{
                background: 'var(--surface-2)',
                borderRadius: 10,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Гость</span>
                  <span style={{ fontWeight: 600, color: 'var(--text)' }}>{booking.guestName}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Дата заезда</span>
                  <span style={{ fontWeight: 600, color: 'var(--text)' }}>{booking.checkIn.slice(0, 10)}</span>
                </div>
                {!isSameDayCheckout && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>По брони до</span>
                      <span style={{ fontWeight: 600, color: 'var(--text)' }}>{booking.checkOut.slice(0, 10)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>Фактический выезд</span>
                      <span style={{ fontWeight: 600, color: '#d97706' }}>{effectiveToday}</span>
                    </div>
                    {(() => {
                      const planned = new Date(booking.checkOut.slice(0, 10))
                      const actual  = new Date(effectiveToday)
                      const diff    = Math.round((planned.getTime() - actual.getTime()) / 86400_000)
                      return diff > 0 ? (
                        <div style={{
                          marginTop: 4,
                          padding: '8px 12px',
                          background: '#fef3c7',
                          borderRadius: 8,
                          fontSize: '0.92rem',
                          color: '#92400e',
                          fontWeight: 500,
                        }}>
                          Неиспользовано {diff} {diff === 1 ? 'ночь' : diff < 5 ? 'ночи' : 'ночей'}.
                          Возможность возврата за неиспользованные дни будет добавлена позже.
                        </div>
                      ) : null
                    })()}
                  </>
                )}
              </div>

              <div style={{ fontSize: '1rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {isSameDayCheckout
                  ? 'Гость выезжает в день заезда. Бронь будет удалена — номер освободится немедленно.'
                  : 'Гость выезжает раньше запланированного срока. Дата выезда в брони будет обновлена автоматически.'
                }
              </div>

              {/* Buttons */}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setEarlyCheckoutConfirm(false)}
                  style={cancelBtnStyle}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={handleCheckOut}
                  disabled={submitting}
                  style={{
                    padding: '9px 20px',
                    background: isSameDayCheckout ? '#dc2626' : '#d97706',
                    color: '#fff',
                    border: 'none',
                    borderRadius: 8,
                    fontSize: '1rem',
                    fontWeight: 600,
                    cursor: submitting ? 'not-allowed' : 'pointer',
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  {submitting
                    ? 'Оформляем...'
                    : isSameDayCheckout
                    ? 'Да, удалить бронь'
                    : 'Да, оформить выезд'
                  }
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Partner allotment confirmation dialog ── */}
        {/* Квота партнёра — не глухой запрет: отель вправе продать выделенный номер,
            но это должно быть решением администратора, а не молчаливым обходом. */}
        {allotmentWarning && (
          <div style={{
            position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: 'var(--bg)', borderRadius: 14, padding: '28px 26px', maxWidth: 440, width: '90%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 18,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12, background: '#fef3c7', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem',
                }}>🤝</div>
                <div>
                  <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
                    Номер выделен партнёру
                  </div>
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Требуется подтверждение</div>
                </div>
              </div>

              <div style={{
                background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px',
                fontSize: '0.95rem', color: 'var(--text)', lineHeight: 1.5,
              }}>
                {allotmentWarning}
              </div>

              <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                Если продать этот номер, партнёр приедет к занятому номеру. Подтвердите,
                только если это согласовано.
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setAllotmentWarning(null)} style={cancelBtnStyle}>
                  Отмена
                </button>
                <button
                  type="button"
                  onClick={confirmAllotmentOverride}
                  disabled={submitting}
                  style={{
                    padding: '9px 20px', background: '#d97706', color: '#fff', border: 'none',
                    borderRadius: 8, fontSize: '1rem', fontWeight: 600,
                    cursor: submitting ? 'not-allowed' : 'pointer', opacity: submitting ? 0.7 : 1,
                  }}
                >
                  {submitting ? 'Сохраняем…' : 'Всё равно забронировать'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── RIGHT: Calculator ── */}
        {!isMaintenance && (
          <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', minWidth: 0 }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px',
              borderBottom: '1px solid var(--border)',
              flexShrink: 0,
            }}>
              <div style={{ fontSize: '1.23rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
                Калькулятор стоимости
              </div>
              <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', marginTop: 4 }}>
                {nightsLabel}
                {categoryName && <span style={{ marginLeft: 8, color: '#6366f1', fontWeight: 600 }}>{categoryName}</span>}
              </div>
            </div>

            {/* Calculator form (scrollable) */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px' }}>

              {/* Начисления существуют только у сохранённой брони: строки привязаны к её id.
                  Для новой брони справа виден предпросмотр по тарифу, а строки создаст сервер. */}
              {isEdit && booking && (
                <ChargesPanel
                  bookingId={booking.id}
                  readOnly={isClosed}
                  onChanged={(b) => { if (b) setServerBooking(b) }}
                />
              )}

              {/* ── 1. Гости ── три счётчика вместо шести. Типы разделены, потому что
                  в календаре цен у взрослого, ребёнка и доп. места РАЗНЫЕ цены. */}
              <CalcSection title="Гости" badge={adults + children + extraBeds}>
                <GuestCounter label="Взрослые" value={adults} onChange={setAdults} />
                <GuestCounter label="Дети" value={children} onChange={setChildren} />
                <GuestCounter label="Доп. места" value={extraBeds} onChange={setExtraBeds} />
              </CalcSection>

              {/* ── 2. Питание ── у каждой галочки своё число едоков: «завтрак на
                  двоих из троих» — обычная ситуация, а не исключение. */}
              <CalcSection title="Питание" badge={activeMealCodes.size}>
                {mealPlans.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '6px 0 10px' }}>
                    {mealPlans.map(p => {
                      const active = isPlanActive(p)
                      return (
                        <button
                          key={p.id}
                          type="button"
                          disabled={isClosed}
                          onClick={() => applyMealPlan(p)}
                          style={{
                            padding: '5px 11px', borderRadius: 20,
                            border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                            background: active ? 'var(--accent-bg)' : 'var(--surface)',
                            color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                            fontSize: '0.85rem', fontWeight: active ? 700 : 500,
                            cursor: isClosed ? 'default' : 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          {p.name}
                        </button>
                      )
                    })}
                  </div>
                )}
                {mealServices.length === 0 ? (
                  <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', padding: '4px 4px 8px', lineHeight: 1.4 }}>
                    Питание не заведено. Раздел «Тарифы и наличие» → вкладка «Питание».
                  </div>
                ) : mealServices.map(s => (
                  <ServiceRow
                    key={s.id}
                    service={s}
                    link={linkOf(s.id)}
                    guests={guestTotals}
                    disabled={isClosed}
                    onToggle={() => toggleService(s.id)}
                    onPatch={(patch) => patchLink(s.id, patch)}
                  />
                ))}
              </CalcSection>

              {/* ── 3. Доп. услуги ── из того же справочника, но добавляются поштучно */}
              <CalcSection
                title="Доп. услуги"
                defaultOpen={serviceLinks.some(l => servicesById.get(l.serviceId)?.kind !== 'meal')}
                badge={serviceLinks.filter(l => servicesById.get(l.serviceId)?.kind !== 'meal').length}
              >
                {extraServices.filter(s => linkOf(s.id)).map(s => (
                  <ServiceRow
                    key={s.id}
                    service={s}
                    link={linkOf(s.id)}
                    guests={guestTotals}
                    disabled={isClosed}
                    onToggle={() => removeService(s.id)}
                    onPatch={(patch) => patchLink(s.id, patch)}
                  />
                ))}
                <AddServiceRow
                  services={extraServices.filter(s => !linkOf(s.id))}
                  disabled={isClosed}
                  onAdd={(id) => toggleService(id)}
                />
              </CalcSection>

              <CalcSection title="Гости с инвалидностью" defaultOpen={disabledAdults + disabledChildren > 0} badge={disabledAdults + disabledChildren}>
                <GuestCounter label="Взрослые" value={disabledAdults} onChange={setDisabledAdults} />
                <GuestCounter label="Дети" value={disabledChildren} onChange={setDisabledChildren} />
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', padding: '2px 4px 6px', lineHeight: 1.4 }}>
                  Учётное поле. Льгота оформляется отдельной строкой скидки с причиной —
                  так видно, кто и на каком основании её дал.
                </div>
              </CalcSection>

              {/* Discount & Prepayment */}
              <CalcSection title="Параметры оплаты">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.95rem', color: 'var(--text-muted)' }}>Скидка (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={discountPercent}
                      onChange={e => setDiscountPercent(Math.min(100, Math.max(0, Number(e.target.value))))}
                      className="mono"
                      style={{ ...inputStyle, width: 88, textAlign: 'right' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.95rem', color: 'var(--text-muted)' }}>Предоплата (%)</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={prepaymentPercent}
                      onChange={e => setPrepaymentPercent(Math.min(100, Math.max(0, Number(e.target.value))))}
                      className="mono"
                      style={{ ...inputStyle, width: 88, textAlign: 'right' }}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ fontSize: '0.95rem', color: 'var(--text-muted)' }}>Оплачено (₸)</label>
                    <input
                      type="number"
                      min={0}
                      value={paidAmount}
                      onChange={e => setPaidAmount(Math.max(0, Number(e.target.value)))}
                      className="mono"
                      style={{ ...inputStyle, width: 128, textAlign: 'right' }}
                    />
                  </div>
                </div>
              </CalcSection>

            </div>

            {/* Result card (bottom, fixed) */}
            <div style={{
              padding: '16px 20px',
              borderTop: '1px solid #e2e8f0',
              background: '#fff',
              flexShrink: 0,
            }}>
              <ResultCard
                result={calcResult}
                discountPercent={discountPercent}
                prepaymentPercent={prepaymentPercent}
                categoryName={categoryName}
                loading={loadingBooking || ratesLoading}
                saved={isEdit && !sendTotals ? {
                  totalAmount: (serverBooking ?? booking)?.totalAmount,
                  prepaidAmount: (serverBooking ?? booking)?.prepaidAmount,
                  paidAmount,
                } : null}
                onRecalc={() => setRecalc(true)}
                willRecalc={isEdit && sendTotals}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── RoomPicker ───────────────────────────────────────────────────────────────

interface RoomPickerProps {
  rooms: Room[]
  value: number
  onChange: (id: number) => void
  checkIn: string
  checkOut: string
  excludeBookingId?: number
  disabled: boolean
  onOccupied?: (occupied: boolean) => void
}

const RoomPicker: React.FC<RoomPickerProps> = ({
  rooms, value, onChange, checkIn, checkOut, excludeBookingId, disabled, onOccupied,
}) => {
  const [availability, setAvailability] = useState<Record<number, 'free' | 'occupied'>>({})
  const [loadingAvail, setLoadingAvail] = useState(false)

  useEffect(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      setAvailability({})
      setLoadingAvail(false)
      onOccupied?.(false)
      return
    }
    // Сразу показываем "Проверяем..." и сбрасываем старые данные
    setLoadingAvail(true)
    setAvailability({})
    const timer = setTimeout(async () => {
      try {
        const result = await fetchRoomAvailability(checkIn, checkOut, excludeBookingId)
        setAvailability(result)
      } catch (e) {
        console.error('Availability fetch error:', e)
      } finally {
        setLoadingAvail(false)
      }
    }, 400)
    return () => { clearTimeout(timer) }
  }, [checkIn, checkOut, excludeBookingId])

  // Сообщаем родителю об изменении доступности выбранного номера
  useEffect(() => {
    if (!value || loadingAvail) { onOccupied?.(false); return }
    const status = availability[value]
    onOccupied?.(status === 'occupied')
  }, [availability, value, loadingAvail])

  // Категории из списка комнат
  const categories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; color: string }>()
    for (const room of rooms) {
      if (!map.has(room.category.id)) map.set(room.category.id, room.category)
    }
    return [...map.values()]
  }, [rooms])

  const selectedRoom = rooms.find(r => r.id === value)
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(
    selectedRoom?.category.id ?? 0
  )

  // Синхронизируем категорию при смене комнаты извне (edit mode)
  useEffect(() => {
    if (selectedRoom) setSelectedCategoryId(selectedRoom.category.id)
  }, [selectedRoom?.category.id])

  const filteredRooms = useMemo(
    () => rooms.filter(r => r.category.id === selectedCategoryId),
    [rooms, selectedCategoryId]
  )

  const datesOk = !!(checkIn && checkOut && checkOut > checkIn)
  const freeInCategory = filteredRooms.filter(r => availability[r.id] === 'free').length
  const selectedStatus = datesOk && value ? availability[value] : undefined

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Category dropdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <label style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-faint)' }}>
          Категория
        </label>
        <select
          disabled={disabled}
          value={selectedCategoryId}
          onChange={e => {
            const catId = Number(e.target.value)
            setSelectedCategoryId(catId)
            if (selectedRoom?.category.id !== catId) onChange(0)
          }}
          style={pickerSelectStyle}
        >
          <option value={0}>— выберите категорию —</option>
          {categories.map(cat => (
            <option key={cat.id} value={cat.id}>{cat.name}</option>
          ))}
        </select>
      </div>

      {/* Room custom dropdown */}
      {selectedCategoryId > 0 && (
        <RoomDropdown
          rooms={filteredRooms}
          value={value}
          onChange={onChange}
          availability={availability}
          loadingAvail={loadingAvail}
          datesOk={datesOk}
          disabled={disabled}
          freeInCategory={freeInCategory}
          selectedStatus={selectedStatus}
        />
      )}
    </div>
  )
}

// ─── RoomDropdown (кастомный выпадающий список с точками) ─────────────────────

interface RoomDropdownProps {
  rooms: Room[]
  value: number
  onChange: (id: number) => void
  availability: Record<number, 'free' | 'occupied'>
  loadingAvail: boolean
  datesOk: boolean
  disabled: boolean
  freeInCategory: number
  selectedStatus: 'free' | 'occupied' | undefined
}

const RoomDropdown: React.FC<RoomDropdownProps> = ({
  rooms, value, onChange, availability, loadingAvail, datesOk, disabled,
  freeInCategory, selectedStatus,
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Закрываем при клике вне компонента
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const selectedRoom = rooms.find(r => r.id === value)

  const dotColor = (roomId: number) => {
    if (loadingAvail) return 'var(--border-strong)'
    const st = datesOk ? availability[roomId] : undefined
    if (st === 'free') return '#16a34a'
    if (st === 'occupied') return '#dc2626'
    return 'var(--border-strong)'
  }

  const triggerBorderColor = selectedStatus === 'occupied' ? '#fca5a5'
    : selectedStatus === 'free' ? '#86efac'
    : 'var(--border)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Label row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-faint)' }}>
          Номер комнаты
        </label>
        {datesOk && (
          <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>
            {loadingAvail
              ? 'Проверяем...'
              : Object.keys(availability).length > 0
                ? <><span style={{ color: '#16a34a', fontWeight: 700 }}>{freeInCategory}</span>{' из '}{rooms.length}{' свободны'}</>
                : null
            }
          </span>
        )}
      </div>

      {/* Custom dropdown trigger */}
      <div ref={ref} style={{ position: 'relative' }}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen(o => !o)}
          style={{
            width: '100%',
            padding: '8px 32px 8px 10px',
            border: `1px solid ${triggerBorderColor}`,
            borderRadius: open ? 'var(--ui-radius) var(--ui-radius) 0 0' : 'var(--ui-radius)',
            fontSize: 'inherit',
            background: 'var(--bg)',
            color: value ? 'var(--text)' : 'var(--text-faint)',
            cursor: disabled ? 'default' : 'pointer',
            textAlign: 'left',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            position: 'relative',
          }}
        >
          {/* Dot for selected room */}
          {value > 0 && (
            <span style={{
              width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
              background: dotColor(value),
              transition: 'background 0.2s',
            }} />
          )}
          <span style={{ flex: 1 }}>
            {selectedRoom
              ? `№${selectedRoom.number} — корп. ${selectedRoom.building}, эт. ${selectedRoom.floor}`
              : '— выберите номер —'
            }
          </span>
          {/* Arrow */}
          <span style={{
            position: 'absolute', right: 10,
            fontSize: '0.75rem',
            color: 'var(--text-faint)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
            pointerEvents: 'none',
          }}>▼</span>
        </button>

        {/* Dropdown list */}
        {open && (
          <div style={{
            position: 'absolute',
            top: '100%', left: 0, right: 0,
            zIndex: 200,
            background: 'var(--bg)',
            border: `1px solid ${triggerBorderColor}`,
            borderTop: 'none',
            borderRadius: '0 0 var(--ui-radius) var(--ui-radius)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            maxHeight: 260,
            overflowY: 'auto',
          }}>
            {/* "Не выбрано" option */}
            <button
              type="button"
              onClick={() => { onChange(0); setOpen(false) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                width: '100%', padding: '9px 12px',
                border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                background: value === 0 ? 'var(--surface-2)' : 'transparent',
                cursor: 'pointer', textAlign: 'left',
                color: 'var(--text-faint)', fontSize: 'inherit',
              }}
            >
              — выберите номер —
            </button>

            {rooms.length === 0 ? (
              <div style={{ padding: '10px 12px', color: 'var(--text-faint)', fontSize: '0.92rem' }}>
                Нет номеров в этой категории
              </div>
            ) : (
              rooms.map((room, idx) => {
                const st = datesOk ? availability[room.id] : undefined
                const isFree = st === 'free'
                const isSelected = room.id === value

                return (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => { onChange(room.id); setOpen(false) }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      width: '100%', padding: '9px 12px',
                      border: 'none',
                      borderTop: idx > 0 ? '1px solid var(--border-subtle)' : 'none',
                      background: isSelected ? 'var(--accent-bg)' : 'transparent',
                      cursor: 'pointer', textAlign: 'left',
                    }}
                    onMouseEnter={e => {
                      if (!isSelected)
                        (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)'
                    }}
                    onMouseLeave={e => {
                      if (!isSelected)
                        (e.currentTarget as HTMLButtonElement).style.background = 'transparent'
                    }}
                  >
                    {/* Availability dot */}
                    <span style={{
                      width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                      background: dotColor(room.id),
                      transition: 'background 0.2s',
                    }} />

                    {/* Room number */}
                    <span style={{
                      flex: 1, fontSize: 'inherit',
                      fontWeight: isSelected ? 700 : 500,
                      color: isSelected ? 'var(--accent-text)' : 'var(--text)',
                    }}>
                      №{room.number}
                    </span>

                    {/* Building / floor */}
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>
                      корп. {room.building}, эт. {room.floor}
                    </span>

                    {/* Status label */}
                    {datesOk && !loadingAvail && st && (
                      <span style={{
                        fontSize: '0.77rem', fontWeight: 700,
                        color: isFree ? '#16a34a' : '#dc2626',
                        minWidth: 60, textAlign: 'right',
                      }}>
                        {isFree ? 'Свободен' : 'Занят'}
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Status badge for selected room */}
      {value > 0 && datesOk && !loadingAvail && selectedStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '7px 10px', borderRadius: 6,
          background: selectedStatus === 'free' ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${selectedStatus === 'free' ? '#86efac' : '#fca5a5'}`,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: selectedStatus === 'free' ? '#16a34a' : '#dc2626',
          }} />
          <span style={{
            fontSize: '0.88rem', fontWeight: 600,
            color: selectedStatus === 'free' ? '#15803d' : '#dc2626',
          }}>
            {selectedStatus === 'free'
              ? 'Номер свободен на выбранные даты'
              : 'Номер занят на выбранные даты — выберите другой'}
          </span>
        </div>
      )}
    </div>
  )
}

const pickerSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', background: 'var(--bg)',
  color: 'var(--text)', cursor: 'pointer', outline: 'none',
}

// ─── FlagsField ───────────────────────────────────────────────────────────────

interface FlagsFieldProps {
  flags: BookingFlagItem[]
  selected: string[]
  customFlag: string
  onToggle: (id: string) => void
  onCustomChange: (v: string) => void
  disabled: boolean
}

const FlagsField: React.FC<FlagsFieldProps> = ({ flags, selected, customFlag, onToggle, onCustomChange, disabled }) => {
  const hasAny = selected.length > 0 || customFlag.trim()
  if (flags.length === 0 && !hasAny) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: '0.9em', fontWeight: 600, color: 'var(--text)' }}>Метки</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {flags.map(f => {
          const active = selected.includes(f.id)
          return (
            <button
              key={f.id}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(f.id)}
              style={{
                padding: '5px 12px',
                borderRadius: 20,
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-bg)' : 'var(--surface)',
                color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                fontSize: '0.92rem',
                fontWeight: active ? 700 : 500,
                cursor: disabled ? 'default' : 'pointer',
                transition: 'all 0.12s',
              }}
            >
              {active && <span style={{ marginRight: 4 }}>✓</span>}
              {f.label}
            </button>
          )
        })}
      </div>
      <input
        type="text"
        value={customFlag}
        onChange={e => onCustomChange(e.target.value)}
        disabled={disabled}
        placeholder="Или введите произвольную метку..."
        style={{
          ...({
            padding: '6px 10px',
            border: `1px solid ${customFlag.trim() ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 'var(--ui-radius)',
            fontSize: 'inherit',
            outline: 'none',
            width: '100%',
            boxSizing: 'border-box' as const,
            fontFamily: 'inherit',
            background: 'var(--bg)',
            color: 'var(--text)',
          }),
        }}
      />
    </div>
  )
}

// ─── Shared styles ────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
  background: 'var(--bg)',
  color: 'var(--text)',
}

const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

const submitBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 20px',
  background: disabled ? 'var(--surface-3)' : 'var(--accent)',
  color: disabled ? 'var(--text-faint)' : '#fff',
  border: 'none',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
})

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
}

const actionBtn = (color: string): React.CSSProperties => ({
  padding: '8px 12px',
  background: color,
  color: '#fff',
  border: 'none',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  fontWeight: 600,
  cursor: 'pointer',
})

const infoBoxStyle = (bg: string, color: string): React.CSSProperties => ({
  padding: '8px 12px',
  borderRadius: 6,
  background: bg,
  color,
  fontSize: '0.92rem',
})
