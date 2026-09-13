/**
 * Регрессионный обзор волны 12 (2026-09-13): заморозка прожитых ночей в
 * `PUT /bookings/:id` — `resolveFrozenBefore` + `frozenBefore` по рабочей дате
 * отеля (S13-010, `controllers/bookingController.js:636,758`).
 *
 * Что проверяется: не появилось ли у починки побочного эффекта на тех правках,
 * где набор ночей брони СОКРАЩАЕТСЯ ниже рабочей даты. Аудит предлагал границу
 * только для `CHECKED_IN` (01-server.md:198) — у заселённого гостя заезд менять
 * нельзя, а выезд можно двигать только вперёд от рабочей даты, поэтому набор
 * ночей у него сократиться не может. В волне 12 условие по статусу не вошло, и
 * граница применяется к любой открытой брони.
 *
 * Стенд — `helpers/bookingStack.js` (настоящие контроллер и `utils/charges.js`,
 * фейковая Prisma с честным `where`). Живая база и сервер не участвуют.
 * Рабочая дата стенда — 10 июля 2026.
 *
 * Починено волной 12b (2026-09-13): заморозка по рабочей дате оставлена только
 * заселённым броням, прожитой считается лишь ночь из НОВОГО периода, заглушка на 0
 * ставится только там, где ночь уже закрыта прежним итогом. Репродукции ниже
 * переписаны под ожидаемое поведение — `it.fails` в файле больше нет.
 */
import { describe, it, expect } from 'vitest'
import { makeStack, run, booking, room, charge, rate, chargesOf, totalOf, d } from './helpers/bookingStack.js'

/** Ночи 5–14 июля: пять до рабочей даты (10-е) и пять с неё. */
const NIGHTS = ['2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09',
  '2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14']

/** Цена ночи по календарю на стенде: 2 взрослых × 15 000. */
const PRICE = 30000
/** Заметная сумма в уже записанных строках: по ней видно, какую строку сохранили, а какую пересчитали. */
const OLD = 11111

const RATES = NIGHTS.concat(['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'])
  .map((iso) => rate(iso))

/** Даты строк начислений брони — в том виде, в каком их удобно сверять глазами. */
function days(prisma, id = 1) {
  return chargesOf(prisma, id)
    .filter((c) => c.kind === 'stay')
    .map((c) => (c.date ? c.date.toISOString().slice(0, 10) : null))
}

/**
 * Бронь 5 → 15 июля (десять ночей), заезд в прошлом относительно рабочей даты.
 * Статус — не `CHECKED_IN`: гость не приехал либо заезд ещё не отмечен, и
 * контроллер разрешает двигать обе даты.
 */
function stand({ status = 'CONFIRMED', charges = null, over = {} } = {}) {
  return makeStack({
    rooms: [room({ id: 101 }), room({ id: 102 })],
    rates: RATES,
    bookings: [booking({
      id: 1, services: [], status,
      checkIn: d('2026-07-05'), checkOut: d('2026-07-15'), ...over,
    })],
    charges: charges === null
      ? NIGHTS.map((iso, i) => charge({ id: i + 1, bookingId: 1, date: d(iso), amount: PRICE, unitPrice: PRICE }))
      : charges,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// R13-S-001 · В счёте остаются ночи, которых в брони больше нет
// ─────────────────────────────────────────────────────────────────────────────

describe('R13-S-001 · сокращение брони ниже рабочей даты', () => {
  /**
   * Гость не приехал 5-го, бронь переписали на 12-е. Ночей 5–9 в брони больше
   * нет — и в счёте их тоже быть не должно. Заморозка по рабочей дате к
   * НЕзаселённой брони не применяется (`resolveFrozenBefore`).
   */
  it('после переноса заезда в счёте только ночи нового периода', async () => {
    const { ctrl, prisma } = stand()
    const out = await run(ctrl.update, {
      params: { id: '1' },
      body: { checkIn: '2026-07-12', checkOut: '2026-07-15' },
    })
    expect(out.status).toBe(200)
    expect(days(prisma)).toEqual(['2026-07-12', '2026-07-13', '2026-07-14'])
    // Три ночи × 30 000 = 90 000. До починки было 240 000.
    expect(totalOf(prisma, 1)).toBe(3 * PRICE)
  })

  /**
   * Обратная сторона того же: бронь укоротили выездом в прошлое (гость съехал,
   * закрыли правкой дат, а не кнопкой «Выезд»).
   */
  it('после переноса выезда назад в счёте ровно ночи нового периода', async () => {
    const { ctrl, prisma } = stand()
    const out = await run(ctrl.update, { params: { id: '1' }, body: { checkOut: '2026-07-08' } })
    expect(out.status).toBe(200)
    expect(days(prisma)).toEqual(['2026-07-05', '2026-07-06', '2026-07-07'])
    expect(totalOf(prisma, 1)).toBe(3 * PRICE)
  })

  /**
   * Вторая половина починки — страховка в самом `rebuildChainCharges`: даже
   * если граница пришла снаружи, прожитой считается только та ночь, которая
   * есть в новом периоде брони.
   */
  it('граница заморозки не сохраняет ночи вне нового периода', async () => {
    const { prisma, charges } = stand()
    prisma.booking.rows[0].checkIn = d('2026-07-12')
    // Граница «рабочая дата» — ровно та, что раньше сохраняла ночи 5–9
    await charges.rebuildChainCharges(1, { adminId: 1, keepIfEmpty: true, frozenBefore: d('2026-07-10') })
    expect(days(prisma)).toEqual(['2026-07-12', '2026-07-13', '2026-07-14'])
    expect(totalOf(prisma, 1)).toBe(3 * PRICE)
  })

  /**
   * Доказательство, что дело именно в новой границе: на той же фикстуре прежнее
   * правило волны 5a (`frozenBefore: existing.accountBookingId ? … : null` —
   * для одиночной брони это `null`) собирает счёт верно.
   */
  it('прежнее правило (frozenBefore = null) на той же брони даёт верный счёт', async () => {
    const { prisma, charges } = stand()
    prisma.booking.rows[0].checkIn = d('2026-07-12')
    await charges.rebuildChainCharges(1, { adminId: 1, keepIfEmpty: true, frozenBefore: null })
    expect(days(prisma)).toEqual(['2026-07-12', '2026-07-13', '2026-07-14'])
    expect(totalOf(prisma, 1)).toBe(3 * PRICE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R13-S-002 · Ночь до рабочей даты без строки закрывается нулём навсегда
// ─────────────────────────────────────────────────────────────────────────────

describe('R13-S-002 · прожитые ночи, у которых строки не было', () => {
  /**
   * Цены на июль выставили в июле, бронь завели раньше — строк нет. Стойка жмёт
   * «Пересчитать» 10-го. Ночи 5–9 генератор закрывает заглушкой на 0 и в счёт
   * не попадают: заморозка не отличает «уже посчитано» от «не было посчитано».
   */
  it('ночь без строки получает цену, а не остаётся неначисленной', async () => {
    const { ctrl, prisma } = stand({ status: 'CHECKED_IN', charges: [] })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { recalcCharges: true } })
    expect(out.status).toBe(200)
    expect(days(prisma)).toEqual(NIGHTS)
    expect(totalOf(prisma, 1)).toBe(10 * PRICE)
  })

  /**
   * Ночь, у которой строка ЕСТЬ, по-прежнему не переоценивается: заглушка убрана
   * только там, где закрывать нечего.
   */
  it('прожитая ночь со своей строкой остаётся при своей сумме', async () => {
    const { ctrl, prisma } = stand({
      status: 'CHECKED_IN',
      // Строки есть только у ночей 5 и 6 — остальных не посчитали
      charges: NIGHTS.slice(0, 2).map((iso, i) => charge({
        id: i + 1, bookingId: 1, date: d(iso), amount: OLD, unitPrice: OLD,
      })),
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { recalcCharges: true } })
    expect(out.status).toBe(200)
    const byDay = Object.fromEntries(chargesOf(prisma, 1)
      .filter((c) => c.kind === 'stay' && c.date)
      .map((c) => [c.date.toISOString().slice(0, 10), c.amount]))
    expect(byDay['2026-07-05']).toBe(OLD)
    expect(byDay['2026-07-06']).toBe(OLD)
    expect(byDay['2026-07-07']).toBe(PRICE)   // ночь до границы, но без строки — посчитана
    expect(byDay['2026-07-14']).toBe(PRICE)
  })

  /**
   * Старая бронь без строк, у которой сумма живёт только в кэше `totalAmount`
   * (в NOTES — «107 старых»). `move()` перед пересборкой фиксирует прежний итог
   * строкой (`pinLegacyTotal`) — теперь то же делает и `update()`.
   *
   * Прежний итог покрывает прожитую часть срока (за какие именно ночи он был,
   * уже неизвестно — поэтому ночи до границы генератору не отдаются), ночи с
   * границы считаются по календарю.
   */
  it('прежний итог старой брони не исчезает при правке', async () => {
    const { ctrl, prisma } = stand({
      status: 'CHECKED_IN', charges: [], over: { totalAmount: 400000, paidAmount: 400000 },
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { adultsWithMeals: 2, recalcCharges: true } })
    expect(out.status).toBe(200)
    const rows = chargesOf(prisma, 1)
    const legacy = rows.find((c) => c.label === 'Проживание · по прежнему расчёту')
    expect(legacy).toBeTruthy()
    expect(legacy.amount).toBe(400000)
    expect(legacy.source).toBe('manual')
    // Ночи 5–9 закрыты прежним итогом, 10–14 посчитаны заново
    expect(days(prisma).filter(Boolean)).toEqual(['2026-07-10', '2026-07-11', '2026-07-12', '2026-07-13', '2026-07-14'])
    expect(prisma.booking.rows[0].totalAmount).toBe(400000 + 5 * PRICE)
  })

  /**
   * Сторож к предыдущему: фиксировать прежний итог есть смысл только когда часть
   * срока прожита. У брони целиком в будущем строка прежнего итога легла бы
   * поверх пересчёта вторым счётом.
   */
  it('незаселённая старая бронь пересчитывается по календарю, без строки прежнего итога', async () => {
    const { ctrl, prisma } = stand({
      status: 'CONFIRMED', charges: [], over: { totalAmount: 400000 },
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { recalcCharges: true } })
    expect(out.status).toBe(200)
    expect(chargesOf(prisma, 1).some((c) => c.label === 'Проживание · по прежнему расчёту')).toBe(false)
    expect(totalOf(prisma, 1)).toBe(10 * PRICE)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Сторожа: то, ради чего заморозку делали, и то, что она не должна была задеть
// ─────────────────────────────────────────────────────────────────────────────

describe('S13-010 · заморозка работает там, где задумана', () => {
  it('подселение третьего гостя не переоценивает прожитые ночи, но считает будущие', async () => {
    const { ctrl, prisma } = stand({
      status: 'CHECKED_IN',
      charges: NIGHTS.map((iso, i) => charge({ id: i + 1, bookingId: 1, date: d(iso), amount: OLD, unitPrice: OLD })),
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { adultsWithMeals: 3 } })
    expect(out.status).toBe(200)
    const stay = chargesOf(prisma, 1).filter((c) => c.kind === 'stay')
    // Ночи 5–9 — со старыми суммами, ночи 10–14 пересчитаны по календарю на троих.
    expect(stay.slice(0, 5).map((c) => c.amount)).toEqual([OLD, OLD, OLD, OLD, OLD])
    expect(stay.slice(5).map((c) => c.amount)).toEqual([45000, 45000, 45000, 45000, 45000])
  })

  it('бронь целиком в будущем пересчитывается вся', async () => {
    const future = ['2026-07-20', '2026-07-21', '2026-07-22']
    const { ctrl, prisma } = makeStack({
      rates: future.map((iso) => rate(iso)),
      bookings: [booking({
        id: 1, services: [], checkIn: d('2026-07-20'), checkOut: d('2026-07-23'), status: 'CONFIRMED',
      })],
      charges: future.map((iso, i) => charge({ id: i + 1, bookingId: 1, date: d(iso), amount: OLD, unitPrice: OLD })),
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { adultsWithMeals: 2, recalcCharges: true } })
    expect(out.status).toBe(200)
    expect(chargesOf(prisma, 1).map((c) => c.amount)).toEqual([PRICE, PRICE, PRICE])
  })

  /**
   * Ремонтный блок — единственная бронь, которой разрешено уезжать заездом в
   * прошлое. У появившихся ночей строк нет, и заморозка закрыла бы их нулём:
   * `resolveFrozenBefore` для такой правки возвращает null.
   */
  it('ремонтный блок, растянутый назад, считается целиком', async () => {
    const { ctrl, prisma } = makeStack({
      rates: RATES,
      bookings: [booking({
        id: 1, services: [], source: 'ремонт', status: 'CONFIRMED',
        checkIn: d('2026-07-10'), checkOut: d('2026-07-12'),
      })],
      charges: [
        charge({ id: 1, bookingId: 1, date: d('2026-07-10'), amount: PRICE, unitPrice: PRICE }),
        charge({ id: 2, bookingId: 1, date: d('2026-07-11'), amount: PRICE, unitPrice: PRICE }),
      ],
    })
    const out = await run(ctrl.update, { params: { id: '1' }, body: { checkIn: '2026-07-07' } })
    expect(out.status).toBe(200)
    expect(days(prisma)).toEqual([
      '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11',
    ])
    expect(chargesOf(prisma, 1).every((c) => c.amount === PRICE)).toBe(true)
  })

  /**
   * Цепочка: правка продолжения замораживает ночи до РАБОЧЕЙ даты, а не только
   * до даты переезда. Ночи 8 и 9 (уже прожитые в новом номере) больше не
   * переоцениваются — ровно то, чего добивалась починка.
   */
  it('у продолжения цепочки граница поднимается с даты переезда до рабочей даты', async () => {
    const head = booking({
      id: 1, services: [], checkIn: d('2026-07-05'), checkOut: d('2026-07-08'), status: 'CHECKED_IN',
    })
    const tail = booking({
      id: 2, services: [], roomId: 102, accountBookingId: 1, status: 'CHECKED_IN',
      checkIn: d('2026-07-08'), checkOut: d('2026-07-12'),
    })
    const { ctrl, prisma } = makeStack({
      rates: RATES,
      bookings: [head, tail],
      // Все строки счёта — на голове цепочки
      charges: NIGHTS.slice(0, 7).map((iso, i) => charge({
        id: i + 1, bookingId: 1, date: d(iso), amount: OLD, unitPrice: OLD,
      })),
    })
    const out = await run(ctrl.update, { params: { id: '2' }, body: { adultsWithMeals: 3 } })
    expect(out.status).toBe(200)
    const stay = chargesOf(prisma, 1).filter((c) => c.kind === 'stay')
    // 5–9 июля со старыми суммами (в том числе 8 и 9 — ночи продолжения),
    // 10 и 11 июля пересчитаны на троих.
    expect(stay.map((c) => c.amount)).toEqual([OLD, OLD, OLD, OLD, OLD, 45000, 45000])
  })
})
