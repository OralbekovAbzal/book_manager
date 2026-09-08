import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Местная зона отеля: календарный день, посчитанный от момента времени.
 *
 * Зачем это вообще есть. Сервер живёт в UTC (`TZ=UTC` в упаковке), а отель — в
 * UTC+5. Всё, что сделано с полуночи до пяти утра, по календарю процесса уезжает
 * на вчера: бронь, заведённая 2 сентября в 01:20 по Алматы, попадала в «дату
 * создания 1 сентября» (аудит D4-004, D6-003). Поэтому здесь проверяются не
 * «работает верно», а ровно те моменты, где день переворачивается: 19:00 UTC,
 * перевод часов вперёд и назад, полуоткрытый конец диапазона.
 *
 * Живая база не нужна: модуль чистый, из зависимостей — только логгер.
 */

const load = () => loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } })

const ALMATY = 'Asia/Almaty'   // UTC+5 круглый год, перевода часов нет
const BERLIN = 'Europe/Berlin' // +1/+2, переход в последнее воскресенье марта и октября
const NY = 'America/New_York'  // −5/−4, переход в первое воскресенье ноября

const iso = (d) => (d === null ? null : d.toISOString())

let envBackup

beforeEach(() => {
  envBackup = { HOTEL_TZ: process.env.HOTEL_TZ, BACKUP_TZ: process.env.BACKUP_TZ }
})
afterEach(() => {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('localDateISO — момент времени в местный календарный день', () => {
  it('20:20 UTC первого сентября — это уже второе сентября в Алматы', () => {
    const { localDateISO } = load()
    expect(localDateISO(new Date('2026-09-01T20:20:00Z'), ALMATY)).toBe('2026-09-02')
  })

  it('та же минута по UTC остаётся первым сентября', () => {
    const { localDateISO } = load()
    expect(localDateISO(new Date('2026-09-01T20:20:00Z'), 'UTC')).toBe('2026-09-01')
  })

  it('19:00 UTC — первая минута новых суток Алматы, миллисекундой раньше — ещё прошлые', () => {
    const { localDateISO } = load()
    expect(localDateISO(new Date('2026-09-01T19:00:00.000Z'), ALMATY)).toBe('2026-09-02')
    expect(localDateISO(new Date('2026-09-01T18:59:59.999Z'), ALMATY)).toBe('2026-09-01')
  })

  it('принимает и ISO-строку, и Date — результат один', () => {
    const { localDateISO } = load()
    expect(localDateISO('2026-09-01T20:20:00Z', ALMATY))
      .toBe(localDateISO(new Date('2026-09-01T20:20:00Z'), ALMATY))
  })

  it('мусор, пустая строка и null дают null, а не «сегодня»', () => {
    const { localDateISO } = load()
    expect(localDateISO('не дата', ALMATY)).toBe(null)
    expect(localDateISO('', ALMATY)).toBe(null)
    expect(localDateISO(null, ALMATY)).toBe(null)
    expect(localDateISO(new Date('нет такой даты'), ALMATY)).toBe(null)
  })
})

describe('localDayStartUTC — полночь местных суток как момент UTC', () => {
  it('полночь 2 сентября в Алматы — это 19:00 UTC первого сентября', () => {
    const { localDayStartUTC } = load()
    expect(iso(localDayStartUTC('2026-09-02', ALMATY))).toBe('2026-09-01T19:00:00.000Z')
  })

  it('в день перевода часов вперёд сутки начинаются ещё по зимнему времени', () => {
    // Берлин, 29 марта 2026: стрелки идут вперёд в 02:00, но полночь наступила
    // при +1 — начало суток 28.03 23:00 UTC, а не 22:00.
    const { localDayStartUTC } = load()
    expect(iso(localDayStartUTC('2026-03-29', BERLIN))).toBe('2026-03-28T23:00:00.000Z')
  })

  it('в день перевода часов назад сутки начинаются ещё по летнему времени', () => {
    // Берлин, 25 октября 2026: стрелки назад в 03:00, полночь была при +2.
    const { localDayStartUTC } = load()
    expect(iso(localDayStartUTC('2026-10-25', BERLIN))).toBe('2026-10-24T22:00:00.000Z')
  })

  it('Нью-Йорк 1 ноября: сутки начинаются в 04:00 UTC, по летнему смещению', () => {
    const { localDayStartUTC } = load()
    expect(iso(localDayStartUTC('2026-11-01', NY))).toBe('2026-11-01T04:00:00.000Z')
  })

  it('несуществующая дата и мусор дают null', () => {
    const { localDayStartUTC } = load()
    expect(localDayStartUTC('2026-13-01', ALMATY)).toBe(null)
    expect(localDayStartUTC('01.09.2026', ALMATY)).toBe(null)
    expect(localDayStartUTC('', ALMATY)).toBe(null)
    expect(localDayStartUTC(null, ALMATY)).toBe(null)
  })

  it('30 февраля не «съезжает» на март, а отвергается', () => {
    // Дата приходит из параметров отчёта, то есть от клиента: молчаливый сдвиг
    // дал бы отчёт за соседний месяц без единого признака ошибки.
    const { localDayStartUTC } = load()
    expect(localDayStartUTC('2026-02-30', ALMATY)).toBe(null)
    expect(localDayStartUTC('2026-04-31', ALMATY)).toBe(null)
  })

  it('29 февраля високосного года — обычный день', () => {
    const { localDayStartUTC } = load()
    expect(iso(localDayStartUTC('2028-02-29', ALMATY))).toBe('2028-02-28T19:00:00.000Z')
  })
})

describe('localDayRangeUTC — диапазон для where Prisma', () => {
  it('один день — полуоткрытый отрезок [полночь, полночь следующего дня)', () => {
    const { localDayRangeUTC } = load()
    const r = localDayRangeUTC('2026-09-02', '2026-09-02', ALMATY)
    expect(iso(r.gte)).toBe('2026-09-01T19:00:00.000Z')
    expect(iso(r.lt)).toBe('2026-09-02T19:00:00.000Z')
  })

  it('верхняя граница — строгий lt: момент 19:00 UTC принадлежит уже следующему дню', () => {
    const { localDayRangeUTC } = load()
    const r = localDayRangeUTC('2026-09-02', '2026-09-02', ALMATY)
    const edge = new Date('2026-09-02T19:00:00.000Z')
    expect(edge.getTime() >= r.gte.getTime()).toBe(true)
    expect(edge.getTime() < r.lt.getTime()).toBe(false)
  })

  it('открытый конец не даёт ключа lt, открытое начало — ключа gte', () => {
    const { localDayRangeUTC } = load()
    const noEnd = localDayRangeUTC('2026-09-02', null, ALMATY)
    expect(iso(noEnd.gte)).toBe('2026-09-01T19:00:00.000Z')
    expect('lt' in noEnd).toBe(false)

    const noStart = localDayRangeUTC(null, '2026-09-02', ALMATY)
    expect(iso(noStart.lt)).toBe('2026-09-02T19:00:00.000Z')
    expect('gte' in noStart).toBe(false)

    expect(localDayRangeUTC(null, null, ALMATY)).toEqual({})
  })

  it('мусор в границе просто не даёт ключа — период молча расширяется', () => {
    // Зафиксировано как есть: невалидное значение отбрасывается, а не отвергается.
    // Для отчёта это значит «конца периода нет», то есть выборка шире просимой;
    // отвергать такое должен слой параметров отчёта, а не этот модуль.
    const { localDayRangeUTC } = load()
    const r = localDayRangeUTC('2026-09-02', 'мусор', ALMATY)
    expect(iso(r.gte)).toBe('2026-09-01T19:00:00.000Z')
    expect('lt' in r).toBe(false)
  })

  it('сутки с переводом часов вперёд длятся 23 часа, назад — 25', () => {
    const { localDayRangeUTC } = load()
    const spring = localDayRangeUTC('2026-03-29', '2026-03-29', BERLIN)
    expect((spring.lt - spring.gte) / 3600000).toBe(23)

    const autumn = localDayRangeUTC('2026-10-25', '2026-10-25', BERLIN)
    expect((autumn.lt - autumn.gte) / 3600000).toBe(25)
  })

  it('последний день года: верхняя граница перешагивает в следующий год', () => {
    const { localDayRangeUTC } = load()
    const r = localDayRangeUTC('2026-12-31', '2026-12-31', ALMATY)
    expect(iso(r.gte)).toBe('2026-12-30T19:00:00.000Z')
    expect(iso(r.lt)).toBe('2026-12-31T19:00:00.000Z')
  })

  it('месяц целиком: с первого по последний день, конец включительно', () => {
    const { localDayRangeUTC } = load()
    const r = localDayRangeUTC('2026-09-01', '2026-09-30', ALMATY)
    expect(iso(r.gte)).toBe('2026-08-31T19:00:00.000Z')
    expect(iso(r.lt)).toBe('2026-09-30T19:00:00.000Z')
  })
})

describe('todayLocalISO и выбор зоны', () => {
  it('берёт переданный момент, а не часы машины', () => {
    const { todayLocalISO } = load()
    expect(todayLocalISO(ALMATY, new Date('2026-09-01T20:20:00Z'))).toBe('2026-09-02')
    expect(todayLocalISO('UTC', new Date('2026-09-01T20:20:00Z'))).toBe('2026-09-01')
  })

  it('несуществующая зона — это UTC, а не падение сервера', () => {
    process.env.HOTEL_TZ = 'Mars/Olympus'
    const { hotelTz } = load()
    expect(hotelTz()).toBe('UTC')
  })

  it('HOTEL_TZ важнее BACKUP_TZ, без обоих — зона по умолчанию', () => {
    const { hotelTz, DEFAULT_TZ } = load()
    expect(DEFAULT_TZ).toBe('Asia/Almaty')

    process.env.HOTEL_TZ = 'Europe/Berlin'
    process.env.BACKUP_TZ = 'America/New_York'
    expect(hotelTz()).toBe('Europe/Berlin')

    delete process.env.HOTEL_TZ
    expect(hotelTz()).toBe('America/New_York')

    delete process.env.BACKUP_TZ
    expect(hotelTz()).toBe(DEFAULT_TZ)
  })

  it('зона по умолчанию подставляется и в функции, если её не передали', () => {
    process.env.HOTEL_TZ = ALMATY
    const { localDateISO, localDayStartUTC } = load()
    expect(localDateISO(new Date('2026-09-01T20:20:00Z'))).toBe('2026-09-02')
    expect(iso(localDayStartUTC('2026-09-02'))).toBe('2026-09-01T19:00:00.000Z')
  })
})
