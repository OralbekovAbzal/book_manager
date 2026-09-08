import { describe, it, expect } from 'vitest'
import {
  makeStack, run, booking, room, rate, service, charge, chargesOf, totalOf, d,
} from './helpers/bookingStack.js'

/**
 * Найденное волной тестов, но НЕ починенное — по правилу роли: тест описывает, как
 * должно быть, и помечен `it.fails`, чтобы прогон оставался зелёным и падение не
 * спутали с поломкой. Как только поведение исправят, `it.fails` начнёт падать
 * («ожидали провал, а тест прошёл») — это и есть сигнал снять пометку.
 *
 * Подробности каждой находки — в комментарии перед тестом: файл, строка, вход.
 */

const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })
const RATES = ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso))

/**
 * Бронь 10→13 июля, 2 взр., завтрак, скидка 10 %.
 * Строка «Скидка 10%» уже ПРАВЛЕНА администратором (`updateCharge` переводит
 * авто-строку в `source: 'manual'`, см. bookingController.js:1475) — уступка 8 000
 * вместо расчётных 11 100.
 */
function discountEditedByHand({ businessDate } = {}) {
  return makeStack({
    businessDate,
    rates: RATES,
    services: [BREAKFAST],
    rooms: [room({ id: 101 })],
    bookingServices: [{ id: 1, bookingId: 7, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
    bookings: [booking({
      id: 7, status: 'CHECKED_IN', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
      discountPercent: 10, totalAmount: 103000,
    })],
    charges: [
      charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 4, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
      charge({
        id: 5, bookingId: 7, kind: 'discount', label: 'Скидка 10%', quantity: 1,
        unitPrice: -8000, amount: -8000, source: 'manual', reason: 'договорились на 8 000',
      }),
    ],
  })
}

/**
 * НАХОДКА 1 (деньги, тяжёлая). `server/src/utils/charges.js:196-215` — блок процентной
 * скидки в `buildAutoChargesDetailed` пишет строку «Скидка N%» БЕЗ проверки
 * `manualLabels`, в отличие от проживания (сверка по дате, :136) и услуг (:170).
 *
 * Вход: у брони со скидкой 10 % администратор поправил строку «Скидка 10%»
 * (`PUT /bookings/7/charges/5`) — она стала ручной на −8 000. Любая последующая
 * пересборка добавляет ВТОРУЮ строку «Скидка 10%» на −11 100 рядом с ручной.
 * Гость получает скидку 19 100 вместо согласованных 8 000.
 *
 * Достижимо кнопкой «Пересчитать» (`POST /:id/charges/rebuild`), сохранением брони
 * с новыми датами/гостями и — с волны 5a — ранним выездом (см. следующий тест).
 * Дефект не новый (блок скидки такой с 2026-09-04), но волна 5a добавила ему путей.
 */
it('правленная вручную скидка не должна дублироваться авто-строкой при пересборке', async () => {
  const st = discountEditedByHand()

  await run(st.ctrl.rebuildCharges, { params: { id: '7' } })

  const discounts = chargesOf(st.prisma, 7).filter((c) => c.kind === 'discount')
  expect(discounts).toHaveLength(1)
  expect(discounts[0].amount).toBe(-8000)
  expect(totalOf(st.prisma, 7)).toBe(103000)   // сейчас 91 900: скидка снята дважды
})

/** Та же находка 1, но через путь волны 5a — ранний выезд (`trimChargesToCheckOut`). */
it('ранний выезд не должен добавлять вторую строку скидки к правленной вручную', async () => {
  const st = discountEditedByHand({ businessDate: d('2026-07-12') })

  await run(st.ctrl.checkOut, { params: { id: '7' } })

  expect(chargesOf(st.prisma, 7).filter((c) => c.kind === 'discount')).toHaveLength(1)
})

/**
 * НАХОДКА 2 (права, средняя). `server/src/controllers/bookingController.js:1401-1414`
 * — `loadBookingForCharges` проверяет роль ТОЛЬКО при `allowClosed: true`, а этот
 * флаг ставит один `addCharge` (:1441). `updateCharge` (:1477) и `removeCharge`
 * (:1524) зовут её без флага, поэтому на закрытой (`CHECKED_OUT`) брони роль не
 * проверяется вовсе.
 *
 * Вход: бронь 7 в статусе CHECKED_OUT с ручной строкой «Удержание» 15 000.
 * STAFF не может её ДОБАВИТЬ (403), но может обнулить `PUT /bookings/7/charges/1`
 * и удалить `DELETE /bookings/7/charges/1` — оба 200. Граница «правка денег по
 * закрытой сделке — только администратор» держится с одной стороны.
 *
 * Практический вес зависит от судьбы роли STAFF (пункт 1 волны 5): если её уберут,
 * находка станет теоретической.
 */
it.fails('STAFF не должен править и удалять строки закрытой брони', async () => {
  const closed = () => makeStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, status: 'CHECKED_OUT', totalAmount: 15000 })],
    charges: [charge({
      id: 1, bookingId: 7, kind: 'extra', label: 'Удержание', amount: 15000,
      unitPrice: 15000, source: 'manual', reason: 'политика отмены',
    })],
  })
  const staff = { id: 2, name: 'Стойка', role: 'STAFF' }

  const edited = closed()
  const up = await run(edited.ctrl.updateCharge, {
    params: { id: '7', chargeId: '1' },
    body: { quantity: 1, unitPrice: 0, reason: 'обнуляю' },
    admin: staff,
  })
  expect(up.status).toBe(403)

  const removed = closed()
  const del = await run(removed.ctrl.removeCharge, {
    params: { id: '7', chargeId: '1' }, admin: staff,
  })
  expect(del.status).toBe(403)
  expect(chargesOf(removed.prisma, 7)).toHaveLength(1)
})

/**
 * НАХОДКА 3 (деньги, лёгкая). `server/src/controllers/bookingController.js:569-577`
 * пересчитывает предоплату через `recalcBookingTotals(..., { keepIfEmpty: true })`,
 * а та выходит РАНЬШЕ любых записей, если строк начислений нет вовсе
 * (`utils/charges.js:301`). У брони без строк смена процента предоплаты теперь не
 * меняет ничего: клиент `prepaidAmount` больше не присылает (волна 5a), а сервер
 * его не считает.
 *
 * Вход: бронь с `totalAmount: 100 000`, без `BookingCharge` (таких 107 в рабочей
 * базе, см. NOTES) → `PUT /bookings/7 { prepaymentPercent: 30 }` → в базе
 * `prepaymentPercent = 30`, а `prepaidAmount` остался 50 000 вместо 30 000.
 * В форме и в печати брони предоплата и процент противоречат друг другу.
 */
it('смена процента предоплаты у брони без строк должна пересчитать саму предоплату', async () => {
  const st = makeStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, totalAmount: 100000, prepaidAmount: 50000, prepaymentPercent: 50 })],
  })

  const r = await run(st.ctrl.update, { params: { id: '7' }, body: { prepaymentPercent: 30 } })

  expect(r.body.data.prepaymentPercent).toBe(30)
  expect(r.body.data.totalAmount).toBe(100000)  // старый итог не обнуляем — это верно
  expect(r.body.data.prepaidAmount).toBe(30000) // сейчас 50 000
})

/**
 * НАХОДКА 4 (данные, средняя). `server/src/controllers/paymentController.js:213-234`
 * — экран «кто должен» теперь берёт и отменённые, отсеивая их по `paid !== 0 ||
 * due !== 0`. Но `due` считается через `utils/bookingMoney.js:80`: когда строк
 * начислений нет, «начислено» берётся из кэша `Booking.totalAmount`.
 *
 * Вход: бронь, отменённая ДО волны 5a (тогда `cancel` только менял статус), —
 * `status: 'CANCELLED'`, `totalAmount: 120 000`, ни строк, ни платежей. В списке
 * долгов она появляется с долгом 120 000 (`chargesFromRows: false`), хотя не должна
 * никому ничего: новый `cancel` обнулил бы ей итог. На рабочей базе таких броней
 * много — экран приёма оплаты и отчёт «Долги» покажут фантомные суммы.
 * Лечится либо разовой миграцией итогов отменённых броней, либо условием
 * «отменённую без строк начислений считать нулевой».
 */
it('отменённая бронь без строк начислений не должна висеть должником по старому итогу', async () => {
  const st = makeStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({
      id: 50, status: 'CANCELLED', checkIn: d('2026-07-11'), checkOut: d('2026-07-14'),
      totalAmount: 120000, paidAmount: 0,
    })],
  })

  const r = await run(st.payCtrl.debts, { query: {} })

  expect(r.body.data.bookings).toEqual([])
})
