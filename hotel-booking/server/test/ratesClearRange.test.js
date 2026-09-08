import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * «Очистить период» в календаре цен и счётчик перед ним (D6-004 / D7-011).
 *
 * Удаление цен необратимо: `RatePrice` не входит ни в снимки, ни в откат. Поэтому
 * перед ним показывают «будет удалено N цен» — и это число обязано быть тем же,
 * что удалится. Разойтись они могут ровно одним способом: если счётчик строит
 * свой `where`. Здесь проверяется, что оба эндпоинта строят его ОДНОЙ функцией
 * и получают побайтово одинаковые аргументы — и что на равном наборе данных
 * счётчик называет ровно столько строк, сколько потом исчезает.
 *
 * `fakePrisma` вычисляет `where` по-настоящему, поэтому перепутанные `lt`/`lte`
 * на верхней границе периода здесь падают, а не проходят молча.
 */

const price = (id, categoryId, date, over = {}) => ({
  id, categoryId, date: d(date),
  roomPrice: 20000, adultPrice: 15000, childPrice: 7000, extraBedPrice: 5000,
  updatedAt: d('2026-06-01'), ...over,
})

// Две категории, июнь 2026, по одной цене на день с 1 по 5 число.
const ROWS = [
  price(1, 1, '2026-06-01'), price(2, 1, '2026-06-02'), price(3, 1, '2026-06-03'),
  price(4, 1, '2026-06-04'), price(5, 1, '2026-06-05'),
  price(6, 2, '2026-06-02'), price(7, 2, '2026-06-03'),
  price(8, 3, '2026-06-02'),
]

function stack(rows = ROWS) {
  const { prisma, calls } = createFakePrisma({ ratePrice: rows })
  const errorHandler = loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  })
  const ctrl = loadCjs('src/controllers/rateController.js', {
    stubs: { '../utils/prisma': { prisma }, '../middleware/errorHandler': errorHandler },
  })
  return { ctrl, prisma, calls }
}

const call = (handler, { body = {}, query = {} } = {}) => {
  const out = { status: 200, body: null }
  const res = { status(c) { out.status = c; return res }, json(b) { out.body = b; return res } }
  const next = (err) => { out.status = err.status || 500; out.body = { error: err.message } }
  return Promise.resolve(handler({ body, query, params: {}, admin: { id: 1, role: 'ADMIN' } }, res, next))
    .then(() => out)
}

const whereOf = (calls, op) => calls.find((c) => c.model === 'ratePrice' && c.op === op).args.where

describe('счётчик и удаление строят один и тот же where', () => {
  it('GET /rates/count и DELETE /rates получают побайтово одинаковый where', async () => {
    const a = stack()
    await call(a.ctrl.countRange, { query: { categoryIds: '1,2', from: '2026-06-02', to: '2026-06-04' } })

    const b = stack()
    await call(b.ctrl.clearRange, { body: { categoryIds: [1, 2], dateFrom: '2026-06-02', dateTo: '2026-06-04' } })

    expect(whereOf(a.calls, 'count')).toEqual(whereOf(b.calls, 'deleteMany'))
  })

  it('счётчик называет ровно столько строк, сколько потом исчезает', async () => {
    const a = stack()
    const counted = await call(a.ctrl.countRange, {
      query: { categoryIds: '1,2', from: '2026-06-02', to: '2026-06-04' },
    })

    const b = stack()
    const deleted = await call(b.ctrl.clearRange, {
      body: { categoryIds: [1, 2], dateFrom: '2026-06-02', dateTo: '2026-06-04' },
    })

    expect(counted.body.data.count).toBe(deleted.body.data.deleted)
    expect(counted.body.data.count).toBe(5)   // кат.1: 02,03,04 + кат.2: 02,03
  })

  it('верхняя граница периода включающая: цена ровно на дату «по» удаляется', async () => {
    const { ctrl, prisma } = stack()
    await call(ctrl.clearRange, { body: { categoryIds: [1], dateFrom: '2026-06-04', dateTo: '2026-06-05' } })
    expect(prisma.ratePrice.rows.filter((r) => r.categoryId === 1).map((r) => r.id)).toEqual([1, 2, 3])
  })

  it('нижняя граница тоже включающая: цена ровно на дату «с» удаляется', async () => {
    const { ctrl, prisma } = stack()
    await call(ctrl.clearRange, { body: { categoryIds: [1], dateFrom: '2026-06-01', dateTo: '2026-06-01' } })
    expect(prisma.ratePrice.rows.some((r) => r.id === 1)).toBe(false)
    expect(prisma.ratePrice.rows.some((r) => r.id === 2)).toBe(true)
  })

  it('период в один день удаляет один день, а не ноль', async () => {
    const a = stack()
    const counted = await call(a.ctrl.countRange, {
      query: { categoryIds: '1', from: '2026-06-03', to: '2026-06-03' },
    })
    expect(counted.body.data.count).toBe(1)
  })

  it('чужая категория не задевается: удаление ограничено списком', async () => {
    const { ctrl, prisma } = stack()
    await call(ctrl.clearRange, { body: { categoryIds: [1, 2], dateFrom: '2026-06-01', dateTo: '2026-06-30' } })
    expect(prisma.ratePrice.rows.map((r) => r.id)).toEqual([8])
  })

  it('категории списком через запятую и массивом дают один результат', async () => {
    const a = stack()
    await call(a.ctrl.countRange, { query: { categoryIds: '1,2,3', from: '2026-06-01', to: '2026-06-30' } })
    const b = stack()
    await call(b.ctrl.countRange, { query: { categoryIds: ['1', '2', '3'], from: '2026-06-01', to: '2026-06-30' } })
    expect(whereOf(a.calls, 'count')).toEqual(whereOf(b.calls, 'count'))
  })
})

describe('оба эндпоинта отказывают на одинаковых параметрах', () => {
  const bad = [
    ['дата «по» раньше даты «с»', { categoryIds: '1', from: '2026-06-10', to: '2026-06-01' }, { categoryIds: [1], dateFrom: '2026-06-10', dateTo: '2026-06-01' }],
    ['категории не указаны', { from: '2026-06-01', to: '2026-06-02' }, { dateFrom: '2026-06-01', dateTo: '2026-06-02' }],
    ['пустой список категорий', { categoryIds: '', from: '2026-06-01', to: '2026-06-02' }, { categoryIds: [], dateFrom: '2026-06-01', dateTo: '2026-06-02' }],
    ['мусор в списке категорий', { categoryIds: '1,кот', from: '2026-06-01', to: '2026-06-02' }, { categoryIds: [1, 'кот'], dateFrom: '2026-06-01', dateTo: '2026-06-02' }],
    ['ноль как номер категории', { categoryIds: '0', from: '2026-06-01', to: '2026-06-02' }, { categoryIds: [0], dateFrom: '2026-06-01', dateTo: '2026-06-02' }],
    ['нет дат вовсе', { categoryIds: '1' }, { categoryIds: [1] }],
    ['мусор вместо даты', { categoryIds: '1', from: 'вчера', to: '2026-06-02' }, { categoryIds: [1], dateFrom: 'вчера', dateTo: '2026-06-02' }],
  ]

  for (const [name, query, body] of bad) {
    it(`${name} — 400 и у счётчика, и у удаления`, async () => {
      const a = stack()
      const counted = await call(a.ctrl.countRange, { query })
      const b = stack()
      const deleted = await call(b.ctrl.clearRange, { body })
      expect(counted.status).toBe(400)
      expect(deleted.status).toBe(400)
      expect(counted.body.error).toBe(deleted.body.error)
      // Отказ обязан быть ДО обращения к базе: иначе половина строк уже ушла бы
      expect(b.calls.some((c) => c.op === 'deleteMany')).toBe(false)
    })
  }

  it('диапазон ровно в 800 дней разрешён, 801 — уже нет', async () => {
    const a = stack()
    const ok = await call(a.ctrl.countRange, { query: { categoryIds: '1', from: '2026-01-01', to: '2028-03-10' } })
    expect(ok.status).toBe(200)

    const b = stack()
    const tooBig = await call(b.ctrl.countRange, { query: { categoryIds: '1', from: '2026-01-01', to: '2028-03-11' } })
    expect(tooBig.status).toBe(400)
    expect(tooBig.body.error).toMatch(/Слишком большой диапазон/)
  })
})

describe('несуществующая календарная дата в границах периода', () => {
  it('несуществующая дата должна отвергаться, как в utils/hotelTz.js', async () => {
    const { ctrl } = stack()
    const res = await call(ctrl.countRange, {
      query: { categoryIds: '1', from: '2026-02-30', to: '2026-03-05' },
    })
    expect(res.status).toBe(400)
  })

})
