import { describe, it, expect } from 'vitest'
import {
  makeSettlementStack, run, booking, room, rate, service, charge, payment,
  chargesOf, totalOf, dbSnapshot, writeOps, d,
} from './helpers/settlementStack.js'

/**
 * Волна 5b: «Расчёт с гостем» для гостя, который переезжал.
 *
 * У продолжения нет ни одной своей строки и ни одного своего платежа — всё лежит
 * на голове счёта. Значит расчёт, запущенный из формы продолжения (а стойка
 * запускает его именно оттуда — в этой комнате гость сейчас и живёт), обязан
 * считать по ВСЕЙ цепочке. Иначе `planEarlyCheckout` не нашёл бы ни одной строки,
 * «начислено» вышло бы нулём, и калькулятор предложил бы вернуть гостю ВСЕ
 * принятые деньги — при том, что он три ночи прожил.
 *
 * Здесь же — граница «штраф и возврат кладутся на голову»: платёж, записанный на
 * продолжение, потерялся бы для кассы и для «Долгов», которые ходят по счёту.
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

/** Гость заплатил вперёд 150 000 — переплата, ради которой расчёт и нужен. */
const PREPAID = [payment({ id: 1, bookingId: 1, amount: 150000, method: 'card' })]

/**
 * Стенд: бронь 10 → 14 июля «Стандарт» (4 × 20 000 + завтраки − 10 %), 12-го
 * переезд в «Комфорт», рабочая дата 13-е — гость уезжает на ночь раньше срока.
 * Цепочку строим НАСТОЯЩИМ `move`, а не фикстурой: расчёт обязан работать с тем,
 * что оставляет после себя переезд, а не с тем, что удобно тесту.
 */
async function chainReadyToLeave() {
  const st = makeSettlementStack({
    businessDate: d('2026-07-13'),
    rooms: [ROOM_STD, ROOM_CMF],
    rates: RATES,
    services: [BREAKFAST],
    bookingServices: [{ id: 1, bookingId: 1, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
    payments: PREPAID,
    bookings: [booking({
      id: 1, roomId: 101, room: ROOM_STD, status: 'CHECKED_IN',
      checkIn: d('2026-07-10'), checkOut: d('2026-07-14'),
      discountPercent: 10, totalAmount: 97200, prepaidAmount: 48600, paidAmount: 150000,
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
  await run(st.ctrl.move, { params: { id: '1' }, body: { newRoomId: 201, moveDate: '2026-07-12' } })
  return st
}

const preview = (st, id, action) =>
  run(st.settlement.preview, { params: { id: String(id) }, body: { action } })

const settle = (st, id, body) =>
  run(st.settlement.settle, { params: { id: String(id) }, body })

const iso = (date) => date.toISOString().slice(0, 10)

// ─── Предпросмотр расчёта ────────────────────────────────────────────────────

describe('предпросмотр расчёта по продолжению считает всю цепочку', () => {
  it('«начислено» — это прожитые ночи ОБЕИХ комнат, а не ноль', async () => {
    // Без счёта у продолжения нет строк вовсе: «начислено 0» открыло бы возврат
    // всех 150 000 гостю, прожившему три ночи.
    const st = await chainReadyToLeave()

    const res = await preview(st, 2, 'checkout')

    expect(res.status).toBe(200)
    // 20 000 + 20 000 (Стандарт) + 30 000 (Комфорт) + завтраки 6 × 3 500 − 10 %
    expect(res.body.data.charged).toBe(81900)
  })

  it('к возврату — переплата по всему счёту', async () => {
    const st = await chainReadyToLeave()

    const res = await preview(st, 2, 'checkout')

    expect(res.body.data.paid).toBe(150000)
    expect(res.body.data.toReturn).toBe(68100)
    expect(res.body.data.due).toBe(0)
  })

  it('расчёт помечен счётом головы — стойка видит, по какой броне идут деньги', async () => {
    const st = await chainReadyToLeave()
    expect((await preview(st, 2, 'checkout')).body.data.accountBookingId).toBe(1)
  })

  it('приёмы к возврату берутся у ГОЛОВЫ: своих платежей у продолжения нет', async () => {
    const st = await chainReadyToLeave()

    const res = await preview(st, 2, 'checkout')

    expect(res.body.data.payments).toHaveLength(1)
    expect(res.body.data.payments[0]).toMatchObject({ id: 1, amount: 150000, refundable: 150000 })
  })

  it('ночи считаются по текущему отрезку: прожита одна, снимается одна', async () => {
    // Прожитые ночи предыдущих комнат в «снимается» попасть не могут — они уже
    // прожиты, и укорачивается только тот отрезок, в котором гость сейчас.
    const st = await chainReadyToLeave()

    expect((await preview(st, 2, 'checkout')).body.data.nights)
      .toEqual({ planned: 2, stayed: 1, removed: 1 })
  })

  it('строки плана показывают ночи обеих комнат и пересчитанные завтраки', async () => {
    const st = await chainReadyToLeave()

    const rows = (await preview(st, 2, 'checkout')).body.data.rows

    expect(rows.filter((r) => r.kind === 'stay').map((r) => r.amount)).toEqual([20000, 20000, 30000])
    expect(rows.find((r) => r.kind === 'meal')).toMatchObject({ quantity: 6, amount: 21000 })
    expect(rows.find((r) => r.kind === 'discount').amount).toBe(-9100)
  })

  it('предпросмотр не пишет в базу ни строки', async () => {
    const st = await chainReadyToLeave()
    const before = dbSnapshot(st.prisma)
    const from = st.calls.length

    await preview(st, 2, 'checkout')

    expect(writeOps(st.calls, from)).toEqual([])
    expect(dbSnapshot(st.prisma)).toBe(before)
  })

  it('отмену продолжения предпросмотр отклоняет там же, где и сохранение', async () => {
    // Иначе он пообещал бы расчёт, который подтверждение отвергнет, — а сумму
    // администратор гостю уже назвал.
    const st = await chainReadyToLeave()

    const res = await preview(st, 2, 'cancel')

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Продолжение брони отменить нельзя — оформите выезд')
  })

  it('выезд по закрытой переездом голове отклоняется: гость живёт не там', async () => {
    const st = await chainReadyToLeave()

    const res = await preview(st, 1, 'checkout')

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('CHECKED_OUT')
  })
})

// ─── Подтверждение расчёта ───────────────────────────────────────────────────

describe('расчёт с гостем кладёт штраф и возврат на голову счёта', () => {
  /** Удерживаем 5 000 за ранний выезд, остальное возвращаем. */
  async function settled() {
    const st = await chainReadyToLeave()
    const res = await settle(st, 2, {
      action: 'checkout',
      penalty: { amount: 5000, reason: 'ранний выезд' },
      refund: { amount: 63100, method: 'card' },
    })
    return { st, res }
  }

  it('выезд оформлен по продолжению: статус и дата — у него', async () => {
    const { st, res } = await settled()
    const cont = st.prisma.booking.rows.find((b) => b.id === 2)

    expect(res.status).toBe(200)
    expect(cont.status).toBe('CHECKED_OUT')
    expect(iso(cont.checkOut)).toBe('2026-07-13')
    expect(cont.totalAmount).toBe(0)
  })

  it('непрожитая ночь снята со счёта ГОЛОВЫ, прожитые сохранили цену своей категории', async () => {
    const { st } = await settled()
    const stays = chargesOf(st.prisma, 1).filter((c) => c.kind === 'stay')

    expect(stays.map((c) => [iso(c.date), c.amount])).toEqual([
      ['2026-07-10', 20000],
      ['2026-07-11', 20000],
      ['2026-07-12', 30000],
    ])
  })

  it('штраф записан ручной строкой на голове, а не на продолжении', async () => {
    const { st, res } = await settled()

    expect(res.body.data.penalty.bookingId).toBe(1)
    expect(res.body.data.penalty).toMatchObject({
      kind: 'extra', label: 'Штраф: ранний выезд', amount: 5000, source: 'manual',
    })
    expect(chargesOf(st.prisma, 2)).toEqual([])
  })

  it('возврат лёг на голову и сослался на исходный приём', async () => {
    // Возврат без `refundOfId` — это «свободный» возврат, отменённый в волне 5a;
    // а `bookingId` продолжения потерял бы платёж для кассы и «Долгов».
    const { st, res } = await settled()

    expect(res.body.data.refunds).toHaveLength(1)
    expect(res.body.data.refunds[0]).toMatchObject({ bookingId: 1, amount: 63100, refundOfId: 1, kind: 'refund' })
    expect(st.prisma.payment.rows.every((p) => p.bookingId === 1)).toBe(true)
  })

  it('счёт сошёлся: начислено 86 900, принято 86 900, долг ноль', async () => {
    const { st, res } = await settled()

    expect(totalOf(st.prisma, 1)).toBe(86900)
    expect(res.body.data.summary).toMatchObject({ charged: 86900, paid: 86900, due: 0 })
    expect(st.prisma.booking.rows.find((b) => b.id === 1).paidAmount).toBe(86900)
    expect(st.prisma.booking.rows.find((b) => b.id === 2).paidAmount).toBe(0)
  })

  it('вернуть больше переплаты по счёту нельзя — 400 с суммой лимита', async () => {
    // Лимит считается по ЦЕПОЧКЕ и уже включает штраф. Если бы он считался по
    // продолжению (начислено 0), вернуть можно было бы всё принятое.
    const st = await chainReadyToLeave()

    const res = await settle(st, 2, {
      action: 'checkout',
      penalty: { amount: 5000, reason: 'ранний выезд' },
      refund: { amount: 70000, method: 'card' },
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('63100')
  })

  it('расчёт по продолжению обновляет деньги на обоих отрезках', async () => {
    const st = await chainReadyToLeave()
    st.emitted.length = 0

    await settle(st, 2, { action: 'checkout', penalty: { amount: 5000, reason: 'ранний выезд' }, refund: { amount: 63100 } })

    const ids = st.emitted.filter((e) => e.event === 'booking:updated').map((e) => e.payload.booking.id)
    expect([...new Set(ids)].sort()).toEqual([1, 2])
  })
})
