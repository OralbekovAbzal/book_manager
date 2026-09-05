import React from 'react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import type { Booking } from '../../types'
import type { BookingMoney } from '../../api/payments'
import {
  DocBlock, DocHeader, DocPrintedAt, DocRow, DocSigner,
  INK, INK_SOFT, docDate, docMoney, docTitle,
  type DocHotel,
} from './printUi'

/**
 * «Подтверждение бронирования» — бумажка, которую гость просит прислать
 * в WhatsApp или показывает на заезде: что забронировано, на какие даты,
 * сколько стоит и сколько уже оплачено.
 *
 * Это НЕ счёт: строк начислений здесь нет намеренно — гостю нужны даты,
 * номер и итог, а разбор по ночам он не читает. Разбор — в счёте.
 */

// Константы — ДО компонента (временная мёртвая зона при горячей перезагрузке).

const thanksStyle: React.CSSProperties = {
  marginTop: '8mm', fontSize: '10.5pt', color: INK, fontWeight: 600,
}

/** «Завтрак — 2 чел.» вместо «adults: 2»: на бумаге читается с одного взгляда. */
const serviceAmount = (s: NonNullable<Booking['services']>[number]) => {
  const heads = (s.adults ?? 0) + (s.children ?? 0)
  return s.service.unit === 'per_person' || s.service.unit === 'per_person_night'
    ? `${heads} чел.`
    : `${s.quantity} шт.`
}

interface Props {
  booking: Booking
  hotel: DocHotel
  /** Деньги из кассы: «начислено» — сумма строк, «принято» — журнал платежей. */
  money: BookingMoney | null
  printedAt: Date
}

export const BookingConfirmation: React.FC<Props> = ({ booking, hotel, money, printedAt }) => {
  const cur = hotel.currency

  const nights = differenceInCalendarDays(
    parseISO(booking.checkOut.slice(0, 10)),
    parseISO(booking.checkIn.slice(0, 10)),
  )

  // Колонки «с питанием» и «без питания» складываем: питание теперь описано
  // услугами брони, и на подтверждении важно ЧИСЛО гостей, а не это деление.
  const adults = (booking.adultsWithMeals ?? 0) + (booking.adultsNoMeals ?? 0)
  const children = (booking.childrenWithMeals ?? 0) + (booking.childrenNoMeals ?? 0)
  const extraBeds = (booking.extraBedsWithMeals ?? 0) + (booking.extraBedsNoMeals ?? 0)

  const guestParts = [
    adults > 0 ? `взрослых — ${adults}` : '',
    children > 0 ? `детей — ${children}` : '',
    extraBeds > 0 ? `доп. мест — ${extraBeds}` : '',
  ].filter(Boolean)

  const services = booking.services ?? []

  // Итог берём из кассы (сумма строк начислений). Если касса не ответила —
  // сохранённый итог брони: лучше показать старое число, чем пустое место.
  const charged = money ? money.charged : (booking.totalAmount ?? 0)
  const paid = money?.paid ?? 0
  const due = money ? money.due : charged - (booking.paidAmount ?? 0)
  const prepaid = booking.prepaidAmount ?? 0

  const roomLine = [
    booking.room?.number ? `№ ${booking.room.number}` : '',
    booking.room?.category?.name || '',
  ].filter(Boolean).join(' · ')

  return (
    <>
      <DocHeader hotel={hotel} />

      {/* Дата документа — внизу, в «сформирован …»: `createdAt` брони сюда не
          годится (это timestamp, а не дата суток), а две даты в шапке путают. */}
      <h1 style={{ ...docTitle, marginBottom: '6mm' }}>
        Подтверждение бронирования № {booking.id}
      </h1>

      <DocBlock title="Гость">
        <DocRow label="ФИО" value={booking.guestName} strong />
        {booking.guestPhone && <DocRow label="Телефон" value={booking.guestPhone} />}
        {guestParts.length > 0 && <DocRow label="Гостей" value={guestParts.join(', ')} />}
      </DocBlock>

      <DocBlock title="Проживание">
        <DocRow label="Заезд" value={docDate(booking.checkIn)} strong />
        <DocRow label="Выезд" value={docDate(booking.checkOut)} strong />
        <DocRow label="Ночей" value={String(nights)} />
        {roomLine && <DocRow label="Номер" value={roomLine} />}
      </DocBlock>

      {services.length > 0 && (
        <DocBlock title="Питание и услуги">
          {services.map(s => (
            <DocRow key={s.id} label={s.service.name} value={serviceAmount(s)} />
          ))}
        </DocBlock>
      )}

      <DocBlock title="Оплата">
        <DocRow label="Сумма к оплате" value={docMoney(charged, cur)} strong />
        {prepaid > 0 && <DocRow label="Предоплата" value={docMoney(prepaid, cur)} />}
        <DocRow label="Принято" value={docMoney(paid, cur)} />
        <DocRow
          label={due < 0 ? 'Переплата' : 'Остаток к оплате'}
          value={docMoney(Math.abs(due), cur)}
          strong
        />
      </DocBlock>

      <div style={thanksStyle}>Спасибо, что выбрали нас.</div>

      <DocSigner hotel={hotel} />
      <DocPrintedAt at={printedAt} />

      {/* Пояснение мелким шрифтом: гость на заезде спрашивает именно это. */}
      <div style={{ marginTop: '4mm', fontSize: '8.5pt', color: INK_SOFT }}>
        Документ носит информационный характер и подтверждает бронирование
        на указанные даты.
      </div>
    </>
  )
}
