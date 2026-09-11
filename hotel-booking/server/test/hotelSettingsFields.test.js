import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * `GET` и `PUT /api/hotel` — единственное место, где строка `HotelSettings`
 * целиком уходит клиенту. С волны «Хост в сети» в ней лежит приватный ключ
 * личности установки (`instancePrivateKey`), и цена утечки конкретная: любой,
 * кто его получил, может ответить в сети «хост теперь я», а сторож на рабочем
 * месте переедет на него и понесёт туда пароли сотрудников. Токен для запроса
 * тут не защита: `GET /api/hotel` доступен ЛЮБОМУ вошедшему, в том числе
 * администратору стойки с чужого ноутбука.
 *
 * Поэтому контроллер отдаёт белый список (`PUBLIC_FIELDS`), а не «всё, кроме».
 * Разница видна только в тесте вроде этого: при чёрном списке новая колонка
 * публикуется в тот же день, когда её добавили в схему, и заметить это некому.
 *
 * Тесты бьют в четыре места: чтение, ветка «строки нет — контроллер создаёт»
 * (там `create` возвращает ВСЕ колонки), ответ на запись и попытка записать
 * личность телом запроса.
 */

const errorHandler = loadCjs('src/middleware/errorHandler.js', {
  stubs: { '../utils/logger': silentLogger },
})

/** Секреты в том виде, в каком они лежат в базе у работающей установки. */
const SECRET = {
  instanceId: '6f1b3c52-9a7e-4a10-9f0c-1d2e3f405162',
  instancePublicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA-публичный\n-----END PUBLIC KEY-----\n',
  instancePrivateKey: '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEI-приватный\n-----END PRIVATE KEY-----\n',
}

const SECRET_FIELDS = Object.keys(SECRET)

/** Строка настроек со всеми колонками — как её отдаёт Prisma без `select`. */
function settingsRow(over = {}) {
  return {
    id: 1,
    name: 'Туран',
    city: 'Караганда',
    currency: 'KZT',
    pricingBase: 'person',
    lateArrivalHour: null,
    setupCompletedAt: new Date('2026-09-03T03:54:54.890Z'),
    legalName: 'ИП Оралбеков А.',
    bin: '990514300123',
    address: null,
    phone: null,
    email: null,
    bankName: null,
    iban: 'KZ868562000000327523',
    signerName: null,
    signerTitle: null,
    ...SECRET,
    updatedAt: new Date('2026-09-11T19:09:10.000Z'),
    ...over,
  }
}

function loadCtrl(rows = [settingsRow()]) {
  const { prisma, calls } = createFakePrisma({ hotelSettings: rows })
  const ctrl = loadCjs('src/controllers/hotelController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../middleware/errorHandler': errorHandler,
    },
  })
  return { ctrl, prisma, calls }
}

function run(handler, body = {}) {
  const res = { status: 200, body: null }
  const fakeRes = {
    status(code) { res.status = code; return fakeRes },
    json(payload) { res.body = payload; return fakeRes },
  }
  const next = (err) => { res.status = err.status || 500; res.body = { error: err.message } }
  return Promise.resolve(handler({ body, params: {}, query: {}, admin: { id: 1, role: 'ADMIN' } }, fakeRes, next))
    .then(() => res)
}

const get = (ctrl) => run(ctrl.get)
const put = (ctrl, body) => run(ctrl.update, body)

/** Всё, что уехало клиенту, одной строкой — искать секрет в ней надёжнее, чем по ключам. */
const wire = (res) => JSON.stringify(res.body)

// ─── Чтение ──────────────────────────────────────────────────────────────────

describe('GET /api/hotel — личность установки наружу не уходит', () => {
  it('в ответе нет ни приватного ключа, ни публичного, ни id установки', async () => {
    const { ctrl } = loadCtrl()

    const res = await get(ctrl)

    expect(res.status).toBe(200)
    for (const f of SECRET_FIELDS) expect(res.body.data).not.toHaveProperty(f)
    expect(wire(res)).not.toContain('PRIVATE KEY')
    expect(wire(res)).not.toContain(SECRET.instanceId)
  })

  it('ответ состоит ровно из белого списка — лишнего поля в нём взяться неоткуда', async () => {
    const { ctrl } = loadCtrl()

    const res = await get(ctrl)

    expect(Object.keys(res.body.data).sort()).toEqual([...ctrl.PUBLIC_FIELDS].sort())
    // Настройки, ради которых экран и открывают, на месте
    expect(res.body.data).toMatchObject({ name: 'Туран', pricingBase: 'person', iban: 'KZ868562000000327523' })
  })

  it('секреты не покидают даже базу: в select уходит тот же белый список', async () => {
    // Второй рубеж. Первый (`publicOnly`) вычищает ответ, этот не даёт колонке
    // доехать до процесса сервера вовсе — то есть и в текст ошибки Prisma.
    const { ctrl, calls } = loadCtrl()

    await get(ctrl)

    const read = calls.find((c) => c.op === 'findUnique')
    expect(read.args.select).toEqual(ctrl.PUBLIC_SELECT)
    for (const f of SECRET_FIELDS) expect(read.args.select).not.toHaveProperty(f)
  })

  it('строки настроек ещё нет: контроллер её создаёт — и всё равно не отдаёт секреты', async () => {
    // Ветка, в которой `select` не спасает: `create` без select возвращает ВСЕ
    // колонки, включая дефолты и то, что успел записать сосед по гонке.
    const { ctrl, prisma } = loadCtrl([])
    prisma.hotelSettings.create = async () => settingsRow({ name: 'Отель' })

    const res = await get(ctrl)

    expect(res.status).toBe(200)
    for (const f of SECRET_FIELDS) expect(res.body.data).not.toHaveProperty(f)
    expect(wire(res)).not.toContain('PRIVATE KEY')
  })
})

// ─── Запись ──────────────────────────────────────────────────────────────────

describe('PUT /api/hotel — ответ на сохранение тоже по белому списку', () => {
  it('после сохранения названия в ответе нет личности установки', async () => {
    // `update` возвращает то, что записал, — всю строку целиком. Один забытый
    // `publicOnly` здесь и есть утечка ключа.
    const { ctrl } = loadCtrl()

    const res = await put(ctrl, { name: 'Дорожник' })

    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('Дорожник')
    for (const f of SECRET_FIELDS) expect(res.body.data).not.toHaveProperty(f)
    expect(wire(res)).not.toContain('PRIVATE KEY')
  })

  it('личность из тела запроса игнорируется — подменить хост через настройки нельзя', async () => {
    // Иначе любой вошедший заменил бы пару ключей своей и увёл рабочие места
    // на свой ноутбук, не трогая ни одного пароля.
    const { ctrl, prisma } = loadCtrl()

    const res = await put(ctrl, {
      name: 'Туран',
      instanceId: 'подменённый-id',
      instancePublicKey: 'чужой открытый',
      instancePrivateKey: 'чужой закрытый',
    })

    expect(res.status).toBe(200)
    expect(prisma.hotelSettings.rows[0]).toMatchObject(SECRET)
  })

  it('сохранение реквизитов не задевает личность установки', async () => {
    const { ctrl, prisma } = loadCtrl()

    await put(ctrl, { bankName: 'АО «Kaspi Bank»', iban: 'kz86 8562 0000 0032 7523' })

    expect(prisma.hotelSettings.rows[0]).toMatchObject(SECRET)
    expect(prisma.hotelSettings.rows[0].iban).toBe('KZ868562000000327523')
  })

  it('GET и PUT отвечают одним и тем же набором полей', async () => {
    // Расхождение здесь означало бы, что форма настроек после сохранения
    // теряет поле, которого не ждала, — и следующий PUT его обнулит.
    const { ctrl } = loadCtrl()

    const a = await get(ctrl)
    const b = await put(ctrl, { name: 'Туран' })

    expect(Object.keys(b.body.data).sort()).toEqual(Object.keys(a.body.data).sort())
  })
})

// ─── Сам белый список ────────────────────────────────────────────────────────

describe('Белый список полей', () => {
  it('в нём нет ни одного поля личности установки', () => {
    const { ctrl } = loadCtrl()

    for (const f of SECRET_FIELDS) expect(ctrl.PUBLIC_FIELDS).not.toContain(f)
    expect(ctrl.PUBLIC_FIELDS.filter((f) => /^instance/i.test(f))).toEqual([])
  })

  it('publicOnly вычищает любое поле, которого нет в списке', () => {
    // Страховка на будущее: следующая колонка-секрет в HotelSettings (пароль
    // почты, токен интеграции) не опубликуется сама собой.
    const { ctrl } = loadCtrl()

    const out = ctrl.publicOnly({ ...settingsRow(), smtpPassword: 'секрет-из-будущего' })

    expect(out).not.toHaveProperty('smtpPassword')
    for (const f of SECRET_FIELDS) expect(out).not.toHaveProperty(f)
    expect(out.name).toBe('Туран')
  })

  it('publicOnly не выдумывает поля, которых в строке нет', () => {
    // Свежесозданная строка приходит почти пустой — «null» и «ключа нет» для
    // формы настроек разные вещи, и врать тут нечем.
    const { ctrl } = loadCtrl()

    const out = ctrl.publicOnly({ id: 1, name: 'Отель' })

    expect(Object.keys(out).sort()).toEqual(['id', 'name'])
  })
})
