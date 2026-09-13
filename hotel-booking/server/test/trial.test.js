import { describe, it, expect, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Пробный период: 14 дней без ключа (решение владельца 12.09.2026).
 *
 * Цена ошибки в обе стороны разная, и стережём обе:
 *  - ложное закрытие (срок не записан, база лежит, ключ действует) остановит
 *    работающий отель — этого не должно быть никогда;
 *  - незакрытие (битый ключ «продлевает» срок, переустановка обнуляет дату)
 *    превращает 14 дней в вечность — тогда механизм бессмыслен.
 */

const hotelTz = loadCjs('src/utils/hotelTz.js', { stubs: { './logger': silentLogger } })

function loadTrial(prisma = createFakePrisma({ hotelSettings: [] }).prisma) {
  return loadCjs('src/utils/trial.js', {
    stubs: { './prisma': { prisma }, './hotelTz': hotelTz, './logger': silentLogger },
  })
}

const T0 = new Date('2026-09-12T10:00:00.000Z')
const day = (n) => new Date(T0.getTime() + n * 86400000)

afterEach(() => { delete process.env.ROOMLINE_TRIAL_DAYS })

describe('evaluateTrial — чистый расчёт срока', () => {
  const lib = loadTrial()

  it('в первый день: не истёк, осталось 14 дней, последний день — 13-й от старта', () => {
    const t = lib.evaluateTrial(T0, T0)
    expect(t.expired).toBe(false)
    expect(t.daysLeft).toBe(14)
    expect(t.days).toBe(14)
    // 12.09 10:00Z + 14 дней = 26.09 10:00Z; последний рабочий день по Алматы — 26.09
    expect(t.lastDay).toBe('2026-09-26')
    expect(t.endsAt).toBe('2026-09-26T10:00:00.000Z')
  })

  it('за час до конца — ещё «1 день», не «0»', () => {
    const t = lib.evaluateTrial(T0, new Date(day(14).getTime() - 3600000))
    expect(t.expired).toBe(false)
    expect(t.daysLeft).toBe(1)
  })

  it('ровно в момент конца — истёк', () => {
    const t = lib.evaluateTrial(T0, day(14))
    expect(t.expired).toBe(true)
    expect(t.daysLeft).toBe(0)
  })

  it('через месяц — истёк, последний день не «уезжает»', () => {
    const t = lib.evaluateTrial(T0, day(40))
    expect(t.expired).toBe(true)
    expect(t.lastDay).toBe('2026-09-26')
  })

  it('срок не записан — НЕ истёк: закрывать программу за незаписанную дату нельзя', () => {
    for (const v of [null, undefined, 'мусор', new Date('x')]) {
      const t = lib.evaluateTrial(v, day(100))
      expect(t.expired, String(v)).toBe(false)
      expect(t.lastDay).toBeNull()
      expect(t.daysLeft).toBeNull()
    }
  })

  it('строка ISO из базы читается так же, как Date', () => {
    expect(lib.evaluateTrial(T0.toISOString(), day(3)).daysLeft).toBe(11)
  })

  it('ROOMLINE_TRIAL_DAYS меняет длину; 0 — закрыто сразу; мусор — 14', () => {
    process.env.ROOMLINE_TRIAL_DAYS = '30'
    expect(lib.evaluateTrial(T0, day(20)).expired).toBe(false)
    expect(lib.evaluateTrial(T0, day(20)).days).toBe(30)
    process.env.ROOMLINE_TRIAL_DAYS = '0'
    expect(lib.evaluateTrial(T0, T0).expired).toBe(true)
    process.env.ROOMLINE_TRIAL_DAYS = 'много'
    expect(lib.evaluateTrial(T0, T0).days).toBe(14)
    process.env.ROOMLINE_TRIAL_DAYS = '-3'
    expect(lib.evaluateTrial(T0, T0).days).toBe(14)
  })

  it('текст отказа — с датой последнего дня в русском формате', () => {
    expect(lib.expiredMessage(lib.evaluateTrial(T0, day(20)))).toBe(
      'Пробный период закончился 26.09.2026. Чтобы продолжить работу, введите ключ лицензии. Данные не тронуты.',
    )
    expect(lib.expiredMessage({ lastDay: null })).toBe(
      'Пробный период закончился. Чтобы продолжить работу, введите ключ лицензии. Данные не тронуты.',
    )
  })
})

describe('ensureTrialStart — запись начала срока в базу', () => {
  it('строки настроек нет → null, ничего не создаём (её создаст личность или мастер)', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [] })
    const lib = loadTrial(prisma)
    expect(await lib.ensureTrialStart(prisma)).toBeNull()
    expect(calls.filter((c) => c.op === 'create' || c.op === 'upsert')).toHaveLength(0)
  })

  it('строка есть, даты нет → проставляет сейчас', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [{ id: 1, name: 'Отель', trialStartedAt: null }] })
    const lib = loadTrial(prisma)
    const before = Date.now()
    const got = await lib.ensureTrialStart(prisma)
    expect(got).toBeInstanceOf(Date)
    expect(got.getTime()).toBeGreaterThanOrEqual(before - 5)
    expect(prisma.hotelSettings.rows[0].trialStartedAt).toBe(got)
  })

  it('дата уже есть → не перезаписывается (переустановка срок не обнуляет)', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [{ id: 1, trialStartedAt: T0 }] })
    const lib = loadTrial(prisma)
    expect(await lib.ensureTrialStart(prisma)).toBe(T0)
    expect(calls.filter((c) => c.op === 'updateMany')).toHaveLength(0)
  })

  it('getTrialState читает базу один раз за минуту (кэш), после сброса — снова', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [{ id: 1, trialStartedAt: T0 }] })
    const lib = loadTrial(prisma)
    const reads = () => calls.filter((c) => c.op === 'findUnique').length
    await lib.getTrialState(prisma, day(1))
    await lib.getTrialState(prisma, day(1))
    expect(reads()).toBe(1)
    lib.resetTrialCache()
    const t = await lib.getTrialState(prisma, day(20))
    expect(reads()).toBe(2)
    expect(t.expired).toBe(true)
  })

  it('ошибка базы не глотается — решает вызывающий (гейт пропустит запрос)', async () => {
    const prisma = { hotelSettings: { findUnique: async () => { throw new Error('база недоступна') } } }
    const lib = loadTrial(prisma)
    await expect(lib.getTrialState(prisma)).rejects.toThrow('база недоступна')
  })
})

// ————————————————————————————————————————————————————————————————

describe('гейт 402 по пробному периоду', () => {
  function gate({ state = 'none', trial = { expired: false }, fail = false } = {}) {
    const licenseStub = {
      getLicenseState: async () => ({ state, payload: state === 'ok' || state === 'expired' ? { maintenanceUntil: '2026-01-31' } : null }),
      getBuildDate: () => '2026-09-12',
      formatRu: (iso) => iso.split('-').reverse().join('.'),
    }
    const trialStub = {
      getTrialState: async () => {
        if (fail) throw new Error('база недоступна')
        return { lastDay: '2026-09-26', daysLeft: 0, ...trial }
      },
      expiredMessage: (t) => `Пробный период закончился ${t.lastDay}.`,
    }
    const mod = loadCjs('src/middleware/license.js', {
      stubs: { '../utils/license': licenseStub, '../utils/trial': trialStub, '../utils/logger': silentLogger },
    })
    return mod.maintenanceGate
  }

  function call(mw, { path = '/api/bookings', method = 'GET' } = {}) {
    return new Promise((resolve) => {
      const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this },
        json(payload) { this.body = payload; resolve({ passed: false, res: this }) },
      }
      mw({ path, method }, res, () => resolve({ passed: true, res }))
    })
  }

  it('без ключа и с истёкшим сроком — 402 TRIAL_EXPIRED с датой', async () => {
    const { passed, res } = await call(gate({ trial: { expired: true } }))
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(402)
    expect(res.body.code).toBe('TRIAL_EXPIRED')
    expect(res.body.message).toBe('Пробный период закончился 2026-09-26.')
    expect(res.body.error).toBe(res.body.message)
    expect(res.body.trialEndsAt).toBe('2026-09-26')
  })

  it('без ключа, срок идёт — пропускает', async () => {
    const { passed } = await call(gate({ trial: { expired: false } }))
    expect(passed).toBe(true)
  })

  it('битый ключ срок НЕ продлевает — закрывается так же, как без ключа', async () => {
    const { passed, res } = await call(gate({ state: 'invalid', trial: { expired: true } }))
    expect(passed).toBe(false)
    expect(res.body.code).toBe('TRIAL_EXPIRED')
  })

  it('действующий ключ — пробный период не смотрится вовсе', async () => {
    let asked = false
    const mod = loadCjs('src/middleware/license.js', {
      stubs: {
        '../utils/license': {
          getLicenseState: async () => ({ state: 'ok', payload: { maintenanceUntil: '2027-09-06' } }),
          getBuildDate: () => '2026-09-12', formatRu: (s) => s,
        },
        '../utils/trial': { getTrialState: async () => { asked = true; return { expired: true } }, expiredMessage: () => '' },
        '../utils/logger': silentLogger,
      },
    })
    const { passed } = await call(mod.maintenanceGate)
    expect(passed).toBe(true)
    expect(asked).toBe(false)
  })

  it('обслуживание кончилось — по-прежнему MAINTENANCE_EXPIRED, а не пробный период', async () => {
    const { res } = await call(gate({ state: 'expired', trial: { expired: true } }))
    expect(res.body.code).toBe('MAINTENANCE_EXPIRED')
  })

  it.each(['/api/health', '/api/license', '/api/auth/login'])('%s открыт и после конца срока', async (path) => {
    const { passed } = await call(gate({ trial: { expired: true } }), { path, method: 'POST' })
    expect(passed).toBe(true)
  })

  it('база лежит при чтении срока — пропускаем, это не «кончился пробный период»', async () => {
    const { passed } = await call(gate({ fail: true }))
    expect(passed).toBe(true)
  })

  it('OPTIONS пропускается всегда', async () => {
    const { passed } = await call(gate({ trial: { expired: true } }), { method: 'OPTIONS' })
    expect(passed).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————

describe('GET /api/license отдаёт пробный период клиенту', () => {
  function setup({ licenseRow = null, trialStartedAt = T0 } = {}) {
    const { prisma } = createFakePrisma({
      license: licenseRow ? [licenseRow] : [],
      room: [],
      // `name` — контроллер читает его ради `hotelMismatch` (S13-008)
      hotelSettings: [{ id: 1, name: 'Отель', trialStartedAt }],
    })
    const license = loadCjs('src/utils/license.js', { stubs: { './prisma': { prisma }, './logger': silentLogger } })
    const trial = loadTrial(prisma)
    const ctrl = loadCjs('src/controllers/licenseController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/license': license,
        '../utils/trial': trial,
        '../middleware/errorHandler': { createError: (m, s) => Object.assign(new Error(m), { status: s }) },
      },
    })
    return ctrl
  }

  const get = (ctrl) => new Promise((resolve, reject) => ctrl.get({}, { json: resolve }, reject))

  it('без ключа — trial с датами и остатком', async () => {
    const body = await get(setup())
    expect(body.state).toBe('none')
    expect(body.trial.lastDay).toBe('2026-09-26')
    expect(body.trial.days).toBe(14)
    expect(typeof body.trial.daysLeft).toBe('number')
    expect(typeof body.trial.expired).toBe('boolean')
  })

  it('с ключом — trial: null (даже если по датам он давно вышел)', async () => {
    // Ключ не разберётся боевым публичным ключом — это состояние invalid, не ok:
    // подписать тестовой парой без подмены ключа нельзя. Поэтому проверяем
    // «invalid → trial есть», а «ok → null» — через describeLicense с подменой.
    const body = await get(setup({ licenseRow: { id: 1, key: 'ROOMLINE-битый.ключ', hardwareId: '', expiresAt: new Date(), isActive: true } }))
    expect(body.state).toBe('invalid')
    expect(body.trial).not.toBeNull()
  })

  it('дата в базе не проставлена — trial без дат, не истёк', async () => {
    const { prisma } = createFakePrisma({ license: [], room: [], hotelSettings: [] })
    const license = loadCjs('src/utils/license.js', { stubs: { './prisma': { prisma }, './logger': silentLogger } })
    const ctrl = loadCjs('src/controllers/licenseController.js', {
      stubs: {
        '../utils/prisma': { prisma }, '../utils/license': license, '../utils/trial': loadTrial(prisma),
        '../middleware/errorHandler': { createError: (m, s) => Object.assign(new Error(m), { status: s }) },
      },
    })
    const body = await get(ctrl)
    expect(body.trial.expired).toBe(false)
    expect(body.trial.lastDay).toBeNull()
  })
})
