import { describe, it, expect, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * `POST /api/setup/complete` — сама отдача программы в чужие руки (D1-001).
 *
 * `setupState.test.js` проверяет ГЕЙТ (что считать нетронутой базой). Здесь —
 * то, что происходит после гейта, и это отдельная история: между быстрым
 * отказом в начале обработчика и записью в базу проходит около полусекунды
 * (два-три bcrypt по 250 мс), и всё это время окно открыто. Мастер отправляют
 * дважды — с двух рабочих мест на свежей установке это буквально сценарий
 * «оба нажали кнопку» — и без сериализации второй запрос переписал бы логин и
 * пароль первого, не зная его.
 *
 * Сериализация сделана внутри транзакции тремя строками, и порядок у них
 * единственно верный:
 *   1) `INSERT INTO "HotelSettings" … ON CONFLICT (id) DO NOTHING` — точка
 *      сериализации. Без неё блокировать нечего: на базе, где строки настроек
 *      ещё нет, `SELECT … FOR UPDATE` не находит ни одной строки и НЕ ждёт
 *      никого — обе транзакции проходят проверку одновременно.
 *   2) `SELECT … FOR UPDATE` — второй запрос ждёт коммита первого.
 *   3) перечитанный под блокировкой состав учёток — отметку мог поставить
 *      кто-то другой ровно сейчас.
 * Поэтому тесты ниже проверяют не только ответы, но и то, что эти три запроса
 * вообще есть и идут в этом порядке: потерянный `FOR UPDATE` внешне не виден
 * никак — гонка редкая, а цена ей чужая база.
 *
 * Живой Postgres здесь не нужен: атомарность отката и настоящая параллельная
 * отправка проверены отдельно на пробной базе (см. отчёт волны) — здесь
 * закрепляется логика, которую видно без базы.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret'

const SEED_HASH = bcrypt.hashSync('admin', 4)

const seedRow = (over = {}) => ({
  id: 1, username: 'admin', name: 'Администратор', password: SEED_HASH,
  role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0, ...over,
})

/**
 * Мини-Prisma на две таблицы + сырой SQL. Своя, а не `fakePrisma`: там нет ни
 * `upsert`, ни `$executeRaw`/`$queryRaw`, а тут именно они и проверяются.
 *
 * `sql` — журнал сырых запросов в порядке вызова: по нему видно, что точка
 * сериализации на месте. `onTx` — крючок «пока транзакция шла, база изменилась»:
 * так воспроизводится гонка без потоков.
 */
function fakeDb({ admins = [], settings = null, onTx = null, failCreateMany = null } = {}) {
  const rows = admins.map((a) => ({ ...a }))
  let hotel = settings ? { id: 1, name: 'Отель', setupCompletedAt: null, ...settings } : null
  const sql = []
  let seq = rows.reduce((m, r) => Math.max(m, r.id || 0), 0)

  // Ровно тот `where`, которым контроллер ищет занятые логины:
  // { username: { in: [...] }, NOT: { username: 'admin' } }. Фильтр настоящий —
  // потерянный `NOT` (то есть «сидовый admin занят») тест обязан увидеть.
  const match = (rec, where = {}) => {
    if (where.username?.in && !where.username.in.includes(rec.username)) return false
    if (where.NOT?.username && rec.username === where.NOT.username) return false
    return true
  }

  const client = {
    admin: {
      findMany: async ({ where } = {}) => rows.filter((r) => match(r, where)).map((r) => ({ ...r })),
      findUnique: async ({ where }) => {
        const hit = rows.find((r) => (where.id != null ? r.id === where.id : r.username === where.username))
        return hit ? { ...hit } : null
      },
      update: async ({ where, data }) => {
        const hit = rows.find((r) => r.id === where.id)
        Object.assign(hit, data)
        return { ...hit }
      },
      create: async ({ data }) => {
        const rec = { id: ++seq, tokenVersion: 0, ...data }
        rows.push(rec)
        return { ...rec }
      },
      createMany: async ({ data }) => {
        if (failCreateMany) throw failCreateMany
        for (const d of data) {
          if (rows.some((r) => r.username === d.username)) {
            const e = new Error('Unique constraint failed on the fields: (`username`)')
            e.code = 'P2002'
            throw e
          }
          rows.push({ id: ++seq, tokenVersion: 0, ...d })
        }
        return { count: data.length }
      },
    },
    hotelSettings: {
      findUnique: async () => (hotel ? { ...hotel } : null),
      upsert: async ({ create, update }) => {
        hotel = hotel ? { ...hotel, ...update } : { id: 1, ...create }
        return { ...hotel }
      },
    },
    $executeRaw: async (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      sql.push({ text, values })
      // ON CONFLICT DO NOTHING: строка появляется, только если её не было
      if (/INSERT INTO "HotelSettings"/i.test(text) && !hotel) {
        hotel = { id: 1, name: values[0], setupCompletedAt: null }
        return 1
      }
      return 0
    },
    $queryRaw: async (strings, ...values) => {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      sql.push({ text, values })
      if (/FOR UPDATE/i.test(text)) return hotel ? [{ setupCompletedAt: hotel.setupCompletedAt }] : []
      return []
    },
  }

  const prisma = {
    ...client,
    $transaction: async (fn) => {
      // «Пока мы считали bcrypt, базу изменил кто-то другой»
      if (onTx) onTx({ rows, setHotel: (v) => { hotel = v } })
      return fn(client)
    },
  }
  return { prisma, sql, rows, hotelOf: () => hotel }
}

function loadController(prisma, { bcryptCalls = null } = {}) {
  // Считаем сверки пароля: они стоят по четверти секунды каждая (bcrypt cost 12)
  const bcryptStub = bcryptCalls
    ? { ...bcrypt, compare: (a, b) => { bcryptCalls.compare += 1; return bcrypt.compare(a, b) } }
    : bcrypt
  const setupState = loadCjs('src/utils/setupState.js', {
    stubs: { './logger': silentLogger, bcryptjs: bcryptStub },
  })
  return loadCjs('src/controllers/setupController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/setupState': setupState,
    },
  })
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
  }
}

const body = (over = {}) => ({
  hotel: { name: 'Дорожник', city: 'Алматы' },
  mainAdmin: { username: 'vladelec', name: 'Владелец', password: 'parol12345' },
  ...over,
})

async function complete(prisma, reqBody) {
  const ctrl = loadController(prisma)
  const res = mockRes()
  let nexted
  await ctrl.complete({ body: reqBody }, res, (e) => { nexted = e })
  return { res, nexted }
}

describe('setup/complete — сериализация двух отправок мастера', () => {
  it('точка сериализации на месте: вставка строки настроек идёт ДО блокирующего SELECT', async () => {
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body())

    expect(res.statusCode).toBe(201)
    expect(db.sql).toHaveLength(2)
    expect(db.sql[0].text).toMatch(/INSERT INTO "HotelSettings".*ON CONFLICT \(id\) DO NOTHING/i)
    expect(db.sql[1].text).toMatch(/SELECT "setupCompletedAt" FROM "HotelSettings" WHERE id = 1 FOR UPDATE/i)
  })

  it('название отеля уходит в сырой INSERT параметром, а не склейкой строк', async () => {
    // Склейка означала бы SQL-инъекцию из публичного эндпоинта; кириллица
    // и кавычка в названии — обычное дело («ТОО "Туран"»).
    const db = fakeDb({ admins: [seedRow()] })
    await complete(db.prisma, body({ hotel: { name: 'ТОО "Туран" — база отдыха' } }))
    expect(db.sql[0].values).toEqual(['ТОО "Туран" — база отдыха'])
    expect(db.sql[0].text).not.toContain('Туран')
  })

  it('отметку поставили, пока считался bcrypt — 409 SETUP_DONE, а не переписанный администратор', async () => {
    const db = fakeDb({
      admins: [seedRow()],
      // Соперник успел пройти мастер целиком между быстрой проверкой и транзакцией
      onTx: ({ rows, setHotel }) => {
        rows.splice(0, rows.length, seedRow({ username: 'sopernik', password: bcrypt.hashSync('drugoy12345', 4) }))
        setHotel({ id: 1, name: 'Чужой', setupCompletedAt: new Date('2026-09-08T10:00:00Z') })
      },
    })
    const { res, nexted } = await complete(db.prisma, body())

    expect(nexted).toBeUndefined()
    expect(res.statusCode).toBe(409)
    expect(res.body).toEqual({ error: 'Настройка уже выполнена', code: 'SETUP_DONE' })
    expect(db.rows.map((r) => r.username)).toEqual(['sopernik'])
  })

  it('соперник успел завести настоящую учётку, но отметку не поставил — всё равно 409', async () => {
    const db = fakeDb({
      admins: [seedRow()],
      onTx: ({ rows }) => {
        rows.push(seedRow({ id: 2, username: 'sopernik', password: bcrypt.hashSync('drugoy12345', 4) }))
      },
    })
    const { res } = await complete(db.prisma, body())
    expect(res.statusCode).toBe(409)
    expect(res.body.code).toBe('SETUP_DONE')
  })

  it('быстрый отказ до транзакции: живая база — 403 и ни одного сырого запроса', async () => {
    const db = fakeDb({
      admins: [seedRow({ username: 'oleg', password: bcrypt.hashSync('svoyparol12', 4) })],
      settings: { setupCompletedAt: new Date('2026-09-01T00:00:00Z') },
    })
    const { res } = await complete(db.prisma, body())
    expect(res.statusCode).toBe(403)
    expect(db.sql).toEqual([])
  })
})

describe('setup/complete — кого мастер переименовывает', () => {
  it('переименован именно сидовый admin, а не «первый попавшийся SUPER_ADMIN»', async () => {
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body())

    expect(res.statusCode).toBe(201)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].id).toBe(1)                       // та же строка, не новая
    expect(db.rows[0].username).toBe('vladelec')
    expect(db.rows[0].role).toBe('SUPER_ADMIN')
    expect(bcrypt.compareSync('parol12345', db.rows[0].password)).toBe(true)
  })

  it('пароль в базу кладётся хешем, а не как пришёл из формы', async () => {
    const db = fakeDb({ admins: [seedRow()] })
    await complete(db.prisma, body())
    expect(db.rows[0].password).not.toBe('parol12345')
    expect(db.rows[0].password.startsWith('$2')).toBe(true)
  })

  it('учёток нет вовсе (копия восстановилась без Admin) — главный создаётся, а не ищется', async () => {
    const db = fakeDb({ admins: [], settings: { setupCompletedAt: new Date('2026-09-01T00:00:00Z') } })
    const { res } = await complete(db.prisma, body())

    // Отметка стоит, но войти в программу некому — мастер уместен (решение D1-001)
    expect(res.statusCode).toBe(201)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].username).toBe('vladelec')
    expect(db.hotelOf().setupCompletedAt).toBeInstanceOf(Date)
  })

  it('сотрудник с логином «admin» рядом с переименованным сидом — не конфликт', async () => {
    // Сид уже переименован в главного, освободившийся логин занимает сотрудник стойки
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body({
      users: [{ username: 'admin', name: 'Стойка', password: 'parol12345', role: 'ADMIN' }],
    }))
    expect(res.statusCode).toBe(201)
    expect(db.rows.map((r) => `${r.username}:${r.role}`)).toEqual(['vladelec:SUPER_ADMIN', 'admin:ADMIN'])
  })

  it('токен авто-входа несёт версию сессии — иначе первый же запрос после мастера даст 401', async () => {
    const db = fakeDb({ admins: [seedRow({ tokenVersion: 3 })] })
    const { res } = await complete(db.prisma, body())
    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET)
    expect(payload).toMatchObject({ id: 1, role: 'SUPER_ADMIN', tv: 3 })
    expect(res.body.admin).not.toHaveProperty('password')
  })
})

describe('setup/complete — проверка логинов до записи', () => {
  it('один логин дважды в одной отправке — 400 с указанием на второе поле', async () => {
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body({
      mainAdmin: { username: 'petya', name: 'Пётр', password: 'parol12345' },
      users: [{ username: 'petya', name: 'Пётр второй', password: 'parol12345', role: 'ADMIN' }],
    }))
    expect(res.statusCode).toBe(400)
    expect(res.body.details[0].field).toBe('users[0].username')
    expect(db.sql).toEqual([])              // до транзакции дело не дошло
  })

  it('повтор внутри самого списка сотрудников тоже ловится', async () => {
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body({
      users: [
        { username: 'stoyka', name: 'Первая', password: 'parol12345', role: 'ADMIN' },
        { username: 'stoyka', name: 'Вторая', password: 'parol12345', role: 'ADMIN' },
      ],
    }))
    expect(res.statusCode).toBe(400)
    expect(res.body.details[0].field).toBe('users[1].username')
  })

  it('главный оставил себе логин «admin» — сидовая учётка не считается занятой', async () => {
    // Проверка «логин уже занят» исключает сидовый admin намеренно: его мастер
    // переименовывает, а не обходит. Побочное следствие — после гейта D1-001
    // эта проверка вообще не может сработать (учёток либо ноль, либо один
    // сидовый admin), и держится она только как страховка на случай, если
    // условие гейта когда-нибудь ослабят.
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await complete(db.prisma, body({
      mainAdmin: { username: 'admin', name: 'Владелец', password: 'parol12345' },
    }))
    expect(res.statusCode).toBe(201)
    expect(db.rows).toHaveLength(1)
    expect(bcrypt.compareSync('parol12345', db.rows[0].password)).toBe(true)
  })

  it('сбой внутри транзакции уходит в next(err) — 201 не отвечаем', async () => {
    const boom = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    const db = fakeDb({ admins: [seedRow()], failCreateMany: boom })
    const { res, nexted } = await complete(db.prisma, body({
      users: [{ username: 'stoyka', name: 'Стойка', password: 'parol12345', role: 'ADMIN' }],
    }))
    expect(nexted).toBe(boom)               // errorHandler переведёт P2002 в 409
    expect(res.statusCode).not.toBe(201)
  })
})

/**
 * `GET /api/setup/status` — публичный эндпоинт, который клиент зовёт при КАЖДОМ
 * запуске программы, ещё до экрана входа.
 *
 * Отвечает он на вопрос «показывать ли мастер», и в 99 % запусков ответ известен
 * заранее: отметка `setupCompletedAt` стоит, учётки есть — мастер не нужен.
 * Но состав учёток при этом всё равно проверяется по паролю, а это bcrypt
 * стоимостью 12: четверть секунды процессорного времени на сверку, и до двух
 * сверок подряд (сид ставил то `admin`, то `admin123`).
 */
describe('setup/status — цена ответа «мастер не нужен»', () => {
  const own = bcrypt.hashSync('svoyparol12', 4)

  async function status(prisma, opts) {
    const ctrl = loadController(prisma, opts)
    const res = mockRes()
    let nexted
    await ctrl.status({}, res, (e) => { nexted = e })
    return { res, nexted }
  }

  it('ответ — только needsSetup и название; служебное «отметку починили» наружу не уходит', async () => {
    const db = fakeDb({
      admins: [seedRow({ username: 'oleg', password: own })],
      settings: { name: 'Туран' },       // отметки нет — состояние будет вылечено
    })
    const { res } = await status(db.prisma)
    expect(res.body).toEqual({ needsSetup: false, hotelName: 'Туран' })
    expect(res.body).not.toHaveProperty('healed')
    expect(db.hotelOf().setupCompletedAt).toBeInstanceOf(Date)
  })

  it('на нетронутой базе пароль сида действительно сверяется — иначе гейт не работает', async () => {
    const calls = { compare: 0 }
    const db = fakeDb({ admins: [seedRow()] })
    const { res } = await status(db.prisma, { bcryptCalls: calls })
    expect(res.body.needsSetup).toBe(true)
    expect(calls.compare).toBeGreaterThan(0)
  })

  /**
   * НАХОДКА (D1-001, цена решения). При стоящей отметке результат `isSeedOnly`
   * не используется НИГДЕ: `needsSetup` вырождается в `admins.length === 0`, а
   * ветка самолечения закрыта условием `!marked`. Тем не менее
   * `utils/setupState.js:66` считает его безусловно — то есть на каждый
   * публичный `GET /api/setup/status` приходится до двух bcrypt(12).
   *
   * Вход, при котором это стреляет: отель, где единственная учётка сохранила
   * логин `admin`, а пароль сменили на свой (самый вероятный расклад у первого
   * клиента). Замерено на этой машине: 307 мс + 255 мс = ~0,56 с процессорного
   * времени на КАЖДЫЙ запрос статуса. Последствий два: (1) запуск программы
   * ждёт лишние полсекунды до экрана входа; (2) эндпоинт публичный и висит на
   * общем ограничителе (500 запросов в минуту с адреса в production) — то есть
   * любой в локальной сети может занять сервер счётом хешей, не имея учётной
   * записи, и стойка получит зависший экран.
   *
   * Чинить — вопрос доменный (порядок проверок в `getSetupState`), поэтому тест
   * оставлен ожидаемо падающим: при стоящей отметке сверок пароля быть не должно.
   */
  it('отметка настройки стоит — пароли сверять незачем, bcrypt звать не должны', async () => {
    const calls = { compare: 0 }
    const db = fakeDb({
      admins: [seedRow({ password: own })],           // логин admin, пароль свой
      settings: { setupCompletedAt: new Date('2026-09-01T00:00:00Z') },
    })
    const { res } = await status(db.prisma, { bcryptCalls: calls })
    expect(res.body.needsSetup).toBe(false)
    expect(calls.compare).toBe(0)
  })

  it('две учётки и больше — сверок нет и сейчас: состав уже не сидовый', async () => {
    const calls = { compare: 0 }
    const db = fakeDb({
      admins: [seedRow(), seedRow({ id: 2, username: 'stoyka' })],
      settings: { setupCompletedAt: new Date('2026-09-01T00:00:00Z') },
    })
    const { res } = await status(db.prisma, { bcryptCalls: calls })
    expect(res.body.needsSetup).toBe(false)
    expect(calls.compare).toBe(0)
  })
})
