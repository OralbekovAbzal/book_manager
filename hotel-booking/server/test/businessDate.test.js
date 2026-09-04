import { describe, it, expect, afterEach, vi } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Рабочая дата = дата последней смены из БД. Она НЕ берётся с устройства и
 * меняется только кнопкой «Следующий день». Даты `@db.Date` лежат как
 * UTC-полночь, поэтому главное, что тут проверяется — что день никуда не съезжает.
 */

function setup(shifts = []) {
  const { prisma, calls } = createFakePrisma({ shift: shifts })
  const mod = loadCjs('src/utils/businessDate.js', { stubs: { './prisma': { prisma } } })
  return { ...mod, prisma, calls }
}

afterEach(() => { vi.useRealTimers() })

describe('getCurrentBusinessDate', () => {
  it('берёт дату последней смены, а не дату устройства', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T09:00:00Z'))

    const { getCurrentBusinessDate } = setup([
      { id: 1, date: d('2026-06-30'), createdById: 1 },
    ])
    const businessDate = await getCurrentBusinessDate()
    expect(businessDate.toISOString()).toBe('2026-06-30T00:00:00.000Z')
  })

  it('текущая смена — самая поздняя по дате, а не последняя добавленная строка', async () => {
    const { getCurrentShift } = setup([
      { id: 1, date: d('2026-07-01'), createdById: 1 },
      { id: 2, date: d('2026-07-03'), createdById: 1 },
      { id: 3, date: d('2026-07-02'), createdById: 1 },
    ])
    const shift = await getCurrentShift()
    expect(shift.id).toBe(2)
  })

  it('без единой смены откатывается на календарный день (разовый посев)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T09:00:00Z'))

    const { getCurrentBusinessDate } = setup([])
    const businessDate = await getCurrentBusinessDate()
    expect(businessDate.toISOString()).toBe('2026-09-04T00:00:00.000Z')
  })

  it('рабочая дата всегда UTC-полночь — сравнение с checkIn брони не съезжает на день', async () => {
    const { getCurrentBusinessDate } = setup([{ id: 1, date: d('2026-07-15'), createdById: 1 }])
    const businessDate = await getCurrentBusinessDate()

    expect(businessDate.getUTCHours()).toBe(0)
    expect(businessDate.getUTCMinutes()).toBe(0)
    expect(businessDate.getUTCSeconds()).toBe(0)
    expect(businessDate.getUTCMilliseconds()).toBe(0)
    // Ровно та же полночь, что у checkIn, разобранного из 'YYYY-MM-DD'
    expect(businessDate.getTime()).toBe(new Date('2026-07-15').getTime())
    // и «бронь на сегодня» не считается прошедшей
    expect(new Date('2026-07-15') < businessDate).toBe(false)
  })

  it('возвращает копию, а не саму запись смены — правка результата не портит объект из БД', async () => {
    const { getCurrentBusinessDate, getCurrentShift } = setup([{ id: 1, date: d('2026-07-15'), createdById: 1 }])
    const businessDate = await getCurrentBusinessDate()
    businessDate.setUTCDate(businessDate.getUTCDate() + 5)

    const shift = await getCurrentShift()
    expect(shift.date.toISOString()).toBe('2026-07-15T00:00:00.000Z')
  })
})

describe('todayUTC', () => {
  it('срезает время до полуночи', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T17:45:12.345Z'))
    const { todayUTC } = setup()
    expect(todayUTC().toISOString()).toBe('2026-09-04T00:00:00.000Z')
  })

  it('день считается по UTC: в 02:30 по Алматы посев даст ВЧЕРАШНЮЮ дату', () => {
    // 2026-09-05 02:30 в Asia/Almaty (UTC+5) — это ещё 2026-09-04 по UTC.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T21:30:00Z'))
    const { todayUTC } = setup()
    expect(todayUTC().toISOString()).toBe('2026-09-04T00:00:00.000Z')
  })
})

describe('ensureCurrentShift', () => {
  it('создаёт первую смену с сегодняшней UTC-датой, если смен ещё нет', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-04T09:00:00Z'))

    const { ensureCurrentShift, calls } = setup([])
    const shift = await ensureCurrentShift(7)

    expect(shift.date.toISOString()).toBe('2026-09-04T00:00:00.000Z')
    expect(shift.createdById).toBe(7)
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(1)
  })

  it('не создаёт новую смену, когда смена уже есть', async () => {
    const { ensureCurrentShift, calls } = setup([{ id: 1, date: d('2026-06-30'), createdById: 1 }])
    const shift = await ensureCurrentShift(7)

    expect(shift.id).toBe(1)
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(0)
  })
})
