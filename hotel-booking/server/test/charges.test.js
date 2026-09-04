import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Генератор начислений: проживание, питание и услуги.
 *
 * Главное, ради чего заведена таблица `BookingService`: проживание считается на ВСЕХ
 * гостей, а питание — только на тех, кто ест. «Завтрак на двоих из троих» — обычная
 * ситуация живого отеля, и раньше выразить её было нечем: питание цеплялось глобальным
 * флагом `Service.includedByDefault`, то есть либо всем, либо никому.
 *
 * `buildAutoCharges` — чистая функция, база ей не нужна; prisma подменена заглушкой
 * только потому, что модуль требует её на верхнем уровне.
 */

const { buildAutoCharges } = loadCjs('src/utils/charges.js', { stubs: { './prisma': { prisma: {} } } })

/** Цена ночи: взрослый 15 000, ребёнок 13 000, доп. место 9 000. */
const RATE = { adultPrice: 15000, childPrice: 13000, extraBedPrice: 9000, roomPrice: 40000 }

const RATES_3_NIGHTS = {
  '2026-08-25': RATE,
  '2026-08-26': RATE,
  '2026-08-27': RATE,
}

/** Бронь на 3 ночи: 2 взрослых + 1 ребёнок. */
function booking(overrides = {}) {
  return {
    id: 1,
    checkIn: d('2026-08-25'),
    checkOut: d('2026-08-28'),
    adultsWithMeals: 2,
    childrenWithMeals: 1,
    adultsNoMeals: 0,
    childrenNoMeals: 0,
    extraBedsWithMeals: 0,
    extraBedsNoMeals: 0,
    discountPercent: 0,
    ...overrides,
  }
}

function service(overrides = {}) {
  return {
    id: 1, code: 'breakfast', name: 'Завтрак', price: 3500, childPrice: null,
    unit: 'per_person_night', kind: 'meal', isActive: true,
    ...overrides,
  }
}

/** Подключение услуги к брони: кому и сколько раз. */
function link(svc, { adults = 0, children = 0, quantity = 1 } = {}) {
  return { serviceId: svc.id, adults, children, quantity, service: svc }
}

function build(b, bookingServices = [], ratesByDate = RATES_3_NIGHTS) {
  return buildAutoCharges({ booking: b, pricingBase: 'person', ratesByDate, bookingServices })
}

const sum = (rows) => rows.reduce((s, r) => s + r.amount, 0)
const byKind = (rows, kind) => rows.filter(r => r.kind === kind)

describe('проживание', () => {
  it('считается на всех гостей, а не только на едоков', () => {
    const rows = build(booking(), [link(service(), { adults: 2 })])
    const stay = byKind(rows, 'stay')
    // 3 ночи по (2 × 15 000 + 1 × 13 000)
    expect(stay).toHaveLength(3)
    expect(sum(stay)).toBe(129000)
  })

  it('старые брони: гости из колонок «с питанием» и «без питания» складываются', () => {
    // Так лежат данные 107 броней, заведённых до трёх счётчиков в форме
    const old = booking({
      adultsWithMeals: 1, adultsNoMeals: 1,
      childrenWithMeals: 0, childrenNoMeals: 1,
    })
    expect(sum(byKind(build(old), 'stay'))).toBe(129000)
  })

  it('ночь без цены в календаре строки не порождает — ноль это не цена', () => {
    const rows = build(booking(), [], { '2026-08-25': RATE })
    expect(byKind(rows, 'stay')).toHaveLength(1)
  })
})

describe('питание', () => {
  it('завтрак на 2 из 3 гостей: 2 человека × 3 ночи', () => {
    const rows = build(booking(), [link(service(), { adults: 2, children: 0 })])
    const meals = byKind(rows, 'meal')
    expect(meals).toHaveLength(1)
    expect(meals[0]).toMatchObject({ label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 })
  })

  it('детская цена — отдельной строкой', () => {
    const svc = service({ childPrice: 2000 })
    const rows = byKind(build(booking(), [link(svc, { adults: 2, children: 1 })]), 'meal')
    expect(rows.map(r => [r.label, r.amount])).toEqual([
      ['Завтрак', 21000],          // 2 × 3 ночи × 3500
      ['Завтрак (дети)', 6000],    // 1 × 3 ночи × 2000
    ])
  })

  it('childPrice = null — дети считаются по взрослой цене одной строкой', () => {
    const rows = byKind(build(booking(), [link(service(), { adults: 2, children: 1 })]), 'meal')
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(9)  // (2 + 1) × 3 ночи
  })

  it('услуга не подключена к брони — питания нет, сколько бы гостей ни было', () => {
    expect(byKind(build(booking(), []), 'meal')).toHaveLength(0)
  })

  it('скрытая (неактивная) услуга не начисляется, даже если строка осталась', () => {
    const svc = service({ isActive: false })
    expect(byKind(build(booking(), [link(svc, { adults: 2 })]), 'meal')).toHaveLength(0)
  })

  it('нулевая цена услуги строки не даёт: тариф не заполнен, а не «бесплатно»', () => {
    const svc = service({ id: 2, name: 'Обед', price: 0 })
    expect(byKind(build(booking(), [link(svc, { adults: 3 })]), 'meal')).toHaveLength(0)
  })
})

describe('услуги вне питания', () => {
  it('per_booking считается по количеству раз, а не по числу гостей', () => {
    const svc = service({ id: 3, name: 'Поздний выезд', kind: 'extra', unit: 'per_booking', price: 7000 })
    const rows = byKind(build(booking(), [link(svc, { adults: 3, quantity: 1 })]), 'extra')
    expect(rows[0]).toMatchObject({ quantity: 1, amount: 7000 })
  })

  it('per_night умножается на ночи', () => {
    const svc = service({ id: 4, name: 'Парковка', kind: 'extra', unit: 'per_night', price: 1000 })
    const rows = byKind(build(booking(), [link(svc, { quantity: 1 })]), 'extra')
    expect(rows[0]).toMatchObject({ quantity: 3, amount: 3000 })
  })

  it('per_person считается однократно по числу людей', () => {
    const svc = service({ id: 5, name: 'Трансфер', kind: 'extra', unit: 'per_person', price: 5000 })
    const rows = byKind(build(booking(), [link(svc, { adults: 2 })]), 'extra')
    expect(rows[0]).toMatchObject({ quantity: 2, amount: 10000 })
  })
})

describe('скидка', () => {
  it('считается от всего счёта — проживание вместе с питанием', () => {
    const rows = build(
      booking({ discountPercent: 10 }),
      [link(service(), { adults: 2 })],
    )
    const discount = byKind(rows, 'discount')
    expect(discount).toHaveLength(1)
    // 10% от (129 000 + 21 000)
    expect(discount[0].amount).toBe(-15000)
  })
})

describe('ручные строки', () => {
  it('услуга, которую администратор ведёт сам, автоматически не дублируется', () => {
    const rows = buildAutoCharges({
      booking: booking(),
      pricingBase: 'person',
      ratesByDate: RATES_3_NIGHTS,
      bookingServices: [link(service(), { adults: 2 })],
      manualCharges: [{ kind: 'meal', label: 'завтрак', amount: 10000 }],
    })
    expect(byKind(rows, 'meal')).toHaveLength(0)
  })
})
