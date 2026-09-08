import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Зона отеля — края, которых не было в `hotelTz.test.js` (второй заход волны).
 *
 * Проверяются две вещи:
 *
 *  1. Зона, где перевод часов вперёд приходится РОВНО на полночь. Берлин и
 *     Нью-Йорк переводят стрелки в 02:00 и 03:00 — там «начало суток» ни в какую
 *     дыру не попадает, поэтому двухпроходное вычисление смещения их проходит.
 *     Сантьяго переводит в 24:00: суток 6 сентября 2026 года местная полночь
 *     просто не существует, 23:59:59 сменяется на 01:00:00. Что вернуть в таком
 *     случае — вопрос без единственно верного ответа, но результат обязан хотя бы
 *     принадлежать ЗАПРОШЕННОМУ дню, иначе граница периода и подпись строки
 *     отчёта разойдутся.
 *
 *  2. Пустая переменная окружения. `HOTEL_TZ=` в `.env` — не «зона не задана
 *     явно и потому UTC», а «строка пустая»: должен работать тот же запасной
 *     путь, что и при отсутствующей переменной.
 */

const load = () => loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } })

// Чили: летнее время начинается в первую субботу сентября в 24:00 по местному.
// 2026: с 5 на 6 сентября, −04 → −03, полуночи 6 сентября не существует.
const SANTIAGO = 'America/Santiago'

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

describe('localDayStartUTC — сутки, у которых нет полуночи', () => {
  it('обычные сутки той же зоны считаются верно: 5 сентября начинается в 04:00 UTC', () => {
    const { localDayStartUTC } = load()
    expect(localDayStartUTC('2026-09-05', SANTIAGO).toISOString()).toBe('2026-09-05T04:00:00.000Z')
  })

  it('сутки после перевода считаются верно: 7 сентября начинается в 03:00 UTC', () => {
    const { localDayStartUTC } = load()
    expect(localDayStartUTC('2026-09-07', SANTIAGO).toISOString()).toBe('2026-09-07T03:00:00.000Z')
  })

  it('начало суток должно принадлежать этим же суткам, а не предыдущим', () => {
    const { localDayStartUTC, localDateISO } = load()
    const start = localDayStartUTC('2026-09-06', SANTIAGO)
    expect(localDateISO(start, SANTIAGO)).toBe('2026-09-06')
  })

  it('первый существующий момент 6 сентября — 04:00 UTC (01:00 по местному)', () => {
    const { localDayStartUTC } = load()
    expect(localDayStartUTC('2026-09-06', SANTIAGO).toISOString()).toBe('2026-09-06T04:00:00.000Z')
  })

  it('час 5 сентября 23:00–24:00 не должен попадать в диапазон 6 сентября', () => {
    const { localDayRangeUTC } = load()
    const range = localDayRangeUTC('2026-09-06', '2026-09-06', SANTIAGO)
    const lateOnFifth = new Date('2026-09-06T03:30:00.000Z')   // 5 сентября 23:30 по местному
    expect(lateOnFifth >= range.gte).toBe(false)
  })

  it('верхняя граница тех же суток посчитана по новому смещению — она уже верна', () => {
    const { localDayRangeUTC } = load()
    const range = localDayRangeUTC('2026-09-06', '2026-09-06', SANTIAGO)
    expect(range.lt.toISOString()).toBe('2026-09-07T03:00:00.000Z')
  })

  it('обратный перевод (сутки с двумя полуночами) края не ломает', () => {
    // 2027: зимнее время в Чили с 4 апреля, 24:00 → 23:00. Полночь 4 апреля
    // существует и наступает один раз — по летнему смещению −03.
    const { localDayStartUTC, localDateISO } = load()
    const start = localDayStartUTC('2027-04-04', SANTIAGO)
    expect(localDateISO(start, SANTIAGO)).toBe('2027-04-04')
  })
})

describe('выбор зоны при пустых переменных окружения', () => {
  it('пустой HOTEL_TZ уступает BACKUP_TZ, а не превращается в UTC', () => {
    process.env.HOTEL_TZ = ''
    process.env.BACKUP_TZ = 'America/New_York'
    const { hotelTz } = load()
    expect(hotelTz()).toBe('America/New_York')
  })

  it('обе переменные пустые — зона по умолчанию, а не UTC', () => {
    process.env.HOTEL_TZ = ''
    process.env.BACKUP_TZ = ''
    const { hotelTz, DEFAULT_TZ } = load()
    expect(hotelTz()).toBe(DEFAULT_TZ)
    expect(hotelTz()).toBe('Asia/Almaty')
  })

  it('пробел вместо зоны — это мусор: запасной вариант UTC, а не падение', () => {
    process.env.HOTEL_TZ = ' '
    delete process.env.BACKUP_TZ
    const { hotelTz } = load()
    expect(hotelTz()).toBe('UTC')
  })

  it('зона читается на КАЖДЫЙ вызов: правка окружения видна без перезагрузки модуля', () => {
    const mod = load()
    process.env.HOTEL_TZ = 'Europe/Berlin'
    expect(mod.hotelTz()).toBe('Europe/Berlin')
    process.env.HOTEL_TZ = 'Asia/Almaty'
    expect(mod.hotelTz()).toBe('Asia/Almaty')
  })
})
