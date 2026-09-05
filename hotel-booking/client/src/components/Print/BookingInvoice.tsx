import React from 'react'
import type { Booking } from '../../types'
import type { BookingCharge } from '../../api/charges'
import type { BookingMoney } from '../../api/payments'
import {
  DocBlock, DocHeader, DocPrintedAt, DocRow, DocSigner,
  INK, INK_SOFT, docDate, docDateLong, docMoney, docTable, docTd, docTfootTd,
  docTh, docTitle, docSubTitle, formatIban, requisiteLines,
  type DocHotel,
} from './printUi'

/**
 * «Счёт на оплату» — документ, без которого турфирма не платит: кому платить,
 * по каким реквизитам, за что и сколько.
 *
 * Строк НДС здесь нет намеренно: отель может быть плательщиком НДС, а может
 * и не быть, поля «плательщик НДС» в настройках объекта нет — а печатать
 * «без НДС» или «в т.ч. НДС», не зная правды, значит врать в документе,
 * с которым идут в банк.
 */

// Константы — ДО компонента (временная мёртвая зона при горячей перезагрузке).

const numTd: React.CSSProperties = { ...docTd, textAlign: 'right', whiteSpace: 'nowrap' }
const numTh: React.CSSProperties = { ...docTh, textAlign: 'right' }

/**
 * Свёртка одинаковых строк начислений.
 *
 * Проживание начисляется ПО НОЧАМ — отдельная строка на каждую (у неё своя
 * дата и своя цена по календарю). В счёте на две недели это четырнадцать
 * одинаковых строк подряд; сворачиваем их в одну «кол-во × цена».
 * Ключ включает цену: если по календарю ночи стоили по-разному, строки
 * останутся раздельными — так и должно быть, это разные цены.
 * Сумма считается сложением `amount`, а не умножением, поэтому итог счёта
 * совпадает с кассой до копейки даже у ручных строк, где сумма задана руками.
 */
function foldCharges(rows: BookingCharge[]) {
  const out: { key: string; label: string; quantity: number; unitPrice: number; amount: number }[] = []
  const index = new Map<string, number>()
  for (const c of rows) {
    const key = `${c.kind}|${c.label}|${c.unitPrice}`
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, out.length)
      out.push({ key, label: c.label, quantity: c.quantity, unitPrice: c.unitPrice, amount: c.amount })
    } else {
      out[at].quantity += c.quantity
      out[at].amount += c.amount
    }
  }
  return out
}

interface Props {
  booking: Booking
  hotel: DocHotel
  charges: BookingCharge[]
  money: BookingMoney | null
  printedAt: Date
}

export const BookingInvoice: React.FC<Props> = ({ booking, hotel, charges, money, printedAt }) => {
  const cur = hotel.currency
  const lines = foldCharges(charges)

  // Итог — из кассы (там же считается долг), иначе сумма строк: две разные
  // цифры в счёте и в «Кассе» на одну бронь недопустимы.
  const total = money ? money.charged : lines.reduce((s, l) => s + l.amount, 0)
  const paid = money?.paid ?? 0
  const due = money ? money.due : total - (booking.paidAmount ?? 0)

  // Плательщик: турфирма, если бронь пришла от партнёра, иначе сам гость.
  // Счёт на оплату нужен как раз партнёру — гостю чаще хватает подтверждения.
  const payer = booking.partner?.name || booking.guestName

  const supplier = requisiteLines([
    { label: 'Наименование', value: hotel.legalName || hotel.name },
    { label: 'БИН / ИИН', value: hotel.bin },
    { label: 'Адрес', value: hotel.address },
    { label: 'Банк', value: hotel.bankName },
    { label: 'IBAN', value: formatIban(hotel.iban) },
    { label: 'Телефон', value: hotel.phone },
    { label: 'Эл. почта', value: hotel.email },
  ])

  const basis = [
    `бронирование № ${booking.id}`,
    booking.room?.number ? `номер ${booking.room.number}` : '',
    `${docDate(booking.checkIn)} — ${docDate(booking.checkOut)}`,
    booking.guestName ? `гость ${booking.guestName}` : '',
  ].filter(Boolean).join(', ')

  return (
    <>
      <DocHeader hotel={hotel} />

      <h1 style={docTitle}>Счёт на оплату № {booking.id}</h1>
      <div style={docSubTitle}>от {docDateLong(printedAt)}</div>

      <DocBlock title="Поставщик">
        {supplier.map(r => <DocRow key={r.label} label={r.label!} value={r.value} />)}
      </DocBlock>

      <DocBlock title="Плательщик">
        <DocRow label="Наименование" value={payer} strong />
        <DocRow label="Основание" value={basis} />
      </DocBlock>

      <div className="doc-block" style={{ marginBottom: '5mm' }}>
        <table className="doc-table" style={docTable}>
          <thead>
            <tr>
              <th style={{ ...docTh, width: '10mm' }}>№</th>
              <th style={docTh}>Наименование</th>
              <th style={{ ...numTh, width: '20mm' }}>Кол-во</th>
              <th style={{ ...numTh, width: '30mm' }}>Цена</th>
              <th style={{ ...numTh, width: '32mm' }}>Сумма</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td style={{ ...docTd, color: INK_SOFT }} colSpan={5}>
                  Начисления по брони не заведены
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td style={docTd}>{i + 1}</td>
                <td style={docTd}>{l.label}</td>
                <td style={numTd}>{l.quantity}</td>
                <td style={numTd}>{docMoney(l.unitPrice, cur)}</td>
                <td style={numTd}>{docMoney(l.amount, cur)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td style={{ ...docTfootTd, textAlign: 'right' }} colSpan={4}>Итого к оплате</td>
              <td style={{ ...docTfootTd, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {docMoney(total, cur)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <DocBlock>
        <DocRow label="Принято" value={docMoney(paid, cur)} />
        <DocRow
          label={due < 0 ? 'Переплата' : 'Остаток к оплате'}
          value={docMoney(Math.abs(due), cur)}
          strong
        />
      </DocBlock>

      {/* Реквизиты для платежа продублированы строкой: их ищут глазами первым
          делом, и в бухгалтерии счёт часто читают уже с этого места. */}
      {(hotel.iban || hotel.bankName) && (
        <div style={{ fontSize: '9.5pt', color: INK, marginTop: '4mm' }}>
          Оплату производить по реквизитам поставщика
          {hotel.iban ? `: ${formatIban(hotel.iban)}` : ''}
          {hotel.bankName ? ` (${hotel.bankName})` : ''}.
        </div>
      )}

      <DocSigner hotel={hotel} />
      <DocPrintedAt at={printedAt} />
    </>
  )
}
