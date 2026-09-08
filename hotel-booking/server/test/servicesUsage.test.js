import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Удаление услуги из справочника (аудит D6-005, D7-011).
 *
 * `BookingService.serviceId` стоит с `onDelete: Cascade` — это осознанное решение
 * схемы (деньги уже записаны строками `BookingCharge` и живут отдельно). Но на
 * экране справочника удаление шло без единого вопроса: одно нажатие — и завтрак
 * исчезал из всех текущих броней, а восстановить состав питания уже нечем.
 *
 * Правило: сколько броней пользуется услугой, видно в списке (`usedInBookings`),
 * а удаление используемой требует подтверждения (`force`). Отказ не должен
 * оставлять следов — ни удалённой услуги, ни вычищенных пресетов питания.
 */

const service = (over = {}) => ({
  id: 1, code: 'breakfast', name: 'Завтрак', price: 3500, childPrice: null,
  unit: 'per_person_night', kind: 'meal', includedByDefault: false, isActive: true, order: 1,
  ...over,
})

const link = (id, serviceId, bookingId) => ({
  id, serviceId, bookingId, adults: 2, children: 0, quantity: 1,
})

const plan = (over = {}) => ({
  id: 1, code: 'bb', name: 'Только завтрак', serviceCodes: ['breakfast'], order: 1, ...over,
})

function stack({ services = [], bookingServices = [], mealPlans = [] } = {}) {
  const used = (serviceId) =>
    new Set(bookingServices.filter((bs) => bs.serviceId === serviceId).map((bs) => bs.bookingId)).size

  const { prisma, calls } = createFakePrisma(
    { service: services, bookingService: bookingServices, mealPlan: mealPlans },
    {
      // `_count` по связи `bookings` (это BookingService[]): счётчик лежит в другой
      // таблице, поэтому его считает вычислитель, а не фикстура. Имя связи берём
      // из самого запроса — тест не должен угадывать, как назвали её в select.
      virtual: {
        service: {
          _count: (rec, _rows, on) => {
            const keys = on && on.select ? Object.keys(on.select) : ['bookings']
            return Object.fromEntries(keys.map((k) => [k, used(rec.id)]))
          },
        },
      },
    },
  )

  const errorHandler = loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  })
  const ctrl = loadCjs('src/controllers/serviceController.js', {
    stubs: { '../utils/prisma': { prisma }, '../middleware/errorHandler': errorHandler },
  })
  return { ctrl, prisma, calls }
}

const run = (handler, { params = {}, query = {}, body = {} } = {}) => {
  const out = { status: 200, body: null }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  const next = (err) => {
    out.status = err.status || 500
    out.body = { error: err.message }
    if (err.code) out.body.code = err.code
    if (!err.status) out.body.stack = err.stack
  }
  return Promise.resolve(handler({ params, query, body, admin: { id: 1, role: 'ADMIN' } }, res, next)).then(() => out)
}

const deleted = (calls) => calls.filter((c) => c.model === 'service' && c.op === 'delete')

const SERVICES = [
  service({ id: 1, code: 'breakfast', name: 'Завтрак' }),
  service({ id: 2, code: 'transfer', name: 'Трансфер', kind: 'extra' }),
]
// Завтрак — в двух бронях (двумя строками), трансфер не используется никем
const LINKS = [link(1, 1, 100), link(2, 1, 101)]

describe('GET /services — сколько броней пользуется услугой', () => {
  it('список сообщает usedInBookings по каждой услуге', async () => {
    const { ctrl } = stack({ services: SERVICES, bookingServices: LINKS })
    const res = await run(ctrl.list)

    expect(res.status).toBe(200)
    const byCode = Object.fromEntries(res.body.data.map((s) => [s.code, s.usedInBookings]))
    expect(byCode).toEqual({ breakfast: 2, transfer: 0 })
  })

  it('неиспользуемая услуга получает ноль, а не отсутствующее поле', async () => {
    const { ctrl } = stack({ services: [service({ id: 2, code: 'transfer' })] })
    const res = await run(ctrl.list)
    expect(res.body.data[0].usedInBookings).toBe(0)
  })

  it('фильтр по виду услуги продолжает работать', async () => {
    const { ctrl } = stack({ services: SERVICES, bookingServices: LINKS })
    const res = await run(ctrl.list, { query: { kind: 'meal' } })
    expect(res.body.data.map((s) => s.code)).toEqual(['breakfast'])
  })
})

describe('DELETE /services/:id — удаление используемой услуги', () => {
  it('без подтверждения отвечает 409 с кодом SERVICE_IN_USE', async () => {
    const { ctrl } = stack({ services: SERVICES, bookingServices: LINKS, mealPlans: [plan()] })
    const res = await run(ctrl.remove, { params: { id: '1' } })

    expect(res.status).toBe(409)
    expect(res.body.code).toBe('SERVICE_IN_USE')
  })

  it('при отказе услуга остаётся в справочнике', async () => {
    const st = stack({ services: SERVICES, bookingServices: LINKS, mealPlans: [plan()] })
    await run(st.ctrl.remove, { params: { id: '1' } })

    expect(deleted(st.calls)).toEqual([])
    expect(st.prisma.service.rows.map((s) => s.id)).toEqual([1, 2])
  })

  it('при отказе пресет питания не тронут: код завтрака из него не вычищен', async () => {
    const st = stack({ services: SERVICES, bookingServices: LINKS, mealPlans: [plan()] })
    await run(st.ctrl.remove, { params: { id: '1' } })

    expect(st.prisma.mealPlan.rows[0].serviceCodes).toEqual(['breakfast'])
  })

  it('с подтверждением force=1 услуга удаляется', async () => {
    const st = stack({ services: SERVICES, bookingServices: LINKS, mealPlans: [plan()] })
    const res = await run(st.ctrl.remove, { params: { id: '1' }, query: { force: '1' } })

    expect(res.status).toBe(200)
    expect(deleted(st.calls)).toHaveLength(1)
    expect(st.prisma.service.rows.map((s) => s.id)).toEqual([2])
  })

  it('подтверждённое удаление вычищает код услуги из пресета питания', async () => {
    const st = stack({ services: SERVICES, bookingServices: LINKS, mealPlans: [plan({ serviceCodes: ['breakfast', 'dinner'] })] })
    await run(st.ctrl.remove, { params: { id: '1' }, query: { force: '1' } })

    expect(st.prisma.mealPlan.rows[0].serviceCodes).toEqual(['dinner'])
  })
})

describe('DELETE /services/:id — обычные случаи', () => {
  it('неиспользуемая услуга удаляется без подтверждения', async () => {
    const st = stack({ services: SERVICES, bookingServices: LINKS })
    const res = await run(st.ctrl.remove, { params: { id: '2' } })

    expect(res.status).toBe(200)
    expect(deleted(st.calls)).toHaveLength(1)
    expect(st.prisma.service.rows.map((s) => s.id)).toEqual([1])
  })

  it('несуществующая услуга — 404, а не 409', async () => {
    const st = stack({ services: SERVICES })
    const res = await run(st.ctrl.remove, { params: { id: '99' } })

    expect(res.status).toBe(404)
    expect(deleted(st.calls)).toEqual([])
  })
})
