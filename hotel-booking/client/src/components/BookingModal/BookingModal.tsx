import React, { useEffect, useState, useMemo, useRef } from 'react'
import { format } from 'date-fns'
import { useForm, Controller } from 'react-hook-form'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore, BookingFlagItem } from '../../store/useSettingsStore'
import { useRealtimeStore } from '../../store/useRealtimeStore'
import { confirmDialog } from '../ui/ConfirmDialog'
import { fetchRooms } from '../../api/rooms'
import { compareRooms } from '../../utils/sortRooms'
import {
  createBooking,
  updateBooking,
  cancelBooking,
  checkInBooking,
  checkOutBooking,
  updateActualTimes,
  checkAvailability,
  fetchBooking,
  previewBooking,
} from '../../api/bookings'
import type {
  GuestDocPayload, PreviewResult, PreviewRow, MissingPrice, SettlementAction,
} from '../../api/bookings'
import { lookupGuest } from '../../api/guests'
import type {
  Room, GridBooking, Booking, Service, MealPlan,
  GuestDocType, GuestSex, GuestDocument, GuestLookup,
} from '../../types'
import type { BookingMoney } from '../../api/payments'
import { fetchRoomAvailability } from '../../api/occupancy'
import type { RoomAvailability, RoomBlockReason } from '../../api/occupancy'
import {
  accountIdOf, chainRoomsLabel, hasContinuations, isContinuation, lastSegment,
} from '../../utils/bookingAccount'
import { fetchServices, fetchMealPlans } from '../../api/services'
import { nightsBetween } from '../../utils/calculator'
import { formatApiError } from '../Setup/accountRules'
import { ChargesPanel } from './ChargesPanel'
import { AllotmentConfirm } from './AllotmentConfirm'
import { SettlementDialog } from './SettlementDialog'
import { BookingMoneyBar } from '../Payments/BookingMoneyBar'
import type { BookingMoneyBarHandle } from '../Payments/BookingMoneyBar'
import {
  defaultLinks, linksFromBooking, linksKey, linksToPayload, newLink, isPerPerson,
  syncLinksWithGuests,
} from './serviceLines'
import type { ServiceLink, GuestTotals } from './serviceLines'
import { editableFieldsChanged, docFromBooking, EMPTY_DOC } from './editableFields'
import type { DocFields } from './editableFields'
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
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
    <label style={{ fontSize: '0.9em', fontWeight: 600, color: 'var(--text)' }}>{label}</label>
    {children}
    {error && <span style={{ fontSize: '0.85rem', color: '#dc2626' }}>{error}</span>}
  </div>
)

// ─── Раскладка формы ──────────────────────────────────────────────────────────
// Окно тянется по вьюпорту, поэтому фиксированного числа колонок у групп полей
// нет: `auto-fit` + `minmax` сам решает, встанут поля рядом или друг под другом.
// Это заменяет медиазапросы (стили в проекте инлайновые) и работает от ширины
// САМОЙ колонки, а не окна — левая колонка узкая и в широком окне тоже.

/** Пара полей рядом; ниже ~460px колонки схлопываются в одну. */
const fieldGrid = (min = 210): React.CSSProperties => ({
  display: 'grid',
  gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
  gap: 14,
  alignItems: 'start',
})

/**
 * Смысловая группа полей: заголовок + разделитель сверху. Раньше форма шла одним
 * потоком из полутора десятков полей — глазу не за что было зацепиться.
 */
const FormSection: React.FC<{ title: string; first?: boolean; children: React.ReactNode }> = ({ title, first, children }) => (
  <section style={{
    display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0,
    paddingTop: first ? 0 : 20,
    marginTop: first ? 0 : 4,
    borderTop: first ? undefined : '1px solid var(--border-subtle)',
  }}>
    <div style={{
      fontSize: '0.74rem', fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: 'var(--text-faint)',
    }}>
      {title}
    </div>
    {children}
  </section>
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
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: small ? '5px 2px' : '9px 2px' }}>
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
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden', marginBottom: 14 }}>
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
        <div style={{ padding: '6px 16px 12px', borderTop: '1px solid var(--border-subtle)' }}>
          {children}
        </div>
      )}
    </div>
  )
}

const fmt = (n: number) => n.toLocaleString('ru-RU') + ' ₸'

/**
 * Кнопка, выглядящая ссылкой. Объявлена ЗДЕСЬ, до компонента: константа ниже
 * компонента падает при горячей перезагрузке с «is not defined» (мёртвая зона).
 */
const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent-text)', fontFamily: 'inherit', fontSize: 'inherit',
  textDecoration: 'underline',
}

/**
 * 'YYYY-MM-DD' → 'дд.мм.гггг'. Режем строку, а не Date: у `@db.Date` полночь по UTC,
 * и любой разбор в местную зону сдвинул бы дату на день назад.
 */
const fmtDay = (iso?: string) => {
  if (!iso || iso.length < 10) return iso ?? ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

// ─── Фактические заезд и выезд ────────────────────────────────────────────────
// Это НАСТОЯЩИЕ моменты времени, а не `@db.Date`, как плановые checkIn/checkOut.
// Поэтому здесь нигде нет `timeZone:'UTC'`: показываем и вводим местное время
// браузера — правило про UTC-полночь к этим полям не относится.

/**
 * ISO-момент → значение `<input type="datetime-local">`. Инпут живёт в местном
 * времени и без секунд, поэтому строку собираем из локальных частей даты:
 * `toISOString().slice(0,16)` дал бы UTC и сдвинул время на часовой пояс.
 */
const isoToLocalInput = (iso?: string | null): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Обратно: 'YYYY-MM-DDTHH:mm' (местное) → ISO. Пусто = «не отмечено», то есть null. */
const localInputToIso = (value: string): string | null => {
  if (!value) return null
  const d = new Date(value)   // без 'Z' браузер разбирает строку как МЕСТНОЕ время
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Показ для роли без права правки — тот же формат, что в карточке просмотра. */
const fmtDateTime = (value?: string | null) => {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'dd.MM.yyyy HH:mm')
}

/**
 * Время проставляется само кнопками «Заезд»/«Выезд». Правка руками нужна на тот
 * случай, когда кнопку нажали не вовремя. Права на неё есть у любого вошедшего:
 * ролей осталось две, и обе — администраторы (interface.md, 2026-09-08).
 * Текстом поле показывается только пока грузится полная бронь.
 */
const ActualTimeField: React.FC<{
  label: string
  /** 'YYYY-MM-DDTHH:mm' или '' */
  value: string
  /** Пока не загрузилась полная бронь — сравнивать изменения не с чем */
  readOnly?: boolean
  onChange: (v: string) => void
}> = ({ label, value, readOnly, onChange }) => (
  <Field label={label}>
    {!readOnly ? (
      <input
        type="datetime-local"
        value={value}
        onChange={e => onChange(e.target.value)}
        style={inputStyle}
      />
    ) : (
      <div style={{
        ...inputStyle,
        background: 'var(--surface-2)',
        color: 'var(--text-muted)',
        cursor: 'default',
      }}>
        {fmtDateTime(value)}
      </div>
    )}
  </Field>
)

// ─── Документ гостя ───────────────────────────────────────────────────────────
// Шесть полей, и все необязательные: бронь по телефону заводят за недели, а
// паспорт появляется на стойке при заселении. Форма держит их одним объектом
// СТРОК — набор всегда ходит целиком (из брони, из подстановки, в тело
// запроса), а '' означает «не заполнено» и станет на сервере null.
//
// Всё, что ниже, объявлено ДО компонента: константа, объявленная после него,
// падает при горячей перезагрузке с «is not defined» (временная мёртвая зона).
// В этом проекте на это наступали дважды.

// `DocFields`, `EMPTY_DOC` и `docFromBooking` переехали в `editableFields.ts`:
// сравнение «что изменилось на другом рабочем месте» обязано нормализовать
// документ ровно так же, как это делает ввод, — иначе две копии правила разойдутся.

const DOC_TYPE_OPTIONS: { value: GuestDocType; label: string }[] = [
  { value: 'passport', label: 'Паспорт' },
  { value: 'id_card',  label: 'Уд. личности' },
  { value: 'other',    label: 'Иной' },
]

const SEX_OPTIONS: { value: GuestSex; label: string }[] = [
  { value: 'm', label: 'Мужской' },
  { value: 'f', label: 'Женский' },
]

/** Документ из прошлого визита → поля формы. `from` — служебное, в форму не идёт. */
const docFromLookup = (d: GuestDocument): DocFields => ({
  guestCitizenship: d.guestCitizenship ?? '',
  guestDocType: d.guestDocType ?? '',
  guestDocNumber: d.guestDocNumber ?? '',
  // Здесь даты уже обрезаны сервером (guestController.pickDocument) — в отличие
  // от полей самой брони выше. Всё равно режем: две ветки не должны расходиться.
  guestDocExpiry: (d.guestDocExpiry ?? '').slice(0, 10),
  guestBirthDate: (d.guestBirthDate ?? '').slice(0, 10),
  guestSex: d.guestSex ?? '',
})

const docIsEmpty = (d: DocFields) => Object.values(d).every(v => !v.trim())

/**
 * Что из документа отправлять на сервер.
 *
 * `base` — каким документ был у брони. Отправляем ТОЛЬКО изменённые поля, и
 * очищенное уходит пустой строкой: сервер понимает `''` как «стереть», а
 * отсутствие ключа — как «не трогать». Разница не теоретическая: бронь
 * сохраняется и сдвигом дат из шахматки, и правкой заметки, и такое сохранение
 * не имеет права молча стереть паспорт.
 *
 * `base === null` — полную бронь загрузить не удалось. Тогда не отправляем
 * ничего: пустые поля формы в этом случае означают «не показали», а не «стёрли».
 */
function docPayload(cur: DocFields, base: DocFields | null): GuestDocPayload {
  if (!base) return {}
  const out: Record<string, string> = {}
  for (const k of Object.keys(cur) as (keyof DocFields)[]) {
    const v = cur[k].trim()
    if (v !== base[k]) out[k] = v
  }
  // Значения берутся из полей формы, а не из воздуха: тип документа и пол —
  // кнопки с фиксированным набором, даты — <input type="date">.
  return out as GuestDocPayload
}

/** «№56/2Х, апрель 2027 г.» — откуда взят документ. `timeZone:'UTC'`: @db.Date. */
const visitHint = (from: GuestDocument['from']) => {
  const when = new Date(`${from.checkIn.slice(0, 10)}T00:00:00Z`)
    .toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  return from.roomNumber ? `№${from.roomNumber}, ${when}` : when
}

/**
 * Выбор из двух-трёх вариантов пилюлями — как метки и пресеты питания в этой же
 * форме. Повторное нажатие по активной пилюле ОЧИЩАЕТ поле: тип документа и пол
 * необязательны, и «ткнул не туда» должно отменяться, а не оставаться навсегда.
 */
const ChoiceField: React.FC<{
  label: string
  value: string
  options: { value: string; label: string }[]
  disabled?: boolean
  onChange: (v: string) => void
}> = ({ label, value, options, disabled, onChange }) => (
  <Field label={label}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {options.map(o => {
        const active = value === o.value
        return (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            title={active ? 'Нажмите ещё раз, чтобы очистить' : undefined}
            onClick={() => onChange(active ? '' : o.value)}
            style={{
              padding: '6px 12px', borderRadius: 20,
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
              background: active ? 'var(--accent-bg)' : 'var(--surface)',
              color: active ? 'var(--accent-text)' : 'var(--text-muted)',
              fontSize: '0.88rem', fontWeight: active ? 700 : 500,
              cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  </Field>
)

/**
 * Шесть полей документа. Даты — обычный `<input type="date">`, а не DatePicker
 * проекта: тот листает календарь ПО МЕСЯЦАМ, и дата рождения 1988 года стоила бы
 * четырёх сотен нажатий. Ограничения длины (60 и 40) — те же, что проверяет
 * сервер: пусть поле не даст набрать лишнего, вместо 400 после «Сохранить».
 */
const DocumentFields: React.FC<{
  value: DocFields
  disabled?: boolean
  onPatch: (patch: Partial<DocFields>) => void
}> = ({ value, disabled, onPatch }) => (
  // Два ряда, а не один общий `auto-fit` на шесть полей: `auto-fit` схлопывает
  // ПУСТЫЕ дорожки, поэтому ряд из двух элементов делит всю ширину пополам —
  // и три пилюли типа документа встают в одну строку, а не переносятся.
  // В одном общем ряду им доставалась четверть ширины, и «Уд. личности»
  // уезжала на вторую строку, ломая ровные ряды.
  <>
    <div style={fieldGrid(190)}>
      <Field label="Гражданство">
        <input
          type="text"
          placeholder="Казахстан"
          maxLength={60}
          value={value.guestCitizenship}
          disabled={disabled}
          onChange={e => onPatch({ guestCitizenship: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <ChoiceField
        label="Тип документа"
        value={value.guestDocType}
        options={DOC_TYPE_OPTIONS}
        disabled={disabled}
        onChange={v => onPatch({ guestDocType: v })}
      />
    </div>

    {/* 160px — чтобы на узком окне (~800px) эти четыре вставали хотя бы
        в две колонки: шесть полей одной лентой читаются заметно хуже. */}
    <div style={fieldGrid(160)}>
      <Field label="Номер документа">
        <input
          type="text"
          placeholder="N01234567"
          maxLength={40}
          value={value.guestDocNumber}
          disabled={disabled}
          onChange={e => onPatch({ guestDocNumber: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field label="Срок действия">
        <input
          type="date"
          value={value.guestDocExpiry}
          disabled={disabled}
          onChange={e => onPatch({ guestDocExpiry: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <Field label="Дата рождения">
        <input
          type="date"
          value={value.guestBirthDate}
          disabled={disabled}
          onChange={e => onPatch({ guestBirthDate: e.target.value })}
          style={inputStyle}
        />
      </Field>
      <ChoiceField
        label="Пол"
        value={value.guestSex}
        options={SEX_OPTIONS}
        disabled={disabled}
        onChange={v => onPatch({ guestSex: v })}
      />
    </div>
  </>
)

/**
 * Строка под телефоном: «этот гость уже жил у нас — подставить документ?».
 *
 * Подставляем ТОЛЬКО по нажатию. Молча заполнить паспорт по совпадению номера
 * нельзя: телефон могли записать с ошибкой или он перешёл другому человеку, и
 * тогда в брони окажется чужой документ — а его потом отправлять в МВД.
 * После подстановки строка не исчезает, а меняется на подтверждение: иначе по
 * нажатию визуально не происходит ничего.
 */
const DocSuggestionRow: React.FC<{
  from: GuestDocument['from']
  applied: boolean
  disabled?: boolean
  onApply: () => void
}> = ({ from, applied, disabled, onApply }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    padding: '8px 12px', borderRadius: 'var(--ui-radius)',
    background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
    fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.4,
  }}>
    <span style={{ flex: '1 1 240px', minWidth: 0 }}>
      {applied
        ? <>Документ подставлен из брони ({visitHint(from)}) — проверьте поля ниже.</>
        : <>Этот гость уже жил у нас ({visitHint(from)}) — подставить документ?</>}
    </span>
    {!applied && (
      <button
        type="button"
        onClick={onApply}
        disabled={disabled}
        style={{
          padding: '5px 13px', borderRadius: 'var(--ui-radius)',
          border: '1px solid var(--accent)', background: 'var(--accent-bg)',
          color: 'var(--accent-text)', fontSize: '0.85rem', fontWeight: 600,
          cursor: disabled ? 'default' : 'pointer', fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        Подставить
      </button>
    )}
  </div>
)

/**
 * Услуга с нулевой ценой строки начисления не порождает (ноль — это незаполненный
 * тариф, а не «бесплатно»). Без пояснения это выглядит поломкой: включили
 * «Полный пансион», а итог не изменился.
 */
const UnpricedNote: React.FC<{
  names?: string[]
  /** Ветка «нет цен в календаре» уже сказала, где их заполняют — не повторяемся. */
  hideWhere?: boolean
}> = ({ names, hideWhere }) => {
  if (!names || names.length === 0) return null
  return (
    <div style={{
      marginTop: 8, padding: '7px 10px', borderRadius: 8, textAlign: 'left',
      background: 'var(--surface-2)', color: 'var(--text-muted)',
      fontSize: '0.8rem', lineHeight: 1.4,
    }}>
      Цена не задана: {names.join(', ')} — к сумме не добавлено.
      {!hideWhere && (
        <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: 2 }}>
          Цены услуг заполняются в разделе «Тарифы и наличие».
        </div>
      )}
    </div>
  )
}

const resultRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', fontSize: '0.92rem', color: 'var(--text-faint)', marginBottom: 4,
}

// ─── Предпросмотр начислений ─────────────────────────────────────────────────
// Числа приходят из `POST /bookings/preview` — того же кода, что выполняет
// сохранение. Своего расчёта у формы больше нет: до волны 5a их было два (свой
// в `utils/calculator.ts` и свой в `serviceLines.ts`), и на экране висели два
// разных итога, а в базу записывался третий (аудит D7-009).

/** Чего именно не хватает в календаре цен — говорим словами, а не кодом поля. */
const MISSING_PART_LABELS: Record<string, string> = {
  adult: 'взрослые',
  child: 'дети',
  extraBed: 'доп. место',
  room: 'номер',
}

/**
 * «На 2 ноч. цена не задана» + какие даты и что именно не заполнено.
 * Молчать нельзя: итог получится неполным, а выглядеть будет обычным.
 */
const MissingPricesNote: React.FC<{ items: MissingPrice[] }> = ({ items }) => {
  if (items.length === 0) return null
  const parts = new Set<string>()
  for (const it of items) for (const p of it.parts) parts.add(MISSING_PART_LABELS[p] ?? p)
  const dates = items.map(i => fmtDay(i.date))
  return (
    <div style={{ ...infoBoxStyle('#fffbeb', '#b45309'), fontSize: '0.85rem', marginBottom: 8 }}>
      На {items.length} ноч. цена не задана — итог неполный.
      <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
        {dates.slice(0, 6).join(', ')}
        {dates.length > 6 ? ` и ещё ${dates.length - 6}` : ''}
        {parts.size > 0 ? ` · не заполнено: ${[...parts].join(', ')}` : ''}
      </div>
      <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
        Цены заполняются в разделе «Тарифы и наличие».
      </div>
    </div>
  )
}

interface PreviewCardProps {
  preview: PreviewResult | null
  loading: boolean
  /** Предпросмотр не получен: сеть, 400 от сервера. Молча показывать ноль нельзя. */
  error: string
  /** Принято по журналу платежей — без него «остаток» соврал бы */
  paid: number
  prepaymentPercent: number
  categoryName: string
  /** Выбранные услуги без цены — строки они не породят, и это надо объяснить */
  unpricedServices?: string[]
  /**
   * Бронь закрыта (выехал или отменена). Предпросмотр по тарифу для неё был бы
   * враньём: у отменённой автоматических начислений уже нет, у выехавшей раньше
   * срока сняты непрожитые ночи. Настоящие деньги — в начислениях и в полосе
   * «Оплата» выше, туда и отправляем.
   */
  closed?: boolean
}

/**
 * Итог брони — ОДИН на экране (D7-009). Раньше их было два: «Итого по строкам»
 * в панели начислений и «Итого со скидкой» здесь, и они не совпадали. Теперь
 * панель начислений своего итога не печатает, а этот приходит с сервера.
 */
const PreviewCard: React.FC<PreviewCardProps> = ({
  preview, loading, error, paid, prepaymentPercent, categoryName, unpricedServices, closed,
}) => {
  if (closed) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.9rem', padding: '12px 0', lineHeight: 1.5 }}>
        Бронь закрыта — по тарифу больше не считается.
        <div style={{ marginTop: 4 }}>Итог и оплата — в блоках «Начисления» и «Оплата» выше.</div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ ...infoBoxStyle('#fef2f2', '#dc2626'), fontSize: '0.88rem' }}>
        {error}
        <div style={{ fontSize: '0.78rem', marginTop: 2 }}>
          Сумму считает сервер — пока он не ответил, показывать нечего.
        </div>
      </div>
    )
  }

  if (loading || !preview) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: '1rem', padding: '12px 0' }}>
        {loading ? 'Считаем…' : 'Нет данных для расчёта'}
      </div>
    )
  }

  // Проживание — по ОТРЕЗКАМ, а не по ночам: ночей может быть тридцать, и
  // список ночей здесь не нужен (он разворачивается в панели начислений).
  // Отрезок = одинаковая подпись строки: сервер пишет в неё номер, категорию и
  // состав («Проживание · №12 Стандарт · 2 взр.»). У обычной брони группа одна,
  // и строка выглядит как раньше; у цепочки после переезда их две и больше —
  // «Стандарт 2 ночи» и «Комфорт 2 ночи» видно по отдельности при одном итоге.
  const otherRows = preview.rows.filter(r => r.kind !== 'stay')
  const staySegments: { label: string; nights: number; amount: number }[] = []
  const stayIndex = new Map<string, number>()
  for (const r of preview.rows) {
    if (r.kind !== 'stay') continue
    const at = stayIndex.get(r.label)
    if (at === undefined) {
      stayIndex.set(r.label, staySegments.length)
      staySegments.push({ label: r.label, nights: 1, amount: r.amount })
    } else {
      staySegments[at].nights += 1
      staySegments[at].amount += r.amount
    }
  }
  const remaining = preview.total - paid

  if (preview.rows.length === 0) {
    return (
      <div style={{ textAlign: 'center', color: 'var(--s-out)', fontSize: '0.95rem', padding: '12px 0' }}>
        <MissingPricesNote items={preview.missingPrices} />
        {preview.missingPrices.length === 0 && (
          <>
            Начислять нечего: {categoryName ? `для категории «${categoryName}» ` : ''}
            не заданы ни цены, ни гости.
          </>
        )}
        <UnpricedNote names={unpricedServices} hideWhere={preview.missingPrices.length > 0} />
      </div>
    )
  }

  const rowLine = (r: PreviewRow, i: number) => (
    <div key={i} style={{
      display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.92rem',
      color: r.kind === 'discount' ? 'var(--s-out)' : 'var(--text-faint)', marginBottom: 4,
    }}>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.label}>
        {/* Ручная строка помечена так же, как в панели начислений: одна и та же
            строка не должна выглядеть в двух местах по-разному. */}
        {r.source === 'manual' && (
          <span style={{
            marginRight: 5, padding: '0 4px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
            background: '#fef3c7', color: '#92400e',
          }} title="Ручная строка администратора">✎</span>
        )}
        {r.label}
        {r.quantity !== 1 ? ` (${r.quantity} × ${r.unitPrice.toLocaleString('ru-RU')})` : ''}
      </span>
      <span style={{ whiteSpace: 'nowrap' }}>{fmt(r.amount)}</span>
    </div>
  )

  return (
    <div>
      <MissingPricesNote items={preview.missingPrices} />

      {/* Ночей ровно столько, сколько строк проживания: ночь без цены строки
          не порождает, и писать за неё «н.» значило бы соврать. */}
      {staySegments.map((g, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: '0.92rem', color: 'var(--text)', marginBottom: 4 }}>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.label}>
            {/* Одна группа — привычное «Проживание (4 н.)»; несколько — подпись
                сервера с номером и категорией, иначе отрезки не различить. */}
            {staySegments.length === 1 ? 'Проживание' : g.label} ({g.nights} н.)
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>{fmt(g.amount)}</span>
        </div>
      ))}
      {otherRows.map(rowLine)}

      <div style={{ borderTop: '1px solid var(--border-subtle)', marginTop: 8, paddingTop: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.15rem', fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>
          <span>Итого по строкам</span>
          <span style={{ color: '#6366f1' }}>{fmt(preview.total)}</span>
        </div>
        <div style={{ ...resultRowStyle }}>
          <span>Предоплата ({prepaymentPercent}%)</span>
          <span style={{ color: 'var(--s-in)', fontWeight: 600 }}>{fmt(preview.prepaid)}</span>
        </div>
        <div style={{ ...resultRowStyle }}>
          <span>Оплачено</span>
          <span style={{ fontWeight: 600 }}>{fmt(paid)}</span>
        </div>
        <div style={{ ...resultRowStyle }}>
          <span>{remaining < 0 ? 'Переплата' : 'Остаток'}</span>
          <span style={{ color: 'var(--s-overdue)', fontWeight: 600 }}>{fmt(Math.abs(remaining))}</span>
        </div>
        <UnpricedNote names={unpricedServices} />
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export const BookingModal: React.FC = () => {
  const {
    modal, closeModal, fetchGrid, fetchToday, shiftDate,
    openViewModal, openEditModal, findBooking, currentSegment,
  } = useGridStore()
  const { roomFund, hiddenFlagCodes } = useSettingsStore()
  // Проверки роли в форме больше нет: фактическое время правит любой вошедший —
  // ролей осталось две, и обе администраторские (interface.md, 2026-09-08).
  const [rooms, setRooms] = useState<Room[]>([])
  const [conflict, setConflict] = useState<GridBooking | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [apiError, setApiError] = useState('')
  const [earlyCheckoutConfirm, setEarlyCheckoutConfirm] = useState(false)
  // Расчёт с гостем (отмена или ранний выезд по брони, где уже есть деньги).
  // Состояние эфемерное — как у остальных диалогов формы, в стор ему не место.
  const [settlement, setSettlement] = useState<SettlementAction | null>(null)
  // Почему выбранный номер недоступен — с ПРИЧИНОЙ, а не флагом «занят».
  // Два источника, оба про один и тот же номер и одни и те же даты:
  //   - подбор номеров (`/occupancy/availability`) — знает все номера сразу;
  //   - точечная проверка (`/bookings/check-availability`) — знает соседа по имени.
  // Берём первый непустой: гаснут они тоже вместе, на следующей правке дат.
  const [pickerBlock, setPickerBlock] = useState<RoomBlockReason | null>(null)
  const [checkBlock, setCheckBlock] = useState<RoomBlockReason | null>(null)
  // Квота партнёра: сервер вернул 409 ALLOTMENT_CONFLICT (или администратор сам
  // нажал «Продать всё равно») — ждём осознанного подтверждения.
  const [allotmentWarning, setAllotmentWarning] = useState<string | null>(null)
  const pendingValues = useRef<FormValues | null>(null)
  // ── Замок версии (D5-004) ───────────────────────────────────────────────────
  // `updatedAt` той брони, которую форма ПОКАЗАЛА пользователю. Уходит в PUT как
  // `expectedUpdatedAt`: если сосед успел изменить бронь, сервер откажет (409),
  // а не молча затрёт его питание, метки и счётчики — они уходят целиком.
  // null — версии нет (новая бронь или полная бронь ещё не загрузилась); тогда
  // замок не включается, как и на старом сервере.
  const [versionAt, setVersionAt] = useState<string | null>(null)
  // Пришло событие про ЭТУ бронь, пока форма открыта. Только предупреждение:
  // перечитывать самим нельзя — под руками исчез бы недописанный текст.
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  // Тик на момент открытия формы: события ДО открытия — это не «только что».
  const seenTick = useRef(0)
  // Снимок брони, который форма ПОКАЗАЛА пользователю: с ним сравниваются все
  // последующие версии (см. `syncQuietly` и `editableFields.ts`). null — полная
  // бронь ещё не загрузилась, сравнивать не с чем.
  const baseline = useRef<Booking | null>(null)
  // Номер тихой сверки: ответ устаревшей не должен затирать свежую, а смена
  // брони в форме отменяет все начатые.
  const syncReq = useRef(0)
  // Деньги брони по журналу платежей: «принято» и «долг». Приходят из
  // BookingMoneyBar, который их и загружает. Поле «Оплачено» в форме теперь
  // ТОЛЬКО показывает это число: `Booking.paidAmount` — кэш журнала, и правка
  // руками жила до следующего платежа, а гонка между двумя запросами позволяла
  // отправить устаревшее значение на сервер (аудит D5-011, D6-012).
  const [moneySummary, setMoneySummary] = useState<BookingMoney | null>(null)
  const moneyBarRef = useRef<BookingMoneyBarHandle>(null)
  // Подставили ли в НОВУЮ бронь услуги «включено в тариф». Отметка нужна, потому что
  // справочник услуг грузится асинхронно: без неё повторная загрузка вернула бы
  // снятые галочки обратно.
  const linksSeeded = useRef(false)

  const [allServices, setAllServices] = useState<Service[]>([])
  const [mealPlans, setMealPlans] = useState<MealPlan[]>([])

  // Предпросмотр начислений с сервера. Календарь цен форма больше не читает
  // вовсе: цену ночи, базу скидки и округление знает генератор начислений,
  // и второй такой же на клиенте — источник расхождений (D7-009).
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  // Номер запроса: ответ устаревшего предпросмотра не должен затирать свежий.
  const previewReq = useRef(0)
  // Панель начислений сохранила ручную строку — предпросмотр обязан её увидеть.
  const [chargesVersion, setChargesVersion] = useState(0)

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
  const [selectedFlags, setSelectedFlags] = useState<string[]>([])
  const [customFlag, setCustomFlag] = useState('')
  // Фактические заезд/выезд держим в формате datetime-local ('YYYY-MM-DDTHH:mm',
  // местное время). Пустая строка = «не отмечено», на сервер уйдёт null.
  const [actualCheckInAt, setActualCheckInAt] = useState('')
  const [actualCheckOutAt, setActualCheckOutAt] = useState('')

  // Документ гостя — одним объектом, а не шестью useState: набор ходит целиком.
  const [doc, setDoc] = useState<DocFields>(EMPTY_DOC)
  // Документ прошлого визита, найденный по телефону. null — предлагать нечего.
  const [docSuggestion, setDocSuggestion] = useState<GuestLookup | null>(null)
  // Нажали «Подставить»: строку предложения меняем на подтверждение.
  const [docApplied, setDocApplied] = useState(false)

  const patchDoc = (patch: Partial<DocFields>) => setDoc(prev => ({ ...prev, ...patch }))

  // Edit: полная бронь с сервера (объект из сетки может быть частичным) и её загрузка
  const [serverBooking, setServerBooking] = useState<Booking | null>(null)
  const [loadingBooking, setLoadingBooking] = useState(false)
  // Голова счёта — только когда открыто ПРОДОЛЖЕНИЕ. Свой список отрезков есть
  // лишь у головы, а плашке нужно «номера 12 → 15», а не «12 → эта».
  // Ради неё же и грузим: суммы приходят из полосы денег, тут только подпись.
  const [accountBooking, setAccountBooking] = useState<Booking | null>(null)

  // Закрытая бронь — общий признак для предпросмотра и для блокировки правок.
  // Объявлен здесь, а не ниже, потому что от него зависит эффект предпросмотра.
  const bookingClosed = modal.booking?.status === 'CANCELLED' || modal.booking?.status === 'CHECKED_OUT'

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

  // Справочник услуг и пресеты пансиона — общие для всей формы. Цены объекта
  // (pricingBase, календарь RatePrice) форма больше не читает: по ним считает
  // предпросмотр на сервере.
  // Услуги берём ВСЕ активные: питание выбирается галочками, а не флагом в справочнике.
  useEffect(() => {
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

  // Счётчики гостей, скидка и предоплата — из брони; {} даёт сброс для create.
  // «Оплачено» здесь больше нет: это число живёт в журнале платежей, форма его
  // только показывает (см. moneySummary).
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
    // Объект сетки этих полей не отдаёт вовсе — там будет пусто, настоящие значения
    // приедут вторым вызовом, уже с полной бронью из GET /bookings/:id.
    setActualCheckInAt(isoToLocalInput(b.actualCheckInAt))
    setActualCheckOutAt(isoToLocalInput(b.actualCheckOutAt))
  }

  /** Метки: предустановленные — отдельно, произвольный текст — отдельно. */
  const applyFlags = (flags: string[] | undefined) => {
    const all = flags ?? []
    const knownIds = new Set((roomFund.bookingFlags ?? []).map((f: BookingFlagItem) => f.id))
    setSelectedFlags(all.filter((f: string) => knownIds.has(f)))
    setCustomFlag(all.find((f: string) => !knownIds.has(f)) ?? '')
  }

  /**
   * Перечитать форму по ПОЛНОЙ брони с сервера — целиком, включая поля, которые
   * при обычном открытии берутся из объекта сетки.
   *
   * Зовётся только из «Перечитать бронь» после 409 «изменена на другом рабочем
   * месте»: там показанное на экране заведомо неверно, и заполнить надо всё.
   * Обычное открытие формы этим кодом НЕ пользуется намеренно — при
   * перетаскивании в объекте сетки уже лежат новые номер и даты, и серверные
   * значения их бы затёрли.
   */
  const fillFromServer = (full: Booking) => {
    reset({
      roomId: full.roomId,
      guestName: full.guestName,
      guestPhone: full.guestPhone ?? '',
      checkIn: full.checkIn.slice(0, 10),
      checkOut: full.checkOut.slice(0, 10),
      source: full.source ?? 'стойка',
      notes: full.notes ?? '',
      immediateCheckIn: false,
    })
    setServerBooking(full)
    applyCalcFields(full)
    applyFlags(full.flags)
    setServiceLinks(linksFromBooking(full.services))
    setDoc(docFromBooking(full))
    // Версия, которую пользователь теперь видит, — с ней и пойдёт следующее сохранение.
    setVersionAt(full.updatedAt ?? null)
    // И новый снимок для сверки: дальше «изменилось» считается от того, что на экране.
    baseline.current = full
    setChangedElsewhere(false)
    seenTick.current = useRealtimeStore.getState().tick
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
      applyFlags(booking.flags)

      // Гостей и деньги ВСЕГДА берём с сервера: объект из сетки может быть частичным,
      // и раньше `?? 0` обнулял их при сохранении. Пока грузится — «Сохранить» заблокирована.
      setServerBooking(null)
      setAccountBooking(null)
      setServiceLinks([])
      // Документ, как и услуги, приходит только из GET /bookings/:id: объект
      // сетки его не несёт. До ответа сервера поля пустые, а «Сохранить»
      // заблокирована (loadingBooking) — отправить пустой документ нельзя.
      setDoc(EMPTY_DOC)
      setLoadingBooking(true)
      fetchBooking(booking.id)
        .then(full => {
          if (cancelled) return
          setServerBooking(full)
          applyCalcFields(full)
          // Версия брони фиксируется тем же ответом, из которого форма взяла
          // данные: сохранение потом скажет серверу «я правил вот это».
          setVersionAt(full.updatedAt ?? null)
          // Тот же ответ — снимок для тихой сверки: всё, что форма показала.
          baseline.current = full
          // Открыто продолжение — подтягиваем голову ради подписи «номера 12 → 15».
          // Ошибку глотаем: плашка без списка номеров хуже, чем красная ошибка
          // на брони, с которой всё в порядке.
          if (full.accountBookingId != null) {
            fetchBooking(full.accountBookingId)
              .then(head => { if (!cancelled) setAccountBooking(head) })
              .catch(() => {})
          }
          // Питание и услуги приходят только из GET /bookings/:id — в объекте сетки их нет
          setServiceLinks(linksFromBooking(full.services))
          setDoc(docFromBooking(full))
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
      setDoc(EMPTY_DOC)
      setSelectedFlags([])
      setCustomFlag('')
      setServerBooking(null)
      setAccountBooking(null)
      setLoadingBooking(false)
      // Новая бронь получает услуги «включено в тариф». Справочник мог ещё не
      // загрузиться — тогда набор подставит эффект ниже, поэтому снимаем отметку.
      linksSeeded.current = false
      setServiceLinks(defaultLinks(allServices, { adults: 0, children: 0, extraBeds: 0 }))
      if (allServices.length > 0) linksSeeded.current = true
    }
    setConflict(null)
    setApiError('')
    // Версия — про КОНКРЕТНУЮ бронь: с чужой формы она отправила бы сервер
    // сравнивать не то. Новая появится вместе с ответом GET /bookings/:id.
    setVersionAt(null)
    setChangedElsewhere(false)
    seenTick.current = useRealtimeStore.getState().tick
    // Снимок — про КОНКРЕТНУЮ бронь; начатые сверки предыдущей отменяем номером.
    baseline.current = null
    syncReq.current += 1
    setPickerBlock(null)
    setCheckBlock(null)
    // Диалог «Ранний выезд» не должен переживать закрытие формы и всплывать на другой брони
    setEarlyCheckoutConfirm(false)
    setAllotmentWarning(null)
    // Деньги и предпросмотр — про КОНКРЕТНУЮ бронь. Не сбросить их значит
    // показать на следующей открытой брони чужие суммы, пока не придут свои.
    setMoneySummary(null)
    setPreview(null)
    setPreviewError('')
    setChargesVersion(0)
    // Предложение подставить документ — про КОНКРЕТНЫЙ телефон. Не сбросить его
    // значит показать на следующей открытой брони чужую подсказку.
    setDocSuggestion(null)
    setDocApplied(false)
    pendingValues.current = null
    // Закрыли модалку (или открыли другую бронь) до ответа сервера — ответ игнорируем
    return () => { cancelled = true }
  }, [modal.open, modal.mode, booking?.id])

  // ─── «Изменена на другом рабочем месте» ────────────────────────────────────
  /**
   * Тихая сверка: бронь изменилась — но изменилось ли то, что правит форма?
   *
   * Перечитываем `GET /bookings/:id` и сравниваем со снимком, который форма
   * показала (`baseline`). Сравниваются только поля формы — список и причина
   * в `editableFields.ts`.
   *  - ничего «своего» не изменилось (приняли оплату, поправили строку
   *    начислений, сосед провёл платёж) → молча берём новую версию, и
   *    сохранение проходит. Раньше здесь вылезал 409 на собственную оплату;
   *  - изменилось → жёлтая полоса, а `versionAt` НЕ трогаем: PUT обязан
   *    упереться в 409, пока человек не перечитает форму.
   *
   * Саму форму не переписываем никогда: подставить чужую версию под руки тому,
   * кто набирает заметку, — та же тихая потеря правок, от которой защищаемся.
   */
  const syncQuietly = async () => {
    if (!isEdit || !booking) return
    const snapshot = baseline.current
    // Полная бронь ещё не загрузилась — сравнивать не с чем, а её собственный
    // запрос и так принесёт свежую версию.
    if (!snapshot) return
    const my = ++syncReq.current
    let full: Booking
    try {
      full = await fetchBooking(booking.id)
    } catch {
      // Молчим: о пропавшем сервере кричит полоса «Нет связи», а замок версии
      // всё равно не даст затереть чужую правку вслепую.
      return
    }
    // Пока ходили — форму закрыли, открыли другую бронь или пришла сверка свежее.
    if (my !== syncReq.current) return
    if (editableFieldsChanged(snapshot, full)) {
      setChangedElsewhere(true)
      return
    }
    baseline.current = full
    setServerBooking(full)
    if (full.updatedAt) setVersionAt(full.updatedAt)
  }

  // Сокет говорит только «событие про бронь N» — что именно изменилось, знает
  // сверка выше. `broadcast` (связь вернулась, откатили снимок) — тоже повод
  // перепроверить: за время обрыва события не доигрываются.
  const realtimeTick = useRealtimeStore((s) => s.tick)
  const realtimeLastId = useRealtimeStore((s) => s.lastChangedId)
  const realtimeBroadcast = useRealtimeStore((s) => s.broadcast)
  useEffect(() => {
    if (!modal.open || !isEdit || !booking) return
    // События, которые были ДО открытия формы, — не про неё.
    if (realtimeTick <= seenTick.current) return
    seenTick.current = realtimeTick
    if (!realtimeBroadcast && realtimeLastId !== booking.id) return
    void syncQuietly()
  }, [realtimeTick, realtimeLastId, realtimeBroadcast, modal.open, isEdit, booking?.id])

  /**
   * Перечитать бронь с сервера, потеряв незаписанные правки. Спрашиваем всегда:
   * в форме может лежать полчаса работы, и «обновить» без вопроса — та же тихая
   * потеря, от которой мы и защищаемся.
   *
   * `fresh` — бронь из ответа 409: сервер уже прислал текущую версию, второй
   * запрос за тем же был бы лишним (и мог бы принести третью).
   */
  const rereadBooking = async (fresh?: Booking | null) => {
    if (!booking) return
    const answer = await confirmDialog({
      title: 'Бронь изменена на другом рабочем месте',
      text: [
        'Перечитать бронь с сервера? Всё, что вы ввели и не сохранили, будет потеряно.',
        'Можно и продолжить редактирование, но сохранить не выйдет, пока форма не перечитана.',
      ],
      confirmLabel: 'Перечитать бронь',
      cancelLabel: 'Продолжить редактирование',
      danger: true,
    })
    if (answer !== 'confirm') {
      setApiError('Бронь не сохранена: её изменили на другом рабочем месте. Пока форму не перечитать, сохранение будет отклоняться.')
      return
    }
    setApiError('')
    try {
      const full = fresh ?? await fetchBooking(booking.id)
      fillFromServer(full)
    } catch (e) {
      setApiError(formatApiError(e, 'Не удалось перечитать бронь'))
    }
  }

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
  const watchedPhone   = watch('guestPhone')

  // ─── Подстановка документа из прошлого визита ──────────────────────────────
  // Сравниваем номера по ЦИФРАМ: «+7 705…», «8705…» и «(705)…» — один абонент,
  // и сервер группирует их так же (guestController.normalizePhone).
  const phoneDigits = (watchedPhone ?? '').replace(/\D/g, '')
  const docEmpty = docIsEmpty(doc)

  // Телефон изменили — прошлая подсказка больше не про этого гостя.
  // Отдельным эффектом, а не внутри поиска ниже: тот зависит ещё и от «документ
  // пуст», и сброс из него гасил бы подтверждение сразу после подстановки.
  useEffect(() => {
    setDocSuggestion(null)
    setDocApplied(false)
  }, [phoneDigits])

  // Спрашиваем сервер после паузы в наборе — и только если документ в форме ПУСТ:
  // когда паспорт уже вписан, предлагать нечего. Меньше 10 цифр — это обрывок,
  // а не номер: сервер такой всё равно не опознает, а стойка набирает по цифре.
  useEffect(() => {
    if (!modal.open || isMaintenance) return
    if (phoneDigits.length < 10 || !docEmpty) return
    let cancelled = false
    const timer = setTimeout(() => {
      lookupGuest(watchedPhone)
        .then(r => { if (!cancelled && r.found && r.document) setDocSuggestion(r) })
        // Сети нет или сервер ответил ошибкой — молчим. Подстановка это удобство,
        // и красная плашка из-за неё соврала бы, что с бронью что-то не так.
        .catch(() => {})
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [modal.open, isMaintenance, phoneDigits, docEmpty])

  const applyDocSuggestion = () => {
    const d = docSuggestion?.document
    if (!d) return
    // Имя НЕ трогаем намеренно: в форме уже может быть набрано «Асель К.» со слов
    // самого гостя, и заменить его версией из прошлогодней брони — значит
    // переписать свежие данные старыми. Подставляем ровно документ.
    setDoc(docFromLookup(d))
    setDocApplied(true)
  }

  // Find selected room for category name
  const selectedRoom = useMemo(
    () => rooms.find(r => r.id === Number(watchedRoomId)),
    [rooms, watchedRoomId]
  )
  // Категория нужна только для подписи: цену по ней считает сервер.
  const categoryName = selectedRoom?.category?.name ?? ''
  // Номер комнаты для диалога оплаты: список номеров грузится асинхронно, поэтому
  // подстраховываемся серверной версией брони — деньги нельзя принять «непонятно куда».
  const roomNumberLabel = selectedRoom?.number ?? serverBooking?.room?.number ?? ''

  // ─── Счёт брони (цепочка после переезда) ───────────────────────────────────
  // У продолжения свои суммы нулевые: начисления и платежи лежат на голове.
  // Панель начислений, полоса денег и «Оплачено» ведём по счёту — иначе форма
  // второй части переезда показывала бы «начислено 0, не оплачено» живому гостю.
  const accountSource = serverBooking ?? booking ?? null
  const accountId = accountSource ? accountIdOf(accountSource) : 0
  const continuation = !!accountSource && isContinuation(accountSource)
  // Номер головы: у продолжения он в `account`, у самой головы — свой.
  const accountRoomLabel = serverBooking?.account?.room?.number ?? ''

  // «Оплачено» — только из журнала платежей. Пока полоса денег не ответила,
  // показываем кэш брони: это то же число, снятое чуть раньше. Ввода нет —
  // менять его может лишь операция по кассе. У ПРОДОЛЖЕНИЯ кэш всегда нулевой
  // (деньги на голове) — показывать его нельзя, ждём ответа полосы денег.
  const paidAmount = moneySummary?.paid ?? (continuation ? 0 : (serverBooking ?? booking)?.paidAmount ?? 0)

  // ─── Почему номер недоступен ───────────────────────────────────────────────
  // Квота партнёра — предупреждение: продать можно, подтвердив один раз.
  // Пересечение и буфер метки — запрет: кнопка сохранения гаснет.
  const roomBlock = pickerBlock ?? checkBlock
  // Номер и даты не менялись, а бронь уже продана поверх квоты — вопрос задан
  // однажды и повторяться не должен (сервер 409 по ней тоже не пришлёт).
  const soldOverAllotment = !!serverBooking?.allotmentOverride
    && Number(watchedRoomId) === serverBooking.roomId
    && watchedCheckIn === serverBooking.checkIn.slice(0, 10)
    && watchedCheckOut === serverBooking.checkOut.slice(0, 10)
  const allotmentBlock = roomBlock?.reason === 'allotment' && !soldOverAllotment ? roomBlock : null
  const hardBlock = roomBlock && roomBlock.reason !== 'allotment' ? roomBlock : null

  // ─── Переходы по цепочке ───────────────────────────────────────────────────
  /** Открыть голову счёта в просмотре: там видно, из чего сложился общий счёт. */
  const openAccountBooking = () => {
    const local = accountBooking ?? findBooking(accountId)
    if (local) { openViewModal(local); return }
    fetchBooking(accountId)
      .then(openViewModal)
      .catch(() => setApiError('Не удалось открыть бронь счёта'))
  }

  /**
   * Открыть текущий отрезок цепочки. Голова после переезда закрыта, и править
   * в ней нечего — сервер ответит 400 «Нельзя редактировать закрытую бронь».
   */
  const openCurrentSegment = () => {
    const local = booking ? currentSegment(booking) : null
    if (local && booking && local.id !== booking.id) { openEditModal(local); return }
    const last = serverBooking ? lastSegment(serverBooking) : null
    if (!last) return
    fetchBooking(last.id)
      .then(openEditModal)
      .catch(() => setApiError('Не удалось открыть текущую часть брони'))
  }

  /** Плашка «этот отрезок — часть общего счёта» и переход к другой его части. */
  const chainNotice: { text: string; action: string; onOpen: () => void } | null = (() => {
    if (!isEdit || !serverBooking) return null
    if (continuation) {
      const rooms = accountBooking
        ? chainRoomsLabel(accountBooking)
        : [accountRoomLabel, serverBooking.room?.number].filter(Boolean).join(' → ')
      return {
        text: `Счёт брони №${accountId}${rooms ? ` · номера ${rooms}` : ''} — начисления и платежи общие`,
        action: 'Открыть бронь счёта',
        onOpen: openAccountBooking,
      }
    }
    if (hasContinuations(serverBooking)) {
      return {
        text: `Гость переехал: счёт включает номера ${chainRoomsLabel(serverBooking)}. Эта часть закрыта.`,
        action: 'Открыть текущую часть',
        onOpen: openCurrentSegment,
      }
    }
    return null
  })()

  // ─── Предпросмотр начислений: считает СЕРВЕР ───────────────────────────────
  // Ключ входов. Меняется он — уходит новый запрос; не меняется (правка заметки,
  // имени, метки) — сервер не дёргаем. `chargesVersion` в ключе: панель начислений
  // сохранила ручную строку, и предпросмотр обязан её увидеть, хотя поля формы
  // при этом не изменились.
  const previewKey = [
    // Открытие/закрытие в ключе намеренно: закрыли и открыли ту же бронь с теми
    // же полями — ключ обязан смениться, иначе после сброса состояния запрос не
    // уйдёт и карточка останется пустой.
    modal.open ? 1 : 0,
    watchedRoomId, watchedCheckIn, watchedCheckOut,
    adults, children, extraBeds, disabledAdults, disabledChildren,
    discountPercent, prepaymentPercent,
    linksKey(serviceLinks),
    isEdit ? booking?.id : 0,
    // Пока полная бронь не загружена, набор услуг в форме пуст не потому, что
    // питание сняли, — предпросмотр по нему соврал бы. Ждём серверную версию.
    isEdit ? (serverBooking ? 1 : 0) : 1,
    bookingClosed ? 1 : 0,
    chargesVersion,
  ].join('|')

  useEffect(() => {
    // У «Ремонта» денег нет вовсе, калькулятор ему не показывается.
    if (isMaintenance) { setPreview(null); setPreviewLoading(false); setPreviewError(''); return }

    const roomId = Number(watchedRoomId)
    const ready = modal.open && !bookingClosed
      && !!roomId && !!watchedCheckIn && !!watchedCheckOut && watchedCheckOut > watchedCheckIn
      && (!isEdit || !!serverBooking)
    if (!ready) {
      // Считать нечего — гасим и предыдущий ответ, иначе на экране останутся
      // суммы от прошлых дат.
      previewReq.current++
      setPreview(null)
      setPreviewLoading(false)
      setPreviewError('')
      return
    }

    // Номер запроса растёт на КАЖДЫЙ прогон эффекта: ответ, отправленный до
    // последней правки, к этому моменту уже устарел и в состояние не попадает.
    const my = ++previewReq.current
    setPreviewLoading(true)
    const timer = setTimeout(() => {
      previewBooking({
        roomId,
        checkIn: watchedCheckIn,
        checkOut: watchedCheckOut,
        // Гости — в поля `*WithMeals`, как и при сохранении: деление «с питанием /
        // без питания» осталось только в старых колонках (см. NOTES).
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
        services: linksToPayload(serviceLinks),
        // Правка брони: ручные строки (уступки, штрафы) сервер подтянет сам по id.
        ...(isEdit && booking ? { bookingId: booking.id } : {}),
      })
        .then(r => {
          if (my !== previewReq.current) return
          setPreview(r)
          setPreviewError('')
        })
        .catch(e => {
          if (my !== previewReq.current) return
          setPreview(null)
          setPreviewError(formatApiError(e, 'Не удалось рассчитать стоимость'))
        })
        .finally(() => {
          if (my === previewReq.current) setPreviewLoading(false)
        })
    }, 300)

    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, isMaintenance])

  // Выбранные услуги, у которых цены нет вовсе. Строку начисления они не породят
  // (ноль — это незаполненный тариф, а не «бесплатно»), поэтому в счёте их просто
  // не видно. Обед и ужин приходят из засева нулевыми — это штатная ситуация,
  // и молчать о ней нельзя: «Полный пансион» включён, а сумма не изменилась.
  const unpricedServices = useMemo(() => {
    const names: string[] = []
    for (const l of serviceLinks) {
      const s = servicesById.get(l.serviceId)
      if (!s || !s.isActive) continue
      if (s.price > 0) continue
      if (s.childPrice != null && s.childPrice > 0) continue
      names.push(s.name)
    }
    return names
  }, [serviceLinks, servicesById])

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
        // Причина отказа приходит и сюда — с текстом сервера («номер выделен
        // партнёру X до …», «между бронями нужен день»). Раньше клиент её
        // выбрасывал, и квота выглядела как «номер занят» (D5-001, D7-005).
        setCheckBlock(
          result.available || !result.reason || result.reason === 'range'
            ? null
            : { reason: result.reason, text: result.message ?? 'Номер недоступен на выбранные даты' },
        )
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
    // Enter в поле формы обходит погашенную кнопку — жёсткие причины проверяем и здесь.
    // Квоты в этом списке нет намеренно: её обходят подтверждением, а не запретом.
    if (conflict || hardBlock) return
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
        // Документ гостя: при создании — только заполненное, при правке — только
        // ИЗМЕНЁННОЕ (очищенное поле уходит пустой строкой = «стереть»).
        // Причина та же, что у «Оплачено» и фактического времени: бронь
        // сохраняется и сдвигом дат из шахматки, и правкой заметки, и такое
        // сохранение не имеет права стереть паспорт. У «Ремонта» гостя нет вовсе.
        ...(isMaintenance
          ? {}
          : docPayload(doc, isEdit ? (serverBooking ? docFromBooking(serverBooking) : null) : EMPTY_DOC)),
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
        // ИТОГ, ПРЕДОПЛАТА И «ОПЛАЧЕНО» НЕ ОТПРАВЛЯЮТСЯ ВОВСЕ (волна 5a).
        // Итог брони — сумма строк начислений, её собирает сервер тем же кодом,
        // что и предпросмотр; `paidAmount` — кэш журнала платежей. Раньше форма
        // слала свои числа, и они расходились с базой (D5-002, D2-005), а гонка
        // между ответами двух запросов позволяла затереть свежий кэш платежей
        // старым (D5-011, D6-012). Этих полей нет даже в типе `BookingPayload`.
        // Фактические заезд/выезд отправляем ТОЛЬКО если админ их действительно
        // изменил: обычно время ставят кнопки
        // «Заезд»/«Выезд», и слать своё на каждое сохранение брони — значит
        // затирать то, что минуту назад отметило соседнее рабочее место.
        // Сравниваем с серверной версией; пока она не загружена, сравнивать не с чем.
        ...(serverBooking && actualCheckInAt !== isoToLocalInput(serverBooking.actualCheckInAt)
          ? { actualCheckInAt: localInputToIso(actualCheckInAt) }
          : {}),
        ...(serverBooking && actualCheckOutAt !== isoToLocalInput(serverBooking.actualCheckOutAt)
          ? { actualCheckOutAt: localInputToIso(actualCheckOutAt) }
          : {}),
        flags: [...selectedFlags, ...(customFlag.trim() ? [customFlag.trim()] : [])],
        // Строки начислений сервер пересобирает сам при изменении дат/гостей/скидки.
        // Явное «Пересчитать по тарифу» живёт в панели начислений («⟳ По тарифу»):
        // там видно, что именно пересоберётся, и делается это сразу, без сохранения.
        ...(allowAllotmentOverride ? { allowAllotmentOverride: true } : {}),
      }

      if (isEdit && booking) {
        // Замок версии — только у правки и только когда версия известна: при
        // создании сравнивать не с чем, а без загруженной брони замок отказал бы
        // на ровном месте (D5-004).
        await updateBooking(booking.id, {
          ...payload,
          ...(versionAt ? { expectedUpdatedAt: versionAt } : {}),
        })
      } else {
        await createBooking(payload)
      }

      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (err: unknown) {
      const res = (err as { response?: { status?: number; data?: { error?: string; code?: string; booking?: Booking } } })?.response
      // Бронь изменили, пока форма была открыта. Сохранение НЕ прошло — сервер
      // сберёг чужую правку. Дальше решает человек: перечитать (потеряв своё)
      // или продолжить и переписать вручную.
      if (res?.status === 409 && res?.data?.code === 'BOOKING_STALE') {
        // Кнопку возвращаем в рабочее состояние ДО вопроса: пока открыт диалог,
        // «Сохранение…» на ней означало бы, что запрос ещё идёт.
        setSubmitting(false)
        setChangedElsewhere(true)
        await rereadBooking(res.data.booking ?? null)
        return
      }
      // Номер выделен партнёру. Это не запрет: отель вправе его продать, но осознанно —
      // поэтому спрашиваем подтверждение, а не упираемся в красную ошибку.
      if (res?.status === 409 && res?.data?.code === 'ALLOTMENT_CONFLICT') {
        pendingValues.current = values
        setAllotmentWarning(res.data.error ?? 'Номер выделен партнёру по квоте')
        return
      }
      // formatApiError добавляет к сообщению разбор по полям: при 400 сервер
      // отвечает «Ошибка валидации» + details, и без них было непонятно, что чинить.
      setApiError(formatApiError(err, 'Не удалось сохранить бронь'))
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

  /**
   * «Продать всё равно» из плашки о квоте: сначала проверяем форму (иначе
   * подтвердим продажу брони без имени и дат), потом задаём ТОТ ЖЕ вопрос, что
   * приходит от сервера 409-м. Вопрос один и тот же, значит и окно одно —
   * `AllotmentConfirm`, а не второй диалог со своими словами.
   */
  const askAllotmentOverride = handleSubmit((values) => {
    pendingValues.current = values
    setAllotmentWarning(allotmentBlock?.text ?? 'Номер выделен партнёру по квоте')
  })

  /**
   * Отмена брони. Сервер ставит `CANCELLED` и снимает автоматические начисления;
   * ручные строки (штраф за отмену) остаются. Оплаченное превращается в
   * отрицательный долг — «к возврату», он виден в «Кассе → Долги».
   * Раньше окно спрашивало просто «Отменить бронь?» и молчало про деньги (D7-007).
   */
  const handleCancel = async () => {
    if (!booking) return
    const paid = moneySummary?.paid ?? 0
    // По брони уже приняты деньги — отмена без разговора о них оставила бы
    // переплату висеть до тех пор, пока кто-нибудь не откроет «Кассу».
    // Открываем расчёт: там и штраф за отмену, и возврат.
    if (paid > 0) { setSettlement('cancel'); return }
    const text = [
      'Отменить бронь?',
      '',
      'Бронь останется в истории со статусом «Отменена». Начисления будут сняты.',
      paid > 0
        ? `Принятые ${fmt(paid)} станут «к возврату» — их видно в разделе «Касса» → «Долги».`
        : '',
    ].filter(Boolean).join('\n')
    if (!confirm(text)) return
    setSubmitting(true)
    try {
      await cancelBooking(booking.id)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (e) {
      // Текст сервера, а не «Ошибка отмены»: он объясняет, что делать
      // (не тот статус, нет прав, бронь уже закрыта) — аудит D5-005.
      setApiError(formatApiError(e, 'Не удалось отменить бронь'))
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
    } catch (e) {
      // Сервер отвечает содержательно: «раньше даты заезда», «дата выезда уже
      // прошла», «не тот статус». Своё «Ошибка отметки заезда» это скрывало.
      setApiError(formatApiError(e, 'Не удалось отметить заезд'))
    } finally {
      setSubmitting(false)
    }
  }

  const isSameDayCheckout = !!booking && booking.checkIn.slice(0, 10) === effectiveToday

  const handleCheckOut = async () => {
    if (!booking) return

    // Если выезд раньше запланированной даты — показываем подтверждение.
    // А если по брони уже приняты деньги, подтверждения мало: непрожитые ночи
    // снимутся со счёта, и разницу нужно тут же вернуть — открываем расчёт.
    const plannedCheckOut = booking.checkOut.slice(0, 10)
    if (effectiveToday < plannedCheckOut && !earlyCheckoutConfirm) {
      if ((moneySummary?.paid ?? 0) > 0) { setSettlement('checkout'); return }
      setEarlyCheckoutConfirm(true)
      return
    }

    setEarlyCheckoutConfirm(false)
    setSubmitting(true)
    try {
      await checkOutBooking(booking.id)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (e) {
      setApiError(formatApiError(e, 'Не удалось отметить выезд'))
    } finally {
      setSubmitting(false)
    }
  }

  // Правка фактического времени у ЗАКРЫТОЙ брони: общей кнопки «Сохранить» тут
  // нет (isClosed её прячет), поэтому эти два поля сохраняются отдельным
  // запросом на выделенный эндпоинт (единственный, который принимает правку
  // после того, как бронь уже CHECKED_OUT/CANCELLED).
  const actualTimesChanged = !!serverBooking && (
    actualCheckInAt !== isoToLocalInput(serverBooking.actualCheckInAt) ||
    actualCheckOutAt !== isoToLocalInput(serverBooking.actualCheckOutAt)
  )

  const handleSaveActualTimes = async () => {
    if (!booking || !serverBooking) return
    const payload: { actualCheckInAt?: string | null; actualCheckOutAt?: string | null } = {}
    if (actualCheckInAt !== isoToLocalInput(serverBooking.actualCheckInAt)) {
      payload.actualCheckInAt = localInputToIso(actualCheckInAt)
    }
    if (actualCheckOutAt !== isoToLocalInput(serverBooking.actualCheckOutAt)) {
      payload.actualCheckOutAt = localInputToIso(actualCheckOutAt)
    }
    if (Object.keys(payload).length === 0) return

    setSubmitting(true)
    try {
      await updateActualTimes(booking.id, payload)
      closeModal()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (e) {
      setApiError(formatApiError(e, 'Не удалось сохранить фактическое время'))
    } finally {
      setSubmitting(false)
    }
  }

  if (!modal.open) return null
  if (modal.mode === 'move') return null  // Move-режим обрабатывает MoveBookingModal
  if (modal.mode === 'view') return null  // View-режим обрабатывает BookingViewModal

  const isClosed = bookingClosed
  const isCheckedIn = booking?.status === 'CHECKED_IN'

  // Заезд доступен, только если дата заезда брони не позже рабочей даты И дата
  // выезда ещё не прошла: заселять «во вчера» бессмысленно, сервер такой заезд
  // теперь и не примет (400). Кнопку прячем, чтобы не предлагать заведомый отказ.
  const canCheckIn = isEdit && booking?.status === 'CONFIRMED' &&
    !!booking?.checkIn && booking.checkIn.slice(0, 10) <= effectiveToday &&
    !!booking?.checkOut && booking.checkOut.slice(0, 10) > effectiveToday
  const canCheckOut = isEdit && isCheckedIn

  // Фактическое время показываем, когда оно уже есть либо когда статус говорит,
  // что оно должно быть. У подтверждённой брони (никто не заехал) пара пустых
  // полей — просто шум, а у заселённого без отметки это как раз тот случай,
  // ради которого правку и просили: кнопку нажать забыли.
  const showActualIn = isEdit && !isMaintenance &&
    (!!actualCheckInAt || isCheckedIn || booking?.status === 'CHECKED_OUT')
  const showActualOut = isEdit && !isMaintenance &&
    (!!actualCheckOutAt || booking?.status === 'CHECKED_OUT')

  const title = isMaintenance
    ? '🔧 Ремонт / Блокировка'
    : isEdit
      ? 'Бронь'
      : 'Новая бронь'

  const nightsLabel = watchedCheckIn && watchedCheckOut && watchedCheckOut > watchedCheckIn
    ? `${nightsBetween(watchedCheckIn, watchedCheckOut)} ночей · ${watchedCheckIn} – ${watchedCheckOut}`
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
        className="booking-form-modal"
        style={{
          // relative — чтобы диалог «Ранний выезд» (absolute; inset: 0) накрывал только форму
          position: 'relative',
          // Ширина по вьюпорту, а не жёсткие 960px: на широком мониторе вокруг окна
          // оставалось пустое затемнение, а поля жались в узкую колонку. Потолок
          // 1280px — дальше строки формы становятся неудобно длинными для чтения.
          // У «Ремонта» правой колонки нет, и та же ширина выглядела бы пустой.
          width: isMaintenance ? 'min(760px, 92vw)' : 'min(1280px, 92vw)',
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
            padding: '20px 28px',
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

          {/* ── Бронь изменили на соседнем рабочем месте ──
              Только сигнал, без автоперечитки: подставить чужую версию под руки
              человеку, который набирает заметку, — та же тихая потеря правок,
              от которой мы и защищаемся (D5-004). */}
          {changedElsewhere && (
            <div style={{
              padding: '10px 28px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--surface-2)',
              borderLeft: '3px solid var(--s-out)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              flexShrink: 0,
              fontSize: '0.88rem', color: 'var(--text-muted)',
            }}>
              <span aria-hidden style={{ fontSize: '1rem' }}>⚠</span>
              <span style={{ minWidth: 0 }}>Изменена на другом рабочем месте только что</span>
              <button
                type="button"
                onClick={() => { void rereadBooking() }}
                style={{ ...linkBtnStyle, marginLeft: 'auto' }}
              >
                Перечитать бронь
              </button>
            </div>
          )}

          {/* ── Счёт цепочки ── у второй части переезда деньги лежат на первой:
              без этой плашки стойка видит форму с чужими (по её мнению) суммами
              и не понимает, почему «Начислено» больше, чем этот отрезок. */}
          {chainNotice && (
            <div style={{
              padding: '10px 28px',
              borderBottom: '1px solid var(--border-subtle)',
              background: 'var(--surface)',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              // Как и шапка, полоса не сжимается: она объясняет суммы формы,
              // и на невысоком экране схлопнуться в ничто не должна.
              flexShrink: 0,
              fontSize: '0.88rem', color: 'var(--text-muted)',
            }}>
              <span aria-hidden style={{ fontSize: '1rem' }}>⛓</span>
              <span style={{ minWidth: 0 }}>{chainNotice.text}</span>
              <button type="button" onClick={chainNotice.onOpen} style={{ ...linkBtnStyle, marginLeft: 'auto' }}>
                {chainNotice.action}
              </button>
            </div>
          )}

          {/* Form (scrollable) */}
          <form
            id="booking-form"
            onSubmit={handleSubmit(onSubmit)}
            style={{ flex: 1, overflowY: 'auto', padding: '22px 28px 26px', display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {/* ── Гость ── имя и телефон читают и диктуют вместе, поэтому и стоят
                рядом, а не друг под другом двумя узкими строками. */}
            <FormSection first title={isMaintenance ? 'Блокировка' : 'Гость'}>
              <div style={fieldGrid()}>
                <Field label={isMaintenance ? 'Причина' : 'Имя гостя'} error={errors.guestName?.message}>
                  <input
                    type="text"
                    placeholder={isMaintenance ? 'Ремонт, замена сантехники...' : 'Иванов Иван'}
                    {...register('guestName', { required: isMaintenance ? 'Укажите причину' : 'Укажите имя гостя' })}
                    disabled={isClosed}
                    style={inputStyle}
                  />
                </Field>

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
              </div>

              {/* Подсказка стоит ПОД телефоном и прямо НАД секцией «Документ»:
                  подставленные поля видно сразу, без прокрутки формы. */}
              {!isMaintenance && docSuggestion?.document && (docApplied || docEmpty) && (
                <DocSuggestionRow
                  from={docSuggestion.document.from}
                  // Подставили, а потом всё стёрли руками — снова предлагаем, а не
                  // рапортуем «документ подставлен» над пустыми полями.
                  applied={docApplied && !docEmpty}
                  disabled={isClosed}
                  onApply={applyDocSuggestion}
                />
              )}
            </FormSection>

            {/* ── Документ ── данные гостя, поэтому сразу за его именем и
                телефоном, а не в конце формы. Необязателен: бронь по телефону
                заводят за недели, паспорт появляется на стойке при заселении. */}
            {!isMaintenance && (
              <FormSection title="Документ">
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', lineHeight: 1.45, marginTop: -4 }}>
                  Заполняется при заселении. Сохранить бронь без документа можно.
                </div>
                <DocumentFields value={doc} disabled={isClosed} onPatch={patchDoc} />
              </FormSection>
            )}

            {/* ── Размещение ── у группы теперь свой заголовок, поэтому обёртка
                Field с подписью «Номер комнаты» убрана: она дублировала подпись
                внутри самого выбора номера. Ошибка валидации показывается тут же. */}
            <FormSection title="Размещение">
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
                    onBlock={setPickerBlock}
                  />
                )}
              />
              {errors.roomId?.message && (
                <span style={{ fontSize: '0.85rem', color: '#dc2626' }}>{errors.roomId.message}</span>
              )}
            </FormSection>

            {/* ── Даты ── плановые и фактические в одной сетке: их читают вместе
                («по брони до 12-го, вышел 10-го в 11:40»). В широком окне все
                четыре встают в строку, в узком — попарно, это решает auto-fit.
                Плановые даты — сутки (`@db.Date`), фактические — моменты времени
                в МЕСТНОЙ зоне, поэтому и формат ввода у них разный. */}
            <FormSection title="Даты">
              <div style={fieldGrid(185)}>
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

                {showActualIn && (
                  <ActualTimeField
                    label="Факт. заезд"
                    value={actualCheckInAt}
                    readOnly={loadingBooking}
                    onChange={setActualCheckInAt}
                  />
                )}
                {showActualOut && (
                  <ActualTimeField
                    label="Факт. выезд"
                    value={actualCheckOutAt}
                    readOnly={loadingBooking}
                    onChange={setActualCheckOutAt}
                  />
                )}
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
              {/* Жёсткий отказ: пересечение или буфер метки. Текст — от сервера:
                  он называет соседа и правило, а «номер занят» не объясняло ничего. */}
              {!conflict && !checking && hardBlock && watchedCheckIn && watchedCheckOut && (
                <div style={{
                  ...infoBoxStyle('#fef2f2', '#dc2626'),
                  fontWeight: 600,
                  border: '1px solid #fca5a5',
                }}>
                  🚫 {hardBlock.text}<br />
                  <span style={{ fontWeight: 400, fontSize: '0.88rem' }}>
                    {hardBlock.reason === 'buffer'
                      // Буфер — жёсткое правило метки, обойти его из формы нечем:
                      // его снимают, убрав метку или сдвинув даты.
                      ? 'Сохранение заблокировано — сдвиньте даты или снимите метку, которая требует перерыв.'
                      : 'Сохранение заблокировано — выберите другой номер или измените даты.'}
                  </span>
                </div>
              )}
              {/* Квота партнёра — НЕ запрет. Отель вправе продать выделенный номер,
                  но осознанно: показываем причину и даём кнопку (D5-001, D7-005).
                  Кнопка «Сохранить» по этой причине НЕ гаснет. */}
              {!conflict && !checking && allotmentBlock && watchedCheckIn && watchedCheckOut && (
                <div style={{
                  ...infoBoxStyle('#fffbeb', '#b45309'),
                  border: '1px solid #fcd34d',
                }}>
                  <div style={{ fontWeight: 600 }}>🤝 {allotmentBlock.text}</div>
                  <div style={{ fontSize: '0.88rem', marginTop: 2 }}>
                    Это предупреждение, а не запрет: номер можно продать, подтвердив один раз.
                  </div>
                  <button
                    type="button"
                    onClick={askAllotmentOverride}
                    disabled={submitting || loadingBooking}
                    style={{
                      marginTop: 8, padding: '6px 14px', borderRadius: 8, cursor: 'pointer',
                      background: '#d97706', color: '#fff', border: 'none',
                      fontFamily: 'inherit', fontSize: '0.88rem', fontWeight: 600,
                    }}
                  >
                    Продать всё равно
                  </button>
                </div>
              )}
              {soldOverAllotment && !conflict && !checking && (
                <div style={infoBoxStyle('#f5f3ff', '#6d28d9')}>
                  🤝 Продано поверх квоты партнёра — подтверждение уже дано, вопрос не повторяется.
                </div>
              )}
              {/* «Свободен» и «продано поверх квоты» вместе не показываем: про
                  этот номер уже всё сказано плашкой выше. */}
              {!conflict && !checking && !roomBlock && !soldOverAllotment && watchedCheckIn && watchedCheckOut && watchedCheckOut > watchedCheckIn && (
                <div style={infoBoxStyle('#f0fdf4', '#15803d')}>
                  ✓ Номер свободен на выбранные даты
                </div>
              )}
            </FormSection>

            {/* ── Дополнительно ── источник, метки и примечания. */}
            <FormSection title="Дополнительно">
              {!isMaintenance && (
                // Выпадающий список из четырёх коротких слов во всю ширину широкой
                // колонки выглядел бы нелепо — ограничиваем, но не жёстко.
                <div style={{ maxWidth: 340 }}>
                  <Field label="Источник брони">
                    <select {...register('source')} disabled={isClosed} style={selectStyle}>
                      {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </Field>
                </div>
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
                  style={{ ...inputStyle, resize: 'vertical', height: 76, lineHeight: 1.45 }}
                />
              </Field>
            </FormSection>

            {/* immediateCheckIn управляется программно через prefillImmediateCheckIn */}
            <input type="hidden" {...register('immediateCheckIn')} />

            {apiError && (
              <div style={{ ...infoBoxStyle('#fef2f2', '#dc2626'), marginTop: 14 }}>{apiError}</div>
            )}
          </form>

          {/* Action buttons (bottom, fixed) */}
          <div style={{
            padding: '16px 28px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg)',
            display: 'flex',
            gap: 12,
            flexShrink: 0,
            flexWrap: 'wrap',
            justifyContent: 'space-between',
          }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
              {/* Продолжение переезда отменить нельзя (сервер отвечает 400
                  «оформите выезд»): «гость не жил» — ложь для второй части, а
                  снятие её начислений оставило бы голову начислять непрожитые
                  ночи. Живому гостю оформляют ВЫЕЗД — кнопка выше. */}
              {isEdit && !isClosed && !isCheckedIn && !continuation && (
                <button type="button" onClick={handleCancel} disabled={submitting} style={actionBtn('#dc2626')}>
                  Отменить бронь
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, marginLeft: 'auto' }}>
              <button type="button" onClick={closeModal} style={cancelBtnStyle}>
                Закрыть
              </button>
              {isClosed && (showActualIn || showActualOut) && (
                <button
                  type="button"
                  onClick={handleSaveActualTimes}
                  disabled={submitting || loadingBooking || !actualTimesChanged}
                  style={submitBtnStyle(submitting || loadingBooking || !actualTimesChanged)}
                >
                  {submitting ? 'Сохранение...' : 'Сохранить время'}
                </button>
              )}
              {!isClosed && (
                <button
                  form="booking-form"
                  type="submit"
                  // Гасим только по ЖЁСТКИМ причинам (пересечение, буфер).
                  // Квота кнопку не гасит: продажу подтверждают диалогом.
                  disabled={submitting || loadingBooking || !!conflict || !!hardBlock}
                  title={conflict || hardBlock ? (hardBlock?.text ?? 'Номер занят на выбранные даты') : undefined}
                  style={submitBtnStyle(!!conflict || !!hardBlock || submitting || loadingBooking)}
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
                }}>{'⚠'}</div>
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
                      // Ночи между рабочей датой и датой выезда по брони — ровно
                      // те, что сервер снимет со счёта при выезде (проживание и
                      // питание за них). Раньше здесь обещали «возврат позже».
                      const diff = nightsBetween(effectiveToday, booking.checkOut.slice(0, 10))
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
                          Со счёта будут сняты {diff} {diff === 1 ? 'непрожитая ночь' : diff < 5 ? 'непрожитые ночи' : 'непрожитых ночей'}
                          {' '}— проживание и питание за них. Итог брони пересчитается.
                          <div style={{ fontWeight: 400, marginTop: 4 }}>
                            Штраф за досрочный выезд, если он есть, добавляется ручной строкой в начислениях.
                          </div>
                        </div>
                      ) : null
                    })()}
                  </>
                )}
              </div>

              <div style={{ fontSize: '1rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {isSameDayCheckout
                  ? (
                      <>
                        Гость выезжает в день заезда — номер освободится немедленно.
                        {' '}Бронь <strong>не удаляется</strong>: она останется в истории со статусом
                        {' '}«Отменена», начисления будут сняты.
                        {(moneySummary?.paid ?? 0) > 0 && (
                          <div style={{ marginTop: 6 }}>
                            Принятые {fmt(moneySummary?.paid ?? 0)} станут «к возврату» — их видно в «Кассе».
                          </div>
                        )}
                      </>
                    )
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
                    ? 'Да, отменить бронь'
                    : 'Да, оформить выезд'
                  }
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Расчёт с гостем ── открывается вместо простого подтверждения, если
            по брони уже приняты деньги: отмена и ранний выезд меняют счёт, и
            разницу надо вернуть здесь же, не уходя в «Кассу». */}
        {settlement && booking && (
          <SettlementDialog
            // id ОТРЕЗКА, а не счёта: отменяем и выселяем именно эту часть
            // цепочки. Деньги сервер всё равно сводит к голове — расчёт по
            // сегменту и по счёту даёт одни и те же цифры (data-and-money.md).
            bookingId={booking.id}
            action={settlement}
            guestName={(serverBooking ?? booking).guestName}
            subtitle={`${roomNumberLabel ? `Номер ${roomNumberLabel} · ` : ''}${fmtDay(watchedCheckIn)} — ${fmtDay(watchedCheckOut)}`}
            onClose={() => setSettlement(null)}
            onDone={async () => {
              // Отмена и выезд закрывают бронь — держать её форму открытой
              // не на чем: правки в ней уже запрещены статусом.
              setSettlement(null)
              closeModal()
              await Promise.all([fetchGrid(), fetchToday()])
            }}
          />
        )}

        {/* ── Partner allotment confirmation dialog ── */}
        {/* Вид окна вынесен в AllotmentConfirm: тот же вопрос задаёт окно переезда,
            и пользователь должен узнавать его независимо от того, откуда пришёл. */}
        {allotmentWarning && (
          <AllotmentConfirm
            message={allotmentWarning}
            busy={submitting}
            confirmLabel="Всё равно забронировать"
            busyLabel="Сохраняем…"
            onCancel={() => setAllotmentWarning(null)}
            onConfirm={confirmAllotmentOverride}
          />
        )}

        {/* ── RIGHT: Calculator ── */}
        {!isMaintenance && (
          // Калькулятор растёт вместе с окном, а не остаётся полоской в 340px:
          // раньше вся прибавка ширины доставалась левой колонке, и справа
          // счётчики с суммами продолжали жаться. Нижняя граница — прежние 340px.
          <div style={{ width: 'clamp(340px, 32%, 440px)', flexShrink: 0, display: 'flex', flexDirection: 'column', background: 'var(--surface)', minWidth: 0 }}>
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
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px 24px' }}>

              {/* Начисления существуют только у сохранённой брони: строки привязаны к её id.
                  Для новой брони справа виден предпросмотр по тарифу, а строки создаст сервер. */}
              {isEdit && booking && (
                <ChargesPanel
                  // Строки — ВСЕГДА по счёту: у продолжения переезда своих нет,
                  // они лежат на голове цепочки (data-and-money.md).
                  bookingId={accountId}
                  readOnly={isClosed}
                  onChanged={() => {
                    // Правка строк начислений — это НАША правка брони: сервер
                    // пересобрал итог, и `updatedAt` уже другой. Не подхватив
                    // его, форма получила бы 409 «изменена на другом рабочем
                    // месте» на собственное же действие (D5-004).
                    //
                    // Бронь из ответа панели здесь НЕ используем намеренно: у
                    // продолжения переезда строки лежат на голове счёта, и
                    // панель отвечает бронью ГОЛОВЫ — её `updatedAt` замку
                    // версии этой формы не подходит вовсе. Сверка сама сходит
                    // за той бронью, которая открыта.
                    void syncQuietly()
                    // Ручная строка изменилась — предпросмотр внизу обязан её
                    // учесть, иначе на экране снова окажутся два разных итога.
                    setChargesVersion(v => v + 1)
                  }}
                />
              )}

              {/* Деньги — сразу под начислениями: «начислено» из строк выше, «принято»
                  и «долг» рядом с ним. Гость платит здесь же, у стойки, а раньше
                  единственным входом в кассу был отдельный раздел.
                  Только для сохранённой брони: платёж требует её id. */}
              {isEdit && booking && (
                <BookingMoneyBar
                  ref={moneyBarRef}
                  // Деньги — по счёту цепочки: приём оплаты из формы продолжения
                  // уходит на голову, туда же смотрит «начислено / принято / долг».
                  bookingId={accountId}
                  title="Оплата"
                  guestName={(serverBooking ?? booking).guestName}
                  subtitle={`${roomNumberLabel ? `Номер ${roomNumberLabel} · ` : ''}${fmtDay(watchedCheckIn)} — ${fmtDay(watchedCheckOut)}`}
                  // Единственный источник «принято/долг» в форме: полосу денег
                  // и так грузит она сама, второй такой же запрос был бы гонкой
                  // (из-за неё форма и отправляла устаревшее «Оплачено» — D5-011).
                  onSummary={setMoneySummary}
                  // Приём оплаты и возврат меняют `updatedAt` самой брони —
                  // без этой сверки следующее «Сохранить» упиралось бы в 409
                  // из-за нашей же оплаты, принятой минуту назад.
                  onBookingChanged={() => { void syncQuietly() }}
                  bookingStatus={(serverBooking ?? booking).status}
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
                  {/* «Оплачено» — ВСЕГДА только для чтения (волна 5a). Это кэш
                      журнала платежей: сервер пересчитывает его после каждого
                      приёма, возврата и отмены и с волны 5a не принимает это поле
                      от клиента вовсе. Ручной ввод раньше выглядел как касса, но
                      мимо неё и проходил: в отчёте смены таких денег не было
                      (аудит D2-005). Поправить сумму можно только операцией по
                      журналу — кнопка рядом. Новую бронь оплачивают так же:
                      сначала создать, потом принять деньги.
                      У новой брони полосы денег ещё нет, поэтому и поля нет. */}
                  {isEdit && booking && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <label style={{ fontSize: '0.95rem', color: 'var(--text-muted)' }}>Оплачено (₸)</label>
                        <div
                          className="mono"
                          style={{
                            ...inputStyle,
                            width: 128,
                            textAlign: 'right',
                            background: 'var(--surface-2)',
                            color: 'var(--text-muted)',
                            cursor: 'default',
                          }}
                        >
                          {paidAmount.toLocaleString('ru-RU')}
                        </div>
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>
                        Считается по журналу платежей.{' '}
                        <button
                          type="button"
                          onClick={() => moneyBarRef.current?.openPayment()}
                          style={linkBtnStyle}
                        >
                          Принять оплату
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </CalcSection>

            </div>

            {/* Итог брони — ОДИН на экране (D7-009): числа приходят из
                `POST /bookings/preview`, то есть из того же кода, что выполнит
                сохранение. Панель начислений выше своего итога больше не печатает.
                Раньше здесь были зашитые #fff и #111827 — в тёмной теме
                блок оставался белым островом посреди тёмной формы. */}
            <div style={{
              padding: '18px 22px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'var(--surface)',
              flexShrink: 0,
            }}>
              <PreviewCard
                preview={preview}
                loading={previewLoading || loadingBooking}
                error={previewError}
                paid={paidAmount}
                prepaymentPercent={prepaymentPercent}
                categoryName={categoryName}
                unpricedServices={unpricedServices}
                closed={isClosed}
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
  /**
   * Почему выбранный номер недоступен (null — доступен). Причину отдаём наружу
   * целиком, а не флагом «занят»: квота партнёра — это предупреждение, с ним
   * форма сохраняется по подтверждению, а буфер и пересечение — запрет
   * (docs/decisions/bookings.md).
   */
  onBlock?: (block: RoomBlockReason | null) => void
}

const RoomPicker: React.FC<RoomPickerProps> = ({
  rooms, value, onChange, checkIn, checkOut, excludeBookingId, disabled, onBlock,
}) => {
  const [avail, setAvail] = useState<RoomAvailability>({ availability: {}, reasons: {} })
  const [loadingAvail, setLoadingAvail] = useState(false)
  const availability = avail.availability

  useEffect(() => {
    if (!checkIn || !checkOut || checkOut <= checkIn) {
      setAvail({ availability: {}, reasons: {} })
      setLoadingAvail(false)
      onBlock?.(null)
      return
    }
    // Сразу показываем "Проверяем..." и сбрасываем старые данные
    setLoadingAvail(true)
    setAvail({ availability: {}, reasons: {} })
    const timer = setTimeout(async () => {
      try {
        setAvail(await fetchRoomAvailability(checkIn, checkOut, excludeBookingId))
      } catch (e) {
        console.error('Availability fetch error:', e)
      } finally {
        setLoadingAvail(false)
      }
    }, 400)
    return () => { clearTimeout(timer) }
  }, [checkIn, checkOut, excludeBookingId])

  // Сообщаем родителю о доступности выбранного номера и о причине отказа.
  useEffect(() => {
    if (!value || loadingAvail) { onBlock?.(null); return }
    if (avail.availability[value] !== 'occupied') { onBlock?.(null); return }
    // Причина у сервера есть всегда, но подстраховываемся: без текста форма
    // показала бы пустую плашку вместо объяснения.
    onBlock?.(avail.reasons[value] ?? { reason: 'overlap', text: 'Номер занят на выбранные даты' })
  }, [avail, value, loadingAvail])

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
    // Категория и номер — один выбор в два шага, поэтому при достаточной ширине
    // они стоят рядом, а не двумя строчками одна под другой.
    <div style={fieldGrid(230)}>
      {/* Category dropdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
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
      {/* Плашка остаётся В КОЛОНКЕ НОМЕРА, а не во всю ширину формы: ниже, в блоке
          дат, есть своя зелёная плашка о свободных датах, и две одинаковые полосы
          подряд читались бы как ошибка. Здесь она явно относится к выбору номера. */}
      {value > 0 && datesOk && !loadingAvail && selectedStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '8px 11px', borderRadius: 'var(--ui-radius)',
          background: selectedStatus === 'free' ? '#f0fdf4' : '#fef2f2',
          border: `1px solid ${selectedStatus === 'free' ? '#86efac' : '#fca5a5'}`,
        }}>
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
            background: selectedStatus === 'free' ? '#16a34a' : '#dc2626',
          }} />
          <span style={{
            fontSize: '0.88rem', fontWeight: 600, lineHeight: 1.35,
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <label style={{ fontSize: '0.9em', fontWeight: 600, color: 'var(--text)' }}>Метки</label>
      {/* Пилюли переносятся на несколько рядов почти всегда. Прежний общий gap 6px
          склеивал ряды в кашу — вертикальный зазор нужен заметно больше. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 8, rowGap: 10 }}>
        {flags.map(f => {
          const active = selected.includes(f.id)
          return (
            <button
              key={f.id}
              type="button"
              disabled={disabled}
              onClick={() => onToggle(f.id)}
              style={{
                padding: '6px 14px',
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
            marginTop: 2,
            padding: '8px 10px',
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

// border/background намеренно не заданы инлайн — обычное и focus-состояние
// (мягкая заливка / акцентная обводка со свечением) держит .booking-form-modal
// в theme.css, а инлайн перебил бы CSS :focus.
const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
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
