import { describe, it, expect } from 'vitest'
import {
  makeStack, run, booking, room, rate, service, charge, chargesOf, totalOf, d, BUSINESS_DATE,
} from './helpers/bookingStack.js'

/**
 * Волна 5a: ранний выезд и отмена перестали быть «только сменой статуса».
 *
 * Решение владельца (`docs/decisions/data-and-money.md`, 2026-09-08):
 *   • выезд раньше срока снимает проживание и питание за НЕпрожитые ночи,
 *     а прожитые сохраняют свою цену — даже если календарь цен с тех пор изменился;
 *   • отмена обнуляет автоматический счёт, ручные строки (штраф, удержание) остаются;
 *   • ручную строку на закрытую бронь заводит только администратор.
 *
 * Границы, ради которых всё это писалось: ночь РОВНО в день выезда (снимается) против
 * предыдущей (остаётся), выезд в срок (не трогать ничего) и бронь без строк начислений
 * (107 старых броней — их итог посчитан вручную, обнулять нельзя).
 */

const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })

/** Календарь ПОДОРОЖАЛ после того, как бронь была посчитана: 15 000 → 20 000. */
const RAISED = ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso, { adultPrice: 20000 }))

/**
 * Бронь: 10→13 июля (3 ночи), 2 взрослых, завтрак, скидка 10 %.
 * Строки посчитаны по СТАРОЙ цене 15 000 за взрослого — 30 000 за ночь.
 * Итог: 90 000 + 21 000 + 4 000 (ручной мини-бар) − 11 500 (скидка) = 103 500.
 */
function stayedThreeNights({ businessDate, status = 'CHECKED_IN' } = {}) {
  return makeStack({
    businessDate,
    rates: RAISED,
    services: [BREAKFAST],
    rooms: [room({ id: 101 })],
    bookingServices: [{ id: 1, bookingId: 7, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
    bookings: [booking({
      id: 7, status, checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
      discountPercent: 10, totalAmount: 103500, prepaidAmount: 51750,
    })],
    charges: [
      charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 4, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
      charge({
        id: 5, bookingId: 7, kind: 'extra', label: 'Мини-бар', quantity: 1, unitPrice: 4000,
        amount: 4000, source: 'manual', reason: 'выпито из мини-бара',
      }),
      charge({ id: 6, bookingId: 7, kind: 'discount', label: 'Скидка 10%', quantity: 1, unitPrice: -11500, amount: -11500 }),
    ],
  })
}

const checkOut = (st, id = 7) => run(st.ctrl.checkOut, { params: { id: String(id) } })

describe('ранний выезд пересчитывает счёт за фактические ночи', () => {
  /** Гость уехал утром 12-го: прожиты ночи 10 и 11, ночь 12-го — нет. */
  async function leaveAfterSecondNight() {
    const st = stayedThreeNights({ businessDate: d('2026-07-12') })
    const r = await checkOut(st)
    return { st, r, rows: chargesOf(st.prisma, 7) }
  }

  it('ночь ровно в день выезда снимается, предыдущая остаётся', async () => {
    const { rows } = await leaveAfterSecondNight()
    const stays = rows.filter((c) => c.kind === 'stay')
    expect(stays.map((c) => c.date.toISOString().slice(0, 10))).toEqual(['2026-07-10', '2026-07-11'])
  })

  it('прожитые ночи сохраняют СВОЮ цену, даже если календарь подорожал', async () => {
    const { rows } = await leaveAfterSecondNight()
    const stays = rows.filter((c) => c.kind === 'stay')
    // Полная пересборка дала бы 40 000 за ночь по новому календарю — это переоценка задним числом
    expect(stays.map((c) => c.amount)).toEqual([30000, 30000])
    expect(stays.map((c) => c.id)).toEqual([1, 2])
  })

  it('посуточное питание пересчитано на прожитые ночи', async () => {
    const { rows } = await leaveAfterSecondNight()
    const meal = rows.find((c) => c.kind === 'meal')
    expect(meal.quantity).toBe(4)      // 2 взр. × 2 ночи
    expect(meal.amount).toBe(14000)
  })

  it('ручная строка не тронута — ни сумма, ни id', async () => {
    const { rows } = await leaveAfterSecondNight()
    const manual = rows.filter((c) => c.source === 'manual')
    expect(manual).toHaveLength(1)
    expect(manual[0]).toMatchObject({ id: 5, label: 'Мини-бар', amount: 4000 })
  })

  it('процентная скидка пересчитана от новой базы', async () => {
    const { rows } = await leaveAfterSecondNight()
    // 60 000 (2 ночи) + 14 000 (завтраки) + 4 000 (мини-бар) = 78 000 → 10 %
    expect(rows.find((c) => c.kind === 'discount').amount).toBe(-7800)
  })

  it('итог брони = сумме строк, дата выезда сдвинута, статус закрыт', async () => {
    const { st, r, rows } = await leaveAfterSecondNight()
    expect(r.status).toBe(200)
    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CHECKED_OUT')
    expect(saved.checkOut.getTime()).toBe(d('2026-07-12').getTime())
    expect(saved.actualCheckOutAt).toBeInstanceOf(Date)
    expect(totalOf(st.prisma, 7)).toBe(70200)
    expect(saved.totalAmount).toBe(70200)
    expect(saved.prepaidAmount).toBe(35100)   // 50 % от нового итога
  })

  it('booking:checkout эмитится со свежей бронью', async () => {
    const { st } = await leaveAfterSecondNight()
    const ev = st.emitted.filter((e) => e.event === 'booking:checkout')
    expect(ev).toHaveLength(1)
    expect(ev[0].payload.booking.totalAmount).toBe(70200)
    expect(ev[0].payload.booking.checkOut.getTime()).toBe(d('2026-07-12').getTime())
  })

  it('выезд в срок не трогает ни одной строки', async () => {
    const st = stayedThreeNights({ businessDate: d('2026-07-13') })
    const before = chargesOf(st.prisma, 7).map((c) => ({ id: c.id, amount: c.amount }))

    const r = await checkOut(st)

    expect(r.status).toBe(200)
    expect(chargesOf(st.prisma, 7).map((c) => ({ id: c.id, amount: c.amount }))).toEqual(before)
    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CHECKED_OUT')
    expect(saved.totalAmount).toBe(103500)
    expect(saved.checkOut.getTime()).toBe(d('2026-07-13').getTime())
  })

  it('бронь без строк начислений ранний выезд не обнуляет (107 старых броней)', async () => {
    const st = makeStack({
      businessDate: d('2026-07-12'),
      rates: RAISED,
      rooms: [room({ id: 101 })],
      bookings: [booking({
        id: 7, status: 'CHECKED_IN', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
        totalAmount: 88000, prepaidAmount: 44000,
      })],
    })

    await checkOut(st)

    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.totalAmount).toBe(88000)
    expect(chargesOf(st.prisma, 7)).toEqual([])
  })
})

describe('отмена обнуляет автоматический счёт', () => {
  function withCharges(over = {}) {
    return makeStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, totalAmount: 103500, prepaidAmount: 51750, ...over.bookingOver })],
      charges: over.charges,
      ...over.stack,
    })
  }

  const AUTO_AND_MANUAL = [
    charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
    charge({ id: 2, bookingId: 7, kind: 'meal', label: 'Завтрак', quantity: 6, unitPrice: 3500, amount: 21000 }),
    charge({
      id: 3, bookingId: 7, kind: 'extra', label: 'Штраф за отмену', quantity: 1, unitPrice: 15000,
      amount: 15000, source: 'manual', reason: 'позднее аннулирование',
    }),
  ]

  it('автоматические строки сняты, ручные остались, итог = сумме ручных', async () => {
    const st = withCharges({ charges: AUTO_AND_MANUAL })

    const r = await run(st.ctrl.cancel, { params: { id: '7' } })

    expect(r.status).toBe(200)
    const rows = chargesOf(st.prisma, 7)
    expect(rows.map((c) => c.id)).toEqual([3])
    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CANCELLED')
    expect(saved.totalAmount).toBe(15000)
  })

  it('без ручных строк итог отменённой брони — ноль', async () => {
    const st = withCharges({ charges: AUTO_AND_MANUAL.filter((c) => c.source === 'auto') })

    await run(st.ctrl.cancel, { params: { id: '7' } })

    expect(chargesOf(st.prisma, 7)).toEqual([])
    expect(st.prisma.booking.rows[0].totalAmount).toBe(0)
    expect(st.prisma.booking.rows[0].prepaidAmount).toBe(0)
  })

  it('booking:cancelled эмитится с номером комнаты', async () => {
    const st = withCharges({ charges: AUTO_AND_MANUAL })
    await run(st.ctrl.cancel, { params: { id: '7' } })

    expect(st.emitted).toEqual([{ event: 'booking:cancelled', payload: { bookingId: 7, roomId: 101 } }])
  })

  it('выезд в день заезда ведёт себя как отмена: автострок нет, ручные целы, заметка дописана', async () => {
    const st = makeStack({
      businessDate: d('2026-07-10'),
      rooms: [room({ id: 101 })],
      bookings: [booking({
        id: 7, status: 'CHECKED_IN', checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
        totalAmount: 103500, notes: 'приехал ночью',
      })],
      charges: AUTO_AND_MANUAL,
    })

    const r = await checkOut(st)

    expect(r.status).toBe(200)
    const saved = st.prisma.booking.rows.find((b) => b.id === 7)
    expect(saved.status).toBe('CANCELLED')
    expect(saved.notes).toContain('гость не ночевал')
    expect(chargesOf(st.prisma, 7).map((c) => c.id)).toEqual([3])
    expect(saved.totalAmount).toBe(15000)
    expect(st.emitted.map((e) => e.event)).toEqual(['booking:cancelled'])
  })
})

describe('строки начислений закрытой брони', () => {
  function closed(status) {
    return makeStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status, totalAmount: 0 })],
      charges: [],
    })
  }

  const PENALTY = { kind: 'extra', label: 'Удержание за отмену', quantity: 1, unitPrice: 15000, reason: 'политика отмены' }

  it('администратор добавляет удержание к отменённой брони', async () => {
    const st = closed('CANCELLED')
    const r = await run(st.ctrl.addCharge, {
      params: { id: '7' }, body: PENALTY, admin: { id: 1, name: 'Админ', role: 'ADMIN' },
    })

    expect(r.status).toBe(200)
    expect(chargesOf(st.prisma, 7).map((c) => c.amount)).toEqual([15000])
    expect(st.prisma.booking.rows[0].totalAmount).toBe(15000)
  })

  it('главный администратор — тоже', async () => {
    const st = closed('CANCELLED')
    const r = await run(st.ctrl.addCharge, {
      params: { id: '7' }, body: PENALTY, admin: { id: 1, name: 'Гл', role: 'SUPER_ADMIN' },
    })
    expect(r.status).toBe(200)
  })

  it('стойке (STAFF) добавлять строки к отменённой брони нельзя — 403', async () => {
    const st = closed('CANCELLED')
    const r = await run(st.ctrl.addCharge, {
      params: { id: '7' }, body: PENALTY, admin: { id: 2, name: 'Стойка', role: 'STAFF' },
    })

    expect(r.status).toBe(403)
    expect(chargesOf(st.prisma, 7)).toEqual([])
  })

  it('к выехавшей брони — та же граница: ADMIN можно, STAFF 403', async () => {
    const ok = closed('CHECKED_OUT')
    const okRes = await run(ok.ctrl.addCharge, {
      params: { id: '7' }, body: PENALTY, admin: { id: 1, name: 'Админ', role: 'ADMIN' },
    })
    expect(okRes.status).toBe(200)

    const denied = closed('CHECKED_OUT')
    const deniedRes = await run(denied.ctrl.addCharge, {
      params: { id: '7' }, body: PENALTY, admin: { id: 2, name: 'Стойка', role: 'STAFF' },
    })
    expect(deniedRes.status).toBe(403)
    expect(chargesOf(denied.prisma, 7)).toEqual([])
  })

  it('пересборка по тарифу на отменённой брони по-прежнему запрещена — 400', async () => {
    const st = makeStack({
      rooms: [room({ id: 101 })],
      rates: RAISED,
      bookings: [booking({ id: 7, status: 'CANCELLED', totalAmount: 0 })],
      charges: [charge({
        id: 1, bookingId: 7, kind: 'extra', label: 'Удержание', amount: 15000,
        unitPrice: 15000, source: 'manual', reason: 'отмена',
      })],
    })

    const r = await run(st.ctrl.rebuildCharges, { params: { id: '7' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/отменённой брони/)
    expect(chargesOf(st.prisma, 7).map((c) => c.id)).toEqual([1])
  })
})

describe('заезд: верхняя и нижняя границы', () => {
  function confirmed(over = {}) {
    return makeStack({
      businessDate: over.businessDate ?? BUSINESS_DATE,
      rooms: [room({ id: 101 })],
      bookings: [booking({
        id: 7, status: 'CONFIRMED',
        checkIn: over.checkIn ?? d('2026-07-08'),
        checkOut: over.checkOut ?? d('2026-07-12'),
      })],
    })
  }

  it('выезд ровно в текущий рабочий день — заезд уже некуда оформлять, 400', async () => {
    const st = confirmed({ checkOut: d('2026-07-10') })   // рабочая дата = 10 июля
    const r = await run(st.ctrl.checkIn, { params: { id: '7' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/выезда уже прошла/)
    expect(st.prisma.booking.rows[0].status).toBe('CONFIRMED')
    expect(st.prisma.booking.rows[0].actualCheckInAt).toBeNull()
  })

  it('выезд в прошлом — тоже 400', async () => {
    const st = confirmed({ checkIn: d('2026-07-06'), checkOut: d('2026-07-09') })
    const r = await run(st.ctrl.checkIn, { params: { id: '7' } })
    expect(r.status).toBe(400)
    expect(st.prisma.booking.rows[0].status).toBe('CONFIRMED')
  })

  it('выезд завтра — заезд оформляется, время фиксируется', async () => {
    const st = confirmed({ checkOut: d('2026-07-11') })
    const r = await run(st.ctrl.checkIn, { params: { id: '7' } })

    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('CHECKED_IN')
    expect(st.prisma.booking.rows[0].actualCheckInAt).toBeInstanceOf(Date)
  })

  it('нижняя граница не изменилась: заезд раньше даты заезда — 400', async () => {
    const st = confirmed({ checkIn: d('2026-07-11'), checkOut: d('2026-07-14') })
    const r = await run(st.ctrl.checkIn, { params: { id: '7' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/раньше даты заезда/)
  })
})

describe('walk-in из шахматки', () => {
  const WALK_IN = {
    roomId: 101, guestName: 'Гость с улицы', adultsWithMeals: 2,
    checkOut: '2026-07-13', status: 'CHECKED_IN', services: [],
  }

  it('заезд на рабочую дату сразу ставит фактическое время заезда', async () => {
    const st = makeStack({ rooms: [room({ id: 101 })] })
    const r = await run(st.ctrl.create, { body: { ...WALK_IN, checkIn: '2026-07-10' } })

    expect(r.status).toBe(201)
    expect(r.body.data.status).toBe('CHECKED_IN')
    expect(r.body.data.actualCheckInAt).toBeInstanceOf(Date)
  })

  it('заезд в будущем понижается до «подтверждена», времени заезда нет', async () => {
    const st = makeStack({ rooms: [room({ id: 101 })] })
    const r = await run(st.ctrl.create, { body: { ...WALK_IN, checkIn: '2026-07-11' } })

    expect(r.status).toBe(201)
    expect(r.body.data.status).toBe('CONFIRMED')
    expect(r.body.data.actualCheckInAt).toBeNull()
  })
})
