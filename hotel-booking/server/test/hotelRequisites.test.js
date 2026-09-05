import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Реквизиты объекта для печатных документов: юридическое имя, БИН/ИИН, адрес,
 * телефон, почта, банк, IBAN, подписант и его должность.
 *
 * Зачем они есть: счёт турфирме и подтверждение брони гостю печатаются с шапкой.
 * Без реквизитов это бумажка — турфирма не сможет по ней заплатить, а гость
 * не поймёт, кто ему что подтвердил.
 *
 * Куда бьют тесты — в четыре места, где эти данные реально теряются:
 *
 *   1. **Частичный PUT.** Реквизиты вводят один раз и забывают. Любое другое
 *      сохранение настроек объекта (мастер первого запуска, экран «Объект»,
 *      переключение «за номер / за место») присылает форму БЕЗ полей реквизитов —
 *      и не имеет права обнулить IBAN, который никто больше не помнит.
 *   2. **Формат «как в жизни».** БИН копируют группами по три, IBAN — по четыре
 *      и в нижнем регистре. Ответить на это 400 значит заставить человека
 *      набирать вручную то, что он только что скопировал из свидетельства.
 *   3. **Слишком строгая проверка.** IBAN проверяем МЯГКО: жёсткая маска «KZ и
 *      ровно 20» не даст сохранить счёт в иностранном банке, и печать останется
 *      без реквизитов вообще.
 *   4. **Пустое значение стирает.** Опечатку в реквизите надо чем-то исправлять,
 *      а очищенный input приходит пустой строкой, а не null.
 *
 * Пятое место — резервная копия — проверяется в `backup.test.js`: состав копии
 * собирается из DMMF, и на «забыли новую колонку» в этом проекте наступали дважды.
 */

// ─── Загрузка контроллера и правил роута ─────────────────────────────────────

const errorHandler = loadCjs('src/middleware/errorHandler.js', {
  stubs: { '../utils/logger': silentLogger },
})

const validate = loadCjs('src/middleware/validate.js')

/** Строка настроек в том виде, в каком её отдаёт база после миграции. */
function settingsRow(over = {}) {
  return {
    id: 1,
    name: 'Туран',
    city: null,
    currency: 'KZT',
    pricingBase: 'person',
    lateArrivalHour: null,
    setupCompletedAt: new Date('2026-09-03T03:54:54.890Z'),
    legalName: null,
    bin: null,
    address: null,
    phone: null,
    email: null,
    bankName: null,
    iban: null,
    signerName: null,
    signerTitle: null,
    updatedAt: new Date('2026-09-05T04:07:48.213Z'),
    ...over,
  }
}

function loadCtrl(rows = [settingsRow()]) {
  const { prisma } = createFakePrisma({ hotelSettings: rows })
  const ctrl = loadCjs('src/controllers/hotelController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../middleware/errorHandler': errorHandler,
    },
  })
  return { ctrl, prisma }
}

/**
 * Правила валидации живут в роуте (`routes/hotel.js`) — их и прогоняем,
 * без поднятия Express. Роут экспортирует их отдельно именно ради этого.
 */
function loadRules(ctrl) {
  const route = loadCjs('src/routes/hotel.js', {
    stubs: {
      '../controllers/hotelController': ctrl,
      '../middleware/auth': {
        authenticate: (_req, _res, next) => next(),
        requireRole: () => (_req, _res, next) => next(),
      },
      '../middleware/validate': validate,
    },
  })
  return route.hotelRules
}

/** Мини-Express: контроллер отвечает либо через res, либо через next(err). */
function run(handler, { body = {}, params = {}, query = {}, role = 'ADMIN' } = {}) {
  const res = { status: 200, body: null }
  const fakeRes = {
    status(code) { res.status = code; return fakeRes },
    json(payload) { res.body = payload; return fakeRes },
  }
  const next = (err) => {
    res.status = err.status || 500
    res.body = { error: err.message }
  }
  return Promise.resolve(handler({ body, params, query, admin: { id: 1, role } }, fakeRes, next)).then(() => res)
}

/**
 * Полный путь запроса: правила роута (они же санитайзеры) → validate → контроллер.
 * Именно так и надо проверять — иначе легко получить роут, который принимает
 * одно, а контроллер сохраняет другое.
 */
async function put(ctrl, rules, body) {
  const req = { body: { ...body }, params: {}, query: {}, headers: {}, cookies: {}, admin: { id: 1, role: 'ADMIN' } }
  for (const rule of rules) await rule.run(req)

  let rejected = null
  const vres = {
    status(code) { this.code = code; return this },
    json(payload) { rejected = { status: this.code, body: payload }; return this },
  }
  let passed = false
  validate.validate(req, vres, () => { passed = true })
  if (!passed) return { ...rejected, sanitized: req.body }

  const res = await run(ctrl.update, { body: req.body })
  return { ...res, sanitized: req.body }
}

const get = (ctrl) => run(ctrl.get)

/** Сообщения об ошибках полей — из details, которые собирает middleware/validate. */
const fields = (res) => (res.body.details || []).map((d) => d.field)

const FULL = {
  legalName: 'ИП Оралбеков А.',
  bin: '990514300123',
  address: 'Карагандинская обл., п. Каркаралинск, ул. Лесная, 1',
  phone: '+7 (7212) 55-55-55',
  email: 'turan@example.kz',
  bankName: 'АО «Kaspi Bank»',
  iban: 'KZ868562000000327523',
  signerName: 'Оралбеков А.',
  signerTitle: 'Директор',
}

const REQUISITES = Object.keys(FULL)

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/hotel', () => {
  it('отдаёт реквизиты вместе с остальными настройками', async () => {
    const { ctrl } = loadCtrl([settingsRow(FULL)])

    const res = await get(ctrl)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject(FULL)
    // Старые поля на месте — печать печатью, а расчёт цен от pricingBase
    expect(res.body.data).toMatchObject({ name: 'Туран', currency: 'KZT', pricingBase: 'person' })
  })

  it('на свежей установке реквизиты пустые, а не отсутствуют', async () => {
    // Клиенту нужно отличать «не заполнено» от «поля вообще нет в ответе»:
    // во втором случае форма настроек не поймёт, что показывать.
    const { ctrl } = loadCtrl([])

    const res = await get(ctrl)

    expect(res.status).toBe(200)
    for (const f of REQUISITES) expect(res.body.data[f] ?? null).toBeNull()
  })
})

// ─── PUT: сохранение ─────────────────────────────────────────────────────────

describe('PUT /api/hotel — сохранение реквизитов', () => {
  it('сохраняет все девять полей', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, FULL)

    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject(FULL)
    expect(prisma.hotelSettings.rows[0]).toMatchObject(FULL)
  })

  it('строку id = 1 заводит сам, если её ещё нет', async () => {
    const { ctrl, prisma } = loadCtrl([])
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { legalName: 'ТОО «Дорожник»' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0]).toMatchObject({ id: 1, legalName: 'ТОО «Дорожник»' })
  })
})

// ─── PUT: частичный ──────────────────────────────────────────────────────────

describe('PUT /api/hotel — частичный запрос НЕ обнуляет реквизиты', () => {
  it('сохранение названия объекта не стирает банк и IBAN', async () => {
    // Главный сценарий потери: форма «Объект» присылает name/city/currency,
    // полей реквизитов в ней нет вовсе.
    const { ctrl, prisma } = loadCtrl([settingsRow(FULL)])
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { name: 'Дорожник', city: 'Караганда' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0]).toMatchObject({ name: 'Дорожник', city: 'Караганда', ...FULL })
    expect(res.body.data).toMatchObject(FULL)
  })

  it('правка одного реквизита не трогает восемь соседних', async () => {
    const { ctrl, prisma } = loadCtrl([settingsRow(FULL)])
    const rules = loadRules(ctrl)

    await put(ctrl, rules, { signerTitle: 'ИП' })

    expect(prisma.hotelSettings.rows[0]).toMatchObject({ ...FULL, signerTitle: 'ИП' })
  })

  it('переключение pricingBase не задевает реквизиты', async () => {
    const { ctrl, prisma } = loadCtrl([settingsRow(FULL)])
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { pricingBase: 'room' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0]).toMatchObject({ pricingBase: 'room', ...FULL })
  })
})

// ─── PUT: очистка ────────────────────────────────────────────────────────────

describe('PUT /api/hotel — пустое значение стирает реквизит', () => {
  it('пустая строка из очищенного поля формы кладётся как null, а не как «»', async () => {
    // «» в базе печать не отличит от «не заполнено» и выведет пустую строку в шапке
    const { ctrl, prisma } = loadCtrl([settingsRow(FULL)])
    const rules = loadRules(ctrl)

    await put(ctrl, rules, { bankName: '', iban: '   ' })

    expect(prisma.hotelSettings.rows[0].bankName).toBeNull()
    expect(prisma.hotelSettings.rows[0].iban).toBeNull()
    // Соседнее поле не пострадало — стирали два, а не «реквизиты целиком»
    expect(prisma.hotelSettings.rows[0].legalName).toBe('ИП Оралбеков А.')
  })

  it('явный null стирает так же — опечатку надо чем-то исправлять', async () => {
    const { ctrl, prisma } = loadCtrl([settingsRow(FULL)])
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { bin: null, email: null })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0].bin).toBeNull()
    expect(prisma.hotelSettings.rows[0].email).toBeNull()
  })
})

// ─── Нормализация ────────────────────────────────────────────────────────────

describe('PUT /api/hotel — нормализация', () => {
  it('БИН, скопированный группами по три, принимается и хранится сплошным', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { bin: ' 990 514 300 123 ' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0].bin).toBe('990514300123')
  })

  it('IBAN с бланка — группами по четыре и строчными — приводится к каноническому виду', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { iban: 'kz86 8562 0000 0032 7523' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0].iban).toBe('KZ868562000000327523')
  })

  it('лишние пробелы по краям обрезаются у всех текстовых реквизитов', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    await put(ctrl, rules, { legalName: '  ИП Оралбеков А.  ', signerTitle: ' Директор ' })

    expect(prisma.hotelSettings.rows[0].legalName).toBe('ИП Оралбеков А.')
    expect(prisma.hotelSettings.rows[0].signerTitle).toBe('Директор')
  })

  it('нормализация роута и контроллера — одна и та же функция', async () => {
    // Роут санитайзит запрос, контроллер пишет в базу. Разъедься они —
    // проверку прошло бы одно значение, а сохранилось другое.
    const { ctrl } = loadCtrl()
    expect(ctrl.cleanBin(' 990 514 300 123 ')).toBe('990514300123')
    expect(ctrl.cleanIban('kz86 8562 0000 0032 7523')).toBe('KZ868562000000327523')
    expect(ctrl.cleanText('   ')).toBeNull()
  })
})

// ─── Валидация ───────────────────────────────────────────────────────────────

describe('PUT /api/hotel — валидация БИН/ИИН', () => {
  it('11 цифр — 400 с понятным сообщением, в базу ничего не уходит', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { bin: '99051430012' })

    expect(res.status).toBe(400)
    expect(fields(res)).toEqual(['bin'])
    expect(res.body.details[0].message).toBe('БИН/ИИН — ровно 12 цифр')
    expect(prisma.hotelSettings.rows[0].bin).toBeNull()
  })

  it('буквы в номере не проходят', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { bin: '99051430012A' })

    expect(res.status).toBe(400)
  })

  it('ведущий ноль сохраняется — номер хранится строкой, а не числом', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    await put(ctrl, rules, { bin: '000514300123' })

    expect(prisma.hotelSettings.rows[0].bin).toBe('000514300123')
  })
})

describe('PUT /api/hotel — валидация IBAN мягкая', () => {
  it('казахстанский счёт (KZ + 18) проходит', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { iban: 'KZ868562000000327523' })

    expect(res.status).toBe(200)
  })

  it('счёт в иностранном банке НЕ отвергается', async () => {
    // Ровно та причина, по которой проверка мягкая: длина IBAN зависит от страны
    // (15–34 знака), и «ровно 20» отрезало бы объекту счёт за границей.
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    for (const iban of [
      'DE89370400440532013000',        // Германия, 22
      'GB33BUKB20201555555555',        // Великобритания, 22
      'NO9386011117947',               // Норвегия, 15 — самый короткий
      'MT84MALT011000012345MTLCAST001S', // Мальта, 31
    ]) {
      const res = await put(ctrl, rules, { iban })
      expect(res.status, iban).toBe(200)
    }
  })

  it('явный мусор всё-таки отвергается — иначе в шапку счёта уедет что угодно', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    for (const iban of [
      'KZ86',                 // слишком коротко
      '868562000000327523',   // без кода страны
      'KZ86-8562-0000-0032',  // дефисы это не пробелы: сплошной строки не выйдет
    ]) {
      const res = await put(ctrl, rules, { iban })
      expect(res.status, iban).toBe(400)
      expect(fields(res), iban).toEqual(['iban'])
    }
  })

  it('контрольная сумма НЕ проверяется — это сознательное решение', async () => {
    // Неверная контрольная сумма (KZ99 вместо KZ86) сохраняется: ошибку в счёте
    // покажет банк, а несохранённый счёт ломает печать сразу и у всех.
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { iban: 'KZ998562000000327523' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0].iban).toBe('KZ998562000000327523')
  })
})

describe('PUT /api/hotel — прочая валидация', () => {
  it('телефон формат не проверяет: в шапке пишут «+7 (7212) 55-55-55, доб. 12»', async () => {
    const { ctrl, prisma } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { phone: '+7 (7212) 55-55-55, доб. 12 / +7 701 000 00 00' })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0].phone).toContain('доб. 12')
  })

  it('почта с опечаткой — 400', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { email: 'turan@example' })

    expect(res.status).toBe(400)
    expect(fields(res)).toEqual(['email'])
  })

  it('слишком длинное значение — 400, а не молчаливое обрезание', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { legalName: 'Я'.repeat(201) })

    expect(res.status).toBe(400)
    expect(fields(res)).toEqual(['legalName'])
  })

  it('старые проверки не сломались: pricingBase и час позднего заезда', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    expect((await put(ctrl, rules, { pricingBase: 'bed' })).status).toBe(400)
    expect((await put(ctrl, rules, { lateArrivalHour: 25 })).status).toBe(400)
    expect((await put(ctrl, rules, { lateArrivalHour: 17 })).status).toBe(200)
  })

  it('запрос вообще без реквизитов проходит — правила необязательные', async () => {
    const { ctrl } = loadCtrl()
    const rules = loadRules(ctrl)

    const res = await put(ctrl, rules, { name: 'Туран' })

    expect(res.status).toBe(200)
  })
})
