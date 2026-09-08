import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import {
  makeStack, run, booking, room, rate, service, charge, chargesOf, totalOf, d,
} from './helpers/bookingStack.js'

/**
 * `POST /bookings/preview` — «сколько выйдет», посчитанное ТЕМ ЖЕ кодом, что и
 * сохранение (волна 5a, аудит D7-009 / D5-002 / D2-003).
 *
 * Главное свойство здесь одно и оно проверяется числом: итог предпросмотра обязан
 * совпасть с суммой строк, которую запишет `create` + пересборка. Раньше формa
 * показывала 106 000 и 99 900, а в базу ложилось 94 900 — три разных числа на одном
 * экране. Поэтому тесты сравнивают не «форму ответа», а деньги.
 *
 * Второй блок — про то, что итог и принятое клиент больше НЕ задаёт:
 * `totalAmount` / `prepaidAmount` / `paidAmount` из тела игнорируются.
 */

/** Календарь цен на три ночи 10–12 июля: 15 000 за взрослого, 7 000 за ребёнка. */
const THREE_NIGHTS = ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso))
const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })
const BREAKFAST_LINK = [{ serviceId: 1, adults: 2, children: 0, quantity: 1 }]

/** Входы сценария B из живого прогона аудита (07-ui-live.md, сц. 3). */
const D7_009 = {
  roomId: 101,
  checkIn: '2026-07-10',
  checkOut: '2026-07-13',
  adultsWithMeals: 2,
  discountPercent: 10,
  services: BREAKFAST_LINK,
}
const MANUAL_LATE = { kind: 'discount', label: 'Поздний заезд', quantity: 1, unitPrice: 5000 }

function scene(over = {}) {
  return makeStack({
    rates: THREE_NIGHTS,
    services: [BREAKFAST],
    rooms: [room({ id: 101 })],
    ...over,
  })
}

const preview = (st, body) => run(st.ctrl.preview, { body })

describe('POST /bookings/preview — форма ответа', () => {
  it('отдаёт строки, итог, предоплату, число ночей и пустой список ночей без цены', async () => {
    const st = scene()
    const r = await preview(st, { ...D7_009, discountPercent: 0, prepaymentPercent: 50 })

    expect(r.status).toBe(200)
    const data = r.body.data
    expect(data.nights).toBe(3)
    expect(data.missingPrices).toEqual([])
    // 3 ночи × 30 000 + завтрак 6 × 3 500
    expect(data.total).toBe(111000)
    expect(data.prepaid).toBe(55500)
    expect(data.rows.map((x) => [x.kind, x.amount, x.source])).toEqual([
      ['stay', 30000, 'auto'],
      ['stay', 30000, 'auto'],
      ['stay', 30000, 'auto'],
      ['meal', 21000, 'auto'],
    ])
    expect(data.rows[0].date).toBe('2026-07-10')
    expect(data.rows[3].date).toBeNull()
  })

  it('выезд в день заезда — 400, а не счёт на ноль ночей', async () => {
    const st = scene()
    const same = await preview(st, { ...D7_009, checkOut: '2026-07-10' })
    expect(same.status).toBe(400)
    expect(same.body.error).toMatch(/позже даты заезда/)

    const back = await preview(st, { ...D7_009, checkOut: '2026-07-09' })
    expect(back.status).toBe(400)
  })
})

describe('POST /bookings/preview — то же число, что сохранит сервер (D7-009)', () => {
  it('3 ночи × 2 взр. + завтрак + ручная строка −5 000 + скидка 10 % = 94 900 и в предпросмотре, и в базе', async () => {
    const st = scene()

    const shown = await preview(st, { ...D7_009, prepaymentPercent: 50, manualCharges: [MANUAL_LATE] })
    expect(shown.status).toBe(200)
    expect(shown.body.data.total).toBe(94900)
    expect(shown.body.data.prepaid).toBe(47450)

    // Тот же набор входов, но сохранённый: create → ручная строка → пересборка.
    const created = await run(st.ctrl.create, { body: { ...D7_009, guestName: 'Иванов' } })
    expect(created.status).toBe(201)
    const id = created.body.data.id

    await run(st.ctrl.addCharge, {
      params: { id: String(id) },
      body: { ...MANUAL_LATE, reason: 'договорились на стойке' },
    })
    await run(st.ctrl.rebuildCharges, { params: { id: String(id) } })

    expect(totalOf(st.prisma, id)).toBe(shown.body.data.total)
    const saved = st.prisma.booking.rows.find((b) => b.id === id)
    expect(saved.totalAmount).toBe(94900)
    expect(saved.prepaidAmount).toBe(47450)
  })

  it('процентная скидка считается от полного счёта, а ручная скидка в её базу не входит', async () => {
    const st = scene()
    const r = await preview(st, { ...D7_009, manualCharges: [MANUAL_LATE] })
    const discount = r.body.data.rows.find((x) => x.source === 'auto' && x.kind === 'discount')
    // 10 % от 90 000 + 21 000, а не от 106 000 и не от одного проживания
    expect(discount.amount).toBe(-11100)
  })
})

describe('POST /bookings/preview — существующая бронь', () => {
  /** Бронь уже сохранена: ручная строка лежит в базе, процент предоплаты — 30. */
  function withSaved() {
    return scene({
      bookings: [booking({ id: 7, checkOut: d('2026-07-13'), discountPercent: 10, prepaymentPercent: 30 })],
      charges: [charge({
        id: 50, bookingId: 7, kind: 'discount', label: 'Поздний заезд',
        quantity: 1, unitPrice: -5000, amount: -5000, source: 'manual', reason: 'уступка',
      })],
    })
  }

  it('bookingId подтягивает сохранённые ручные строки и процент предоплаты брони', async () => {
    const st = withSaved()
    // prepaymentPercent в теле НЕ передан — должен взяться из брони (30 %)
    const r = await preview(st, { ...D7_009, bookingId: 7 })

    expect(r.body.data.total).toBe(94900)
    expect(r.body.data.prepaid).toBe(28470)
    expect(r.body.data.rows.filter((x) => x.source === 'manual')).toHaveLength(1)
  })

  it('ещё не сохранённые manualCharges складываются с сохранёнными, а не заменяют их', async () => {
    const st = withSaved()
    const r = await preview(st, {
      ...D7_009,
      bookingId: 7,
      manualCharges: [{ kind: 'extra', label: 'Трансфер', quantity: 1, unitPrice: 3000 }],
    })

    const manual = r.body.data.rows.filter((x) => x.source === 'manual')
    expect(manual.map((x) => x.amount)).toEqual([-5000, 3000])
    // Трансфер входит в базу скидки: 111 000 + 3 000 → 11 400
    expect(r.body.data.rows.find((x) => x.kind === 'discount' && x.source === 'auto').amount).toBe(-11400)
    expect(r.body.data.total).toBe(111000 + 3000 - 5000 - 11400)
  })
})

describe('POST /bookings/preview — ночь без полной цены', () => {
  it('цена только для взрослых: ребёнок попадает в missingPrices, строка ночи считается на взрослых', async () => {
    const st = makeStack({
      rates: [rate('2026-07-10', { childPrice: null })],
      rooms: [room({ id: 101 })],
    })
    const r = await preview(st, {
      roomId: 101, checkIn: '2026-07-10', checkOut: '2026-07-11',
      adultsWithMeals: 2, childrenWithMeals: 1, services: [],
    })

    expect(r.body.data.missingPrices).toEqual([{ date: '2026-07-10', parts: ['child'] }])
    expect(r.body.data.rows).toHaveLength(1)
    expect(r.body.data.rows[0].amount).toBe(30000)
    expect(r.body.data.total).toBe(30000)
  })

  it('ночь без цены вовсе: строки нет, но ночь названа в missingPrices', async () => {
    const st = makeStack({
      // 11 июля в календаре отсутствует
      rates: [rate('2026-07-10'), rate('2026-07-12')],
      rooms: [room({ id: 101 })],
    })
    const r = await preview(st, {
      roomId: 101, checkIn: '2026-07-10', checkOut: '2026-07-13',
      adultsWithMeals: 2, services: [],
    })

    expect(r.body.data.nights).toBe(3)
    expect(r.body.data.rows).toHaveLength(2)
    expect(r.body.data.missingPrices).toEqual([{ date: '2026-07-11', parts: ['adult'] }])
    expect(r.body.data.total).toBe(60000)
  })
})

describe('деньги брони задаёт сервер, а не тело запроса', () => {
  it('create игнорирует totalAmount / prepaidAmount / paidAmount из тела', async () => {
    const st = scene()
    const r = await run(st.ctrl.create, {
      body: {
        ...D7_009, discountPercent: 0, guestName: 'Иванов',
        totalAmount: 999999, prepaidAmount: 777777, paidAmount: 555555,
      },
    })

    expect(r.status).toBe(201)
    expect(r.body.data.totalAmount).toBe(111000)   // сумма строк, а не 999 999
    expect(r.body.data.prepaidAmount).toBe(55500)  // 50 % от неё
    expect(r.body.data.paidAmount).toBe(0)         // платежей ещё не было
  })

  it('update игнорирует totalAmount и paidAmount из тела', async () => {
    const st = scene({
      bookings: [booking({ id: 7, totalAmount: 111000, prepaidAmount: 55500, paidAmount: 20000 })],
      charges: [
        charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') }),
        charge({ id: 2, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
      ],
    })

    const r = await run(st.ctrl.update, {
      params: { id: '7' },
      body: { notes: 'позвонить', totalAmount: 1, prepaidAmount: 2, paidAmount: 99999 },
    })

    expect(r.status).toBe(200)
    expect(r.body.data.totalAmount).toBe(111000)
    expect(r.body.data.prepaidAmount).toBe(55500)
    expect(r.body.data.paidAmount).toBe(20000)
    expect(r.body.data.notes).toBe('позвонить')
  })

  it('смена одного процента предоплаты пересчитывает предоплату, но не пересобирает строки', async () => {
    const st = scene({
      bookings: [booking({ id: 7, totalAmount: 111000, prepaidAmount: 55500 })],
      charges: [
        charge({ id: 1, bookingId: 7, amount: 90000, unitPrice: 90000, date: d('2026-07-10') }),
        charge({ id: 2, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
      ],
    })

    const r = await run(st.ctrl.update, { params: { id: '7' }, body: { prepaymentPercent: 30 } })

    expect(r.body.data.prepaymentPercent).toBe(30)
    expect(r.body.data.prepaidAmount).toBe(33300)
    expect(r.body.data.totalAmount).toBe(111000)
    // Строки те же самые: пересборка выдала бы новые id
    expect(chargesOf(st.prisma, 7).map((c) => c.id)).toEqual([1, 2])
  })

  it('paidAmount меняет только журнал платежей', async () => {
    const st = scene({
      bookings: [booking({ id: 7, totalAmount: 111000, paidAmount: 0 })],
      charges: [charge({ id: 1, bookingId: 7, amount: 111000, unitPrice: 111000, date: d('2026-07-10') })],
    })

    await run(st.ctrl.update, { params: { id: '7' }, body: { paidAmount: 99999 } })
    expect(st.prisma.booking.rows[0].paidAmount).toBe(0)

    const paid = await run(st.payCtrl.create, { body: { bookingId: 7, amount: 40000, method: 'cash' } })
    expect(paid.status).toBe(201)
    expect(st.prisma.booking.rows[0].paidAmount).toBe(40000)
  })
})

describe('предпросмотр не засоряет журнал действий', () => {
  const { isTracked } = loadCjs('src/middleware/audit.js', {
    append: 'module.exports.__test = { isTracked };',
    stubs: { '../utils/prisma': { prisma: {} }, '../utils/logger': silentLogger },
  }).__test

  it('POST /bookings/preview не журналируется — форма зовёт его на каждое нажатие', () => {
    expect(isTracked('POST', '/bookings/preview')).toBe(false)
    // а сохранение брони и ручная строка — журналируются по-прежнему
    expect(isTracked('POST', '/bookings')).toBe(true)
    expect(isTracked('POST', '/bookings/7/charges')).toBe(true)
  })
})
