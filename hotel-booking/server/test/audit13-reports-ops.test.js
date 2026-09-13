import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Аудит 2026-09-13, направление «Отчёты, копии, desktop/опс».
 * Тесты-репродукции к находкам O13-*. Правок в `src/` и `electron/` нет.
 *
 * Тест, помеченный `it.fails`, ОПИСЫВАЕТ ОЖИДАЕМОЕ поведение и падает сегодня:
 * так прогон остаётся зелёным, а находка не теряется. Починит её тот, кто решит,
 * КАК чинить (это вопрос предметный, а не тестовый).
 *
 * Подробности каждой находки — `docs/audit-2026-09-13/02-reports-backup-desktop.md`.
 */

const createError = (message, status = 400) => Object.assign(new Error(message), { status })
const ERR_STUBS = {
  '../middleware/errorHandler': { createError },
  '../utils/logger': silentLogger,
}

const loadExpr = () => loadCjs('src/reports/expr.js')
const loadExport = () => loadCjs('src/reports/export.js', { stubs: ERR_STUBS })

/** Крошечный датасет: движок настоящий, база не нужна. */
const DATASET = {
  id: 'probe',
  label: 'Проба',
  requiresPeriod: false,
  fields: {
    guestName: { label: 'Гость', type: 'text', groupable: true },
    amount: { label: 'Сумма', type: 'money' },
    room: { label: 'Номер', type: 'text', groupable: true },
  },
  metrics: {},
  load: async () => [
    { guestName: 'Иванов Иван Иванович', amount: 100, room: '1' },
    { guestName: 'Петров Пётр', amount: 200, room: '1' },
    { guestName: 'Асель', amount: 300, room: '2' },
  ],
}

const loadEngine = () => loadCjs('src/reports/engine.js', {
  stubs: { './datasets': { getDataset: (id) => (id === DATASET.id ? DATASET : null) }, ...ERR_STUBS },
})

const loadRegistry = () => loadCjs('src/reports/registry.js', {
  stubs: {
    '../utils/prisma': { prisma: {} },
    './datasets': { getDataset: (id) => (id === DATASET.id ? DATASET : null) },
    ...ERR_STUBS,
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-004 · Имена из Object.prototype проходят все белые списки движка
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-004 · «constructor» и «__proto__» как имя операции, расчёта и формата', () => {
  it('движок сегодня принимает такие имена — это и есть корень находки', () => {
    const { analyze } = loadExpr()
    // Ни одно из этих имён движок функцией не объявлял: они приходят из
    // Object.prototype, потому что SCALARS/AGGREGATES/OPS/AGGS/FORMATS —
    // обычные объектные литералы, а проверка — `if (!TABLE[name])`.
    expect(analyze('constructor(1)').problems).toEqual([])
    expect(analyze('__proto__(1)').problems).toEqual([])
    expect(analyze('toString(1)').problems).toEqual([])
  })

  it.fails('расчёт «constructor» должен отвергаться при сохранении отчёта', () => {
    const registry = loadRegistry()
    const problems = registry.validateDefinition({
      id: 'p', title: 'П', dataset: 'probe', groupBy: ['room'],
      columns: [{ key: 'bad', title: 'Плохая', agg: { fn: 'constructor', field: 'amount' } }],
    })
    expect(problems.length).toBeGreaterThan(0)
  })

  it.fails('запуск такого отчёта не должен класть в ячейку весь исходный набор строк', async () => {
    const engine = loadEngine()
    const res = await engine.runReport({
      id: 'p', title: 'П', dataset: 'probe', groupBy: ['room'],
      columns: [
        { key: 'room', title: 'Номер', field: '$group' },
        { key: 'bad', title: 'Плохая', agg: { fn: 'constructor', field: 'amount' } },
      ],
    }, {}, {})
    // Сегодня в `bad` лежит массив строк группы целиком — вместе с полями,
    // которых нет ни в одной колонке (телефон гостя в реальном датасете).
    expect(Array.isArray(res.rows[0].bad)).toBe(false)
  })

  it.fails('формула «__proto__(1)» должна давать ошибку формулы (400), а не TypeError (500)', () => {
    const { parse, evaluate, ExprError } = loadExpr()
    const ctx = { get: () => null, param: () => null, rows: [{ a: 1 }] }
    expect(() => evaluate(parse('__proto__(1)'), ctx)).toThrow(ExprError)
  })

  it.fails('операция фильтра «constructor» должна отвергаться, а не пропускать все строки', async () => {
    const registry = loadRegistry()
    const engine = loadEngine()
    const def = {
      id: 'p', title: 'П', dataset: 'probe',
      filters: [{ field: 'amount', op: 'constructor', value: 1 }],
      columns: [{ key: 'a', title: 'Сумма', field: 'amount' }],
    }
    const problems = registry.validateDefinition(def)
    const res = await engine.runReport(def, {}, {})
    // Сегодня: проблем нет, а «фильтр» пропускает все три строки.
    expect([problems.length > 0, res.rows.length]).toEqual([true, 0])
  })

  it.fails('формат выгрузки «constructor» должен отвечать «формат не поддерживается»', async () => {
    const { exportReport } = loadExport()
    const result = {
      report: { id: 'x', title: 'Тест' },
      columns: [{ key: 'a', title: 'А', type: 'text' }],
      rows: [{ a: 'ok' }], totals: {}, params: {},
      meta: { hotelName: 'H', generatedAt: '2026-09-13T00:00:00Z' },
    }
    // Сегодня собирается docx, а `mime` приходит undefined — контроллер падает
    // на res.setHeader() уже ПОСЛЕ сборки файла, то есть 500 и зря потраченная работа.
    await expect(exportReport(result, 'constructor')).rejects.toMatchObject({ status: 400 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-002 · Формула-бомба: колонка ссылается на предыдущую
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-002 · цепочка удваивающих колонок', () => {
  /** N колонок, каждая удваивает предыдущую: k0 = гость+гость, k1 = k0+k0 … */
  const doublingColumns = (n) => {
    const cols = [{ key: 'k0', title: 'k0', type: 'text', expr: 'concat(guestName, guestName)' }]
    for (let i = 1; i < n; i++) {
      cols.push({ key: 'k' + i, title: 'k' + i, type: 'text', expr: `concat(k${i - 1}, k${i - 1})` })
    }
    return cols
  }

  it('каждая формула по отдельности крошечная и в пределы expr.js укладывается', () => {
    const { MAX_EXPR_LENGTH, MAX_NODES, MAX_DEPTH } = loadExpr()
    const cols = doublingColumns(20)
    for (const c of cols) expect(c.expr.length).toBeLessThan(40)
    expect([MAX_EXPR_LENGTH, MAX_NODES, MAX_DEPTH]).toEqual([2000, 2000, 64])
  })

  it.fails('20 таких колонок не должны давать ячейку в мегабайты', async () => {
    const engine = loadEngine()
    const def = { id: 'bomb', title: 'Бомба', dataset: 'probe', columns: doublingColumns(20) }
    const res = await engine.runReport(def, {}, {})
    // Замер аудита: 20 колонок → последняя ячейка 13 631 488 символов НА КАЖДУЮ
    // строку (и всё это уезжает в JSON ответа); 26 колонок → 1,75 ГБ RSS и 400
    // «формула слишком сложная» (RangeError поймали, память уже съедена).
    expect(String(res.rows[0].k19).length).toBeLessThan(100_000)
  })

  it.fails('такое определение должно отвергаться при сохранении и при импорте чужого JSON', () => {
    const registry = loadRegistry()
    const problems = registry.validateDefinition({
      id: 'bomb', title: 'Бомба', dataset: 'probe', columns: doublingColumns(26),
    })
    expect(problems.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-001 · Выгрузка в Word на большом отчёте
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-001 · потолок строк выгрузки', () => {
  it('потолок выгрузки — 50 000 строк на все три формата разом', () => {
    const engine = loadEngine()
    expect(engine.MAX_ROWS_EXPORT).toBe(50000)
    expect(engine.MAX_ROWS).toBe(5000)
  })

  it('у docx свой потолок: 50 000 строк его убивают', () => {
    const mod = loadExport()
    // Замеры аудита (отдельный процесс node, файл из 12 колонок):
    //   csv  50 000 строк — 0,2 с, 13 МБ;
    //   xlsx 50 000 строк — 4,7 с, 667 МБ RSS;
    //   docx 20 000 строк — 27 с блокировки цикла событий, 3,2 ГБ RSS;
    //   docx 50 000 строк — FATAL ERROR: JavaScript heap out of memory.
    // Процесс сервера один на весь отель: 27 с — это 27 с без броней и сокета,
    // а OOM — падение сервера для всех рабочих мест.
    expect(mod.DOCX_MAX_ROWS).toBe(5000)
    expect(mod.DOCX_MAX_ROWS).toBeLessThan(50000)
  })

  /** Результат отчёта из одной колонки на N строк — движок для этого не нужен. */
  const fakeResult = (n) => ({
    report: { id: 'x', title: 'Реестр броней' },
    columns: [{ key: 'a', title: 'А', type: 'text' }],
    rows: Array.from({ length: n }, () => ({ a: 'Иванов' })),
    totals: {}, params: {},
    meta: { hotelName: 'Туран', generatedAt: '2026-09-13T00:00:00Z' },
  })

  it('5001 строка в Word — отказ 400 с кодом DOCX_TOO_LARGE и без сборки документа', async () => {
    const { exportReport } = loadExport()
    const err = await exportReport(fakeResult(5001), 'docx').catch((e) => e)
    expect(err.status).toBe(400)
    expect(err.code).toBe('DOCX_TOO_LARGE')
    // Текст называет и потолок, и сколько строк в отчёте, и куда выгружать вместо Word
    expect(err.message).toMatch(/5.000/)
    expect(err.message).toMatch(/5.001/)
    expect(err.message).toMatch(/Excel\/CSV/)
  })

  it('5000 строк в Word проходят', async () => {
    const { exportReport } = loadExport()
    const file = await exportReport(fakeResult(5000), 'docx')
    expect(file.buffer.length).toBeGreaterThan(0)
    expect(file.filename.endsWith('.docx')).toBe(true)
  })

  it('csv и xlsx потолок Word не трогает: их 50 000 строк не убивают', async () => {
    const { exportReport } = loadExport()
    const csv = await exportReport(fakeResult(5001), 'csv')
    expect(csv.buffer.length).toBeGreaterThan(0)
  })

  it('контроллер отдаёт клиенту код DOCX_TOO_LARGE, а не «внутреннюю ошибку»', async () => {
    const result = fakeResult(5001)
    const controller = loadCjs('src/controllers/reportController.js', {
      stubs: {
        '../reports/registry': { getDefinition: async () => ({ id: 'x', title: 'Реестр броней' }) },
        '../reports/datasets': { describeDatasets: () => [] },
        '../reports/options': { resolveOptions: async (d) => d },
        '../reports/engine': { runReport: async () => result },
        '../reports/vocab': {},
        '../utils/businessDate': { getCurrentBusinessDate: async () => new Date('2026-09-13T00:00:00Z') },
        '../utils/prisma': { prisma: { hotelSettings: { findUnique: async () => ({ name: 'Туран' }) } } },
        '../middleware/errorHandler': { createError },
        '../socket/socketManager': { emitReportsChanged() {} },
      },
    })

    const sent = {}
    const res = {
      status(code) { sent.status = code; return this },
      json(body) { sent.body = body; return this },
      setHeader() { throw new Error('документ не должен собираться') },
      send() { throw new Error('документ не должен собираться') },
    }
    let passedToNext = null
    await controller.exportFile(
      { body: { format: 'docx' }, query: {}, params: { id: 'x' }, admin: { name: 'Асель' } },
      res,
      (err) => { passedToNext = err },
    )

    // errorHandler коды в тело ответа не переносит — поэтому контроллер отвечает сам
    expect(passedToNext).toBe(null)
    expect(sent.status).toBe(400)
    expect(sent.body.code).toBe('DOCX_TOO_LARGE')
    expect(sent.body.error).toMatch(/Word/)
  })

  it('переменная REPORT_DOCX_MAX_ROWS работает вне production и молчит в нём', () => {
    const mod = loadExport()
    const oldEnv = process.env.NODE_ENV
    const oldRaw = process.env.REPORT_DOCX_MAX_ROWS
    try {
      process.env.REPORT_DOCX_MAX_ROWS = '10'
      process.env.NODE_ENV = 'test'
      expect(mod.docxMaxRows()).toBe(10)
      // У клиента стоит production: переменная окружения не должна становиться
      // способом уронить сервер отеля.
      process.env.NODE_ENV = 'production'
      expect(mod.docxMaxRows()).toBe(5000)
      process.env.NODE_ENV = 'test'
      process.env.REPORT_DOCX_MAX_ROWS = 'нет'
      expect(mod.docxMaxRows()).toBe(5000)
    } finally {
      process.env.NODE_ENV = oldEnv
      if (oldRaw === undefined) delete process.env.REPORT_DOCX_MAX_ROWS
      else process.env.REPORT_DOCX_MAX_ROWS = oldRaw
    }
  })

  it.fails('у денежных датасетов должен быть потолок периода, как у «Номеро-ночей»', () => {
    const roomNights = loadCjs('src/reports/datasets/roomNights.js', {
      stubs: { '../../utils/prisma': { prisma: {} }, '../../middleware/errorHandler': { createError } },
    })
    const charges = loadCjs('src/reports/datasets/charges.js', {
      stubs: { '../../utils/prisma': { prisma: {} }, '../../middleware/errorHandler': { createError } },
    })
    expect(roomNights.MAX_DAYS).toBe(400)
    // Период «с 1900 по 2100» по начислениям или платежам поднимает в память всю
    // историю денег одним запросом — потолка нет ни у одного из трёх датасетов.
    expect(typeof charges.MAX_DAYS).toBe('number')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-003 · Копии: отказ записи на флешку
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-003 · флешка вставлена, но записать на неё нельзя', () => {
  let root = null
  let usb = null
  let local = null

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-a13-'))
    usb = path.join(root, 'usb')
    local = path.join(root, 'local')
    fs.mkdirSync(usb, { recursive: true })
  })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  /** Мини-база: копии хватает журнала и одной таблицы. */
  function makeDb() {
    const rows = { backupLog: [], hotelSettings: [{ id: 1, name: 'Туран', updatedAt: new Date() }] }
    const model = (name) => ({
      async findMany() { return rows[name].map((r) => ({ ...r })) },
      async findFirst() { return rows[name][rows[name].length - 1] ?? null },
      async count() { return rows[name].length },
      async create({ data }) {
        const rec = { id: rows[name].length + 1, createdAt: new Date(), ...data }
        rows[name].push(rec)
        return { ...rec }
      },
      async createMany({ data }) { rows[name].push(...data); return { count: data.length } },
      async deleteMany() { const n = rows[name].length; rows[name] = []; return { count: n } },
      async updateMany() { return { count: 0 } },
      async update({ data }) { return { ...data } },
    })
    const prisma = { backupLog: model('backupLog'), hotelSettings: model('hotelSettings') }
    prisma.$transaction = async (fn) => fn(prisma)
    prisma.$executeRawUnsafe = async () => 0
    return { prisma, rows }
  }

  function loadBackup(prisma) {
    process.env.BACKUP_PATH = usb
    process.env.BACKUP_FALLBACK_PATH = local
    process.env.BACKUP_KEEP = '50'
    process.env.BACKUP_TZ = 'UTC'
    return loadCjs('src/utils/backup.js', {
      stubs: {
        './prisma': { prisma },
        './logger': silentLogger,
        'node-cron': { schedule() { return { stop() {} } } },
        '../middleware/errorHandler': { createError },
        '../controllers/occupancyController': { invalidateGridCache() {} },
        '../socket/socketManager': { getIO: () => ({ to: () => ({ emit() {} }) }) },
      },
    })
  }

  /**
   * «Флешка есть, но запись не проходит» — заполненный носитель, защита от
   * записи, антивирус. Воспроизводим переносимо: на месте временного файла копии
   * стоит ПАПКА, поэтому writeFileSync падает так же, как при ENOSPC.
   */
  function blockWrites(dir) {
    const real = fs.writeFileSync
    fs.writeFileSync = function patched(file, ...rest) {
      if (String(file).startsWith(dir)) {
        throw Object.assign(new Error(`ENOSPC: no space left on device, write '${file}'`), { code: 'ENOSPC' })
      }
      return real.call(this, file, ...rest)
    }
    return () => { fs.writeFileSync = real }
  }

  it('отказ записи ВЕЗДЕ виден в журнале копий', async () => {
    const { prisma, rows } = makeDb()
    const backup = loadBackup(prisma)
    // Ни флешка, ни запасная папка не принимают запись — писать копию некуда,
    // и это обязано попасть в журнал: «копия свежая» при отсутствии копий —
    // та же схема молчаливого отказа, из-за которой бэкап месяцами падал.
    const restore = blockWrites(root)
    try {
      await expect(backup.createBackup()).rejects.toThrow(/ENOSPC/)
    } finally { restore() }

    expect(rows.backupLog).toHaveLength(1)
    expect(rows.backupLog[0].success).toBe(false)
    expect(String(rows.backupLog[0].error)).toMatch(/ENOSPC/)
  })

  it('копия уходит в запасную папку, как при вынутой флешке', async () => {
    const { prisma, rows } = makeDb()
    const backup = loadBackup(prisma)
    const restore = blockWrites(usb)
    let res = null
    try {
      // Флешка вставлена и проходит `probeDir`, но запись не проходит: полна,
      // защищена от записи, файл держит антивирус. Для человека это тот же
      // случай, что вынутая флешка, — значит и копия ложится туда же, локально.
      res = await backup.createBackup()
    } finally { restore() }

    const localFiles = fs.existsSync(local) ? fs.readdirSync(local).filter((f) => f.endsWith('.json')) : []
    expect(localFiles).toHaveLength(1)
    expect(fs.readdirSync(usb).filter((f) => f.endsWith('.json'))).toHaveLength(0)
    expect(res.fallbackUsed).toBe(true)
    expect(String(res.fallbackReason)).toMatch(/ENOSPC/)
    // Копия удалась, но мимо флешки — причина едет в журнале, иначе статус
    // и баннер об этом никак не узнают.
    expect(rows.backupLog[0].success).toBe(true)
    expect(String(rows.backupLog[0].error)).toMatch(/ENOSPC/)
  })

  it('битого временного файла на флешке не остаётся', async () => {
    const { prisma } = makeDb()
    const backup = loadBackup(prisma)
    // Падает переименование, а не запись: `.tmp` уже создан — его надо убрать
    const realRename = fs.renameSync
    fs.renameSync = function patched(from, to) {
      if (String(to).startsWith(usb)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      return realRename.call(this, from, to)
    }
    try {
      await backup.createBackup()
    } finally { fs.renameSync = realRename }
    expect(fs.readdirSync(usb)).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-005/006/007 · Восстановление: личность, лицензия, пробный период
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-005/006/007 · что теряется при восстановлении копии старого образца', () => {
  let dir = null
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-a13r-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  const MODELS = ['admin', 'hotelSettings', 'license', 'backupLog']

  /** Условие where мини-базы: только равенство — большего восстановлению не надо. */
  const match = (row, where = {}) => Object.entries(where).every(([f, v]) => row[f] === v)

  function makeDb(fixture) {
    const rows = {}
    for (const m of MODELS) rows[m] = (fixture[m] || []).map((r) => ({ ...r }))
    const model = (name) => ({
      async findMany() { return rows[name].map((r) => ({ ...r })) },
      async findFirst(args = {}) {
        const hits = rows[name].filter((r) => match(r, args.where))
        // orderBy в коде копий всегда «свежие сверху»
        const hit = args.orderBy ? hits[hits.length - 1] : hits[0]
        return hit ? { ...hit } : null
      },
      async count() { return rows[name].length },
      async create({ data }) {
        const rec = { id: rows[name].length + 1, createdAt: new Date(), ...data }
        rows[name].push(rec)
        return { ...rec }
      },
      async createMany({ data }) { rows[name].push(...data.map((r) => ({ ...r }))); return { count: data.length } },
      async deleteMany() { const n = rows[name].length; rows[name] = []; return { count: n } },
      async updateMany(args = {}) {
        const hits = rows[name].filter((r) => match(r, args.where))
        for (const hit of hits) Object.assign(hit, args.data)
        return { count: hits.length }
      },
      async update(args) {
        const hit = rows[name].find((r) => match(r, args.where))
        if (hit) Object.assign(hit, args.data)
        return { ...(hit || args.data) }
      },
    })
    const prisma = {}
    for (const m of MODELS) prisma[m] = model(m)
    prisma.$transaction = async (fn) => fn(prisma)
    prisma.$executeRawUnsafe = async () => 0
    return { prisma, rows }
  }

  let licenseStub = null
  let trialStub = null
  let identityStub = null
  function loadBackup(prisma) {
    process.env.BACKUP_PATH = dir
    process.env.BACKUP_FALLBACK_PATH = dir
    process.env.BACKUP_KEEP = '50'
    licenseStub = { calls: 0, resetLicenseCache() { this.calls++ } }
    trialStub = { calls: 0, resetTrialCache() { this.calls++ } }
    identityStub = { calls: 0, resetIdentityCache() { this.calls++ } }
    return loadCjs('src/utils/backup.js', {
      stubs: {
        './prisma': { prisma },
        './logger': silentLogger,
        './license': licenseStub,
        './trial': trialStub,
        './instanceIdentity': identityStub,
        'node-cron': { schedule() { return { stop() {} } } },
        '../middleware/errorHandler': { createError },
        '../controllers/occupancyController': { invalidateGridCache() {} },
        '../socket/socketManager': { getIO: () => ({ to: () => ({ emit() {} }) }) },
      },
    })
  }

  /** Файл копии, снятый прошлой версией: колонок личности и пробного срока в нём нет. */
  function writeOldDump(name = 'imported_2026-05-01_12-00_staryi.json') {
    const dump = {
      version: 2,
      createdAt: '2026-05-01T12:00:00.000Z',
      tables: {
        Admin: [{
          id: 1, username: 'admin', password: 'x', name: 'Главный администратор',
          role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        HotelSettings: [{
          id: 1, name: 'Туран', currency: 'KZT', pricingBase: 'person',
          setupCompletedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        License: [],
      },
    }
    fs.writeFileSync(path.join(dir, name), JSON.stringify(dump), 'utf8')
    return name
  }

  const liveFixture = () => ({
    admin: [{ id: 1, username: 'admin', password: 'x', name: 'Админ', role: 'SUPER_ADMIN', isActive: true }],
    hotelSettings: [{
      id: 1, name: 'Туран', currency: 'KZT', pricingBase: 'person',
      trialStartedAt: new Date('2026-09-03T00:00:00Z'),
      instanceId: 'f1e2d3c4-0000-4000-8000-000000000001',
      instancePublicKey: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
      instancePrivateKey: '-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n',
      updatedAt: new Date('2026-09-03T00:00:00Z'),
    }],
    license: [{ id: 1, key: 'ROOMLINE-xxx', createdAt: new Date('2026-09-03T00:00:00Z') }],
    backupLog: [],
  })

  it('восстановление старой копии не стирает личность установки', async () => {
    const { prisma, rows } = makeDb(liveFixture())
    const backup = loadBackup(prisma)
    const name = writeOldDump()

    await backup.restoreBackup(name, 1, { allowDataLoss: true })

    // Сегодня instanceId/instancePublicKey/instancePrivateKey становятся null:
    // колонок в файле нет, все три nullable. Сервер на следующем старте выпишет
    // НОВУЮ пару — и рабочие места, запомнившие старый публичный ключ (TOFU),
    // больше никогда не найдут этот хост в сети после смены IP.
    expect(rows.hotelSettings[0].instanceId).toBe('f1e2d3c4-0000-4000-8000-000000000001')
    expect(String(rows.hotelSettings[0].instancePublicKey)).toMatch(/BEGIN PUBLIC KEY/)
    expect(String(rows.hotelSettings[0].instancePrivateKey)).toMatch(/BEGIN PRIVATE KEY/)
  })

  it('личность ИЗ КОПИИ остаётся: это перенос на новый ноутбук', async () => {
    const { prisma, rows } = makeDb(liveFixture())
    const backup = loadBackup(prisma)
    const name = 'imported_2026-09-10_12-00_pereezd.json'
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
      version: 2,
      createdAt: '2026-09-10T12:00:00.000Z',
      tables: {
        Admin: [{
          id: 1, username: 'admin', password: 'x', name: 'Главный администратор',
          role: 'SUPER_ADMIN', isActive: true, tokenVersion: 0,
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        HotelSettings: [{
          id: 1, name: 'Туран', currency: 'KZT', pricingBase: 'person',
          trialStartedAt: '2026-09-01T00:00:00.000Z',
          instanceId: 'aaaaaaaa-0000-4000-8000-00000000000b',
          instancePublicKey: '--PUB-FROM-DUMP--',
          instancePrivateKey: '--PRIV-FROM-DUMP--',
          updatedAt: '2026-09-10T00:00:00.000Z',
        }],
        License: [],
      },
    }), 'utf8')

    await backup.restoreBackup(name, 1, { allowDataLoss: true })

    // Свою личность здесь возвращать НЕЛЬЗЯ: хост на новом ноутбуке обязан
    // стать тем же, что был на старом, иначе рабочие места его не найдут.
    expect(rows.hotelSettings[0].instanceId).toBe('aaaaaaaa-0000-4000-8000-00000000000b')
    expect(rows.hotelSettings[0].instancePublicKey).toBe('--PUB-FROM-DUMP--')
    // Начало срока из копии РАНЬШЕ текущего — остаётся раннее
    expect(new Date(rows.hotelSettings[0].trialStartedAt).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('восстановление старой копии не обнуляет начало пробного периода', async () => {
    const { prisma, rows } = makeDb(liveFixture())
    const backup = loadBackup(prisma)
    const name = writeOldDump()

    await backup.restoreBackup(name, 1, { allowDataLoss: true })

    // trialStartedAt = null → `ensureTrialStart` при первом же запросе поставит
    // «сейчас», то есть ещё 14 дней. Восстановление копии — обычная кнопка у
    // SUPER_ADMIN, и это самый простой способ работать без ключа бесконечно.
    expect(rows.hotelSettings[0].trialStartedAt).toBeInstanceOf(Date)
    expect(rows.hotelSettings[0].trialStartedAt.toISOString()).toBe('2026-09-03T00:00:00.000Z')
  })

  it('восстановление сбрасывает кэши лицензии, срока и личности', async () => {
    const { prisma } = makeDb(liveFixture())
    const backup = loadBackup(prisma)
    const name = writeOldDump()

    await backup.restoreBackup(name, 1, { allowDataLoss: true })

    // `utils/license.js` кэширует строку License НАВСЕГДА (`cacheLoaded`, без TTL)
    // и сбрасывает кэш только ввод ключа. `utils/backup.js` его вовсе не знает —
    // поэтому заглушка ниже не вызывается ни разу. Перенос на новый ноутбук:
    // ключ приехал в копии, а программа до перезапуска считает, что его нет.
    expect(licenseStub.calls).toBeGreaterThan(0)
    expect(trialStub.calls).toBeGreaterThan(0)
    expect(identityStub.calls).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// O13-009 · Откат на прежний установщик
// ─────────────────────────────────────────────────────────────────────────────

describe('O13-009 · база новее сборки (откат на прежний установщик)', () => {
  const loadMigrations = () => loadCjs('../electron/lib/migrations.js')

  it('«каких миграций не хватает базе» модуль считает, и это работает', () => {
    const m = loadMigrations()
    expect(m.pendingMigrations(['0_init', '20260908', '20260912'], ['0_init'])).toEqual(['20260908', '20260912'])
  })

  it('самолечение P3009 видит только незакрытые строки журнала миграций', () => {
    const m = loadMigrations()
    const applied = [{ migration_name: '20260912_trial', finished_at: new Date(), rolled_back_at: null, logs: null }]
    // Миграция, применённая НОВОЙ версией, закрыта — `failedMigrations` её не
    // вернёт, значит `resolve --rolled-back` к ней не применится.
    expect(m.failedMigrations(applied)).toEqual([])
  })

  it.fails('нужна проверка «база новее сборки»: миграции есть в базе, но нет в папке', () => {
    const m = loadMigrations()
    // Сценарий: поставили новую версию (миграция 20260912 применилась), затем
    // вернулись на прежний установщик. Prisma `migrate deploy` на такой базе
    // отвечает «The following migration(s) are applied to the database but
    // missing from the local migrations directory» (строка есть в
    // schema-engine рядом с apply_migrations.rs), выход не 0 → хост показывает
    // «Обновление схемы базы не удалось (код 1)» и НЕ упоминает копию pgdata:
    // `migrationFailureError` в этой ветке не вызывается (stuck пуст → throw first).
    expect(typeof m.extraMigrations).toBe('function')
    expect(m.extraMigrations(['0_init'], ['0_init', '20260912_trial'])).toEqual(['20260912_trial'])
  })
})
