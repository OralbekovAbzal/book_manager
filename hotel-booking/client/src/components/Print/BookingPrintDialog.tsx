import React, { useEffect, useState } from 'react'
import { fetchBooking } from '../../api/bookings'
import { fetchCharges, type BookingCharge } from '../../api/charges'
import { fetchBookingPayments, type BookingMoney } from '../../api/payments'
import { fetchHotel } from '../../api/hotel'
import { PrintPreview } from './PrintPreview'
import { BookingConfirmation } from './BookingConfirmation'
import { BookingInvoice } from './BookingInvoice'
import { INK_SOFT, type DocHotel } from './printUi'
import type { Booking } from '../../types'

/**
 * Загрузка данных для печатного документа и выбор самого документа.
 *
 * Всё берём с сервера заново, а не из объекта сетки: тому неизвестны ни услуги
 * брони, ни строки начислений, ни принятые платежи — а печатать «Принято: 0»
 * там, где деньги приняты, хуже, чем не печатать вовсе.
 *
 * `bookingId` — это id СЧЁТА (головы цепочки): после переезда начисления и
 * платежи лежат на первой части, а документ выписывается на всё проживание.
 * Кто открывает документ, тот и приводит id к счёту (`accountIdOf`).
 */

export type PrintDocKind = 'confirmation' | 'invoice'

// Константы — ДО компонента (временная мёртвая зона при горячей перезагрузке).

const DOC_TITLES: Record<PrintDocKind, string> = {
  confirmation: 'Подтверждение бронирования',
  invoice: 'Счёт на оплату',
}

const stateBoxStyle: React.CSSProperties = {
  padding: '20mm 0', textAlign: 'center', fontSize: '11pt', color: INK_SOFT,
}

interface Data {
  booking: Booking
  hotel: DocHotel
  charges: BookingCharge[]
  money: BookingMoney | null
}

interface Props {
  bookingId: number
  kind: PrintDocKind
  onClose: () => void
}

export const BookingPrintDialog: React.FC<Props> = ({ bookingId, kind, onClose }) => {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  // Момент открытия документа: одна дата на весь лист. Если считать её в каждом
  // месте отдельно, документ, открытый в 23:59:59, получит две разные даты.
  const [printedAt] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')

    // Начисления нужны только счёту: подтверждение печатает итог, а не разбор.
    const chargesReq = kind === 'invoice'
      ? fetchCharges(bookingId).then(r => r.data)
      : Promise.resolve<BookingCharge[]>([])

    Promise.all([
      fetchBooking(bookingId),
      fetchHotel(),
      chargesReq,
      // Касса может ответить ошибкой (нет прав, сеть) — документ всё равно
      // печатаем, суммы возьмутся из полей брони.
      fetchBookingPayments(bookingId).then(r => r.summary).catch(() => null),
    ])
      .then(([booking, hotel, charges, money]) => {
        if (!cancelled) setData({ booking, hotel, charges, money })
      })
      .catch(() => {
        if (!cancelled) setError('Не удалось загрузить данные для документа')
      })

    return () => { cancelled = true }
  }, [bookingId, kind])

  const fileName = kind === 'invoice'
    ? `Счёт-${bookingId}`
    : `Подтверждение-${bookingId}`

  return (
    <PrintPreview title={DOC_TITLES[kind]} fileName={fileName} onClose={onClose}>
      {error && <div style={stateBoxStyle}>{error}</div>}
      {!error && !data && <div style={stateBoxStyle}>Загрузка…</div>}
      {data && kind === 'confirmation' && (
        <BookingConfirmation
          booking={data.booking}
          hotel={data.hotel}
          money={data.money}
          printedAt={printedAt}
        />
      )}
      {data && kind === 'invoice' && (
        <BookingInvoice
          booking={data.booking}
          hotel={data.hotel}
          charges={data.charges}
          money={data.money}
          printedAt={printedAt}
        />
      )}
    </PrintPreview>
  )
}
