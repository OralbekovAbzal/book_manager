import React, { useEffect, useState } from 'react'
import { differenceInCalendarDays, format, parseISO } from 'date-fns'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { useAuthStore } from '../../store/useAuthStore'
import { fetchBooking } from '../../api/bookings'
import { BookingMoneyBar } from '../Payments/BookingMoneyBar'
import { BookingPrintDialog, type PrintDocKind } from '../Print/BookingPrintDialog'
import type { Booking } from '../../types'

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED:   'Подтверждена',
  CHECKED_IN:  'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED:   'Отменена',
  NO_SHOW:     'Не приехал',
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED:   '#2563eb',
  CHECKED_IN:  '#059669',
  CHECKED_OUT: '#6b7280',
  CANCELLED:   '#dc2626',
  NO_SHOW:     '#b45309',
}

// Стили кнопок — ДО компонента: константа, объявленная ниже по файлу, при горячей
// перезагрузке падает с «is not defined» (временная мёртвая зона). Уже ловили.
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '1.6rem', color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px', fontWeight: 300,
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}

// Кнопки печатных документов — компактнее остальных: в подвале их теперь
// четыре, а окно брони всего 480px шириной.
const docBtnStyle: React.CSSProperties = {
  ...secondaryBtnStyle, padding: '8px 12px', fontSize: '0.9em',
}

// Документ гостя. Подписи — те же слова, что в форме брони: одно и то же поле
// не должно называться по-разному в двух окнах.
const DOC_TYPE_LABELS: Record<string, string> = {
  passport: 'Паспорт',
  id_card: 'Удостоверение личности',
  other: 'Иной документ',
}

const SEX_LABELS: Record<string, string> = { m: 'Мужской', f: 'Женский' }

const fmtDate = (iso?: string) => {
  if (!iso) return '—'
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })
}

/**
 * Фактические заезд/выезд — настоящий момент времени, а не `@db.Date`. Поэтому
 * НИКАКОГО `timeZone:'UTC'`, в отличие от fmtDate выше: показываем местное время
 * браузера, иначе стойка увидит «09:00» вместо реальных 14:00.
 */
const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'dd.MM.yyyy HH:mm')
}

export const BookingViewModal: React.FC = () => {
  const { modal, closeModal, openEditModal } = useGridStore()
  const { roomFund } = useSettingsStore()
  const role = useAuthStore(s => s.admin?.role)

  const open = modal.open && modal.mode === 'view'
  const booking = modal.booking

  // Объект из сетки может прийти без гостей/сумм — тогда подгружаем полную бронь с сервера
  const [full, setFull] = useState<Booking | null>(null)

  // Какой печатный документ открыт поверх карточки (null — ни одного).
  const [printKind, setPrintKind] = useState<PrintDocKind | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, closeModal])

  // Грузим всегда, а не только когда в сетке нет сумм: питание и услуги брони
  // в объект сетки не входят в принципе (BOOKING_SELECT их не отдаёт), а без них
  // карточка врала бы — «гость без завтрака», хотя завтрак у него есть.
  useEffect(() => {
    setFull(null)
    // Открытый документ принадлежит КОНКРЕТНОЙ брони: при смене брони (и при
    // закрытии карточки) его надо убрать, иначе следующий открытый гость
    // увидит счёт предыдущего.
    setPrintKind(null)
    if (!open || !booking) return
    let cancelled = false
    fetchBooking(booking.id)
      .then(b => { if (!cancelled) setFull(b) })
      .catch(() => { /* секции «Гость»/«Оплата» покажут то, что есть в объекте сетки */ })
    return () => { cancelled = true }
  }, [open, booking?.id])

  if (!open || !booking) return null

  // Гости и оплата — из полной версии, если она подгружена
  const info = full ?? booking

  const nights = differenceInCalendarDays(
    parseISO(booking.checkOut.slice(0, 10)),
    parseISO(booking.checkIn.slice(0, 10)),
  )

  // Гости по типам: колонки «с питанием» и «без питания» складываем — на проживание
  // это деление не влияет, а питание теперь описано услугами брони (см. ниже).
  const guests = {
    adults: (info.adultsWithMeals ?? 0) + (info.adultsNoMeals ?? 0),
    children: (info.childrenWithMeals ?? 0) + (info.childrenNoMeals ?? 0),
    extraBeds: (info.extraBedsWithMeals ?? 0) + (info.extraBedsNoMeals ?? 0),
  }
  const guestTotal = guests.adults + guests.children + guests.extraBeds

  /** «Завтрак — 2 из 3» читается с одного взгляда, в отличие от «adults: 2». */
  const serviceValue = (s: NonNullable<Booking['services']>[number]) => {
    const heads = (s.adults ?? 0) + (s.children ?? 0)
    if (s.service.unit === 'per_person' || s.service.unit === 'per_person_night') {
      return heads >= guestTotal && guestTotal > 0
        ? `все ${heads}`
        : `${heads} из ${guestTotal}`
    }
    return `${s.quantity} шт.`
  }

  const flagLabels = (() => {
    const flags = booking.flags ?? []
    if (flags.length === 0) return []
    const map = new Map((roomFund.bookingFlags ?? []).map(f => [f.id, f.label]))
    return flags.map(f => map.get(f) ?? f)
  })()

  // Блокировка номера («Ремонт») — не бронь: денег по ней не бывает.
  const isMaintenance = booking.source === 'ремонт'

  // ─── Документ ───────────────────────────────────────────────────────────────
  // Только из полной брони: объект сетки этих полей не несёт, и по нему нельзя
  // отличить «документа нет» от «его не прислали». Пока `full` не загрузилась,
  // блока нет вовсе — соврать «документ не записан» хуже, чем промолчать.
  // Тип и номер — одной строкой: «Паспорт AC1234567» читается как в тетради.
  const docRows: { label: string; value: string }[] = []
  if (full) {
    const typeLabel = full.guestDocType ? DOC_TYPE_LABELS[full.guestDocType] ?? full.guestDocType : ''
    const number = (full.guestDocNumber ?? '').trim()
    if (full.guestCitizenship) docRows.push({ label: 'Гражданство', value: full.guestCitizenship })
    if (typeLabel || number) {
      docRows.push({ label: 'Документ', value: [typeLabel, number].filter(Boolean).join(' ') })
    }
    // Даты документа — `@db.Date`, приходят полным ISO. fmtDate режет строку и
    // показывает с timeZone:'UTC' — иначе сдвиг на день назад.
    if (full.guestDocExpiry) docRows.push({ label: 'Действителен до', value: fmtDate(full.guestDocExpiry) })
    if (full.guestBirthDate) docRows.push({ label: 'Дата рождения', value: fmtDate(full.guestBirthDate) })
    if (full.guestSex) docRows.push({ label: 'Пол', value: SEX_LABELS[full.guestSex] ?? full.guestSex })
  }

  // Правило видимости «Редактировать» — ТО ЖЕ, что в BookingGrid/BookingContextMenu.tsx.
  // Два разных правила в двух местах означали бы кнопку, на которую сервер отвечает 400/403:
  // закрытую бронь `update()` не пускает править вовсе, а CHECKED_OUT администратор
  // всё-таки открывает — ради правки фактического времени заезда/выезда.
  const isClosed = ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'].includes(booking.status)
  const isAdmin = role === 'SUPER_ADMIN' || role === 'ADMIN'
  const canEdit = !isClosed || (booking.status === 'CHECKED_OUT' && isAdmin)

  return (
    <>
    <Overlay onClose={closeModal}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '20px 24px 16px', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)' }}>
            {booking.guestName}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{
              fontSize: '0.82rem', fontWeight: 700, color: '#fff',
              background: STATUS_COLORS[booking.status] ?? '#6b7280',
              padding: '2px 9px', borderRadius: 20,
            }}>
              {STATUS_LABELS[booking.status] ?? booking.status}
            </span>
            {booking.partner && (
              <span style={{
                fontSize: '0.82rem', fontWeight: 700, color: '#fff',
                background: booking.partner.color, padding: '2px 9px', borderRadius: 20,
              }}>
                🅰 {booking.partner.name}
              </span>
            )}
          </div>
        </div>
        <button onClick={closeModal} style={closeBtnStyle}>×</button>
      </div>

      {/* Body */}
      <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        <Section title="Проживание">
          <Row label="Заезд" value={fmtDate(booking.checkIn)} />
          <Row label="Выезд" value={fmtDate(booking.checkOut)} />
          <Row label="Ночей" value={String(nights)} />
          {/* Фактические время заезда/выезда: только из полной брони — в объекте
              сетки этих полей нет. Пустые строки не показываем, как и «Источник». */}
          {full?.actualCheckInAt && <Row label="Факт. заезд" value={fmtDateTime(full.actualCheckInAt)} />}
          {full?.actualCheckOutAt && <Row label="Факт. выезд" value={fmtDateTime(full.actualCheckOutAt)} />}
          {booking.source && <Row label="Источник" value={booking.source} />}
        </Section>

        {(booking.guestPhone || guestTotal > 0) && (
          <Section title="Гость">
            {booking.guestPhone && <Row label="Телефон" value={booking.guestPhone} />}
            {guests.adults > 0 && <Row label="Взрослые" value={String(guests.adults)} />}
            {guests.children > 0 && <Row label="Дети" value={String(guests.children)} />}
            {guests.extraBeds > 0 && <Row label="Доп. места" value={String(guests.extraBeds)} />}
          </Section>
        )}

        {/* Документ гостя. У «Ремонта» гостя нет — блок ему не показываем. */}
        {full && !isMaintenance && (
          <Section title="Документ">
            {docRows.length > 0
              ? docRows.map(r => <Row key={r.label} label={r.label} value={r.value} />)
              : (
                <div style={{ fontSize: '0.9rem', color: 'var(--text-faint)' }}>
                  Документ не записан
                </div>
              )}
          </Section>
        )}

        {/* Питание и услуги: сколько человек ими пользуется, а не «включено/нет» */}
        {(full?.services ?? []).length > 0 && (
          <Section title="Питание и услуги">
            {(full?.services ?? []).map(s => (
              <Row key={s.id} label={s.service.name} value={serviceValue(s)} />
            ))}
          </Section>
        )}

        {/* Деньги берём из кассы, а не из полей брони: «начислено» — это сумма строк
            начислений, «принято» — журнал платежей. `Booking.paidAmount` их лишь
            кэширует. Отсюда же принимается оплата: гость платит, стоя у стойки,
            и уходить ради этого в раздел «Касса» не должен. */}
        {!isMaintenance && (
          <Section title="Оплата">
            {(info.discountPercent ?? 0) > 0 && <Row label="Скидка" value={`${info.discountPercent}%`} />}
            <BookingMoneyBar
              bookingId={booking.id}
              guestName={booking.guestName}
              subtitle={[
                full?.room?.number ? `Номер ${full.room.number}` : '',
                `${fmtDate(booking.checkIn)} — ${fmtDate(booking.checkOut)}`,
              ].filter(Boolean).join(' · ')}
              bookingStatus={booking.status}
            />
          </Section>
        )}

        {flagLabels.length > 0 && (
          <Section title="Метки">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {flagLabels.map((l, i) => (
                <span key={i} style={{
                  fontSize: '0.85rem', fontWeight: 600,
                  background: 'var(--surface-2)', color: 'var(--text-muted)',
                  padding: '3px 9px', borderRadius: 6,
                }}>{l}</span>
              ))}
            </div>
          </Section>
        )}

        {booking.notes && (
          <Section title="Примечания">
            <div style={{ fontSize: '0.95rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {booking.notes}
            </div>
          </Section>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '14px 24px', borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'flex-end', alignItems: 'center',
        gap: 8, flexWrap: 'wrap',
      }}>
        {/* Печатные документы. Статус не важен: подтверждение отменённой брони
            тоже спрашивают («покажите, что именно было забронировано»), а счёт
            остаётся счётом. Исключение — «Ремонт»: это блокировка номера,
            гостя и денег у неё нет. */}
        {!isMaintenance && (
          <div style={{ display: 'flex', gap: 8, marginRight: 'auto' }}>
            <button onClick={() => setPrintKind('confirmation')} style={docBtnStyle}>
              Подтверждение
            </button>
            <button onClick={() => setPrintKind('invoice')} style={docBtnStyle}>
              Счёт
            </button>
          </div>
        )}
        {/* «Закрыть» уступает акцент «Редактировать» только когда та есть: у закрытой
            брони без прав единственная кнопка не должна выглядеть второстепенной. */}
        <button onClick={closeModal} style={canEdit ? secondaryBtnStyle : primaryBtnStyle}>Закрыть</button>
        {canEdit && (
          // Передаём объект из сетки, как и контекстное меню: форма правки сама
          // догружает полную бронь по id (BookingModal → fetchBooking).
          <button onClick={() => openEditModal(booking)} style={primaryBtnStyle}>Редактировать</button>
        )}
      </div>
    </Overlay>

    {/* Документ рисуется РЯДОМ с карточкой, а не внутри неё: предпросмотр
        уходит порталом в body, и клик по его фону не должен всплывать
        к обработчику «клик мимо окна закрывает бронь». */}
    {printKind && (
      <BookingPrintDialog
        bookingId={booking.id}
        kind={printKind}
        onClose={() => setPrintKind(null)}
      />
    )}
    </>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div
    onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    <div style={{
      width: '90vw', maxWidth: 480, maxHeight: '88vh',
      background: 'var(--bg)', color: 'var(--text)',
      borderRadius: 12, border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  </div>
)

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div style={{
      fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-faint)',
      letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8,
    }}>{title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
  </div>
)

const Row: React.FC<{ label: string; value: string; valueColor?: string }> = ({ label, value, valueColor }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.95rem' }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontWeight: 600, color: valueColor ?? 'var(--text)', textAlign: 'right' }}>{value}</span>
  </div>
)

