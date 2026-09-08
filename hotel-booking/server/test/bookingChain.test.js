import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import {
  makeStack, run, booking, room, rate, service, charge, payment,
  chargesOf, totalOf, d,
} from './helpers/bookingStack.js'

/**
 * Волна 5b: переезд гостя — ОДИН счёт, а не «вторая бронь с половиной денег».
 *
 * Сценарий аудита D7-013 (`docs/decisions/data-and-money.md`, решение 2026-09-08):
 * гость живёт «Стандарт» 4 ночи по 20 000 с завтраком на двоих и скидкой 10 %,
 * после двух ночей переезжает в «Комфорт» по 30 000. Раньше `move()` делил
 * `paidAmount` пропорцией, платежи оставались на первой части, питание и скидка
 * не делились вовсе, а без посуточных строк начисления УДВАИВАЛИСЬ (вживую
 * 21 000 из 14 000).
 *
 * Что должно быть теперь:
 *   • голова цепочки держит все строки и все платежи, продолжение — нули;
 *   • прожитые ночи не переоцениваются по цене новой категории;
 *   • завтраки считаются по ВСЕМ ночам цепочки, скидка — от всего счёта;
 *   • любая денежная операция с продолжения уходит на голову.
 *
 * Границы, ради которых это писалось, — стык категорий в дату переезда, ночь
 * ровно в день переезда (она уже по новой цене) и НЕудвоение: сумма цепочки
 * обязана сойтись до тенге, иначе гость платит за одни и те же ночи дважды.
 */

// ─── Фикстура ────────────────────────────────────────────────────────────────

const STANDARD = { id: 1, name: 'Стандарт', color: '#ccc' }
const COMFORT = { id: 2, name: 'Комфорт', color: '#ccc' }
const SUITE = { id: 3, name: 'Люкс', color: '#ccc' }

const ROOM_STD = room({ id: 101, categoryId: 1, category: STANDARD })
const ROOM_CMF = room({ id: 201, categoryId: 2, category: COMFORT })
const ROOM_SUITE = room({ id: 301, categoryId: 3, category: SUITE })
const ROOMS = [ROOM_STD, ROOM_CMF, ROOM_SUITE]

/** Цена за место: Стандарт 10 000 (=20 000 на двоих), Комфорт 15 000, Люкс 25 000. */
const NIGHTS = ['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13']
const RATES = [
  ...NIGHTS.map((iso) => rate(iso, { categoryId: 1, adultPrice: 10000 })),
  ...NIGHTS.map((iso) => rate(iso, { categoryId: 2, adultPrice: 15000 })),
  ...NIGHTS.map((iso) => rate(iso, { categoryId: 3, adultPrice: 25000 })),
]

const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })

/**
 * Бронь 10 → 14 июля в «Стандарте», 2 взрослых, завтрак, скидка 10 %.
 * Счёт ДО переезда: 4 × 20 000 + 8 × 3 500 − 10 % = 97 200.
 */
function beforeMove({ businessDate = d('2026-07-12'), payments = [] } = {}) {
  return makeStack({
    businessDate,
    rooms: ROOMS,
    rates: RATES,
    services: [BREAKFAST],
    bookingServices: [{ id: 1, bookingId: 1, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
    payments,
    bookings: [booking({
      id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
      checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
      discountPercent: 10, totalAmount: 97200, prepaidAmount: 48600,
      actualCheckInAt: new Date('2026-07-10T14:00:00Z'),
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
}

const moveTo = (st, id, roomId, date) =>
  run(st.ctrl.move, { params: { id: String(id) }, body: { newRoomId: roomId, moveDate: date } })

/** Переезд в «Комфорт» с 12 июля: прожиты ночи 10 и 11, впереди 12 и 13. */
async function movedToComfort(opts = {}) {
  const st = beforeMove(opts)
  const res = await moveTo(st, 1, 201, '2026-07-12')
  return { st, res, head: st.prisma.booking.rows.find((b) => b.id === 1), cont: st.prisma.booking.rows.find((b) => b.id === 2) }
}

const stays = (st, id = 1) => chargesOf(st.prisma, id).filter((c) => c.kind === 'stay')
const iso = (date) => date.toISOString().slice(0, 10)

/** `utils/bookingMoney` поверх базы стенда — тот же экземпляр, что видит контроллер. */
const loadMoney = (st) => loadCjs('src/utils/bookingMoney.js', { stubs: { './prisma': { prisma: st.prisma } } })

// ─── Строки счёта после переезда ─────────────────────────────────────────────

describe('переезд: строки цепочки лежат на голове и не удваиваются', () => {
  it('прожитые ночи остаются по цене СТАРОЙ категории, новые — по новой', async () => {
    const { st } = await movedToComfort()

    expect(stays(st).map((c) => [iso(c.date), c.amount])).toEqual([
      ['2026-07-10', 20000],   // Стандарт, прожита
      ['2026-07-11', 20000],   // Стандарт, прожита
      ['2026-07-12', 30000],   // Комфорт с даты переезда
      ['2026-07-13', 30000],
    ])
  })

  it('ночь РОВНО в день переезда считается по новой категории, а не по старой', async () => {
    // Граница: `move` закрывает голову датой переезда (полуоткрытый интервал),
    // поэтому 12-е принадлежит уже продолжению. Ошибка здесь — 10 000 разницы
    // в счёте на каждую такую бронь.
    const { st } = await movedToComfort()
    const night = stays(st).find((c) => iso(c.date) === '2026-07-12')
    expect(night.amount).toBe(30000)
    expect(night.label).toContain('№201')
  })

  it('замороженные ночи получают в подписи свой номер и категорию', async () => {
    // В одном счёте оказались ночи двух комнат по разной цене — без номера в
    // подписи это выглядит как ошибка тарифа.
    const { st } = await movedToComfort()
    const byDate = Object.fromEntries(stays(st).map((c) => [iso(c.date), c.label]))

    expect(byDate['2026-07-10']).toBe('Проживание · №101 Стандарт · 2 взр.')
    expect(byDate['2026-07-13']).toBe('Проживание · №201 Комфорт · 2 взр.')
  })

  it('id прожитых ночей не изменились: их не пересоздавали, а сохранили', async () => {
    const { st } = await movedToComfort()
    expect(stays(st).slice(0, 2).map((c) => c.id)).toEqual([1, 2])
  })

  it('завтраки считаются по ВСЕМ ночам цепочки одной строкой, а не по разу на отрезок', async () => {
    // Ровно то место, где раньше начисления удваивались: питание не делилось
    // между частями и оставалось на каждой целиком.
    const { st } = await movedToComfort()
    const meals = chargesOf(st.prisma, 1).filter((c) => c.kind === 'meal')

    expect(meals).toHaveLength(1)
    expect(meals[0]).toMatchObject({ quantity: 8, unitPrice: 3500, amount: 28000 })  // 2 взр. × 4 ночи
  })

  it('скидка процентом берётся от ВСЕГО счёта, включая замороженные ночи', async () => {
    const { st } = await movedToComfort()
    // (20 000 + 20 000 + 30 000 + 30 000 + 28 000) × 10 %
    expect(chargesOf(st.prisma, 1).filter((c) => c.kind === 'discount')).toHaveLength(1)
    expect(chargesOf(st.prisma, 1).find((c) => c.kind === 'discount').amount).toBe(-12800)
  })

  it('итог головы = сумме строк цепочки, предоплата пересчитана от него', async () => {
    const { st, head } = await movedToComfort()

    expect(totalOf(st.prisma, 1)).toBe(115200)
    expect(head.totalAmount).toBe(115200)
    expect(head.prepaidAmount).toBe(57600)   // 50 % от нового итога
  })

  it('у продолжения нет ни строк, ни денег — только ссылка на счёт', async () => {
    const { st, cont } = await movedToComfort()

    expect(chargesOf(st.prisma, 2)).toEqual([])
    expect(cont).toMatchObject({
      accountBookingId: 1, totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
      roomId: 201, status: 'CHECKED_IN',
    })
    expect(iso(cont.checkIn)).toBe('2026-07-12')
    expect(iso(cont.checkOut)).toBe('2026-07-14')
  })

  it('голова закрыта датой переезда, фактический заезд гостя не переписан', async () => {
    // Гость НЕ заезжает заново: поставить в продолжение момент переезда значило бы
    // стереть настоящее время заезда серединой проживания.
    const { st, head, cont } = await movedToComfort()

    expect(head.status).toBe('CHECKED_OUT')
    expect(iso(head.checkOut)).toBe('2026-07-12')
    expect(head.actualCheckOutAt).toBeInstanceOf(Date)
    expect(cont.actualCheckInAt.toISOString()).toBe('2026-07-10T14:00:00.000Z')
    expect(st.prisma.bookingCharge.rows.every((c) => c.bookingId === 1)).toBe(true)
  })

  it('услуги ПЕРЕЕЗЖАЮТ на продолжение, а не копируются', async () => {
    // Копия оставила бы две правды о завтраках, и следующая пересборка выбирала
    // бы из них наугад — счёт гостя зависел бы от того, какую нашли первой.
    const { st } = await movedToComfort()
    const links = st.prisma.bookingService.rows

    expect(links).toHaveLength(1)
    expect(links[0].bookingId).toBe(2)
  })
})

// ─── Деньги по счёту, а не по :id ────────────────────────────────────────────

const PAID_40K = [payment({ id: 1, bookingId: 1, amount: 40000 })]

describe('деньги продолжения — это деньги головы', () => {
  it('bookingMoney(продолжение) отдаёт начислено и принято всего счёта', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })
    const money = loadMoney(st)

    await expect(money.bookingMoney(2)).resolves.toMatchObject({
      bookingId: 2,
      accountBookingId: 1,
      charged: 115200,
      totalAmount: 115200,
      paid: 40000,
      due: 75200,
    })
  })

  it('оплата, принятая в форме продолжения, записывается на голову', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })

    const res = await run(st.payCtrl.create, { body: { bookingId: 2, amount: 30000, method: 'cash' } })

    expect(res.status).toBe(201)
    expect(res.body.data.payment.bookingId).toBe(1)
    expect(st.prisma.payment.rows.every((p) => p.bookingId === 1)).toBe(true)
    // Кэш «принято» тоже у головы: у продолжения он обязан остаться нулём
    expect(st.prisma.booking.rows.find((b) => b.id === 1).paidAmount).toBe(70000)
    expect(st.prisma.booking.rows.find((b) => b.id === 2).paidAmount).toBe(0)
  })

  it('ответ на оплату продолжения показывает долг всего счёта, а не ноль', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })

    const res = await run(st.payCtrl.create, { body: { bookingId: 2, amount: 30000, method: 'cash' } })

    expect(res.body.data.summary).toMatchObject({ charged: 115200, paid: 70000, due: 45200 })
  })

  it('журнал платежей продолжения показывает платежи головы', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })

    const res = await run(st.payCtrl.listByBooking, { params: { bookingId: '2' } })

    expect(res.status).toBe(200)
    expect(res.body.data.payments.map((p) => p.id)).toEqual([1])
  })

  it('деньги обновляются на ОБОИХ отрезках: событие уходит и голове, и продолжению', async () => {
    // Полоса «Начислено / Долг» на экране висит у обеих частей цепочки: приняли
    // оплату в продолжении — у головы она обязана перестать врать.
    const { st } = await movedToComfort({ payments: PAID_40K })
    st.emitted.length = 0

    await run(st.payCtrl.create, { body: { bookingId: 2, amount: 30000, method: 'cash' } })

    const ids = st.emitted.filter((e) => e.event === 'booking:updated').map((e) => e.payload.booking.id)
    expect(ids.sort()).toEqual([1, 2])
  })
})

// ─── Долги: цепочка — одна строка ────────────────────────────────────────────

describe('«Долги»: цепочка показывается одной строкой', () => {
  async function debts(st) {
    return run(st.payCtrl.debts, { query: {} })
  }

  it('одна строка вместо двух — за голову, с диапазоном номеров', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })

    const res = await debts(st)

    expect(res.status).toBe(200)
    expect(res.body.data.bookings).toHaveLength(1)
    expect(res.body.data.bookings[0]).toMatchObject({ id: 1, rooms: '101 → 201' })
  })

  it('срок — от заезда ПЕРВОГО отрезка до выезда последнего', async () => {
    // Иначе живущий гость выпадет из кассы: у головы `checkOut` — дата переезда.
    const { st } = await movedToComfort({ payments: PAID_40K })

    const row = (await debts(st)).body.data.bookings[0]

    expect(iso(row.checkIn)).toBe('2026-07-10')
    expect(iso(row.checkOut)).toBe('2026-07-14')
  })

  it('статус — текущего отрезка, а не закрытой головы', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })
    expect((await debts(st)).body.data.bookings[0].status).toBe('CHECKED_IN')
  })

  it('долг считается один раз по всему счёту', async () => {
    const { st } = await movedToComfort({ payments: PAID_40K })
    expect((await debts(st)).body.data.bookings[0]).toMatchObject({ charged: 115200, paid: 40000, due: 75200 })
  })

  it('живущий гость не выпадает из кассы, когда голова выехала за окном отбора', async () => {
    // Граница окна `days`: у головы `checkOut` — дата переезда, и через `days`
    // дней после него она перестаёт попадать в выборку. Живёт при этом
    // продолжение — по нему и надо подниматься к голове, иначе долг живущего
    // гостя исчезнет с экрана приёма оплаты (та же болезнь, что D6-002).
    // Рабочая дата 13-е, переезд был 12-го: у головы `checkOut` = 12-е.
    // При `days=0` окно начинается 13-м — голова в него уже НЕ попадает, и
    // найтись цепочка может только через живущее продолжение.
    const st = beforeMove({ businessDate: d('2026-07-13'), payments: PAID_40K })
    await moveTo(st, 1, 201, '2026-07-12')

    const res = await run(st.payCtrl.debts, { query: { days: '0' } })

    expect(res.body.data.bookings).toHaveLength(1)
    expect(res.body.data.bookings[0]).toMatchObject({ id: 1, rooms: '101 → 201', due: 75200 })
  })
})

// ─── Правка сегмента пересобирает счёт ───────────────────────────────────────

describe('правка продолжения пересобирает счёт цепочки', () => {
  /** У гостя уехал второй взрослый: с 12 июля в «Комфорте» живёт один. */
  async function oneGuestFromMove() {
    const { st } = await movedToComfort()
    const res = await run(st.ctrl.update, {
      params: { id: '2' },
      body: { adultsWithMeals: 1 },
    })
    return { st, res }
  }

  it('прожитые ночи сохранили СВОИ суммы, хотя счётчик гостей изменился', async () => {
    // Полная пересборка посчитала бы 10-е и 11-е по одному взрослому (10 000) —
    // это переоценка задним числом того, что гость уже прожил вдвоём.
    const { st } = await oneGuestFromMove()

    expect(stays(st).map((c) => [iso(c.date), c.amount])).toEqual([
      ['2026-07-10', 20000],
      ['2026-07-11', 20000],
      ['2026-07-12', 15000],
      ['2026-07-13', 15000],
    ])
  })

  it('итог головы пересчитан, у продолжения по-прежнему нули', async () => {
    const { st, res } = await oneGuestFromMove()

    expect(res.status).toBe(200)
    // 40 000 (прожито) + 30 000 (Комфорт на одного) + 28 000 (завтраки) − 10 % = 88 200
    expect(totalOf(st.prisma, 1)).toBe(88200)
    expect(st.prisma.booking.rows.find((b) => b.id === 1).totalAmount).toBe(88200)
    expect(st.prisma.booking.rows.find((b) => b.id === 2).totalAmount).toBe(0)
  })

  it('правка головы после переезда запрещена: она закрыта', async () => {
    // Клиент по «Редактировать» открывает текущий отрезок; форма закрытой брони
    // сохранилась бы мимо цепочки.
    const { st } = await movedToComfort()

    const res = await run(st.ctrl.update, { params: { id: '1' }, body: { guestName: 'Другой' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('закрытую бронь')
  })

  it('правка телефона в продолжении счёт НЕ пересобирает', async () => {
    // Вход тарифа не менялся — пересборка переоценила бы прожитые ночи
    // по сегодняшнему календарю без всякой причины.
    const { st } = await movedToComfort()
    const before = chargesOf(st.prisma, 1).map((c) => c.id)

    await run(st.ctrl.update, { params: { id: '2' }, body: { guestPhone: '+77010000000' } })

    expect(chargesOf(st.prisma, 1).map((c) => c.id)).toEqual(before)
  })
})

// ─── Отмена продолжения ──────────────────────────────────────────────────────

describe('продолжение отменить нельзя', () => {
  it('DELETE по продолжению — 400 с указанием, что делать вместо', async () => {
    // «Гость не жил» для второго отрезка — ложь, а `dropAutoChargesOnCancel`
    // у брони без своих строк не снял бы ничего: голова продолжала бы начислять
    // непрожитые ночи.
    const { st } = await movedToComfort()

    const res = await run(st.ctrl.cancel, { params: { id: '2' } })

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Продолжение брони отменить нельзя — оформите выезд')
    expect(st.prisma.booking.rows.find((b) => b.id === 2).status).toBe('CHECKED_IN')
  })

  it('счёт от неудавшейся отмены не пострадал', async () => {
    const { st } = await movedToComfort()
    await run(st.ctrl.cancel, { params: { id: '2' } })
    expect(totalOf(st.prisma, 1)).toBe(115200)
  })

  it('голову цепочки тоже не отменить — она уже закрыта переездом', async () => {
    const { st } = await movedToComfort()
    const res = await run(st.ctrl.cancel, { params: { id: '1' } })
    expect(res.status).toBe(400)
  })
})

// ─── Предпросмотр формы ──────────────────────────────────────────────────────

describe('предпросмотр по продолжению показывает весь счёт', () => {
  const previewBody = {
    bookingId: 2, roomId: 201, checkIn: '2026-07-12', checkOut: '2026-07-14',
    adultsWithMeals: 2, discountPercent: 10, prepaymentPercent: 50,
    services: [{ serviceId: 1, adults: 2, children: 0, quantity: 1 }],
  }

  it('итог предпросмотра совпадает с сохранённым итогом головы', async () => {
    // Иначе стойка видит в форме одно, а в панели начислений другое — ровно то,
    // из-за чего волна 5a переводила предпросмотр на серверный код.
    const { st } = await movedToComfort()

    const res = await run(st.ctrl.preview, { body: previewBody })

    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(115200)
    expect(res.body.data.total).toBe(st.prisma.booking.rows.find((b) => b.id === 1).totalAmount)
  })

  it('в предпросмотре видны все четыре ночи цепочки, а не две ночи отрезка', async () => {
    const { st } = await movedToComfort()

    const res = await run(st.ctrl.preview, { body: previewBody })
    const rows = res.body.data.rows.filter((r) => r.kind === 'stay')

    expect(rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-07-10', 20000],
      ['2026-07-11', 20000],
      ['2026-07-12', 30000],
      ['2026-07-13', 30000],
    ])
    expect(res.body.data.nights).toBe(4)
  })

  it('несохранённый ввод отрезка подставляется, прожитые ночи — нет', async () => {
    // Стойка правит в форме продолжения число гостей: пересчитаться обязаны
    // только его ночи, прожитые остаются как есть.
    const { st } = await movedToComfort()

    const res = await run(st.ctrl.preview, {
      body: { ...previewBody, adultsWithMeals: 1, services: [{ serviceId: 1, adults: 1, children: 0, quantity: 1 }] },
    })
    const rows = res.body.data.rows.filter((r) => r.kind === 'stay')

    expect(rows.map((r) => r.amount)).toEqual([20000, 20000, 15000, 15000])
  })

  it('предпросмотр ничего не пишет в базу', async () => {
    const { st } = await movedToComfort()
    const before = JSON.stringify({ b: st.prisma.booking.rows, c: st.prisma.bookingCharge.rows })

    await run(st.ctrl.preview, { body: previewBody })

    expect(JSON.stringify({ b: st.prisma.booking.rows, c: st.prisma.bookingCharge.rows })).toBe(before)
  })
})

// ─── Второй переезд ──────────────────────────────────────────────────────────

describe('второй переезд: три отрезка, счёт по-прежнему один', () => {
  /** 10–12 Стандарт → 12–13 Комфорт → 13–14 Люкс. */
  async function threeSegments() {
    const st = beforeMove({ businessDate: d('2026-07-13') })
    await moveTo(st, 1, 201, '2026-07-12')
    const res = await moveTo(st, 2, 301, '2026-07-13')
    return { st, res }
  }

  it('второе продолжение ссылается на ГОЛОВУ, а не на предыдущую часть', async () => {
    // Счёт у гостя один, сколько бы раз он ни переезжал: цепочка ссылок
    // сделала бы «голову головы» и развалила бы поиск денег.
    const { st } = await threeSegments()
    const third = st.prisma.booking.rows.find((b) => b.id === 3)

    expect(third.accountBookingId).toBe(1)
    expect(third.roomId).toBe(301)
  })

  it('ночи трёх категорий стоят каждая по своей цене', async () => {
    const { st } = await threeSegments()

    expect(stays(st).map((c) => [iso(c.date), c.amount])).toEqual([
      ['2026-07-10', 20000],   // Стандарт
      ['2026-07-11', 20000],
      ['2026-07-12', 30000],   // Комфорт — прожита, заморожена вторым переездом
      ['2026-07-13', 50000],   // Люкс
    ])
  })

  it('в подписях видны все три номера', async () => {
    const { st } = await threeSegments()
    const labels = [...new Set(stays(st).map((c) => c.label))]

    expect(labels).toEqual([
      'Проживание · №101 Стандарт · 2 взр.',
      'Проживание · №201 Комфорт · 2 взр.',
      'Проживание · №301 Люкс · 2 взр.',
    ])
  })

  it('итог сходится, и все строки — на одной броне', async () => {
    const { st } = await threeSegments()
    // 120 000 проживание + 28 000 завтраки − 10 % (14 800) = 133 200
    expect(totalOf(st.prisma, 1)).toBe(133200)
    expect(chargesOf(st.prisma, 2)).toEqual([])
    expect(chargesOf(st.prisma, 3)).toEqual([])
  })

  it('завтраки по-прежнему одной строкой на четыре ночи', async () => {
    const { st } = await threeSegments()
    const meals = chargesOf(st.prisma, 1).filter((c) => c.kind === 'meal')
    expect(meals).toHaveLength(1)
    expect(meals[0].quantity).toBe(8)
  })

  it('услуги доехали до последнего отрезка', async () => {
    const { st } = await threeSegments()
    expect(st.prisma.bookingService.rows.map((l) => l.bookingId)).toEqual([3])
  })
})

// ─── Старая бронь без строк (107 из NOTES) ───────────────────────────────────

describe('переезд брони БЕЗ строк начислений фиксирует прежний итог', () => {
  /** Одна из 107 старых броней: сумма стоит числом, строк нет вовсе. */
  async function legacyMoved() {
    const st = makeStack({
      businessDate: d('2026-07-12'),
      rooms: ROOMS,
      rates: RATES,
      bookings: [booking({
        id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
        checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
        totalAmount: 97200, prepaidAmount: 48600,
      })],
      charges: [],
    })
    const res = await moveTo(st, 1, 201, '2026-07-12')
    return { st, res }
  }

  it('прежняя сумма зафиксирована ручной строкой, а не потеряна', async () => {
    const { st } = await legacyMoved()
    const legacy = chargesOf(st.prisma, 1).filter((c) => c.label === 'Проживание · по прежнему расчёту')

    expect(legacy).toHaveLength(1)
    expect(legacy[0]).toMatchObject({ amount: 97200, source: 'manual', date: null })
  })

  it('ночи головы НЕ начисляются поверх зафиксированной суммы', async () => {
    // Строка «по прежнему расчёту» покрывает весь срок до переезда: посчитать
    // 10-е и 11-е ещё раз значило бы выставить их гостю дважды.
    const { st } = await legacyMoved()
    const dates = stays(st).filter((c) => c.date).map((c) => iso(c.date))

    expect(dates).toEqual(['2026-07-12', '2026-07-13'])
  })

  it('итог = прежняя сумма + ночи продолжения', async () => {
    const { st } = await legacyMoved()
    expect(totalOf(st.prisma, 1)).toBe(97200 + 30000 + 30000)
    expect(st.prisma.booking.rows.find((b) => b.id === 1).totalAmount).toBe(157200)
  })

  it('повторная пересборка счёта сумму не удваивает', async () => {
    // Пересборка зовётся из десятка мест (правка, выезд, кнопка «Пересчитать») —
    // фиксация обязана быть идемпотентной.
    const { st } = await legacyMoved()

    await run(st.ctrl.rebuildCharges, { params: { id: '2' } })

    expect(chargesOf(st.prisma, 1).filter((c) => c.label === 'Проживание · по прежнему расчёту')).toHaveLength(1)
    expect(totalOf(st.prisma, 1)).toBe(157200)
  })
})
