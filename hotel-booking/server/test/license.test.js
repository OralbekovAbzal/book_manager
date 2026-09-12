import { describe, it, expect, afterEach } from 'vitest'
import crypto from 'node:crypto'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Лицензия Roomline PMS.
 *
 * Стеречь здесь нужно две вещи, у которых цена ошибки разная:
 *  1) подпись — если её можно подделать или обойти, весь механизм бессмыслен;
 *  2) гейт обслуживания — если он сработает не тогда, у работающего отеля встанет
 *     стойка. Поэтому «ложное срабатывание» проверяется даже настойчивее, чем
 *     «сработало как надо»: неизвестная дата сборки, сломанная база, ключ без
 *     подписи — всё это НЕ должно закрывать программу.
 */

// ————————————————————————————————————————————————————————————————
// Своя пара ключей на тесты: боевой приватный ключ лежит вне репозитория,
// и тесты обязаны проходить на машине, где его нет вовсе.
// ————————————————————————————————————————————————————————————————
const pair = crypto.generateKeyPairSync('ed25519')
const TEST_PUBLIC = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const TEST_PRIVATE = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

const other = crypto.generateKeyPairSync('ed25519')
const OTHER_PRIVATE = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

/**
 * Загружает utils/license.js со своей базой. `swapKey` подменяет зашитый
 * публичный ключ тестовым — без этого проверить путь «ключ из базы → лимит
 * номеров» нечем: приватной половины боевой пары в репозитории нет и не будет.
 */
function loadLicense({ prisma = createFakePrisma({ license: [], room: [] }).prisma, swapKey = false } = {}) {
  return loadCjs('src/utils/license.js', {
    stubs: { './prisma': { prisma }, './logger': silentLogger },
    append: swapKey ? `PUBLIC_KEY_PEM = ${JSON.stringify(TEST_PUBLIC)}` : '',
  })
}

function makeKey(lib, overrides = {}, privateKeyPem = TEST_PRIVATE) {
  return lib.issueLicense(privateKeyPem, {
    hotel: 'База отдыха «Туран»',
    rooms: 45,
    maintenanceUntil: '2027-09-06',
    issuedAt: '2026-09-06',
    ...overrides,
  }).key
}

const opts = { publicKeyPem: TEST_PUBLIC }

describe('ключ: выпуск и проверка подписи', () => {
  const lib = loadLicense()

  it('свой ключ проходит проверку и отдаёт те поля, что в него положили', () => {
    const key = makeKey(lib)
    expect(key.startsWith('ROOMLINE-')).toBe(true)

    const res = lib.parseLicenseKey(key, opts)
    expect(res.valid).toBe(true)
    expect(res.payload).toMatchObject({
      v: 1,
      hotel: 'База отдыха «Туран»',
      rooms: 45,
      issuedAt: '2026-09-06',
      maintenanceUntil: '2027-09-06',
    })
    expect(res.payload.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('подделанный payload не проходит — цифру номеров подписью не прикроешь', () => {
    const key = makeKey(lib)
    const [head, sig] = key.slice('ROOMLINE-'.length).split('.')
    const payload = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))

    // Ровно то, что попробует сделать человек с текстовым редактором: 45 → 500.
    payload.rooms = 500
    const forged = Buffer.from(JSON.stringify(payload)).toString('base64url')

    const res = lib.parseLicenseKey(`ROOMLINE-${forged}.${sig}`, opts)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('bad_signature')
    expect(res.message).toBe('Подпись не сходится')
  })

  it('ключ, подписанный ЧУЖОЙ парой, не проходит', () => {
    const key = makeKey(lib, {}, OTHER_PRIVATE)
    const res = lib.parseLicenseKey(key, opts)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('bad_signature')
  })

  it('честно подписанный ключ будущей версии — «неизвестная версия», а не «подпись»', () => {
    // Версия проверяется ПОСЛЕ подписи, поэтому такой ответ получает только тот,
    // у кого ключ настоящий: у нас появится v: 2, а у клиента старая программа.
    const payload = Buffer.from(
      JSON.stringify({ v: 2, id: 'x', hotel: 'Т', rooms: 10, issuedAt: '2026-09-06', maintenanceUntil: '2027-09-06' }),
    ).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), TEST_PRIVATE).toString('base64url')

    const res = lib.parseLicenseKey(`ROOMLINE-${payload}.${sig}`, opts)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('unknown_version')
  })

  it('самодельный v: 2 БЕЗ подписи получает «подпись не сходится», а не подсказку про версию', () => {
    const payload = Buffer.from(JSON.stringify({ v: 2, rooms: 999 })).toString('base64url')
    const res = lib.parseLicenseKey(`ROOMLINE-${payload}.AAAA`, opts)
    expect(res.code).toBe('bad_signature')
  })

  it.each([
    ['пустая строка', ''],
    ['без префикса', 'eyJ2IjoxfQ.AAAA'],
    ['без подписи', 'ROOMLINE-eyJ2IjoxfQ'],
    ['пустая подпись', 'ROOMLINE-eyJ2IjoxfQ.'],
    ['пустой payload', 'ROOMLINE-.AAAA'],
    ['не base64url', 'ROOMLINE-не-base64!!.AAAA'],
    ['не JSON внутри', `ROOMLINE-${Buffer.from('просто текст').toString('base64url')}.AAAA`],
    ['не объект', `ROOMLINE-${Buffer.from('[1,2,3]').toString('base64url')}.AAAA`],
  ])('повреждённый ключ (%s) — «Ключ повреждён»', (_name, key) => {
    const res = lib.parseLicenseKey(key, opts)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('malformed')
  })

  // Продукт переименован Qonaq → Roomline PMS 09.09.2026. Префикс подписью не
  // покрыт, поэтому старый ключ остаётся годным навсегда: у первого клиента на
  // руках именно такой, и «перевыпустите ключ» по телефону мы ему не скажем.
  it('новые ключи выпускаются с ROOMLINE-, а QONAQ- остаётся в списке читаемых', () => {
    expect(lib.KEY_PREFIX).toBe('ROOMLINE-')
    expect(lib.LEGACY_KEY_PREFIXES).toEqual(['QONAQ-'])
    expect(makeKey(lib).startsWith('ROOMLINE-')).toBe(true)
  })

  it('ключ прежнего образца QONAQ- проверяется как валидный', () => {
    const key = makeKey(lib)
    const legacy = `QONAQ-${key.slice(lib.KEY_PREFIX.length)}`
    const res = lib.parseLicenseKey(legacy, opts)
    expect(res.valid).toBe(true)
    expect(res.payload.rooms).toBe(45)
  })

  it('выдуманный префикс не принимается — «Ключ повреждён»', () => {
    const key = makeKey(lib)
    const res = lib.parseLicenseKey(`FOO-${key.slice(lib.KEY_PREFIX.length)}`, opts)
    expect(res.valid).toBe(false)
    expect(res.code).toBe('malformed')
  })

  it('не строка вместо ключа не роняет проверку', () => {
    for (const v of [null, undefined, 42, {}, []]) {
      expect(lib.parseLicenseKey(v, opts).code).toBe('malformed')
    }
  })

  it('переносы строк и пробелы из письма не мешают', () => {
    const key = makeKey(lib)
    const wrapped = `  ${key.slice(0, 40)}\r\n${key.slice(40, 90)}\n ${key.slice(90)}  `
    expect(lib.parseLicenseKey(wrapped, opts).valid).toBe(true)
  })

  it('ключ с правильной подписью, но битым содержимым — «повреждён»', () => {
    // Подписываем честно, но кладём внутрь чушь: подпись сойдётся, а поля нет.
    const payload = Buffer.from(
      JSON.stringify({ v: 1, id: 'x', hotel: '', rooms: 0, issuedAt: '2026-13-40', maintenanceUntil: 'позже' }),
    ).toString('base64url')
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), TEST_PRIVATE).toString('base64url')
    expect(lib.parseLicenseKey(`ROOMLINE-${payload}.${sig}`, opts).code).toBe('malformed')
  })

  it('issueLicense не выпускает ключ с бессмысленными данными', () => {
    expect(() => lib.issueLicense(TEST_PRIVATE, { hotel: '  ', rooms: 45, maintenanceUntil: '2027-09-06' }))
      .toThrow(/hotel/)
    expect(() => lib.issueLicense(TEST_PRIVATE, { hotel: 'Т', rooms: 0, maintenanceUntil: '2027-09-06' }))
      .toThrow(/rooms/)
    expect(() => lib.issueLicense(TEST_PRIVATE, { hotel: 'Т', rooms: 4.5, maintenanceUntil: '2027-09-06' }))
      .toThrow(/rooms/)
    // 31 февраля Date молча превратил бы в 3 марта — дата в ключе разъехалась бы
    expect(() => lib.issueLicense(TEST_PRIVATE, { hotel: 'Т', rooms: 45, maintenanceUntil: '2027-02-31' }))
      .toThrow(/maintenanceUntil/)
  })

  it('ключ RSA к выпуску не принимается (подпись должна быть Ed25519)', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => lib.issueLicense(rsa, { hotel: 'Т', rooms: 1, maintenanceUntil: '2027-01-01' }))
      .toThrow(/Ed25519/)
  })

  it('боевой публичный ключ в license.js — настоящий Ed25519, а не заглушка', () => {
    // Дешёвая страховка от «забыли вставить публичный ключ после --keygen».
    const key = crypto.createPublicKey(lib.PUBLIC_KEY_PEM)
    expect(key.asymmetricKeyType).toBe('ed25519')
    expect(lib.PUBLIC_KEY_PEM).not.toMatch(/PLACEHOLDER/)
  })
})

// ————————————————————————————————————————————————————————————————

describe('дата сборки', () => {
  const lib = loadLicense()
  const saved = process.env.ROOMLINE_BUILD_DATE
  const savedLegacy = process.env.QONAQ_BUILD_DATE

  afterEach(() => {
    if (saved === undefined) delete process.env.ROOMLINE_BUILD_DATE
    else process.env.ROOMLINE_BUILD_DATE = saved
    if (savedLegacy === undefined) delete process.env.QONAQ_BUILD_DATE
    else process.env.QONAQ_BUILD_DATE = savedLegacy
  })

  it('ROOMLINE_BUILD_DATE перебивает package.json', () => {
    process.env.ROOMLINE_BUILD_DATE = '2028-01-31'
    expect(lib.getBuildDate()).toBe('2028-01-31')
  })

  // Переменная переименована вместе с продуктом; чужой .env с прежним именем
  // должен продолжать работать, иначе разбор обращения начнётся с «а почему гейт».
  it('прежнее имя QONAQ_BUILD_DATE читается как запасное', () => {
    delete process.env.ROOMLINE_BUILD_DATE
    process.env.QONAQ_BUILD_DATE = '2029-03-04'
    expect(lib.getBuildDate()).toBe('2029-03-04')
  })

  it('новое имя главнее прежнего', () => {
    process.env.QONAQ_BUILD_DATE = '2029-03-04'
    process.env.ROOMLINE_BUILD_DATE = '2028-01-31'
    expect(lib.getBuildDate()).toBe('2028-01-31')
  })

  it('мусор в ROOMLINE_BUILD_DATE игнорируется, а не ломает сравнение', () => {
    for (const v of ['вчера', '2028-13-01', '2028-02-30', '31.01.2028', '']) {
      process.env.ROOMLINE_BUILD_DATE = v
      expect(lib.getBuildDate()).not.toBe(v)
    }
  })
})

// ————————————————————————————————————————————————————————————————

describe('состояние лицензии', () => {
  const lib = loadLicense({ swapKey: true })
  const key = makeKey(lib, { maintenanceUntil: '2027-09-06' })

  // evaluateLicense принимает дату сборки параметром — это и делает поведение
  // проверяемым без подмены глобального окружения.
  const state = (k, buildDate) => lib.evaluateLicense(k, buildDate).state

  it('none — ключа нет вовсе', () => {
    expect(state(null, '2026-09-06')).toBe('none')
    expect(state('', '2026-09-06')).toBe('none')
  })

  it('ok — сборка выпущена в пределах обслуживания', () => {
    expect(state(key, '2026-09-06')).toBe('ok')
  })

  it('ok — сборка выпущена ровно в последний день обслуживания (граница включительно)', () => {
    // Иначе клиент, купивший обновление в последний день, получил бы 402.
    expect(state(key, '2027-09-06')).toBe('ok')
  })

  it('expired — сборка на день новее конца обслуживания', () => {
    expect(state(key, '2027-09-07')).toBe('expired')
  })

  it('дата сборки неизвестна — НЕ блокируем', () => {
    // Доказать, что сборка новее оплаченного, нечем. Сомнение — в пользу клиента.
    expect(state(key, null)).toBe('ok')
    expect(state(key, undefined)).toBe('ok')
  })

  it('битый ключ — invalid, но это не «expired»: ограничивать за него нечего', () => {
    expect(state('ROOMLINE-мусор.мусор', '2030-01-01')).toBe('invalid')
  })

  it('describeLicense отдаёт клиенту весь контракт', () => {
    const info = lib.describeLicense(key, '2026-09-06')
    expect(info).toMatchObject({
      state: 'ok',
      hotel: 'База отдыха «Туран»',
      rooms: 45,
      issuedAt: '2026-09-06',
      maintenanceUntil: '2027-09-06',
      buildDate: '2026-09-06',
    })
    expect(info.maintenanceActive).toBe(true)
  })

  it('без ключа поля пустые, но форма ответа та же', () => {
    const info = lib.describeLicense(null, '2026-09-06')
    expect(info.state).toBe('none')
    expect(info.hotel).toBeNull()
    expect(info.rooms).toBeNull()
    expect(info.maintenanceUntil).toBeNull()
    expect(info.buildDate).toBe('2026-09-06')
  })

  it('maintenanceActive отличается от state: старая сборка работает, но продлевать пора', () => {
    const old = makeKey(lib, { maintenanceUntil: '2020-01-01' })
    const info = lib.describeLicense(old, '2019-06-01') // сборка старее конца обслуживания
    expect(info.state).toBe('ok')          // программа работает — это и обещано
    expect(info.maintenanceActive).toBe(false) // но обслуживание давно кончилось
  })
})

// ————————————————————————————————————————————————————————————————

describe('лимит номеров', () => {
  const signer = loadLicense() // только чтобы выпускать ключи тестовой парой

  function setup(keyString) {
    const rows = keyString
      ? [{ id: 1, key: keyString, hardwareId: '', expiresAt: new Date(), isActive: true }]
      : []
    const { prisma, calls } = createFakePrisma({ license: rows, room: [] })
    return { lib: loadLicense({ prisma, swapKey: true }), calls }
  }

  it('без ключа лимита нет — демо и первый показ ничем не ограничены', async () => {
    const { lib } = setup(null)
    expect(await lib.getRoomLimit()).toBeNull()
  })

  it('битый ключ тоже не ограничивает (не наказываем отель за испорченную строку в базе)', async () => {
    const { lib } = setup('ROOMLINE-мусор.мусор')
    expect(await lib.getRoomLimit()).toBeNull()
  })

  it('с ключом лимит равен ступени тарифа', async () => {
    const { lib } = setup(makeKey(signer, { rooms: 45 }))
    expect(await lib.getRoomLimit()).toBe(45)
  })

  it('после конца обслуживания лимит остаётся — ключ на 45 номеров и есть ключ на 45', async () => {
    process.env.ROOMLINE_BUILD_DATE = '2030-01-01'
    try {
      const { lib } = setup(makeKey(signer, { rooms: 45, maintenanceUntil: '2027-09-06' }))
      expect((await lib.getLicenseState()).state).toBe('expired')
      expect(await lib.getRoomLimit()).toBe(45)
    } finally {
      delete process.env.ROOMLINE_BUILD_DATE
    }
  })

  it('текст отказа — тот, что увидит администратор', () => {
    const { lib } = setup(null)
    expect(lib.roomLimitMessage(45)).toBe(
      'Лицензия на 45 номеров; чтобы добавить — обратитесь к поставщику',
    )
  })

  it('ключ читается из базы один раз, пока кэш не сброшен', async () => {
    const { lib, calls } = setup(makeKey(signer))
    const reads = () => calls.filter((c) => c.model === 'license').length

    await lib.getLicenseState()
    await lib.getLicenseState()
    await lib.getRoomLimit()
    expect(reads()).toBe(1)

    lib.resetLicenseCache()
    await lib.getLicenseState()
    expect(reads()).toBe(2)
  })
})

// ————————————————————————————————————————————————————————————————

describe('контроллер /api/license', () => {
  const signer = loadLicense()

  function setup({ licenseRow = null, rooms = [] } = {}) {
    const { prisma } = createFakePrisma({
      license: licenseRow ? [licenseRow] : [],
      room: rooms,
    })
    // upsert в мини-Prisma нет — доклеиваем поверх модели license.
    prisma.license.upsert = async ({ where, create, update }) => {
      const rows = prisma.license.rows
      const hit = rows.find((r) => r.id === where.id)
      if (hit) { Object.assign(hit, update); return hit }
      const rec = { ...create }
      rows.push(rec)
      return rec
    }

    const lib = loadLicense({ prisma, swapKey: true })
    const ctrl = loadCjs('src/controllers/licenseController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/license': lib,
        '../utils/trial': { getTrialState: async () => ({ startedAt: null, endsAt: null, lastDay: null, daysLeft: null, expired: false, days: 14 }) },
        '../middleware/errorHandler': require_errorHandler(),
      },
    })
    return { ctrl, prisma, lib }
  }

  function require_errorHandler() {
    return {
      createError: (message, status) => Object.assign(new Error(message), { status }),
    }
  }

  function invoke(handler, req = {}) {
    return new Promise((resolve, reject) => {
      const res = { json: (body) => resolve({ body }) }
      handler(req, res, (err) => (err ? resolve({ err }) : reject(new Error('next() без ошибки'))))
    })
  }

  const activeRooms = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: i + 1, isActive: true }))

  it('GET без ключа → state none и реальное число номеров', async () => {
    const { ctrl } = setup({ rooms: activeRooms(91) })
    const { body } = await invoke(ctrl.get)
    expect(body.state).toBe('none')
    expect(body.roomsUsed).toBe(91)
    expect(body.rooms).toBeNull()
  })

  it('GET с ключом → state ok и обе цифры рядом', async () => {
    const key = makeKey(signer, { rooms: 45 })
    const { ctrl } = setup({
      licenseRow: { id: 1, key, hardwareId: '', expiresAt: new Date(), isActive: true },
      rooms: activeRooms(91),
    })
    const { body } = await invoke(ctrl.get)
    expect(body.state).toBe('ok')
    expect(body.hotel).toBe('База отдыха «Туран»')
    // Номеров уже больше, чем в ключе. Это НЕ ошибка и ничего не ломает:
    // существующие номера не трогаем, отказываем только в добавлении новых.
    expect(body.rooms).toBe(45)
    expect(body.roomsUsed).toBe(91)
  })

  it('GET считает только АКТИВНЫЕ номера — отключённый корпус не требует доплаты', async () => {
    const { ctrl } = setup({
      rooms: [...activeRooms(3), { id: 4, isActive: false }, { id: 5, isActive: false }],
    })
    const { body } = await invoke(ctrl.get)
    expect(body.roomsUsed).toBe(3)
  })

  it('POST сохраняет верный ключ, пустой hardwareId и дату как UTC-полночь', async () => {
    const key = makeKey(signer, { rooms: 45, maintenanceUntil: '2027-09-06' })
    const { ctrl, prisma } = setup({ rooms: activeRooms(2) })

    const { body } = await invoke(ctrl.activate, { body: { key } })
    expect(body.state).toBe('ok')
    expect(body.rooms).toBe(45)

    const row = prisma.license.rows[0]
    expect(row.key).toBe(key)
    expect(row.hardwareId).toBe('')       // к железу не привязываемся
    expect(row.isActive).toBe(true)
    expect(row.expiresAt.toISOString()).toBe('2027-09-06T00:00:00.000Z')
  })

  it('POST с подделанным ключом → 400 и внятная причина, база не меняется', async () => {
    const key = makeKey(signer)
    const [head, sig] = key.slice('ROOMLINE-'.length).split('.')
    const payload = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))
    payload.rooms = 500
    const forged = `ROOMLINE-${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`

    const { ctrl, prisma } = setup()
    const { err } = await invoke(ctrl.activate, { body: { key: forged } })
    expect(err.status).toBe(400)
    expect(err.message).toBe('Подпись не сходится')
    expect(prisma.license.rows).toHaveLength(0)
  })

  it('POST с пустым ключом → 400', async () => {
    const { ctrl } = setup()
    const { err } = await invoke(ctrl.activate, { body: { key: '   ' } })
    expect(err.status).toBe(400)
  })

  it('POST сбрасывает кэш — следующий GET видит новый ключ, а не старый', async () => {
    const { ctrl, lib } = setup()
    await invoke(ctrl.get)                        // прогреваем кэш пустым состоянием
    expect((await lib.getLicenseState()).state).toBe('none')

    await invoke(ctrl.activate, { body: { key: makeKey(signer, { rooms: 45 }) } })

    const { body } = await invoke(ctrl.get)
    expect(body.state).toBe('ok')
    expect(body.rooms).toBe(45)
  })

  it('повторный POST заменяет ключ (переход на старшую ступень)', async () => {
    const { ctrl, prisma } = setup()
    await invoke(ctrl.activate, { body: { key: makeKey(signer, { rooms: 45 }) } })
    await invoke(ctrl.activate, { body: { key: makeKey(signer, { rooms: 70 }) } })

    expect(prisma.license.rows).toHaveLength(1)
    const { body } = await invoke(ctrl.get)
    expect(body.rooms).toBe(70)
  })
})

// ————————————————————————————————————————————————————————————————

describe('гейт обслуживания (402)', () => {
  /**
   * Собирает middleware с подменённым модулем лицензии: сам гейт про подписи
   * ничего не знает, ему важно только состояние и то, какие пути он пропускает.
   */
  function gate({ state = 'ok', maintenanceUntil = '2026-01-31', buildDate = '2026-09-06', fail = false } = {}) {
    const licenseStub = {
      getLicenseState: async () => {
        if (fail) throw new Error('база недоступна')
        return { state, payload: state === 'none' || state === 'invalid' ? null : { maintenanceUntil } }
      },
      getBuildDate: () => buildDate,
      formatRu: (iso) => iso.split('-').reverse().join('.'),
    }
    const mod = loadCjs('src/middleware/license.js', {
      stubs: {
        '../utils/license': licenseStub,
        // Пробный период здесь не при чём — свой набор проверок в trial.test.js
        '../utils/trial': { getTrialState: async () => ({ expired: false }), expiredMessage: () => '' },
        '../utils/logger': silentLogger,
      },
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

  it('обслуживание закончилось раньше сборки — 402 с точным текстом и кодом', async () => {
    const mw = gate({ state: 'expired', maintenanceUntil: '2026-01-31' })
    const { passed, res } = await call(mw, { path: '/api/bookings' })

    expect(passed).toBe(false)
    expect(res.statusCode).toBe(402)
    expect(res.body.code).toBe('MAINTENANCE_EXPIRED')
    expect(res.body.message).toBe(
      'Обслуживание закончилось 31.01.2026, а эта версия выпущена позже. ' +
      'Продлите обслуживание или установите прежнюю версию. Данные не тронуты.',
    )
    // Дубль в error — чтобы общий обработчик ошибок клиента показал текст
    expect(res.body.error).toBe(res.body.message)
    expect(res.body.maintenanceUntil).toBe('2026-01-31')
  })

  it.each([
    '/api/health',
    '/api/license',
    '/api/license/',
    '/api/auth/login',
  ])('%s остаётся доступным — иначе новый ключ ввести нечем', async (path) => {
    const mw = gate({ state: 'expired' })
    const { passed } = await call(mw, { path, method: 'POST' })
    expect(passed).toBe(true)
  })

  it.each([
    '/api/bookings',
    '/api/bookings/17',
    '/api/rooms',
    '/api/auth/me',
    '/api/auth/logout',
    '/api/reports/run',
    '/api/setup/status',
  ])('%s закрывается', async (path) => {
    const mw = gate({ state: 'expired' })
    const { passed, res } = await call(mw, { path })
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(402)
  })

  it('похожий путь не считается разрешённым по совпадению префикса', async () => {
    const mw = gate({ state: 'expired' })
    // '/api/licenses-report' начинается с '/api/license', но это другой раздел.
    for (const path of ['/api/licenses-report', '/api/health-check', '/api/auth/login-history']) {
      const { passed } = await call(mw, { path })
      expect(passed, path).toBe(false)
    }
  })

  it.each(['ok', 'none', 'invalid'])('состояние %s пропускает всё', async (state) => {
    const mw = gate({ state })
    const { passed } = await call(mw, { path: '/api/bookings' })
    expect(passed).toBe(true)
  })

  it('OPTIONS пропускается всегда — иначе браузер покажет ошибку CORS вместо текста', async () => {
    const mw = gate({ state: 'expired' })
    const { passed } = await call(mw, { path: '/api/bookings', method: 'OPTIONS' })
    expect(passed).toBe(true)
  })

  it('не-API пути гейт не трогает', async () => {
    const mw = gate({ state: 'expired' })
    const { passed } = await call(mw, { path: '/socket.io/' })
    expect(passed).toBe(true)
  })

  it('база недоступна — запрос ПРОПУСКАЕТСЯ, а не выглядит как конец лицензии', async () => {
    const mw = gate({ fail: true })
    const { passed } = await call(mw, { path: '/api/bookings' })
    expect(passed).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————

describe('лимит номеров в roomController', () => {
  const signer = loadLicense()

  /**
   * Контроллер номеров с подменённой лицензией. Сам контроллер про подписи
   * ничего не знает — он спрашивает у утилиты «сколько номеров разрешено».
   */
  function setup({ limit = null, rooms = [] } = {}) {
    const { prisma } = createFakePrisma({ room: rooms })
    // Значения по умолчанию (isActive, createdAt) и связь category живут в схеме,
    // а мини-Prisma их не знает — иначе ROOM_SELECT после create падал бы на них.
    prisma.room.create = async ({ data }) => {
      const rec = { id: 10000 + prisma.room.rows.length, isActive: true, createdAt: new Date(),
        category: { id: 1, name: 'Стандарт', color: '#fff' }, ...data }
      prisma.room.rows.push(rec)
      return rec
    }
    const ctrl = loadCjs('src/controllers/roomController.js', {
      stubs: {
        '../utils/prisma': { prisma },
        '../utils/availability': { checkRoomsAvailability: async () => new Map(), parseFlags: () => [] },
        './occupancyController': { invalidateGridCache() {} },
        '../utils/license': {
          getRoomLimit: async () => limit,
          roomLimitMessage: (n) => `Лицензия на ${n} номеров; чтобы добавить — обратитесь к поставщику`,
        },
      },
    })
    return { ctrl, prisma }
  }

  function invoke(handler, req) {
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this },
        json(body) { resolve({ status: this.statusCode, body }) },
      }
      handler(req, res, (err) => reject(err || new Error('next() без ошибки')))
    })
  }

  const activeRooms = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1, number: `${100 + i}`, categoryId: 1, building: 'A', floor: 1,
      features: [], capacity: 'double', isActive: true, createdAt: new Date(),
      category: { id: 1, name: 'Стандарт', color: '#fff' },
    }))

  const newRoomBody = { number: '999', categoryId: 1, building: 'a', floor: 2 }

  it('без лицензии номера заводятся сколько угодно', async () => {
    const { ctrl } = setup({ limit: null, rooms: activeRooms(200) })
    const { status } = await invoke(ctrl.create, { body: newRoomBody })
    expect(status).toBe(201)
  })

  it('под лимитом номер создаётся', async () => {
    const { ctrl } = setup({ limit: 45, rooms: activeRooms(44) })
    const { status } = await invoke(ctrl.create, { body: newRoomBody })
    expect(status).toBe(201)
  })

  it('на лимите — отказ с текстом для администратора', async () => {
    const { ctrl, prisma } = setup({ limit: 45, rooms: activeRooms(45) })
    const { status, body } = await invoke(ctrl.create, { body: newRoomBody })

    expect(status).toBe(403)
    expect(body.error).toBe('Лицензия на 45 номеров; чтобы добавить — обратитесь к поставщику')
    expect(body.code).toBe('LICENSE_ROOM_LIMIT')
    expect(body).toMatchObject({ limit: 45, used: 45 })
    expect(prisma.room.rows).toHaveLength(45) // номер не создан
  })

  it('номеров УЖЕ больше лимита — существующие целы, новый не добавляется', async () => {
    // Живой случай: в базе 91 номер, ключ на 45. Так бывает при переходе со
    // старшей ступени и при ошибке в выпуске. Отключать чужие номера мы не вправе.
    const { ctrl, prisma } = setup({ limit: 45, rooms: activeRooms(91) })
    const { status, body } = await invoke(ctrl.create, { body: newRoomBody })

    expect(status).toBe(403)
    expect(body.used).toBe(91)
    expect(prisma.room.rows.filter((r) => r.isActive)).toHaveLength(91)
  })

  it('отключённые номера в лимит не считаются', async () => {
    const rooms = [...activeRooms(44), { ...activeRooms(1)[0], id: 90, number: '900', isActive: false }]
    const { ctrl } = setup({ limit: 45, rooms })
    const { status } = await invoke(ctrl.create, { body: newRoomBody })
    expect(status).toBe(201)
  })

  it('включение отключённого номера на лимите — отказ («выключил–включил» не обходит тариф)', async () => {
    const rooms = [...activeRooms(45), { ...activeRooms(1)[0], id: 90, number: '900', isActive: false }]
    const { ctrl, prisma } = setup({ limit: 45, rooms })

    const { status, body } = await invoke(ctrl.update, { params: { id: '90' }, body: { isActive: true } })
    expect(status).toBe(403)
    expect(body.code).toBe('LICENSE_ROOM_LIMIT')
    expect(prisma.room.rows.find((r) => r.id === 90).isActive).toBe(false)
  })

  it('включение под лимитом проходит', async () => {
    const rooms = [...activeRooms(43), { ...activeRooms(1)[0], id: 90, number: '900', isActive: false }]
    const { ctrl, prisma } = setup({ limit: 45, rooms })

    const { status } = await invoke(ctrl.update, { params: { id: '90' }, body: { isActive: true } })
    expect(status).toBe(200)
    expect(prisma.room.rows.find((r) => r.id === 90).isActive).toBe(true)
  })

  it('правка уже активного номера лимитом не блокируется даже при перерасходе', async () => {
    // Иначе отель с 91 номером и ключом на 45 не смог бы переименовать ни одного.
    const { ctrl } = setup({ limit: 45, rooms: activeRooms(91) })
    const { status } = await invoke(ctrl.update, { params: { id: '3' }, body: { number: '303', isActive: true } })
    expect(status).toBe(200)
  })

  it('отключение номера при перерасходе разрешено — это путь ВНИЗ к лимиту', async () => {
    const { ctrl, prisma } = setup({ limit: 45, rooms: activeRooms(91) })
    const { status } = await invoke(ctrl.update, { params: { id: '5' }, body: { isActive: false } })
    expect(status).toBe(200)
    expect(prisma.room.rows.find((r) => r.id === 5).isActive).toBe(false)
  })
})
