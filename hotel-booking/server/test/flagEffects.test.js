import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Эффекты меток: буфер (turnaround) между бронями. Буфер делает двойную работу —
 * запрещает бронь день-в-день и не даёт оптимизатору считать зазор «окном».
 *
 * Словарь для тестов повторяет живой:
 *   lateOut     «выезд после 17:00» — зазор нужен всегда;
 *   lateOut17   «выезд до 17:00»    — зазор снимается, если следующий гость заезжает поздно;
 *   lateIn      «заезд после 17:00» — сама по себе буфера не даёт, служит исключением;
 *   earlyIn     «ранний заезд»      — зазор ДО брони;
 *   deepClean   «генеральная уборка» — зазор 2 дня, исключений нет.
 */
const EFFECTS = {
  lateOut: { bufferAfter: 1 },
  lateOut17: { bufferAfter: 1, bufferAfterExceptFlag: 'lateIn' },
  lateIn: {},
  earlyIn: { bufferBefore: 1 },
  deepClean: { bufferAfter: 2 },
  pinned: { pin: true },
}

function load(data = {}) {
  const { prisma, calls } = createFakePrisma(data)
  const mod = loadCjs('src/utils/flagEffects.js', {
    stubs: { './prisma': { prisma } },
    append: 'module.exports.__afterWithException = afterWithException;',
  })
  return { ...mod, calls }
}

/** Соседняя бронь в номере 101. */
function booking(over = {}) {
  return { id: 1, roomId: 101, guestName: 'Иванов', checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), status: 'CONFIRMED', flags: [], ...over }
}

describe('bookingBuffers — свёртка эффектов меток брони', () => {
  it('бронь без меток не требует никаких буферов', () => {
    const { bookingBuffers } = load()
    expect(bookingBuffers([], EFFECTS)).toEqual({ after: 0, before: 0, pin: false, afterRules: [] })
  })

  it('неизвестный код метки просто игнорируется, а не роняет расчёт', () => {
    const { bookingBuffers } = load()
    expect(bookingBuffers(['метки-такой-нет'], EFFECTS).after).toBe(0)
  })

  it('из нескольких меток берётся САМЫЙ ДЛИННЫЙ буфер, а не последний', () => {
    const { bookingBuffers } = load()
    expect(bookingBuffers(['deepClean', 'lateOut'], EFFECTS).after).toBe(2)
    expect(bookingBuffers(['lateOut', 'deepClean'], EFFECTS).after).toBe(2)
  })

  it('pin поднимается, если он есть хотя бы у одной метки', () => {
    const { bookingBuffers } = load()
    expect(bookingBuffers(['lateOut', 'pinned'], EFFECTS).pin).toBe(true)
    expect(bookingBuffers(['lateOut'], EFFECTS).pin).toBe(false)
  })

  it('flags === undefined трактуется как «меток нет»', () => {
    const { bookingBuffers } = load()
    expect(bookingBuffers(undefined, EFFECTS).after).toBe(0)
  })
})

describe('afterWithException — снятие буфера меткой-исключением', () => {
  it('исключение у следующей брони снимает буфер', () => {
    const { bookingBuffers, __afterWithException } = load()
    const buf = bookingBuffers(['lateOut17'], EFFECTS)
    expect(__afterWithException(buf, ['lateIn'])).toBe(0)
  })

  it('без метки-исключения у следующей брони буфер остаётся', () => {
    const { bookingBuffers, __afterWithException } = load()
    const buf = bookingBuffers(['lateOut17'], EFFECTS)
    expect(__afterWithException(buf, [])).toBe(1)
  })

  it('у метки без исключения буфер не снимается ничем', () => {
    const { bookingBuffers, __afterWithException } = load()
    const buf = bookingBuffers(['lateOut'], EFFECTS)
    expect(__afterWithException(buf, ['lateIn'])).toBe(1)
  })

  // Была ошибка (починена 2026-09-04): exceptAfterFlag собирался со ВСЕХ меток брони
  // и снимал ОБЩИЙ максимум буфера, хотя исключение принадлежит только своей метке.
  // Двухдневный зазор генеральной уборки обнулялся меткой «заезд после 17:00»,
  // к уборке отношения не имеющей. Теперь у каждой метки своё правило (afterRules).
  it('исключение одной метки не должно снимать буфер ДРУГОЙ метки', () => {
    const { bookingBuffers, __afterWithException } = load()
    const buf = bookingBuffers(['deepClean', 'lateOut17'], EFFECTS)
    expect(__afterWithException(buf, ['lateIn'])).toBe(2)
  })

  it('у каждой метки своё исключение — снимается только её собственный буфер', () => {
    const { bookingBuffers, __afterWithException } = load()
    const EX = {
      long:  { bufferAfter: 2, bufferAfterExceptFlag: 'снимаетДлинный' },
      short: { bufferAfter: 1, bufferAfterExceptFlag: 'снимаетКороткий' },
    }
    const buf = bookingBuffers(['long', 'short'], EX)
    expect(__afterWithException(buf, ['снимаетДлинный'])).toBe(1)
    expect(__afterWithException(buf, ['снимаетКороткий'])).toBe(2)
    expect(__afterWithException(buf, ['снимаетДлинный', 'снимаетКороткий'])).toBe(0)
  })

  it('исключение у метки без своего буфера ничего не снимает', () => {
    const { bookingBuffers, __afterWithException } = load()
    const EX = { clean: { bufferAfter: 2 }, weird: { bufferAfterExceptFlag: 'lateIn' } }
    const buf = bookingBuffers(['clean', 'weird'], EX)
    expect(__afterWithException(buf, ['lateIn'])).toBe(2)
  })
})

describe('hasAnyBuffer', () => {
  it('пустой словарь эффектов — буферов нет', () => {
    const { hasAnyBuffer } = load()
    expect(hasAnyBuffer({})).toBe(false)
  })

  it('нулевые буферы и один только pin за буфер не считаются', () => {
    const { hasAnyBuffer } = load()
    expect(hasAnyBuffer({ a: { bufferAfter: 0, bufferBefore: 0 }, b: { pin: true } })).toBe(false)
  })

  it('достаточно одного bufferBefore, чтобы проверка включилась', () => {
    const { hasAnyBuffer } = load()
    expect(hasAnyBuffer({ a: { pin: true }, b: { bufferBefore: 1 } })).toBe(true)
  })
})

describe('getFlagEffectsMap', () => {
  it('строит карту code → effects, метки без эффектов в неё не попадают', async () => {
    const { getFlagEffectsMap } = load({
      bookingFlag: [
        { id: 1, code: 'lateOut', effects: { bufferAfter: 1 } },
        { id: 2, code: 'vip', effects: null },
      ],
    })
    const map = await getFlagEffectsMap()
    expect(map).toEqual({ lateOut: { bufferAfter: 1 } })
  })

  it('карта кэшируется: второй вызов в базу не идёт', async () => {
    const { getFlagEffectsMap, calls } = load({ bookingFlag: [{ id: 1, code: 'lateOut', effects: { bufferAfter: 1 } }] })
    await getFlagEffectsMap()
    await getFlagEffectsMap()
    expect(calls.filter((c) => c.model === 'bookingFlag')).toHaveLength(1)
  })

  it('invalidateFlagCache заставляет перечитать метки из базы', async () => {
    const { getFlagEffectsMap, invalidateFlagCache, calls } = load({ bookingFlag: [{ id: 1, code: 'lateOut', effects: { bufferAfter: 1 } }] })
    await getFlagEffectsMap()
    invalidateFlagCache()
    await getFlagEffectsMap()
    expect(calls.filter((c) => c.model === 'bookingFlag')).toHaveLength(2)
  })
})

describe('findBufferConflict', () => {
  it('если ни у одной метки нет буферов — в базу не ходим вообще', async () => {
    const { findBufferConflict, calls } = load({ booking: [booking()] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') }, { vip: { pin: true } })
    expect(hit).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('поздний выезд: заезд следующего гостя день-в-день — конфликт, нужен зазор 1 день', async () => {
    const { findBufferConflict } = load({ booking: [booking({ flags: ['lateOut'] })] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') }, EFFECTS)
    expect(hit).not.toBeNull()
    expect(hit.required).toBe(1)
    expect(hit.gapDays).toBe(0)
    expect(hit.booking.guestName).toBe('Иванов')
  })

  it('поздний выезд: зазор в одну ночь достаточен', async () => {
    const { findBufferConflict } = load({ booking: [booking({ flags: ['lateOut'] })] })
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-16'), checkOut: d('2026-07-18') }, EFFECTS)).toBeNull()
  })

  it('генеральная уборка на 2 дня: одной ночи зазора мало', async () => {
    const { findBufferConflict } = load({ booking: [booking({ flags: ['deepClean'] })] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-16'), checkOut: d('2026-07-18') }, EFFECTS)
    expect(hit?.required).toBe(2)
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-17'), checkOut: d('2026-07-18') }, EFFECTS)).toBeNull()
  })

  it('буфер «после» принадлежит той брони, что раньше: поздний выезд у ЗАЕЗЖАЮЩЕГО зазора перед ним не требует', async () => {
    const { findBufferConflict } = load({ booking: [booking()] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18'), flags: ['lateOut'] }, EFFECTS)
    expect(hit).toBeNull()
  })

  it('поздний выезд у НОВОЙ брони требует зазор перед следующей соседкой', async () => {
    const { findBufferConflict } = load({ booking: [booking({ checkIn: d('2026-07-20'), checkOut: d('2026-07-25') })] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-20'), flags: ['lateOut'] }, EFFECTS)
    expect(hit?.required).toBe(1)
    expect(hit?.gapDays).toBe(0)
  })

  it('ранний заезд требует зазора после предыдущего гостя', async () => {
    const { findBufferConflict } = load({ booking: [booking()] })
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18'), flags: ['earlyIn'] }, EFFECTS)
    expect(hit?.required).toBe(1)
  })

  it('метка-исключение у заезжающего гостя снимает буфер выезда до 17:00', async () => {
    const { findBufferConflict } = load({ booking: [booking({ flags: ['lateOut17'] })] })
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18'), flags: ['lateIn'] }, EFFECTS)).toBeNull()
    // без метки-исключения тот же случай — конфликт
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18'), flags: [] }, EFFECTS)).not.toBeNull()
  })

  it('прямое пересечение буферным конфликтом не считается — его ловит findOverlap', async () => {
    const { findBufferConflict } = load({ booking: [booking({ flags: ['lateOut'] })] })
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-18') }, EFFECTS)).toBeNull()
  })

  it('при редактировании бронь не конфликтует с буфером самой себя', async () => {
    const { findBufferConflict } = load({ booking: [booking({ id: 42, flags: ['lateOut'] })] })
    const hit = await findBufferConflict(
      { roomId: 101, checkIn: d('2026-07-10'), checkOut: d('2026-07-15'), flags: ['lateOut'], excludeBookingId: 42 },
      EFFECTS,
    )
    expect(hit).toBeNull()
  })

  it('соседи дальше самого длинного буфера из базы не читаются', async () => {
    const { findBufferConflict, calls } = load({ booking: [booking()] })
    // Самый длинный буфер словаря — 2 дня (deepClean), значит окно поиска
    // соседей — [checkIn − 2 дн., checkOut + 2 дн.]. Соседка 10–15 июля в него
    // не попадает: запрос её не вернёт, и читать всю историю номера не нужно.
    const hit = await findBufferConflict({ roomId: 101, checkIn: d('2026-08-01'), checkOut: d('2026-08-05') }, EFFECTS)
    expect(hit).toBeNull()
    const { where } = calls[0].args
    expect(where.checkOut).toEqual({ gt: d('2026-07-30') })
    expect(where.checkIn).toEqual({ lt: d('2026-08-07') })
  })

  it('соседка в другом номере и отменённая бронь буфера не требуют', async () => {
    const { findBufferConflict } = load({
      booking: [
        booking({ id: 1, roomId: 102, flags: ['lateOut'] }),
        booking({ id: 2, roomId: 101, flags: ['lateOut'], status: 'CANCELLED' }),
      ],
    })
    expect(await findBufferConflict({ roomId: 101, checkIn: d('2026-07-15'), checkOut: d('2026-07-18') }, EFFECTS)).toBeNull()
  })
})
