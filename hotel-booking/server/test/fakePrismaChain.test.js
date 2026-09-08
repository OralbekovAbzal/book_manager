import { describe, it, expect } from 'vitest'
import { createFakePrisma, d } from './helpers/fakePrisma.js'
import { booking, room } from './helpers/bookingStack.js'

/**
 * Самоссылка «счёт цепочки» в помощнике `fakePrisma` (волна 5b, шаг 1).
 *
 * Переезд гостя перестаёт быть «второй бронью с половиной денег»: продолжение
 * ссылается на голову (`accountBookingId`), а деньги лежат на голове. Значит
 * фейковая база обязана уметь то, чего у неё раньше не было — связь модели
 * САМОЙ С СОБОЙ: `account` (голова) и `continuations` (продолжения).
 *
 * Почему это вычисляется, а не лежит в фикстуре: положив в строку брони готовый
 * объект головы, мы завели бы вторую правду об одной цепочке — после `move()`
 * фикстура рассказывала бы одно, а `accountBookingId` другое, и тест проверял бы
 * заглушку вместо запроса. Здесь — сторож на сам помощник: если он начнёт врать,
 * врать будут все тесты цепочек, написанные поверх него.
 */

/** Контракт `BOOKING_SELECT` волны 5b в части счёта — тот, что фиксирует план. */
const CHAIN_SELECT = {
  id: true,
  accountBookingId: true,
  allotmentOverride: true,
  account: { select: { id: true, room: { select: { number: true } } } },
  continuations: {
    select: {
      id: true, roomId: true, room: { select: { number: true } },
      checkIn: true, checkOut: true, status: true,
    },
    orderBy: { id: 'asc' },
  },
}

/** Цепочка: голова №1 (номер 101) → продолжения №2 (102) и №3 (103). Плюс чужая бронь. */
function chain() {
  return createFakePrisma({
    booking: [
      booking({ id: 1, roomId: 101, status: 'CHECKED_OUT', room: room({ id: 101 }) }),
      booking({
        id: 3, roomId: 103, accountBookingId: 1, room: room({ id: 103 }),
        checkIn: d('2026-07-12'), checkOut: d('2026-07-14'),
      }),
      booking({
        id: 2, roomId: 102, accountBookingId: 1, room: room({ id: 102 }),
        checkIn: d('2026-07-11'), checkOut: d('2026-07-12'), status: 'CHECKED_OUT',
      }),
      booking({ id: 9, roomId: 104, guestName: 'Чужой', room: room({ id: 104 }) }),
    ],
  }).prisma
}

describe('fakePrisma: счёт цепочки (самоссылка booking → booking)', () => {
  it('продолжение находит голову счёта, голова о себе не ссылается', async () => {
    const prisma = chain()
    const cont = await prisma.booking.findUnique({ where: { id: 2 }, select: CHAIN_SELECT })
    const head = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })

    expect(cont.account).toEqual({ id: 1, room: { number: '101' } })
    expect(head.account).toBeNull()
  })

  it('голова видит свои продолжения и не видит чужую бронь', async () => {
    const prisma = chain()
    const head = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })

    expect(head.continuations.map((c) => c.id)).toEqual([2, 3])
    expect(head.continuations.map((c) => c.room.number)).toEqual(['102', '103'])
  })

  it('у одиночной брони цепочки нет: голова пуста, продолжений пусто', async () => {
    const prisma = chain()
    const alone = await prisma.booking.findUnique({ where: { id: 9 }, select: CHAIN_SELECT })

    expect(alone.account).toBeNull()
    expect(alone.continuations).toEqual([])
  })

  it('продолжение не считает себя головой чужой цепочки', async () => {
    const prisma = chain()
    const cont = await prisma.booking.findUnique({ where: { id: 2 }, select: CHAIN_SELECT })

    expect(cont.continuations).toEqual([])
  })

  it('вложенный select отдаёт только запрошенное — номер, а не весь номерной фонд', async () => {
    // Иначе тест цепочки сравнивал бы ответ с раздутым объектом и «проходил» бы
    // при любом составе select'а контроллера.
    const prisma = chain()
    const head = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })

    expect(head.continuations[0]).toEqual({
      id: 2, roomId: 102, room: { number: '102' },
      checkIn: d('2026-07-11'), checkOut: d('2026-07-12'), status: 'CHECKED_OUT',
    })
  })

  it('порядок продолжений задаёт orderBy запроса, а не порядок строк в фикстуре', async () => {
    // В фикстуре №3 лежит раньше №2 — это и проверяет, что сортировка настоящая.
    const prisma = chain()
    const asc = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })
    const desc = await prisma.booking.findUnique({
      where: { id: 1 },
      select: { continuations: { select: { id: true }, orderBy: { id: 'desc' } } },
    })

    expect(asc.continuations.map((c) => c.id)).toEqual([2, 3])
    expect(desc.continuations.map((c) => c.id)).toEqual([3, 2])
  })

  it('созданное продолжение сразу попадает в цепочку головы', async () => {
    // Переезд создаёт продолжение внутри транзакции и тут же перечитывает счёт:
    // если бы связь лежала в фикстуре, новая часть в цепочку не попала бы.
    const prisma = chain()
    await prisma.booking.create({ data: booking({ id: 4, roomId: 105, accountBookingId: 1, room: room({ id: 105 }) }) })
    const head = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })

    expect(head.continuations.map((c) => c.id)).toEqual([2, 3, 4])
  })

  it('отвязанное продолжение уходит из цепочки', async () => {
    const prisma = chain()
    await prisma.booking.update({ where: { id: 3 }, data: { accountBookingId: null } })
    const head = await prisma.booking.findUnique({ where: { id: 1 }, select: CHAIN_SELECT })

    expect(head.continuations.map((c) => c.id)).toEqual([2])
  })

  it('include цепочки работает так же, как select', async () => {
    const prisma = chain()
    const head = await prisma.booking.findFirst({ where: { id: 1 }, include: { continuations: true } })

    // Без `orderBy` порядок не обещан (у настоящей Prisma — как отдаст база),
    // поэтому сравниваем состав, а не последовательность.
    expect(head.continuations.map((c) => c.id).sort()).toEqual([2, 3])
    expect(head.guestName).toBe('Иванов')
  })

  it('фильтр «только головы» отсекает продолжения, а не всё подряд', async () => {
    // Так реестр броней и отчёты будут исключать продолжения из счёта и среднего чека.
    const prisma = chain()
    const heads = await prisma.booking.findMany({ where: { accountBookingId: null }, select: { id: true } })
    const conts = await prisma.booking.findMany({ where: { accountBookingId: { not: null } }, select: { id: true } })

    expect(heads.map((b) => b.id).sort()).toEqual([1, 9])
    expect(conts.map((b) => b.id).sort()).toEqual([2, 3])
  })

  it('фикстура без accountBookingId падает с внятным текстом, а не отдаёт null молча', async () => {
    // Смысл помощника: забытое поле — исключение, а не тихо пустая цепочка.
    const { prisma } = createFakePrisma({ booking: [{ id: 1, guestName: 'Без поля' }] })

    await expect(prisma.booking.findUnique({ where: { id: 1 }, select: { account: true } }))
      .rejects.toThrow(/accountBookingId/)
  })

  it('связь, положенная в фикстуру руками, важнее вычислителя', async () => {
    // Запасной выход для тестов, которым цепочка не нужна, но связь спрашивают.
    const { prisma } = createFakePrisma({
      booking: [{ id: 2, accountBookingId: 1, account: { id: 1, room: { number: 'из фикстуры' } } }],
    })
    const row = await prisma.booking.findUnique({ where: { id: 2 }, select: { account: true } })

    expect(row.account.room.number).toBe('из фикстуры')
  })
})
