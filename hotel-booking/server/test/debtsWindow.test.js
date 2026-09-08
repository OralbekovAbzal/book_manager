import { describe, it, expect } from 'vitest'
import { makeStack, booking, charge, d, run, BUSINESS_DATE } from './helpers/bookingStack.js'

/**
 * Окно списка долгов в кассе (аудит D6-002).
 *
 * «Касса → Приём оплаты» показывала только тех, кто выехал не раньше чем 30 дней
 * назад, и нигде об этом не говорила: долг турфирмы за прошлый месяц не находился
 * ни поиском, ни листанием — его просто не было в ответе. Окно должно сниматься
 * (`days=0` / `all=1`) и задаваться числом.
 *
 * Проверяется и чистое правило разбора запроса, и то, что оно доходит до ЗАПРОСА
 * к базе: при снятом окне нижней границы по `checkOut` не должно быть вовсе,
 * а не «очень старая дата».
 */

const DAY = 24 * 60 * 60 * 1000

const scene = (bookings, charges) => makeStack({ bookings, charges })

/** Первый запрос за бронями, который сделал контроллер долгов. */
const firstWhere = (calls) =>
  calls.find((c) => c.model === 'booking' && c.op === 'findMany').args.where

const debtor = (id, checkOut, over = {}) => booking({
  id,
  guestName: `Должник ${id}`,
  checkIn: d('2026-06-01'),
  checkOut: d(checkOut),
  status: 'CHECKED_OUT',
  totalAmount: 0,
  ...over,
})

const debt = (id, amount = 50000) => charge({ id, bookingId: id, amount, unitPrice: amount, date: null })

const idsOf = (res) => res.body.data.bookings.map((b) => b.id)

// ─── Чистое правило ──────────────────────────────────────────────────────────

describe('debtsWindow — разбор параметров окна', () => {
  const windowOf = (query) => makeStack({}).payCtrl.debtsWindow(query)

  it('без параметров окно — тридцать дней', () => {
    expect(windowOf({})).toEqual({ days: 30 })
  })

  it('days=0 снимает окно совсем', () => {
    expect(windowOf({ days: '0' })).toEqual({ days: null })
  })

  it('all=1 снимает окно совсем', () => {
    expect(windowOf({ all: '1' })).toEqual({ days: null })
  })

  it('days=45 — это сорок пять дней', () => {
    expect(windowOf({ days: '45' })).toEqual({ days: 45 })
  })

  it('мусор вместо числа возвращает окно по умолчанию', () => {
    expect(windowOf({ days: 'вчера' })).toEqual({ days: 30 })
  })

  // Отрицательное — это опечатка, а не «покажи всё»: снятие окна просят нулём
  // или `all=1`. Расхождение с кодом было (ветка `n <= 0` возвращала `{days:null}`)
  // и закрыто в ту же волну — тест остаётся сторожем правила.
  it('отрицательное число возвращает окно по умолчанию', () => {
    expect(windowOf({ days: '-5' })).toEqual({ days: 30 })
  })

  it('окно ограничено сверху разумным пределом — год', () => {
    // «Все долги» просят через `all`, а не числом в миллион: неограниченное
    // окно числом означало бы полную выборку броней под видом фильтра.
    const w = windowOf({ days: '100000' })
    expect(w.days === null || w.days <= 366).toBe(true)
  })
})

// ─── Запрос к базе ───────────────────────────────────────────────────────────

describe('GET /payments/debts — окно доходит до запроса', () => {
  const ROWS = [
    debtor(1, '2026-07-05'),  // выехал 5 дней назад — в окне
    debtor(2, '2026-06-05'),  // выехал 35 дней назад — за окном
  ]
  const CHARGES = [debt(1), debt(2)]

  it('по умолчанию нижняя граница — рабочая дата минус тридцать дней', async () => {
    const st = scene(ROWS, CHARGES)
    await run(st.payCtrl.debts, {})
    const where = firstWhere(st.calls)
    expect(where.checkOut.gte.getTime()).toBe(BUSINESS_DATE.getTime() - 30 * DAY)
  })

  it('месячный долг турфирмы по умолчанию не виден — ровно то, на что жаловались', async () => {
    const st = scene(ROWS, CHARGES)
    const res = await run(st.payCtrl.debts, {})
    expect(idsOf(res)).toEqual([1])
  })

  it('all=1 убирает фильтр по выезду целиком, а не подставляет старую дату', async () => {
    const st = scene(ROWS, CHARGES)
    const res = await run(st.payCtrl.debts, { query: { all: '1' } })

    expect('checkOut' in firstWhere(st.calls)).toBe(false)
    expect(idsOf(res)).toEqual([1, 2])
  })

  it('days=0 работает так же, как all=1', async () => {
    const st = scene(ROWS, CHARGES)
    const res = await run(st.payCtrl.debts, { query: { days: '0' } })

    expect('checkOut' in firstWhere(st.calls)).toBe(false)
    expect(idsOf(res)).toEqual([1, 2])
  })

  it('days=45 достаёт долг тридцатипятидневной давности', async () => {
    const st = scene(ROWS, CHARGES)
    const res = await run(st.payCtrl.debts, { query: { days: '45' } })
    expect(idsOf(res)).toEqual([1, 2])
  })

  it('выезд ровно на границе окна ещё виден: граница включающая', async () => {
    const edge = new Date(BUSINESS_DATE.getTime() - 30 * DAY).toISOString().slice(0, 10)
    const st = scene([debtor(3, edge)], [debt(3)])

    const res = await run(st.payCtrl.debts, {})
    expect(idsOf(res)).toEqual([3])
  })

  it('днём раньше границы — уже за окном', async () => {
    const out = new Date(BUSINESS_DATE.getTime() - 31 * DAY).toISOString().slice(0, 10)
    const st = scene([debtor(3, out)], [debt(3)])

    const res = await run(st.payCtrl.debts, {})
    expect(idsOf(res)).toEqual([])
  })

  it('снятое окно не отменяет фильтр по статусу: черновики и удалённые в кассу не лезут', async () => {
    const st = scene(ROWS, CHARGES)
    await run(st.payCtrl.debts, { query: { all: '1' } })
    expect(firstWhere(st.calls).status).toEqual({ in: ['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT'] })
  })

  it('поиск по гостю работает вместе со снятым окном', async () => {
    const st = scene(ROWS, CHARGES)
    const res = await run(st.payCtrl.debts, { query: { all: '1', q: 'Должник 2' } })
    expect(idsOf(res)).toEqual([2])
  })
})
