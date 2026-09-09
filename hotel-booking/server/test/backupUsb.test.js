import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Волна 6a — «копии на флешку и перенос на новый ноутбук».
 *
 * Смысл затеи: копия лежит ОТДЕЛЬНО от базы (на флешке), и при смене ноутбука
 * достаточно восстановиться из неё. Отсюда четыре новых места, где всё может
 * молча развалиться, — по ним и бьют тесты:
 *
 *   1. **Флешки нет.** Её вынимают, диск E: исчезает. «Копии нет вообще» хуже,
 *      чем «копия локально», поэтому недоступная BACKUP_PATH — не отказ, а
 *      запись в запасную папку с пометкой. Проверяем и то, что копия
 *      действительно легла в запасную папку, и то, что об этом ВИДНО
 *      (`BackupLog.error`, статус для баннера).
 *   2. **Ротация.** BACKUP_KEEP считается для каждой папки отдельно: копия,
 *      снятая без флешки, не должна вытеснять копии на флешке и наоборот.
 *   3. **Пропуски.** Ноутбук ночью выключен → cron 03:00 просто не наступает
 *      внутри процесса сервера. Догоняющая копия при старте и периодическая
 *      во время работы — единственное, что закрывает D8-003, и они держатся
 *      на `shouldCatchUp`, где ошибка «>» вместо «>=» стоит суток без копии.
 *   4. **Перенос.** Файл с чужого компьютера приходит по сети: имя файла —
 *      пользовательский ввод (`../`, пробелы, кириллица), содержимое — что
 *      угодно. Мусор обязан отличаться от «копии не той версии»: пользователю
 *      важно знать, принёс он не тот файл или файл от другой версии программы.
 *
 * Плюс внутренний путь `POST /api/system/backup` с `X-Internal-Token` — копия
 * при выходе из программы. Это единственное место во всём API, куда пускают
 * без JWT, поэтому его границы (только петля, только при заданном секрете,
 * только этот роут) проверяются отдельно.
 *
 * Живая база не нужна: Prisma подменяется `fakePrisma`, файловая система —
 * настоящая, но во временной папке (как в `backup.test.js`).
 */

// ─── Временные папки: «флешка» и запасная папка рядом с программой ───────────

let root = null
let usb = null // BACKUP_PATH — «флешка»
let local = null // BACKUP_FALLBACK_PATH — userData/backups в упакованной программе

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-usb-'))
  usb = path.join(root, 'usb')
  local = path.join(root, 'local')
  fs.mkdirSync(usb, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
  delete process.env.INTERNAL_TOKEN
  fs.rmSync(root, { recursive: true, force: true })
})

/** Путь на заведомо отсутствующем диске: ровно «флешку вынули». */
const NO_DRIVE = process.platform === 'win32' ? 'Q:\\nope\\Roomline' : '/nope-drive/Roomline'
const isWin = process.platform === 'win32'

const jsonFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [])

/** Файл копии на диске + заданное время изменения (по нему считается ротация). */
function putFile(dir, name, dump = { version: 2, createdAt: new Date().toISOString(), tables: {} }, mtimeSec = null) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, JSON.stringify(dump), 'utf8')
  if (mtimeSec !== null) fs.utimesSync(p, mtimeSec, mtimeSec)
  return p
}

// ─── Мини-база ────────────────────────────────────────────────────────────────

/** Модели, которые видит копия. Их состав и порядок backup.js берёт из DMMF. */
function fixture(backupLog = []) {
  return {
    admin: [{
      id: 1, username: 'admin', password: 'x', name: 'Главный администратор',
      role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0,
      createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-01T00:00:00Z'),
    }],
    category: [{ id: 2, name: 'Стандарт', color: '#123456', description: null }],
    room: [{
      id: 10, number: '101', categoryId: 2, building: 'A', floor: 1,
      features: [], capacity: 'double', isActive: true, createdAt: new Date('2026-01-01T00:00:00Z'),
    }],
    booking: [{
      id: 41, roomId: 10, guestName: 'Асель', checkIn: new Date('2026-08-25T00:00:00Z'),
      checkOut: new Date('2026-08-28T00:00:00Z'), status: 'CONFIRMED', totalAmount: 90000,
      paidAmount: 60000, adminId: 1, accountBookingId: null,
      createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-01T10:00:00Z'),
    }],
    bookingCharge: [{
      id: 71, bookingId: 41, kind: 'stay', label: 'Проживание', amount: 90000,
      source: 'auto', createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-01T10:00:00Z'),
    }],
    bookingService: [],
    payment: [{
      id: 5, bookingId: 41, kind: 'payment', amount: 60000, method: 'cash', adminId: 1,
      refundOfId: null, voidedAt: null, paidAt: new Date('2026-08-25T09:00:00Z'),
      createdAt: new Date('2026-08-25T09:00:00Z'), updatedAt: new Date('2026-08-25T09:00:00Z'),
    }],
    backupLog,
  }
}

function makeDb(backupLog = []) {
  const { prisma, calls } = createFakePrisma(fixture(backupLog))
  // `BackupLog.createdAt` в схеме — @default(now()); fakePrisma умолчаний не знает,
  // а вся логика догоняющей копии считает именно возраст записи.
  const create = prisma.backupLog.create.bind(prisma.backupLog)
  prisma.backupLog.create = (args) => create({ ...args, data: { createdAt: new Date(), ...args.data } })
  prisma.$queryRaw = async () => [{ ok: 1 }]
  return { prisma, calls, logs: prisma.backupLog.rows }
}

const HOUR = 3600 * 1000
/** Запись журнала копий «столько-то часов назад». */
function logRow({ id = 1, hoursAgo = 1, success = true, error = null, dir = null, name = 'backup_2026-09-08_03-00.json', now = Date.now() } = {}) {
  return {
    id, path: path.join(dir ?? '/tmp/usb', name), size: 1234, success, error,
    createdAt: new Date(now - hoursAgo * HOUR),
  }
}

// ─── Загрузка backup.js ───────────────────────────────────────────────────────

function recordingLogger() {
  const lines = { info: [], warn: [], error: [] }
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug() {}, verbose() {},
  }
}

/**
 * Константы (папки, KEEP, часы, задержка) backup.js читает из env ОДИН РАЗ при
 * загрузке — поэтому модуль грузится заново на каждый тест, через loadCjs.
 */
function loadBackup({
  prisma, logger = silentLogger, target = usb, fallback = local,
  keep = '50', maxAgeHours = '20', everyHours = '4', catchUpMs = '1000',
} = {}) {
  process.env.BACKUP_PATH = target
  process.env.BACKUP_FALLBACK_PATH = fallback
  process.env.BACKUP_KEEP = keep
  process.env.BACKUP_MAX_AGE_HOURS = maxAgeHours
  process.env.BACKUP_EVERY_HOURS = everyHours
  process.env.BACKUP_CATCH_UP_DELAY_MS = catchUpMs
  return loadCjs('src/utils/backup.js', {
    stubs: {
      './prisma': { prisma },
      './logger': logger,
      'node-cron': { schedule() { return { stop() {} } } },
      '../middleware/errorHandler': {
        createError: (message, status = 400) => Object.assign(new Error(message), { status }),
      },
    },
  })
}

// ─── Загрузка routes/system.js и вызов роутов без поднятия сервера ───────────

/**
 * Роутер Express — обычная функция (req, res, next), поэтому его прогоняют
 * напрямую: supertest в devDependencies нет, а ставить пакеты в этой задаче
 * нельзя. Заодно это единственный способ подсунуть `req.ip` не с петли.
 */
function callRoute(router, { method = 'GET', url = '/', headers = {}, ip = '127.0.0.1', body = undefined } = {}) {
  return new Promise((resolve, reject) => {
    const h = {}
    for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
    const req = {
      method, url, originalUrl: url, headers: h, body, ip,
      get: (n) => h[String(n).toLowerCase()],
    }
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this },
      send(payload) { resolve({ status: this.statusCode, body: payload }); return this },
      end() { resolve({ status: this.statusCode, body: undefined }); return this },
      setHeader() {}, getHeader() { return undefined }, removeHeader() {},
    }
    try {
      router(req, res, (err) => {
        if (err) return resolve({ status: err.status || 500, body: { error: err.message }, error: err })
        resolve({ status: 404, body: null })
      })
    } catch (err) { reject(err) }
  })
}

/**
 * `authenticate` в заглушке ведёт себя как настоящий: без заголовка Authorization
 * — 401. Именно это и означает «внутренний путь не сработал»: запрос падает
 * ниже, в обычную проверку JWT.
 */
function loadSystemRoutes({ backup, prisma, logger = recordingLogger(), internalToken = undefined }) {
  if (internalToken === undefined) delete process.env.INTERNAL_TOKEN
  else process.env.INTERNAL_TOKEN = internalToken
  const seen = { authenticate: 0, roles: [] }
  const router = loadCjs('src/routes/system.js', {
    stubs: {
      '../middleware/auth': {
        authenticate: (req, res, next) => {
          seen.authenticate += 1
          if (!req.headers.authorization) return res.status(401).json({ error: 'Требуется авторизация' })
          req.admin = { id: 1, role: 'SUPER_ADMIN' }
          next()
        },
        requireRole: (...roles) => (_req, _res, next) => { seen.roles.push(roles); next() },
      },
      '../utils/prisma': { prisma },
      '../utils/logger': logger,
      '../utils/backup': backup,
    },
  })
  return { router, seen, logger }
}

// ─── 1. shouldCatchUp: нужна ли копия прямо сейчас ───────────────────────────

describe('shouldCatchUp — нужна ли догоняющая копия', () => {
  const now = new Date('2026-09-08T10:00:00Z')

  it('без единой удачной копии копия нужна', () => {
    const backup = loadBackup({ prisma: makeDb().prisma })
    expect(backup.shouldCatchUp(null, now, 20)).toBe(true)
  })

  it('последняя удачная 19 часов назад при пороге 20 — догонять нечего', () => {
    const backup = loadBackup({ prisma: makeDb().prisma })
    const last = { success: true, createdAt: new Date(now.getTime() - 19 * HOUR) }
    expect(backup.shouldCatchUp(last, now, 20)).toBe(false)
  })

  it('последняя удачная 21 час назад при пороге 20 — копия нужна', () => {
    const backup = loadBackup({ prisma: makeDb().prisma })
    const last = { success: true, createdAt: new Date(now.getTime() - 21 * HOUR) }
    expect(backup.shouldCatchUp(last, now, 20)).toBe(true)
  })

  it('возраст ровно в порог уже считается просроченным', () => {
    const backup = loadBackup({ prisma: makeDb().prisma })
    const last = { success: true, createdAt: new Date(now.getTime() - 20 * HOUR) }
    // Граница включающая (>=): иначе периодическая копия каждые 4 ч, которую
    // будит таймер ровно через 4 ч, не срабатывала бы никогда.
    expect(backup.shouldCatchUp(last, now, 20)).toBe(true)
  })

  it('битая дата в журнале трактуется в пользу копии', () => {
    const backup = loadBackup({ prisma: makeDb().prisma })
    expect(backup.shouldCatchUp({ success: true, createdAt: 'не дата' }, now, 20)).toBe(true)
  })

  it('свежая неудачная попытка поверх удачной пятичасовой копию не заставляет', async () => {
    // В журнале самая новая запись — ПРОВАЛ, а под ней удачная копия 5 часов
    // назад. Возраст считается по удачной, иначе каждая неудачная попытка
    // (флешку выдернули на секунду) запускала бы копию на каждом тике.
    const now2 = Date.now()
    const { prisma } = makeDb([
      logRow({ id: 1, hoursAgo: 5, success: true, dir: usb, now: now2 }),
      logRow({ id: 2, hoursAgo: 0.1, success: false, error: 'ENOENT', dir: usb, now: now2 }),
    ])
    const backup = loadBackup({ prisma })

    const lastOk = await backup.lastSuccessfulBackupLog()
    expect(lastOk.success).toBe(true)
    expect(backup.shouldCatchUp(lastOk, new Date(now2), 20)).toBe(false)
  })
})

// ─── 2. Флешки нет: копия уходит в запасную папку ────────────────────────────

describe('копия при недоступной BACKUP_PATH', () => {
  it.runIf(isWin)('несуществующий диск уводит копию в запасную папку, а сам диск не создаётся', async () => {
    const { prisma, logs } = makeDb()
    const backup = loadBackup({ prisma, target: NO_DRIVE })

    const res = await backup.createBackup()

    expect(res.fallbackUsed).toBe(true)
    expect(path.dirname(res.path)).toBe(local)
    expect(jsonFiles(local)).toHaveLength(1)
    // Программа не имеет права «починить» отсутствующую флешку, создав папку
    // на другом диске: файлы окажутся не там, где их ищут.
    expect(fs.existsSync('Q:\\nope')).toBe(false)

    expect(logs).toHaveLength(1)
    expect(logs[0].success).toBe(true)
    expect(logs[0].path).toBe(res.path)
    expect(logs[0].size).toBeGreaterThan(0)
    expect(logs[0].error).toMatch(/^BACKUP_PATH недоступна: /)
    expect(logs[0].error).toContain('нет диска')
  })

  it('путь, занятый файлом, тоже уводит копию в запасную папку', async () => {
    const busy = path.join(root, 'not-a-dir')
    fs.writeFileSync(busy, 'я файл, а не папка', 'utf8')
    const { prisma, logs } = makeDb()
    const backup = loadBackup({ prisma, target: path.join(busy, 'Roomline') })

    const res = await backup.createBackup()

    expect(res.fallbackUsed).toBe(true)
    expect(path.dirname(res.path)).toBe(local)
    expect(logs[0].success).toBe(true)
    expect(logs[0].error).toMatch(/^BACKUP_PATH недоступна: /)
    expect(logs[0].error).toContain('ENOTDIR')
  })

  it('копия в запасной папке — полноценный файл, а не заглушка', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, target: path.join(root, 'not-a-dir-2', 'x') })
    fs.writeFileSync(path.join(root, 'not-a-dir-2'), 'файл', 'utf8')

    const res = await backup.createBackup()
    const dump = JSON.parse(fs.readFileSync(res.path, 'utf8'))

    // Ради этого fallback и заведён: из локальной копии можно восстановиться,
    // включая кассу. «Копия есть, но пустая» была бы хуже её отсутствия.
    expect(dump.version).toBe(2)
    expect(dump.tables.Payment).toHaveLength(1)
    expect(dump.tables.Booking).toHaveLength(1)
  })

  it('доступная флешка — копия на ней, error пуст, запасная папка не создаётся', async () => {
    const { prisma, logs } = makeDb()
    const backup = loadBackup({ prisma })

    const res = await backup.createBackup()

    expect(res.fallbackUsed).toBe(false)
    expect(res.fallbackReason).toBe(null)
    expect(path.dirname(res.path)).toBe(usb)
    expect(logs[0]).toMatchObject({ success: true, error: null, path: res.path })
    // Пустая папка «backups-local» рядом с программой на ровном месте — мусор,
    // а в разделе копий она ещё и намекала бы на проблему, которой нет.
    expect(fs.existsSync(local)).toBe(false)
  })

  it('несуществующая папка на СУЩЕСТВУЮЩЕМ диске создаётся сама — это первая настройка', async () => {
    const fresh = path.join(root, 'usb', 'Roomline-копии')
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, target: fresh })

    const res = await backup.createBackup()

    expect(res.fallbackUsed).toBe(false)
    expect(path.dirname(res.path)).toBe(fresh)
    expect(fs.existsSync(local)).toBe(false)
  })

  it('недоступная ЗАПАСНАЯ папка тоже попадает в журнал копий', async () => {
    // Найдено тестом (см. отчёт): resolveBackupDir() зовётся ДО try в createBackup,
    // поэтому падение mkdir запасной папки не пишет BackupLog(success: false).
    // Наружу это выглядит как «последняя запись журнала — удачная», то есть
    // статус копий бодро рапортует о копии, которой нет.
    const busy = path.join(root, 'local-busy')
    fs.writeFileSync(busy, 'файл', 'utf8')
    const { prisma, logs } = makeDb()
    const backup = loadBackup({ prisma, target: NO_DRIVE, fallback: path.join(busy, 'backups') })

    await expect(backup.createBackup()).rejects.toThrow()
    expect(logs).toHaveLength(1)
    expect(logs[0].success).toBe(false)
  })
})

// ─── 3. Ротация BACKUP_KEEP — по каждой папке отдельно ───────────────────────

describe('ротация копий', () => {
  it('на флешке удаляются только копии флешки, локальные не трогаются', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, keep: '2' })
    // Две «локальные» копии, снятые когда-то без флешки
    putFile(local, 'backup_2026-09-01_03-00.json')
    putFile(local, 'backup_2026-09-02_03-00.json')

    const a = await backup.createBackup()
    fs.utimesSync(a.path, 1000, 1000)
    const b = await backup.createBackup()
    fs.utimesSync(b.path, 2000, 2000)
    const c = await backup.createBackup()

    expect(jsonFiles(usb)).toHaveLength(2)
    expect(fs.existsSync(a.path)).toBe(false) // самая старая на флешке
    expect(fs.existsSync(b.path)).toBe(true)
    expect(fs.existsSync(c.path)).toBe(true)
    // Локальные копии живут по своему счётчику — иначе одна поездка с флешкой
    // стёрла бы всё, что накопилось без неё.
    expect(jsonFiles(local)).toHaveLength(2)
  })

  it('без флешки ротация идёт в запасной папке, а копии на флешке целы', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, target: NO_DRIVE, keep: '2' })
    putFile(usb, 'backup_2026-09-01_03-00.json')
    putFile(usb, 'backup_2026-09-02_03-00.json')
    putFile(usb, 'backup_2026-09-03_03-00.json')

    const a = await backup.createBackup()
    fs.utimesSync(a.path, 1000, 1000)
    const b = await backup.createBackup()
    fs.utimesSync(b.path, 2000, 2000)
    await backup.createBackup()

    expect(jsonFiles(local)).toHaveLength(2)
    expect(fs.existsSync(a.path)).toBe(false)
    // Папка флешки в этом прогоне вообще недоступна — её файлы не пересчитываются
    expect(jsonFiles(usb)).toHaveLength(3)
  })
})

// ─── 4. Список и чтение — по обеим папкам ────────────────────────────────────

describe('список копий и чтение файла', () => {
  it('в списке файлы обеих папок, у запасной — признак local', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    putFile(usb, 'backup_2026-09-01_03-00.json', undefined, 1000)
    putFile(local, 'backup_2026-09-07_03-00.json', undefined, 2000)

    const files = backup.listBackupFiles()

    expect(files.map((f) => f.name)).toEqual([
      'backup_2026-09-07_03-00.json', // новее — сверху, независимо от папки
      'backup_2026-09-01_03-00.json',
    ])
    expect(files[0]).toMatchObject({ local: true })
    expect(files[1]).toMatchObject({ local: false })
    expect(files[0].size).toBeGreaterThan(0)
    expect(typeof files[0].createdAt).toBe('string')
  })

  it('копия из запасной папки читается по имени — иначе восстанавливать было бы нечего', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    // Файла на флешке нет вовсе: ровно случай «копию сняли без флешки, и она единственная»
    putFile(local, 'backup_2026-09-07_03-00.json', {
      version: 2, createdAt: '2026-09-07T22:00:00.000Z', tables: { Booking: [], Payment: [] },
    })

    const impact = await backup.describeRestore('backup_2026-09-07_03-00.json')

    expect(impact.file).toBe('backup_2026-09-07_03-00.json')
    expect(impact.version).toBe(2)
  })

  it('одноимённые файлы в двух папках не задваиваются в списке', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    putFile(usb, 'backup_2026-09-07_03-00.json')
    putFile(local, 'backup_2026-09-07_03-00.json')

    const files = backup.listBackupFiles()

    // Восстановление ищет файл по имени и берёт первый найденный — в списке
    // должна быть ровно одна строка, иначе пользователь выбирает вслепую.
    expect(files).toHaveLength(1)
    expect(files[0].local).toBe(false)
  })

  it('посторонние файлы в папке копий в список не попадают', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    putFile(usb, 'backup_2026-09-07_03-00.json')
    fs.writeFileSync(path.join(usb, 'заметки.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(usb, 'backup_2026-09-07_03-00.json.tmp'), '{}', 'utf8')

    expect(backup.listBackupFiles().map((f) => f.name)).toEqual(['backup_2026-09-07_03-00.json'])
  })
})

// ─── 5. Статус копий ─────────────────────────────────────────────────────────

describe('статус копий', () => {
  it('пустой журнал: never, возраст неизвестен', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    expect(res.status).toBe(200)
    expect(res.body.backup).toEqual({ lastOkAt: null, ageHours: null, warning: 'never' })
  })

  it('свежая копия на флешке: none и возраст в часах', async () => {
    const now = Date.now()
    const { prisma } = makeDb([logRow({ hoursAgo: 3.5, dir: usb, now })])
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    expect(res.body.backup.warning).toBe('none')
    expect(res.body.backup.ageHours).toBeCloseTo(3.5, 1)
    expect(res.body.backup.lastOkAt).toBe(new Date(now - 3.5 * HOUR).toISOString())
  })

  it('копия старше двух суток: stale', async () => {
    const { prisma } = makeDb([logRow({ hoursAgo: 50, dir: usb })])
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    expect(res.body.backup.warning).toBe('stale')
    expect(res.body.backup.ageHours).toBeCloseTo(50, 0)
  })

  it('копия на границе 48 часов ещё не считается просроченной', async () => {
    const { prisma } = makeDb([logRow({ hoursAgo: 47.9, dir: usb })])
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    expect(res.body.backup.warning).toBe('none')
  })

  it('последняя удачная копия в запасной папке: fallback', async () => {
    const { prisma } = makeDb([
      logRow({ hoursAgo: 2, dir: local, error: 'BACKUP_PATH недоступна: нет диска E:\\' }),
    ])
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    // Это и есть повод для жёлтой полосы «вставьте флешку»: копия есть, но не там
    expect(res.body.backup.warning).toBe('fallback')
  })

  it('GET /status не выдаёт путей к папкам', async () => {
    const { prisma } = makeDb([logRow({ hoursAgo: 2, dir: usb })])
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/status', headers: { authorization: 'Bearer x' } })

    // Роут открыт любому вошедшему; полный путь содержит имя пользователя Windows
    expect(Object.keys(res.body.backup).sort()).toEqual(['ageHours', 'lastOkAt', 'warning'])
    expect(JSON.stringify(res.body)).not.toContain(usb)
    expect(res.body).toMatchObject({ server: 'ok', db: 'ok' })
  })

  it('targetAvailable ложен и назван причиной, когда флешки нет', async () => {
    const { prisma } = makeDb([logRow({ hoursAgo: 2, dir: local, error: 'BACKUP_PATH недоступна: x' })])
    const backup = loadBackup({ prisma, target: NO_DRIVE })

    const st = await backup.backupStatus()

    expect(st.targetAvailable).toBe(false)
    expect(typeof st.targetProblem).toBe('string')
    expect(st.fallbackUsed).toBe(true)
    expect(st.fallbackPath).toBe(local)
    expect(st.lastError).toContain('BACKUP_PATH недоступна')
  })

  it('статус ничего не создаёт на диске', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, target: path.join(root, 'usb', 'ещё-нет-такой') })

    await backup.backupStatus()

    // Раздел копий открывают часто; побочные эффекты у справки недопустимы
    expect(fs.existsSync(path.join(root, 'usb', 'ещё-нет-такой'))).toBe(false)
    expect(fs.existsSync(local)).toBe(false)
  })

  it('GET /backups отдаёт last, files и status по контракту', async () => {
    const { prisma } = makeDb([logRow({ hoursAgo: 2, dir: usb })])
    const backup = loadBackup({ prisma })
    putFile(usb, 'backup_2026-09-07_03-00.json')
    putFile(local, 'backup_2026-09-06_03-00.json')
    const { router } = loadSystemRoutes({ backup, prisma })

    const res = await callRoute(router, { url: '/backups', headers: { authorization: 'Bearer x' } })

    expect(res.status).toBe(200)
    expect(Object.keys(res.body.data).sort()).toEqual(['files', 'last', 'status'])
    expect(res.body.data.last).toMatchObject({ success: true })
    expect(res.body.data.files.map((f) => f.local).sort()).toEqual([false, true])
    expect(Object.keys(res.body.data.status).sort()).toEqual([
      'fallbackPath', 'fallbackUsed', 'lastError', 'lastOkAt', 'lastOkPath',
      'targetAvailable', 'targetPath', 'targetProblem',
    ])
    // Здесь пути как раз нужны: раздел показывает, куда именно пишутся копии
    expect(res.body.data.status.targetPath).toBe(usb)
  })
})

// ─── 6. Файл копии с другого компьютера ──────────────────────────────────────

describe('загрузка копии с другого компьютера', () => {
  const goodDump = () => ({
    version: 2,
    createdAt: '2026-09-07T22:00:00.000Z',
    tables: { Admin: [], Room: [], Booking: [], Payment: [] },
  })

  it('валидный файл ложится в папку копий под безопасным именем', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    const res = backup.importBackupDump(goodDump(), 'база дяди.json')

    expect(res.fileName).toMatch(/^imported_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_[0-9A-Za-z_-]+\.json$/)
    expect(path.dirname(res.path)).toBe(usb)
    expect(jsonFiles(usb)).toEqual([res.fileName])
    expect(JSON.parse(fs.readFileSync(res.path, 'utf8')).version).toBe(2)
  })

  it('имя с ../ не выводит файл за пределы папки копий', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    const res = backup.importBackupDump(goodDump(), '../../../Windows/System32/evil .json')

    expect(res.fileName).not.toContain('..')
    expect(res.fileName).not.toMatch(/[\\/]/)
    expect(path.dirname(path.resolve(res.path))).toBe(path.resolve(usb))
    // Кириллица и пробелы схлопываются, хвост исходного имени сохраняется читаемым
    expect(res.fileName).toContain('evil')
  })

  it('загруженный файл виден в списке и читается на восстановление', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    const { fileName } = backup.importBackupDump(goodDump(), 'копия.json')

    expect(backup.listBackupFiles().map((f) => f.name)).toContain(fileName)
    const impact = await backup.describeRestore(fileName)
    expect(impact.file).toBe(fileName)
    // В файле нет BookingCharge/BookingService, а в базе они есть — восстановление
    // обязано предупредить, а не молча обнулить
    expect(impact.requiresConfirmation).toBe(true)
  })

  it('мусор вместо копии — 400 «Это не файл резервной копии Roomline PMS»', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    expect(() => backup.importBackupDump({ hello: 1 }, 'hello.json'))
      .toThrow('Это не файл резервной копии Roomline PMS')
    try { backup.importBackupDump({ hello: 1 }, 'hello.json') } catch (e) { expect(e.status).toBe(400) }
    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('чужой JSON с непонятными таблицами — тоже не копия', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    // Формально форма верна (version + tables), но ни одной нашей таблицы нет
    expect(() => backup.importBackupDump(
      { version: 2, tables: { Users: [{ id: 1 }], Orders: [] } }, 'other-app.json',
    )).toThrow('Это не файл резервной копии Roomline PMS')
    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('копия чужой версии отвергается с текстом про версию, а не «это не копия»', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    // Разница принципиальная: «принёс не тот файл» человек исправит сам,
    // «копия от другой версии программы» — повод обновить программу
    expect(() => backup.importBackupDump({ ...goodDump(), version: 7 }, 'копия.json'))
      .toThrow(/версии 7 не поддерживается/)
    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('при недоступной флешке загруженный файл ложится в запасную папку', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, target: NO_DRIVE })

    const res = backup.importBackupDump(goodDump(), 'копия.json')

    expect(res.fallbackUsed).toBe(true)
    expect(path.dirname(res.path)).toBe(local)
    // И сразу же доступен на восстановление — иначе перенос на новый ноутбук
    // без флешки в разъёме был бы невозможен
    expect(backup.listBackupFiles().map((f) => f.name)).toContain(res.fileName)
  })

  it('второй файл с тем же именем не затирает первый', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })

    const a = backup.importBackupDump(goodDump(), 'копия.json')
    const b = backup.importBackupDump({ ...goodDump(), createdAt: '2026-09-08T22:00:00.000Z' }, 'копия.json')

    expect(b.fileName).not.toBe(a.fileName)
    expect(jsonFiles(usb)).toHaveLength(2)
  })

  it('принесённый файл не вытесняется своими копиями', async () => {
    // Найдено тестом (см. отчёт): ротация удаляет по маске и `imported_`, поэтому
    // файл, принесённый на новый ноутбук, исчезает после BACKUP_KEEP очередных
    // копий (при KEEP=14 и копии каждые 4 ч — примерно через двое суток).
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma, keep: '1' })

    const imported = backup.importBackupDump(goodDump(), 'база дяди.json')
    fs.utimesSync(imported.path, 1000, 1000)
    await backup.createBackup()
    await backup.createBackup()

    expect(fs.existsSync(imported.path)).toBe(true)
  })
})

// ─── 7. Расписание: догоняющая и периодическая копии ─────────────────────────

describe('расписание копий', () => {
  const T0 = new Date('2026-09-08T10:00:00Z')

  it('догоняющая копия снимается через BACKUP_CATCH_UP_DELAY_MS, если копий нет', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma, logs } = makeDb()
    const backup = loadBackup({ prisma, catchUpMs: '30000' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(29000)
    expect(jsonFiles(usb)).toHaveLength(0) // до задержки сервер не отвлекают

    await vi.advanceTimersByTimeAsync(2000)
    expect(jsonFiles(usb)).toHaveLength(1)
    expect(logs).toHaveLength(1)
    expect(logs[0].success).toBe(true)
  })

  it('свежая копия догоняющую отменяет', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma } = makeDb([logRow({ hoursAgo: 2, dir: usb, now: T0.getTime() })])
    const backup = loadBackup({ prisma, catchUpMs: '30000', maxAgeHours: '20' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(31000)

    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('копия суточной давности догоняется при старте', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma } = makeDb([logRow({ hoursAgo: 21, dir: usb, now: T0.getTime() })])
    const backup = loadBackup({ prisma, catchUpMs: '30000', maxAgeHours: '20' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(31000)

    // Ровно D8-003: ноутбук ночью был выключен, 03:00 внутри процесса не наступило
    expect(jsonFiles(usb)).toHaveLength(1)
  })

  it('периодический таймер молчит, если копию только что сняли вручную', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma } = makeDb([logRow({ hoursAgo: 0, dir: usb, now: T0.getTime() })])
    const backup = loadBackup({ prisma, everyHours: '4', maxAgeHours: '20', catchUpMs: '1000' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    await backup.createBackup() // ручная копия в 13:00
    expect(jsonFiles(usb)).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1 * HOUR) // тик в 14:00, с ручной копии прошёл час
    expect(jsonFiles(usb)).toHaveLength(1)
  })

  it('через BACKUP_EVERY_HOURS после последней удачной копия снимается', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma } = makeDb([logRow({ hoursAgo: 0, dir: usb, now: T0.getTime() })])
    const backup = loadBackup({ prisma, everyHours: '4', maxAgeHours: '20', catchUpMs: '1000' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(4 * HOUR)

    // «Выключил ноут в 18:00, не выходя из программы» — за день работы копий
    // должно быть несколько, а не одна ночная
    expect(jsonFiles(usb)).toHaveLength(1)
  })

  it('ошибка копии не роняет процесс, а уходит в лог и в журнал', async () => {
    vi.useFakeTimers({ now: T0 })
    const { prisma, logs } = makeDb()
    prisma.booking.findMany = async () => { throw new Error('база отвалилась') }
    const logger = recordingLogger()
    const backup = loadBackup({ prisma, logger, catchUpMs: '1000' })

    backup.startBackupScheduler()
    await vi.advanceTimersByTimeAsync(2000)

    // Фоновая задача не имеет права уронить сервер: ошибка ловится и записывается
    expect(logger.lines.error.join('\n')).toContain('база отвалилась')
    expect(logs).toHaveLength(1)
    expect(logs[0].success).toBe(false)
    // Битого файла в папке не остаётся — писали во временный
    expect(jsonFiles(usb)).toHaveLength(0)
    expect(fs.readdirSync(usb)).toHaveLength(0)
  })
})

// ─── 8. Внутренний путь POST /backup (копия при выходе из программы) ─────────

describe('внутренний POST /backup с X-Internal-Token', () => {
  const TOKEN = 'секрет-этого-запуска'

  const loopbacks = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
  it.each(loopbacks)('верный токен с петли (%s) делает копию без JWT', async (ip) => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router, seen } = loadSystemRoutes({ backup, prisma, internalToken: TOKEN })

    const res = await callRoute(router, {
      method: 'POST', url: '/backup', ip, headers: { 'X-Internal-Token': TOKEN },
    })

    expect(res.status).toBe(200)
    expect(res.body.filename).toMatch(/^backup_/)
    expect(jsonFiles(usb)).toHaveLength(1)
    // Главное: JWT не спрашивали — у main-процесса Electron его нет и быть не может
    expect(seen.authenticate).toBe(0)
  })

  it('верный токен НЕ с петли уходит в обычную проверку JWT и пишет предупреждение', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const logger = recordingLogger()
    const { router, seen } = loadSystemRoutes({ backup, prisma, logger, internalToken: TOKEN })

    const res = await callRoute(router, {
      method: 'POST', url: '/backup', ip: '192.168.1.50', headers: { 'X-Internal-Token': TOKEN },
    })

    expect(res.status).toBe(401)
    expect(seen.authenticate).toBe(1)
    expect(jsonFiles(usb)).toHaveLength(0)
    // Утёкший секрет должен быть виден в логах, а не молча не сработать
    expect(logger.lines.warn.join('\n')).toContain('192.168.1.50')
  })

  it('неверный токен — обычные 401 и никакой копии', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router, seen } = loadSystemRoutes({ backup, prisma, internalToken: TOKEN })

    const res = await callRoute(router, {
      method: 'POST', url: '/backup', headers: { 'X-Internal-Token': 'секрет-этого-запускА' },
    })

    expect(res.status).toBe(401)
    expect(seen.authenticate).toBe(1)
    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('токен другой длины не роняет сервер сравнением', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma, internalToken: TOKEN })

    // timingSafeEqual на буферах разной длины бросает — длину обязаны проверить до него
    const res = await callRoute(router, {
      method: 'POST', url: '/backup', headers: { 'X-Internal-Token': 'к' },
    })

    expect(res.status).toBe(401)
  })

  it('без INTERNAL_TOKEN в окружении путь выключен целиком', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router, seen } = loadSystemRoutes({ backup, prisma }) // env не задан

    const res = await callRoute(router, {
      method: 'POST', url: '/backup', headers: { 'X-Internal-Token': '' },
    })

    expect(res.status).toBe(401)
    expect(seen.authenticate).toBe(1)
    expect(jsonFiles(usb)).toHaveLength(0)
  })

  it('внутренний заголовок не открывает остальные роуты раздела', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup({ prisma })
    const { router } = loadSystemRoutes({ backup, prisma, internalToken: TOKEN })

    const list = await callRoute(router, { url: '/backups', headers: { 'X-Internal-Token': TOKEN } })
    const restore = await callRoute(router, {
      method: 'POST', url: '/backup/restore', headers: { 'X-Internal-Token': TOKEN },
      body: { fileName: 'backup_2026-09-07_03-00.json' },
    })

    // Секрет даёт ровно одно право — снять копию; восстановление им недоступно
    expect(list.status).toBe(401)
    expect(restore.status).toBe(401)
  })
})
