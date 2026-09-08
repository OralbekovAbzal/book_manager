import { describe, it, expect } from 'vitest'
import {
  makeSettlementStack, writeOps, dbSnapshot,
  run, booking, room, rate, service, charge, payment, d,
} from './helpers/settlementStack.js'

/**
 * Шаг 5a-2, половина первая: `POST /bookings/:id/settlement/preview` — «сколько выйдет».
 *
 * Ради чего эндпоинт вообще существует: администратор договаривается с гостем о сумме
 * ГЛЯДЯ на калькулятор, поэтому предпросмотр обязан считать теми же планами
 * (`planCancelCharges` / `planEarlyCheckout`), что и сохранение. Два разных вычисления
 * «сколько к возврату» разошлись бы на тенге — и гостю отдали бы не ту сумму.
 *
 * Отсюда состав проверок: не «ответ похож на правду», а
 *   • отмена обнуляет счёт (остаются только ручные строки — ими оформляют удержание);
 *   • выезд считает по ФАКТИЧЕСКИ прожитым ночам, с пересчётом посуточного питания;
 *   • предпросмотр НИЧЕГО не пишет и не рассылает событий (его зовут на каждое
 *     изменение суммы штрафа в диалоге);
 *   • у брони без строк начислений «начислено» берётся из кэша `totalAmount` — ровно
 *     как в кассе, иначе 107 старых броней показали бы всю оплату «к возврату».
 */

const BREAKFAST = service({ id: 1, name: 'Завтрак', price: 3500, unit: 'per_person_night' })

/** Календарь ПОДОРОЖАЛ уже после того, как бронь была посчитана: 15 000 → 20 000. */
const RAISED = ['2026-07-10', '2026-07-11', '2026-07-12'].map((iso) => rate(iso, { adultPrice: 20000 }))

const previewOf = (st, action, id = 7) =>
  run(st.settlement.preview, { params: { id: String(id) }, body: { action } })

/** Бронь 10→13 июля, 3 авто-ночи по 30 000, оплачено 50 000 одним приёмом. */
function confirmedWithPrepayment({ charges, payments: pays } = {}) {
  return makeSettlementStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 90000, paidAmount: 50000 })],
    charges: charges ?? [
      charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
      charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
    ],
    payments: pays ?? [payment({ id: 1, bookingId: 7, amount: 50000, method: 'card' })],
  })
}

describe('preview cancel — отмена обнуляет счёт, оплаченное уходит «к возврату»', () => {
  it('без ручных строк начислено = 0, а вся оплата — к возврату', async () => {
    const st = confirmedWithPrepayment()

    const r = await previewOf(st, 'cancel')

    expect(r.status).toBe(200)
    expect(r.body.data).toMatchObject({
      action: 'cancel',
      status: 'CONFIRMED',       // текущий статус, а не будущий: диалог показывает «сейчас»
      charged: 0,
      paid: 50000,
      toReturn: 50000,
      due: 0,
    })
    expect(r.body.data.rows).toEqual([])
  })

  it('ручная строка удержания остаётся в счёте и уменьшает возврат', async () => {
    const st = confirmedWithPrepayment({
      charges: [
        charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
        charge({
          id: 2, bookingId: 7, kind: 'extra', label: 'Штраф за отмену', quantity: 1,
          unitPrice: 15000, amount: 15000, source: 'manual', reason: 'позднее аннулирование',
        }),
      ],
    })

    const r = await previewOf(st, 'cancel')

    expect(r.body.data.charged).toBe(15000)
    expect(r.body.data.toReturn).toBe(35000)
    expect(r.body.data.rows).toEqual([
      { kind: 'extra', label: 'Штраф за отмену', quantity: 1, unitPrice: 15000, amount: 15000, date: null, source: 'manual' },
    ])
  })

  it('несостоявшиеся ночи не считаются «снятыми»: nights = {3, 0, 0}', async () => {
    const st = confirmedWithPrepayment()
    const r = await previewOf(st, 'cancel')
    expect(r.body.data.nights).toEqual({ planned: 3, stayed: 0, removed: 0 })
  })

  it('приёмы оплаты приходят с остатком: частично возвращённый показывает не всю сумму', async () => {
    const st = confirmedWithPrepayment({
      payments: [
        payment({ id: 1, bookingId: 7, amount: 50000, method: 'card' }),
        payment({ id: 2, bookingId: 7, kind: 'refund', amount: 5000, method: 'card', refundOfId: 1 }),
      ],
    })

    const r = await previewOf(st, 'cancel')

    expect(r.body.data.paid).toBe(45000)
    expect(r.body.data.payments).toEqual([
      { id: 1, paidAt: expect.any(Date), method: 'card', amount: 50000, refundable: 45000 },
    ])
    // Возврат в списке источников не появляется: возвращать возврат нечем
    expect(r.body.data.payments.map((p) => p.id)).not.toContain(2)
  })

  it('отменённый приём оплаты не показывается как источник возврата', async () => {
    const st = confirmedWithPrepayment({
      payments: [
        payment({ id: 1, bookingId: 7, amount: 50000, method: 'card' }),
        payment({ id: 2, bookingId: 7, amount: 9000, method: 'cash', voidedAt: new Date('2026-07-09T10:00:00Z') }),
      ],
    })

    const r = await previewOf(st, 'cancel')

    expect(r.body.data.payments.map((p) => p.id)).toEqual([1])
    expect(r.body.data.paid).toBe(50000)
  })

  it('предпросмотр не пишет в базу и не шлёт событий', async () => {
    const st = confirmedWithPrepayment()
    const before = dbSnapshot(st.prisma)

    await previewOf(st, 'cancel')

    expect(writeOps(st.calls)).toEqual([])
    expect(dbSnapshot(st.prisma)).toBe(before)
    expect(st.emitted).toEqual([])
  })

  it('повторный вызов даёт тот же ответ — калькулятор не «съезжает» от нажатий', async () => {
    const st = confirmedWithPrepayment()

    const first = await previewOf(st, 'cancel')
    const second = await previewOf(st, 'cancel')

    expect(JSON.stringify(second.body)).toBe(JSON.stringify(first.body))
  })
})

describe('preview checkout — ранний выезд считает по фактически прожитым ночам', () => {
  /**
   * Бронь 10→13 июля (3 ночи), 2 взрослых, завтрак 3 500, скидка 10 %.
   * Строки посчитаны по СТАРОЙ цене 15 000/взр. Рабочая дата — 12-е: прожиты
   * ночи 10 и 11, ночь 12-го — нет.
   */
  function stayedTwoOfThree({ status = 'CHECKED_IN' } = {}) {
    return makeSettlementStack({
      businessDate: d('2026-07-12'),
      rates: RAISED,
      services: [BREAKFAST],
      rooms: [room({ id: 101 })],
      bookingServices: [{ id: 1, bookingId: 7, serviceId: 1, adults: 2, children: 0, quantity: 1 }],
      bookings: [booking({
        id: 7, status, checkIn: d('2026-07-10'), checkOut: d('2026-07-13'),
        discountPercent: 10, totalAmount: 103500, prepaidAmount: 51750, paidAmount: 103500,
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
      payments: [payment({ id: 1, bookingId: 7, amount: 103500, method: 'cash' })],
    })
  }

  it('ночь ровно в день выезда снимается, предыдущая остаётся со своей ценой', async () => {
    const st = stayedTwoOfThree()

    const r = await previewOf(st, 'checkout')

    const stays = r.body.data.rows.filter((x) => x.kind === 'stay')
    expect(stays.map((x) => x.date)).toEqual(['2026-07-10', '2026-07-11'])
    // Пересборка по подорожавшему календарю дала бы 40 000 — это переоценка задним числом
    expect(stays.map((x) => x.amount)).toEqual([30000, 30000])
  })

  it('посуточное питание пересчитано на прожитые ночи, скидка — от новой базы', async () => {
    const st = stayedTwoOfThree()

    const rows = (await previewOf(st, 'checkout')).body.data.rows

    expect(rows.find((x) => x.kind === 'meal')).toMatchObject({ quantity: 4, amount: 14000 })
    // 60 000 + 14 000 + 4 000 (ручной мини-бар) = 78 000 → 10 %
    expect(rows.find((x) => x.kind === 'discount').amount).toBe(-7800)
    expect(rows.find((x) => x.source === 'manual')).toMatchObject({ label: 'Мини-бар', amount: 4000 })
  })

  it('начислено = 70 200, к возврату — разница с оплатой', async () => {
    const st = stayedTwoOfThree()

    const data = (await previewOf(st, 'checkout')).body.data

    expect(data.charged).toBe(70200)
    expect(data.paid).toBe(103500)
    expect(data.toReturn).toBe(33300)
    expect(data.due).toBe(0)
  })

  it('прожито 2 из 3 ночей: nights = {3, 2, 1}', async () => {
    const st = stayedTwoOfThree()
    expect((await previewOf(st, 'checkout')).body.data.nights).toEqual({ planned: 3, stayed: 2, removed: 1 })
  })

  it('предпросмотр выезда не трогает базу — ни строк, ни даты выезда', async () => {
    const st = stayedTwoOfThree()
    const before = dbSnapshot(st.prisma)

    await previewOf(st, 'checkout')

    expect(writeOps(st.calls)).toEqual([])
    expect(dbSnapshot(st.prisma)).toBe(before)
    expect(st.emitted).toEqual([])
  })

  it('на не заселённой брони отвечает 400 — предпросмотр не обещает того, что сохранение отклонит', async () => {
    const st = stayedTwoOfThree({ status: 'CONFIRMED' })

    const r = await previewOf(st, 'checkout')

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Нельзя отметить выезд/)
  })

  it('выезд в срок счёт не меняет: те же строки, снятых ночей нет', async () => {
    const st = makeSettlementStack({
      businessDate: d('2026-07-13'),
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CHECKED_IN', totalAmount: 90000, paidAmount: 90000 })],
      charges: [
        charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 }),
        charge({ id: 2, bookingId: 7, date: d('2026-07-11'), amount: 30000, unitPrice: 30000 }),
        charge({ id: 3, bookingId: 7, date: d('2026-07-12'), amount: 30000, unitPrice: 30000 }),
      ],
      payments: [payment({ id: 1, bookingId: 7, amount: 90000 })],
    })

    const data = (await previewOf(st, 'checkout')).body.data

    expect(data.charged).toBe(90000)
    expect(data.rows).toHaveLength(3)
    expect(data.nights).toEqual({ planned: 3, stayed: 3, removed: 0 })
    expect(data.toReturn).toBe(0)
  })

  it('выезд в день заезда показывается как отмена: гость не ночевал', async () => {
    const st = makeSettlementStack({
      businessDate: d('2026-07-10'),
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CHECKED_IN', totalAmount: 90000, paidAmount: 30000 })],
      charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 30000, unitPrice: 30000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 30000 })],
    })

    const data = (await previewOf(st, 'checkout')).body.data

    expect(data.charged).toBe(0)
    expect(data.rows).toEqual([])
    expect(data.toReturn).toBe(30000)
    expect(data.nights).toEqual({ planned: 3, stayed: 0, removed: 3 })
  })
})

describe('preview none — текущий счёт без смены статуса', () => {
  it('строки есть — начислено равно их сумме, статус не меняется', async () => {
    const st = confirmedWithPrepayment()

    const data = (await previewOf(st, 'none')).body.data

    expect(data).toMatchObject({ action: 'none', status: 'CONFIRMED', charged: 90000, paid: 50000, due: 40000, toReturn: 0 })
    expect(data.rows).toHaveLength(3)
  })

  it('у брони без строк начислено берётся из кэша totalAmount — как в кассе', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CONFIRMED', totalAmount: 88000, paidAmount: 88000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 88000 })],
    })

    const data = (await previewOf(st, 'none')).body.data

    expect(data.charged).toBe(88000)
    expect(data.rows).toEqual([])
    expect(data.toReturn).toBe(0)   // иначе старая бронь показала бы всю оплату к возврату
  })

  it('у ОТМЕНЁННОЙ брони без строк начислено = 0, оплата целиком к возврату', async () => {
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CANCELLED', totalAmount: 88000, paidAmount: 20000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 20000 })],
    })

    const data = (await previewOf(st, 'none')).body.data

    expect(data.charged).toBe(0)
    expect(data.toReturn).toBe(20000)
  })

  it('неизвестное действие — 400, без похода в базу за бронью', async () => {
    const st = confirmedWithPrepayment()

    const r = await run(st.settlement.preview, { params: { id: '7' }, body: { action: 'удалить' } })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Неизвестное действие/)
    expect(st.calls).toEqual([])
  })

  it('брони нет — 404', async () => {
    const st = confirmedWithPrepayment()
    const r = await previewOf(st, 'none', 999)
    expect(r.status).toBe(404)
  })
})

describe('предпросмотр отмены спрашивает cancelGuard — те же гейты, что у сохранения', () => {
  /**
   * Было (найдено тестом 08.09, починено в тот же день): `checkOutGuard` спрашивался
   * только для `action: 'checkout'`, а отмена закрытой брони проходила предпросмотром
   * с 200 и `toReturn` во всю оплату — калькулятор обещал выехавшему гостю возврат за
   * прожитые ночи, и только «Подтвердить» отвечало 400. Денег это не двигало, но сумму
   * администратор гостю уже назвал.
   */
  const closed = (status) => makeSettlementStack({
    rooms: [room({ id: 101 })],
    bookings: [booking({ id: 7, status, totalAmount: 90000, paidAmount: 90000 })],
    charges: [charge({ id: 1, bookingId: 7, date: d('2026-07-10'), amount: 90000, unitPrice: 90000 })],
    payments: [payment({ id: 1, bookingId: 7, amount: 90000 })],
  })

  it('preview cancel на закрытой брони отвечает 400, как и сохранение', async () => {
    const r = await previewOf(closed('CHECKED_OUT'), 'cancel')

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Нельзя отменить закрытую бронь')
  })

  it('на уже отменённой — тот же отказ, что у «Отменить»', async () => {
    const r = await previewOf(closed('CANCELLED'), 'cancel')

    expect(r.status).toBe(400)
    expect(r.body.error).toBe('Бронь уже отменена')
  })

  it('«none» по той же брони по-прежнему открыт: так возвращают переплату назавтра', async () => {
    // Отменённая бронь после расчёта — без строк и с нулевым итогом: начислено 0,
    // вся оплата — переплата. Ради этого случая гейт на «none» и не ставится.
    const st = makeSettlementStack({
      rooms: [room({ id: 101 })],
      bookings: [booking({ id: 7, status: 'CANCELLED', totalAmount: 0, paidAmount: 90000 })],
      payments: [payment({ id: 1, bookingId: 7, amount: 90000 })],
    })

    const r = await previewOf(st, 'none')

    expect(r.status).toBe(200)
    expect(r.body.data.toReturn).toBe(90000)
  })
})
