import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Волна 5b: оптимизатор не трогает номера, выделенные партнёру.
 *
 * Решение (`docs/decisions/bookings.md`, 2026-09-08): квота — это обещание
 * партнёру, а не свойство раскладки. Въехать в неё автоматически значит нарушить
 * договорённость, о которой алгоритм ничего не знает; вывезти из неё чужую бронь —
 * тем более: её туда положили осознанно, поверх квоты, и переселение стёрло бы
 * это решение. До волны 5b оптимизатор про квоты не знал вовсе (аудит D3-007).
 *
 * Проверка обязана быть в ДВУХ местах, и это здесь главное:
 *   • `optimize()` — чтобы ход не предлагался;
 *   • `apply()` — чтобы устаревший план (квоту выдали ПОСЛЕ расчёта) всё равно
 *     не въехал в неё (аудит D3-008). Клиент присылает `moves` из своего
 *     состояния, и «мы же это уже проверили» здесь не работает.
 *
 * Первый тест каждого блока — контрольный, БЕЗ квоты: он показывает, что ход
 * действительно предлагался и применялся. Без него «ходов нет» доказывало бы
 * только то, что фикстура не даёт оптимизировать вовсе.
 */

const TODAY = d('2026-07-01')

const room = (id, over = {}) => ({
  id, number: String(id), building: 'A', floor: 1,
  capacity: 'double', features: ['балкон'], isActive: true,
  categoryId: 1, category: { id: 1, name: 'Стандарт' },
  ...over,
})

const bk = (id, roomId, from, to, over = {}) => ({
  id, roomId, guestName: `Гость ${id}`,
  checkIn: d(from), checkOut: d(to),
  status: 'CONFIRMED', source: null, flags: [], paidAmount: 0,
  room: { categoryId: 1 },
  ...over,
})

const quota = (roomId, over = {}) => ({
  id: 1, roomId, partnerId: 7,
  dateFrom: d('2026-07-01'), dateTo: d('2026-07-31'),
  ...over,
})

/**
 * Раскладка с окном, которое оптимизатору хочется закрыть:
 *   101 — «Гость 1» 5→8 июля и «Гость 3» 12→15 июля, между ними окно в 4 ночи;
 *   102 — «Гость 2» 8→12 июля, ровно в это окно и помещается.
 * Без квот оптимизатор перекладывает одну из броней и окно исчезает.
 */
const LAYOUT = [
  bk(1, 101, '2026-07-05', '2026-07-08'),
  bk(2, 102, '2026-07-08', '2026-07-12'),
  bk(3, 101, '2026-07-12', '2026-07-15'),
]

function loadCtrl({ bookings = LAYOUT, allotments = [], rooms = [room(101), room(102)] } = {}) {
  const { prisma } = createFakePrisma({
    booking: bookings,
    room: rooms,
    allotment: allotments,
  })
  // Оптимизатор откладывает exclusion-constraint на COMMIT — фейковой базе
  // ограничений взять неоткуда, но вызов обязан пережить прогон.
  prisma.$executeRawUnsafe = async () => 0

  const realFlagEffects = loadCjs('src/utils/flagEffects.js', { stubs: { './prisma': { prisma } } })
  const emitted = []
  const ctrl = loadCjs('src/controllers/optimizeController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/businessDate': { getCurrentBusinessDate: async () => TODAY },
      '../utils/flagEffects': { ...realFlagEffects, getFlagEffectsMap: async () => ({}) },
      '../utils/snapshot': { createSnapshot: async () => ({ id: 1 }) },
      '../socket/socketManager': { emitBookingEvent: (e, p) => emitted.push({ e, p }) },
      './bookingController': { BOOKING_SELECT: { id: true, roomId: true } },
      './occupancyController': { invalidateGridCache() {} },
      '../utils/logger': silentLogger,
    },
  })
  return { ctrl, prisma, emitted }
}

function run(handler, body = {}) {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  const next = (err) => {
    out.status = err.status || 500
    out.body = { error: err.message }
    if (!err.status) out.body.stack = err.stack
  }
  return Promise.resolve(handler({ body, params: {}, query: {}, admin: { id: 1, name: 'Админ' } }, res, next))
    .then(() => out)
}

const optimize = (ctrl, body = {}) => run(ctrl.optimize, body)
const apply = (ctrl, moves) => run(ctrl.applyOptimization, { moves })

// ─── Расчёт ──────────────────────────────────────────────────────────────────

describe('optimize() обходит квотные номера стороной', () => {
  it('контроль: без квот ход предлагается и окно закрывается', async () => {
    const { ctrl } = loadCtrl()

    const res = await optimize(ctrl)

    expect(res.status).toBe(200)
    expect(res.body.moves.length).toBeGreaterThan(0)
    expect(res.body.after.totalGaps).toBeLessThan(res.body.before.totalGaps)
  })

  it('в квотный номер оптимизатор не селит', async () => {
    // Квота на 101 — том самом номере, куда без неё уезжала бронь.
    const { ctrl } = loadCtrl({ allotments: [quota(101)] })

    const res = await optimize(ctrl)

    expect(res.body.moves).toEqual([])
  })

  it('бронь ИЗ квотного номера не вывозит', async () => {
    // Её туда положили осознанно, поверх квоты: переселение стёрло бы это решение.
    const { ctrl } = loadCtrl({ allotments: [quota(102)] })

    const res = await optimize(ctrl)

    expect(res.body.moves).toEqual([])
  })

  it('квота на ПРОШЕДШИЙ период номер не блокирует', async () => {
    // Иначе прошлогодний договор с партнёром навсегда вывел бы номер
    // из оптимизации: фильтр по `dateTo > сегодня` и есть эта граница.
    const { ctrl } = loadCtrl({
      allotments: [quota(101, { dateFrom: d('2026-05-01'), dateTo: d('2026-06-01') })],
    })

    const res = await optimize(ctrl)

    expect(res.body.moves.length).toBeGreaterThan(0)
  })

  it('квота на другой номер соседей не задевает', async () => {
    const { ctrl } = loadCtrl({
      bookings: LAYOUT,
      allotments: [quota(999, { roomId: 999 })],
    })

    const res = await optimize(ctrl)

    expect(res.body.moves.length).toBeGreaterThan(0)
  })
})

// ─── Применение ──────────────────────────────────────────────────────────────

describe('apply() проверяет квоты заново, а не верит плану', () => {
  it('контроль: без квот план применяется', async () => {
    const { ctrl, prisma } = loadCtrl()

    const res = await apply(ctrl, [{ bookingId: 2, toRoomId: 101 }])

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ applied: 1 })
    expect(prisma.booking.rows.find((b) => b.id === 2).roomId).toBe(101)
  })

  it('ход В номер, ставший квотным после расчёта, отклоняется 409', async () => {
    // Ровно D3-008: между расчётом и нажатием «Применить» партнёру выделили номер.
    const { ctrl, prisma } = loadCtrl({ allotments: [quota(101)] })

    const res = await apply(ctrl, [{ bookingId: 2, toRoomId: 101 }])

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('План устарел')
    expect(res.body.stale[0].reason).toContain('выделен партнёру')
    // Ни одной записи: отказ приходит ДО транзакции
    expect(prisma.booking.rows.find((b) => b.id === 2).roomId).toBe(102)
  })

  it('ход ИЗ номера, ставшего квотным, тоже отклоняется', async () => {
    const { ctrl, prisma } = loadCtrl({ allotments: [quota(102)] })

    const res = await apply(ctrl, [{ bookingId: 2, toRoomId: 101 }])

    expect(res.status).toBe(409)
    expect(res.body.stale[0].reason).toContain('выделенном партнёру')
    expect(prisma.booking.rows.find((b) => b.id === 2).roomId).toBe(102)
  })

  it('один квотный ход отменяет ВЕСЬ план, а не выполняется частично', async () => {
    // Половина применённого плана — раскладка, которой не было ни до, ни после:
    // откатывать её администратору нечем.
    const { ctrl, prisma } = loadCtrl({
      bookings: [...LAYOUT, bk(4, 103, '2026-07-20', '2026-07-22')],
      rooms: [room(101), room(102), room(103)],
      allotments: [quota(101)],
    })

    const res = await apply(ctrl, [
      // Первый ход сам по себе законный — он обязан НЕ примениться из-за второго
      { bookingId: 4, toRoomId: 102 },
      { bookingId: 2, toRoomId: 101 },
    ])

    expect(res.status).toBe(409)
    expect(res.body.stale).toHaveLength(1)
    expect(res.body.stale[0].bookingId).toBe(2)
    expect(prisma.booking.rows.find((b) => b.id === 4).roomId).toBe(103)
  })
})
