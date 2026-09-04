import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Пересечения броней — самый дорогой класс ошибок в проекте: ошибка здесь
 * означает двойную продажу номера. Даты полуоткрытые: [checkIn, checkOut),
 * поэтому выезд ровно в день заезда следующего гостя пересечением НЕ является.
 */

// Комната 101: гость живёт 10–15 июля (выезд утром 15-го).
const BASE = [
  { id: 1, roomId: 101, guestName: 'Иванов', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CONFIRMED' },
]

function setup(rows = BASE) {
  const { prisma, calls } = createFakePrisma({ booking: rows })
  const mod = loadCjs('src/utils/overlap.js', { stubs: { './prisma': { prisma } } })
  return { ...mod, calls }
}

describe('findOverlap — границы полуоткрытого интервала', () => {
  it('выезд в день заезда следующего гостя не считается пересечением', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') })
    expect(hit).toBeNull()
  })

  it('заезд в день выезда предыдущего гостя не считается пересечением', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-07'), checkOut: d('2026-07-10') })
    expect(hit).toBeNull()
  })

  it('заход на одну ночь внутрь существующей брони — пересечение', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-14'), checkOut: d('2026-07-16') })
    expect(hit).not.toBeNull()
    expect(hit.id).toBe(1)
  })

  it('заезд ровно за день до выезда предыдущего — пересечение', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-09'), checkOut: d('2026-07-11') })
    expect(hit?.id).toBe(1)
  })

  it('полное совпадение дат — пересечение', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-10'), checkOut: d('2026-07-15') })
    expect(hit?.id).toBe(1)
  })

  it('новая бронь целиком внутри существующей — пересечение', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-11'), checkOut: d('2026-07-13') })
    expect(hit?.id).toBe(1)
  })

  it('новая бронь целиком накрывает существующую — пересечение', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-01'), checkOut: d('2026-08-01') })
    expect(hit?.id).toBe(1)
  })
})

describe('findOverlap — фильтры запроса', () => {
  it('бронь в другом номере не мешает', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 102, checkIn: d('2026-07-11'), checkOut: d('2026-07-13') })
    expect(hit).toBeNull()
  })

  it('отменённая и выехавшая брони не мешают, активная — мешает', async () => {
    const rows = [
      { id: 1, roomId: 101, guestName: 'Отменён', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CANCELLED' },
      { id: 2, roomId: 101, guestName: 'Выехал', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CHECKED_OUT' },
      { id: 3, roomId: 101, guestName: 'Неявка', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'NO_SHOW' },
    ]
    const { findOverlap } = setup(rows)
    expect(await findOverlap({ roomId: 101, checkIn: d('2026-07-11'), checkOut: d('2026-07-13') })).toBeNull()

    const withLive = setup([...rows, { id: 4, roomId: 101, guestName: 'Живёт', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CHECKED_IN' }])
    expect((await withLive.findOverlap({ roomId: 101, checkIn: d('2026-07-11'), checkOut: d('2026-07-13') }))?.id).toBe(4)
  })

  it('при редактировании бронь не считает пересечением сама себя', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-10'), checkOut: d('2026-07-16'), excludeBookingId: 1 })
    expect(hit).toBeNull()
  })

  it('excludeBookingId не прячет чужую бронь', async () => {
    const rows = [...BASE, { id: 2, roomId: 101, guestName: 'Петров', checkIn: d('2026-07-16'), checkOut: d('2026-07-20'), status: 'CONFIRMED' }]
    const { findOverlap } = setup(rows)
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-14'), checkOut: d('2026-07-18'), excludeBookingId: 1 })
    expect(hit?.id).toBe(2)
  })

  it('даты строками YYYY-MM-DD дают тот же результат, что и Date', async () => {
    const { findOverlap } = setup()
    expect(await findOverlap({ roomId: 101, checkIn: '2026-07-15', checkOut: '2026-07-18' })).toBeNull()
    expect((await findOverlap({ roomId: 101, checkIn: '2026-07-14', checkOut: '2026-07-16' }))?.id).toBe(1)
  })

  it('бронь нулевой длины проверяется непоследовательно — отсекать её обязан контроллер', async () => {
    // Ограничение БД booking_no_overlap на такую бронь не сработает вообще:
    // daterange(x, x) пуст и не пересекается ни с чем. findOverlap строже —
    // внутри чужой брони конфликт находит, а на её границе нет. Единственная
    // настоящая защита — проверка checkOut > checkIn в bookingController и роутах.
    const { findOverlap } = setup()
    expect(await findOverlap({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-12') })).not.toBeNull()
    expect(await findOverlap({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-15') })).toBeNull()
  })

  it('возвращает ровно те поля, на которые рассчитывает обработчик 409', async () => {
    const { findOverlap } = setup()
    const hit = await findOverlap({ roomId: 101, checkIn: d('2026-07-11'), checkOut: d('2026-07-13') })
    expect(Object.keys(hit).sort()).toEqual(['checkIn', 'checkOut', 'guestName', 'id', 'status'])
  })
})

describe('findOverlapsBulk', () => {
  it('возвращает конфликт по каждому занятому номеру, свободные в карту не попадают', async () => {
    const rows = [
      { id: 1, roomId: 101, guestName: 'Иванов', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CONFIRMED' },
      { id: 2, roomId: 102, guestName: 'Петров', checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), status: 'CHECKED_IN' },
      { id: 3, roomId: 103, guestName: 'Сидоров', checkIn: d('2026-07-15'), checkOut: d('2026-07-20'), status: 'CONFIRMED' },
    ]
    const { findOverlapsBulk } = setup(rows)
    const map = await findOverlapsBulk({ roomIds: [101, 102, 103], checkIn: d('2026-07-11'), checkOut: d('2026-07-15') })

    expect([...map.keys()].sort()).toEqual([101, 102])
    expect(map.get(101).guestName).toBe('Иванов')
    expect(map.has(103)).toBe(false)
  })

  it('на один номер с несколькими конфликтами в карте остаётся один — последний', async () => {
    const rows = [
      { id: 1, roomId: 101, guestName: 'Первый', checkIn: d('2026-07-10'), checkOut: d('2026-07-12'), status: 'CONFIRMED' },
      { id: 2, roomId: 101, guestName: 'Второй', checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), status: 'CONFIRMED' },
    ]
    const { findOverlapsBulk } = setup(rows)
    const map = await findOverlapsBulk({ roomIds: [101], checkIn: d('2026-07-10'), checkOut: d('2026-07-14') })
    expect(map.size).toBe(1)
    expect(map.get(101).guestName).toBe('Второй')
  })
})
