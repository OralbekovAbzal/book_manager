import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Границы периода в датасете «Брони» и поведение движка на испорченном
 * определении отчёта (волна «Отчёты и клиент», второй заход).
 *
 * Здесь сторожатся две разные вещи, которые легко перепутать:
 *
 *  1. `checkIn`/`checkOut` — поля `@db.Date`: их границы остаются UTC-полуночами,
 *     потому что так они и лежат в базе. Движок отдаёт период полуинтервалом
 *     [from, to), где `to` — день ПОСЛЕ последнего.
 *  2. `createdAt` — настоящий момент времени: его границы обязаны считаться по
 *     МЕСТНЫМ суткам отеля. Отступ на сутки внутри `periodWhere('created')` —
 *     самое хрупкое место всей правки: ошибись знаком, и период либо потеряет
 *     последний день, либо прихватит лишний.
 *
 * И отдельно — что мусорная формула в определении отчёта даёт 400 «поправьте
 * отчёт», а не 500 «внутренняя ошибка сервера»: определения приходят в том числе
 * импортом чужого файла.
 */

const TZ = 'Asia/Almaty'   // UTC+5 круглый год, перевода часов нет

/** `periodWhere` датасет наружу не отдаёт — достаём её через append. */
function loadPeriodWhere() {
  const mod = loadCjs('src/reports/datasets/bookings.js', {
    stubs: { '../../utils/prisma': { prisma: {} } },
    append: 'module.exports.periodWhere = periodWhere',
  })
  if (typeof mod.periodWhere !== 'function') {
    throw new Error('periodWhere не найдена в datasets/bookings.js')
  }
  return mod.periodWhere
}

const withTz = (tz, fn) => {
  const prev = process.env.HOTEL_TZ
  process.env.HOTEL_TZ = tz
  try { return fn() } finally {
    if (prev === undefined) delete process.env.HOTEL_TZ
    else process.env.HOTEL_TZ = prev
  }
}

// Период «весь сентябрь 2026» в том виде, в каком его отдаёт движок:
// from — первое сентября, to — первое ОКТЯБРЯ (день после последнего).
const FROM = d('2026-09-01')
const TO = d('2026-10-01')

describe('periodWhere — три режима периода дают разные границы', () => {
  it('режим «заезды» берёт полуинтервал по календарному полю, без сдвига', () => {
    const where = loadPeriodWhere()('checkIn', FROM, TO)
    expect(where).toEqual({ checkIn: { gte: FROM, lt: TO } })
  })

  it('режим «выезды» — тот же полуинтервал, но по дате выезда', () => {
    const where = loadPeriodWhere()('checkOut', FROM, TO)
    expect(where).toEqual({ checkOut: { gte: FROM, lt: TO } })
  })

  it('режим по умолчанию — «бронь задевает период»: заезд строго до конца, выезд строго после начала', () => {
    const where = loadPeriodWhere()(undefined, FROM, TO)
    // Выезд ровно в первый день периода пересечением не считается: гость уехал
    // утром, ночей внутри периода у него нет.
    expect(where).toEqual({ checkIn: { lt: TO }, checkOut: { gt: FROM } })
  })
})

describe('periodWhere («создана») — границы по местным суткам отеля', () => {
  it('нижняя граница — местная полночь первого дня, а не UTC-полночь', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', FROM, TO))
    // 1 сентября 00:00 в Алматы = 31 августа 19:00 UTC
    expect(where.createdAt.gte.toISOString()).toBe('2026-08-31T19:00:00.000Z')
  })

  it('последний день периода входит целиком: верхняя граница — местная полночь 1 октября', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', FROM, TO))
    // Не 30 сентября 19:00 (тогда последние сутки потерялись бы) и не 1 октября
    // 19:00 (тогда период прихватил бы лишний день).
    expect(where.createdAt.lt.toISOString()).toBe('2026-09-30T19:00:00.000Z')
  })

  it('бронь, заведённая 30 сентября в 23:30 по местному, ещё внутри периода', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', FROM, TO))
    const created = new Date('2026-09-30T18:30:00.000Z')   // 30.09 23:30 в Алматы
    expect(created >= where.createdAt.gte && created < where.createdAt.lt).toBe(true)
  })

  it('бронь, заведённая 1 октября в 00:20 по местному, уже за периодом', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', FROM, TO))
    const created = new Date('2026-09-30T19:20:00.000Z')   // 01.10 00:20 в Алматы
    expect(created < where.createdAt.lt).toBe(false)
  })

  it('бронь, заведённая 1 сентября в 01:20 по местному, в период попадает — ради этого правку и делали', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', FROM, TO))
    // 31.08 20:20 UTC — по календарю процесса это АВГУСТ, по местным суткам сентябрь
    const created = new Date('2026-08-31T20:20:00.000Z')
    expect(created >= where.createdAt.gte).toBe(true)
  })

  it('период в один день не схлопывается в пустой: сутки целиком', () => {
    const where = withTz(TZ, () => loadPeriodWhere()('created', d('2026-09-09'), d('2026-09-10')))
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-08T19:00:00.000Z')
    expect(where.createdAt.lt.toISOString()).toBe('2026-09-09T19:00:00.000Z')
    expect(where.createdAt.lt - where.createdAt.gte).toBe(24 * 3600 * 1000)
  })

  it('в UTC тот же период даёт UTC-полуночи — зона действительно участвует', () => {
    const where = withTz('UTC', () => loadPeriodWhere()('created', FROM, TO))
    expect(where.createdAt.gte.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(where.createdAt.lt.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })
})

// ─── Движок на испорченном определении ───────────────────────────────────────

/** Минимальный датасет: одна строка, без базы. */
const stubDataset = {
  id: 'stub',
  fields: { amount: { label: 'Сумма', type: 'money' }, name: { label: 'Имя', type: 'text', groupable: true } },
  metrics: {},
  async load() { return [{ amount: 100, name: 'Иванов' }] },
}

const engine = () => loadCjs('src/reports/engine.js', {
  stubs: { './datasets': { getDataset: (id) => (id === 'stub' ? stubDataset : null) } },
})

const base = (over = {}) => ({
  id: 'test', title: 'Проверка', dataset: 'stub',
  columns: [{ key: 'name', field: 'name' }],
  ...over,
})

const runIt = async (def) => {
  try {
    await engine().runReport(def, {}, { today: d('2026-09-09') })
    return { status: 200 }
  } catch (err) {
    return { status: err.status || 500, message: err.message }
  }
}

describe('движок отвечает 400 на испорченное определение, а не 500', () => {
  it('мусор в формуле фильтра — ошибка определения', async () => {
    const res = await runIt(base({ filters: [{ expr: 'amount >>>< ((' }] }))
    expect(res.status).toBe(400)
    expect(res.message).toMatch(/формула фильтра/i)
  })

  it('незакрытая строка в формуле фильтра — тоже 400', async () => {
    const res = await runIt(base({ filters: [{ expr: "name = 'Иванов" }] }))
    expect(res.status).toBe(400)
  })

  it('неподъёмная по длине формула фильтра — 400, а не переполнение стека', async () => {
    const res = await runIt(base({ filters: [{ expr: `1${'+1'.repeat(3000)}` }] }))
    expect(res.status).toBe(400)
    expect(res.message).toMatch(/длиннее/i)
  })

  it('слишком глубокая вложенность в формуле фильтра — 400', async () => {
    const res = await runIt(base({ filters: [{ expr: `${'('.repeat(200)}1${')'.repeat(200)}` }] }))
    expect(res.status).toBe(400)
  })

  it('мусор в формуле колонки — 400 с названием колонки', async () => {
    const res = await runIt(base({ columns: [{ key: 'x', title: 'Остаток', expr: 'amount - ' }] }))
    expect(res.status).toBe(400)
    expect(res.message).toMatch(/Остаток/)
  })

  it('неизвестное поле фильтра — 400, а не тихая пустая выборка', async () => {
    const res = await runIt(base({ filters: [{ field: 'нетТакого', op: 'eq', value: 1 }] }))
    expect(res.status).toBe(400)
  })

  it('неизвестная операция фильтра — 400', async () => {
    const res = await runIt(base({ filters: [{ field: 'amount', op: 'кактоТак', value: 1 }] }))
    expect(res.status).toBe(400)
  })

  it('исправное определение по-прежнему считается', async () => {
    const res = await runIt(base({ filters: [{ expr: 'amount > 50' }] }))
    expect(res.status).toBe(200)
  })
})

describe('предел длины формулы считается по кодовым единицам UTF-16', () => {
  const expr = () => loadCjs('src/reports/expr.js')

  it('кириллица в строке формулы — один символ на знак, предел не «съедается» вдвое', () => {
    const e = expr()
    const ok = `'${'я'.repeat(e.MAX_EXPR_LENGTH - 2)}'`
    expect(ok.length).toBe(e.MAX_EXPR_LENGTH)
    expect(() => e.parse(ok)).not.toThrow()
  })

  it('на два знака длиннее предела — отказ', () => {
    const e = expr()
    const tooLong = `'${'я'.repeat(e.MAX_EXPR_LENGTH)}'`
    expect(() => e.parse(tooLong)).toThrow(/длиннее/)
  })

  it('эмодзи занимают по две единицы: предел режет вдвое раньше, чем «символов»', () => {
    const e = expr()
    // 1000 эмодзи = 2000 единиц UTF-16 = ровно предел вместе с кавычками уже перебор
    const s = `'${'🏨'.repeat(1000)}'`
    expect([...s].length).toBe(1002)       // «символов» — чуть больше тысячи
    expect(s.length).toBe(2002)            // а единиц — вдвое
    expect(() => e.parse(s)).toThrow(/длиннее/)
  })
})
