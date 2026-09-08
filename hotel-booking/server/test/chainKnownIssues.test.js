import { describe, it, expect } from 'vitest'
import {
  makeStack, run, booking, room, rate, service, charge, chargesOf, totalOf, d,
} from './helpers/bookingStack.js'

/**
 * Найденное тестами волны 5b и ПОЧИНЕННОЕ доработкой 5b (2026-09-08). Тесты были
 * написаны как `it.fails` (описывают, как должно быть, прогон при этом зелёный);
 * после починки пометка снята — теперь это обычная защита от возврата дефектов.
 * Разделы «Что есть» ниже описывают поведение ДО починки, они оставлены как история.
 *
 * Все три находки живут в одном месте модели: «текущий сегмент цепочки». Услуги,
 * скидка и процент предоплаты берутся у него, и пока сегменты только добавляются,
 * это работает. Ломается там, где последний сегмент МЕНЯЕТСЯ или исчезает.
 */

const STANDARD = { id: 1, name: 'Стандарт', color: '#ccc' }
const COMFORT = { id: 2, name: 'Комфорт', color: '#ccc' }
const ROOM_STD = room({ id: 101, categoryId: 1, category: STANDARD })
const ROOM_CMF = room({ id: 201, categoryId: 2, category: COMFORT })

const NIGHTS = ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']
const RATES = [
  ...NIGHTS.map((iso) => rate(iso, { categoryId: 1, adultPrice: 10000 })),
  ...NIGHTS.map((iso) => rate(iso, { categoryId: 2, adultPrice: 15000 })),
]
const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })

const moveToComfort = (st) =>
  run(st.ctrl.move, { params: { id: '1' }, body: { newRoomId: 201, moveDate: '2026-07-12' } })

// ─────────────────────────────────────────────────────────────────────────────

/**
 * НАХОДКА 1 (деньги, средняя). Выезд гостя В ДЕНЬ ПЕРЕЕЗДА стирает со счёта
 * питание и услуги за УЖЕ ПРОЖИТЫЕ ночи.
 *
 * Где. `server/src/controllers/bookingController.js:763` — выезд день-в-день с
 * заездом это отмена (гость не ночевал), и для продолжения `applyCancel` (:743)
 * зовёт `rebuildChainCharges` головы. Дальше `server/src/utils/charges.js:518`
 * выбрасывает из цепочки отменённые продолжения, а `:573-577` берёт набор
 * `BookingService` у ПОСЛЕДНЕГО ОСТАВШЕГОСЯ сегмента — то есть у головы. Но
 * `move()` (`bookingController.js:1119-1122`) услуги на продолжение ПЕРЕНЁС, а не
 * скопировал: у головы их нет, и генератор считает, что услуг не было вовсе.
 *
 * Вход. Бронь 10 → 14 июля, «Стандарт», 2 взрослых, завтрак 3 500 с человека за
 * ночь, скидка 10 %. Рабочая дата 12-е: гость переезжает в «Комфорт» и в тот же
 * день уезжает совсем (`POST /bookings/2/checkout`).
 *
 * Что должно быть: 2 ночи «Стандарта» 40 000 + завтраки за эти 2 ночи 14 000
 * − 10 % = 48 600.
 * Что есть: 40 000 − 10 % = 36 000. Завтраки исчезли — отель теряет 14 000
 * начислений (12 600 после скидки), и восстановить их нечем: строки
 * `BookingService` остались на отменённом продолжении, поэтому и последующая
 * кнопка «Пересчитать» на голове их не увидит. Тем же путём теряется любая
 * платная услуга — трансфер, сауна, поздний выезд.
 *
 * Опасность на практике: сценарий редкий (переехал и в тот же день уехал), но
 * тихий — счёт просто становится меньше, и заметить это можно только сверкой
 * с кухней. Это тот же класс дефекта, что и «касса не попадала в резервную копию».
 */
describe('НАХОДКА 1: выезд в день переезда теряет питание за прожитые ночи', () => {
  function movedAndLeftSameDay() {
    const st = makeStack({
      businessDate: d('2026-07-12'),
      rooms: [ROOM_STD, ROOM_CMF],
      rates: RATES,
      services: [BREAKFAST],
      bookingServices: [{ id: 1, bookingId: 1, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
      bookings: [booking({
        id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
        checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
        discountPercent: 10, totalAmount: 97200, prepaidAmount: 48600,
      })],
      charges: [
        charge({ id: 1, bookingId: 1, date: d('2026-07-10'), amount: 20000, unitPrice: 20000 }),
        charge({ id: 2, bookingId: 1, date: d('2026-07-11'), amount: 20000, unitPrice: 20000 }),
        charge({ id: 3, bookingId: 1, date: d('2026-07-12'), amount: 20000, unitPrice: 20000 }),
        charge({ id: 4, bookingId: 1, date: d('2026-07-13'), amount: 20000, unitPrice: 20000 }),
        charge({ id: 5, bookingId: 1, kind: 'meal', label: 'Завтрак', quantity: 8, unitPrice: 3500, amount: 28000 }),
        charge({ id: 6, bookingId: 1, kind: 'discount', label: 'Скидка 10%', quantity: 1, unitPrice: -10800, amount: -10800 }),
      ],
    })
    return st
  }

  it('непрожитые ночи снимаются, а прожитые остаются — эта часть работает', async () => {
    // Контроль: сам механизм отмены продолжения исправен, дефект ровно в услугах.
    const st = movedAndLeftSameDay()
    await moveToComfort(st)

    await run(st.ctrl.checkOut, { params: { id: '2' } })

    const stays = chargesOf(st.prisma, 1).filter((c) => c.kind === 'stay')
    expect(stays.map((c) => c.amount)).toEqual([20000, 20000])
    expect(st.prisma.booking.rows.find((b) => b.id === 2).status).toBe('CANCELLED')
  })

  it('завтраки за прожитые ночи должны остаться в счёте', async () => {
    const st = movedAndLeftSameDay()
    await moveToComfort(st)

    await run(st.ctrl.checkOut, { params: { id: '2' } })

    const meal = chargesOf(st.prisma, 1).find((c) => c.kind === 'meal')
    expect(meal, 'строка питания пропала со счёта').toBeTruthy()
    expect(meal.quantity).toBe(4)      // 2 взр. × 2 прожитые ночи
    expect(meal.amount).toBe(14000)
    // 40 000 + 14 000 − 10 %
    expect(totalOf(st.prisma, 1)).toBe(48600)
  })

  it('«Пересчитать» после этого тоже должно вернуть питание, а не закрепить потерю', async () => {
    // Услуги остались на отменённом продолжении, поэтому счёт не чинится и вручную:
    // администратор нажмёт «Пересчитать» и получит ту же сумму без завтраков.
    const st = movedAndLeftSameDay()
    await moveToComfort(st)
    await run(st.ctrl.checkOut, { params: { id: '2' } })

    await run(st.ctrl.rebuildCharges, { params: { id: '1' } })

    expect(chargesOf(st.prisma, 1).find((c) => c.kind === 'meal')).toBeTruthy()
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * НАХОДКА 2 (предпросмотр ≠ сохранённое, средняя). Форма брони показывает цепочку
 * старой брони ДОРОЖЕ, чем она есть в базе.
 *
 * Где. `server/src/controllers/bookingController.js:1291-1336` — предпросмотр
 * собирает отрезки цепочки и отдаёт их генератору напрямую, БЕЗ `segmentsToPrice`
 * (`utils/charges.js:544`). А эта функция и есть правило для 107 старых броней без
 * строк (см. NOTES): если у головы есть строка «Проживание · по прежнему расчёту»
 * (`pinLegacyTotal`), она покрывает ВЕСЬ срок до первого переезда, и ночи головы
 * считать заново нельзя. Пересборка (`rebuildChainCharges:597`) и план раннего
 * выезда (`planEarlyCheckout:740`) это правило применяют — предпросмотр нет.
 *
 * Вход. Старая бронь без строк начислений: 10 → 14 июля, `totalAmount 97 200`.
 * Рабочая дата 12-е, переезд в «Комфорт». В базе после переезда: 97 200 (прежний
 * расчёт) + 30 000 + 30 000 = 157 200. Открываем форму продолжения —
 * `POST /bookings/preview` с `bookingId: 2` отвечает 197 200: две ночи «Стандарта»
 * по 20 000 начислены поверх зафиксированной суммы.
 *
 * Опасность на практике: 40 000 разницы на экране против базы — ровно та беда,
 * ради которой волна 5a переводила предпросмотр на серверный код (D7-009).
 * Администратор называет гостю сумму из формы, а в кассе и в печати другая.
 * Ограничение: только брони БЕЗ строк начислений (в рабочей базе их 107) и только
 * после переезда; у новых броней предпросмотр сходится (проверено в
 * `bookingChain.test.js`).
 */
describe('НАХОДКА 2: предпросмотр цепочки со старым итогом считает ночи головы дважды', () => {
  async function legacyChain() {
    const st = makeStack({
      businessDate: d('2026-07-12'),
      rooms: [ROOM_STD, ROOM_CMF],
      rates: RATES,
      bookings: [booking({
        id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
        checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
        totalAmount: 97200, prepaidAmount: 48600,
      })],
      charges: [],
    })
    await moveToComfort(st)
    return st
  }

  const PREVIEW = {
    bookingId: 2, roomId: 201, checkIn: '2026-07-12', checkOut: '2026-07-14',
    adultsWithMeals: 2, services: [],
  }

  it('в базе счёт сложен верно — ночи головы покрыты прежним расчётом', async () => {
    // Контроль: пересборка правило соблюдает, расходится именно предпросмотр.
    const st = await legacyChain()
    expect(totalOf(st.prisma, 1)).toBe(157200)
  })

  it('предпросмотр обязан показать тот же итог, что лежит в базе', async () => {
    const st = await legacyChain()

    const res = await run(st.ctrl.preview, { body: PREVIEW })

    expect(res.body.data.total).toBe(157200)
  })

  it('ночей головы в предпросмотре быть не должно: они внутри прежнего расчёта', async () => {
    const st = await legacyChain()

    const res = await run(st.ctrl.preview, { body: PREVIEW })
    const dates = res.body.data.rows.filter((r) => r.kind === 'stay' && r.date).map((r) => r.date)

    expect(dates).toEqual(['2026-07-12', '2026-07-13'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────

/**
 * НАХОДКА 3 (расхождение на экране, лёгкая). Процент предоплаты, изменённый в форме
 * текущего отрезка, не меняет сумму предоплаты по счёту.
 *
 * Где. Решение волны 5b (`docs/decisions/data-and-money.md`): скидка %, процент
 * предоплаты и услуги берутся у ТЕКУЩЕГО (последнего) отрезка. Скидка так и
 * работает — `utils/charges.js:161` берёт `inputs` у последнего сегмента. А
 * предоплату считает `recalcBookingTotals` (`charges.js:372,379`), и она читает
 * `prepaymentPercent` у брони, для которой пересчитывает итог, — то есть всегда у
 * ГОЛОВЫ (`bookingController.js:659-663` зовёт её с `accountId`). Процент,
 * записанный в продолжение, не влияет ни на что.
 *
 * Вход. Цепочка на 100 000 (голова + продолжение), у головы `prepaymentPercent 50`,
 * предоплата 50 000. `PUT /bookings/2 { prepaymentPercent: 30 }` → у продолжения
 * в базе 30 %, у счёта по-прежнему 50 000 вместо 30 000.
 *
 * Опасность на практике: денежного расхождения нет (предоплата — ориентир «сколько
 * взять сейчас», а не начисление), но форма показывает «Предоплата 30 %» рядом с
 * суммой от 50 %, и та же сумма уходит в печать подтверждения. Это ровно та же
 * болезнь, что находка 3 в `moneyKnownIssues.test.js` — там её починили для
 * одиночной брони, у цепочки она осталась.
 *
 * Отдельно: та же правка возвращает клиенту `prepaidAmount: 0` (поле продолжения),
 * и форма обязана брать деньги по `accountIdOf`. Это по контракту, здесь не тест.
 */
describe('НАХОДКА 3: процент предоплаты текущего отрезка ни на что не влияет', () => {
  async function chainWithPrepayment() {
    const st = makeStack({
      businessDate: d('2026-07-12'),
      rooms: [ROOM_STD, ROOM_CMF],
      rates: RATES,
      bookings: [booking({
        id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
        checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
        prepaymentPercent: 50, totalAmount: 0, prepaidAmount: 0,
      })],
      charges: [],
    })
    await run(st.ctrl.rebuildCharges, { params: { id: '1' } })
    await moveToComfort(st)
    return st
  }

  const head = (st) => st.prisma.booking.rows.find((b) => b.id === 1)

  it('исходное состояние: счёт 100 000, предоплата 50 % = 50 000', async () => {
    const st = await chainWithPrepayment()
    expect(totalOf(st.prisma, 1)).toBe(100000)
    expect(head(st).prepaidAmount).toBe(50000)
  })

  it('скидка, изменённая у продолжения, СЧИТАЕТСЯ — правило работает для неё', async () => {
    // Контроль: «вход текущего отрезка» реализован, но не для процента предоплаты.
    const st = await chainWithPrepayment()

    await run(st.ctrl.update, { params: { id: '2' }, body: { discountPercent: 10 } })

    expect(chargesOf(st.prisma, 1).find((c) => c.kind === 'discount').amount).toBe(-10000)
  })

  it('процент предоплаты у продолжения должен пересчитать предоплату счёта', async () => {
    const st = await chainWithPrepayment()

    const res = await run(st.ctrl.update, { params: { id: '2' }, body: { prepaymentPercent: 30 } })

    expect(res.status).toBe(200)
    expect(st.prisma.booking.rows.find((b) => b.id === 2).prepaymentPercent).toBe(30)
    expect(head(st).prepaidAmount).toBe(30000)
  })
})
