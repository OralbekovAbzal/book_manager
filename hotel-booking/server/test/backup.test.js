import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Резервные копии базы и восстановление из них.
 *
 * Что здесь на самом деле проверяется. Восстановление физически удаляет
 * содержимое таблиц и вставляет его заново из файла, поэтому таблица, которой
 * в дампе нет, после восстановления пуста. Раньше состав дампа вёлся руками
 * массивом TABLES — и в нём не оказалось `Payment` (касса) и `BookingService`,
 * то есть «восстановление из резервной копии» само стирало деньги. Тесты бьют
 * в четыре точки:
 *   1. состав дампа собирается ИЗ СХЕМЫ — новая таблица попадает в копию сама,
 *      без правки backup.js (иначе грабли вернутся с третьей таблицей);
 *   2. порядок вставки считается по внешним ключам, а самоссылка возврата
 *      (Payment.refundOfId) проставляется вторым проходом;
 *   3. счётчики автоинкремента сбрасываются у КАЖДОЙ таблицы;
 *   4. файл старого формата без явного подтверждения не восстанавливается.
 *
 * `helpers/fakePrisma.js` умеет только чтение, а здесь нужны
 * deleteMany/createMany/update/count/$transaction и каскад — поэтому мини-база
 * своя, локальная (так же поступил тест снимков).
 */

// ─── Мини-Prisma с записью и каскадом ────────────────────────────────────────

/** Каскад от брони: ровно те таблицы, что в схеме помечены onDelete: Cascade. */
const CASCADE_FROM_BOOKING = ['bookingCharge', 'payment', 'bookingService']

/**
 * `Snapshot.createdById → Admin` объявлен ON DELETE SET NULL (0_init). Мини-база
 * это повторяет: снимки в копию не входят и переживают восстановление, поэтому
 * именно на них видно, обнулит ли пересоздание администраторов авторство.
 */
const SET_NULL_FROM_ADMIN = [{ table: 'snapshot', column: 'createdById' }]

/** Все модели схемы в нижнем camelCase — мини-база должна знать про каждую. */
const ALL_MODELS = [
  'room', 'category', 'building', 'roomFeature', 'roomCapacity', 'bookingFlag',
  'booking', 'admin', 'reportDefinition', 'auditLog', 'license', 'shift',
  'backupLog', 'snapshot', 'partner', 'allotment', 'release', 'contact',
  'hotelSettings', 'ratePrice', 'service', 'bookingService', 'mealPlan',
  'bookingCharge', 'payment',
]

function createDb(fixture = {}) {
  const tables = {}
  for (const name of ALL_MODELS) tables[name] = (fixture[name] || []).map((r) => ({ ...r }))

  const calls = { deleteMany: [], createMany: [], update: [], updateMany: [], raw: [] }

  const match = (row, where = {}) => Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && Array.isArray(cond.in)) return cond.in.includes(row[field])
    if (cond && typeof cond === 'object' && 'not' in cond) return row[field] !== cond.not
    return row[field] === cond
  })

  const query = (name, args = {}) => {
    let rows = tables[name].filter((r) => match(r, args.where))
    if (args.orderBy) {
      const [field, dir] = Object.entries(args.orderBy)[0]
      rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1))
    }
    return rows
  }

  const model = (name) => ({
    async findMany(args = {}) { return query(name, args).map((r) => ({ ...r })) },
    async findFirst(args = {}) { return query(name, args)[0] ?? null },
    async count(args = {}) { return query(name, args).length },
    async create(args) {
      const id = tables[name].reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
      const rec = { id, createdAt: new Date(), ...args.data }
      tables[name].push(rec)
      return { ...rec }
    },
    async createMany(args) {
      calls.createMany.push({ model: name, count: args.data.length })
      for (const row of args.data) {
        if (row.id != null && tables[name].some((r) => r.id === row.id)) {
          throw new Error(`fakeDb: ${name}.id=${row.id} уже существует — восстановление вставило бы дубль`)
        }
        tables[name].push({ ...row })
      }
      return { count: args.data.length }
    },
    async update(args) {
      const hit = tables[name].find((r) => r.id === args.where.id)
      if (!hit) throw new Error(`fakeDb: ${name}#${args.where.id} не найден для update`)
      calls.update.push({ model: name, id: args.where.id, data: { ...args.data } })
      Object.assign(hit, args.data)
      return { ...hit }
    },
    async updateMany(args = {}) {
      const hits = query(name, args)
      calls.updateMany.push({ model: name, ids: hits.map((r) => r.id), data: { ...args.data } })
      for (const hit of hits) Object.assign(hit, args.data)
      return { count: hits.length }
    },
    async deleteMany(args = {}) {
      calls.deleteMany.push(name)
      const doomed = new Set(query(name, args).map((r) => r.id))
      tables[name] = tables[name].filter((r) => !doomed.has(r.id))
      if (name === 'booking') {
        // Каскад: без него тест не заметил бы, что деньги улетели вместе с бронями
        for (const child of CASCADE_FROM_BOOKING) {
          tables[child] = tables[child].filter((r) => !doomed.has(r.bookingId))
        }
      }
      if (name === 'admin') {
        // SET NULL: без этого тест не заметил бы, что у снимков пропал автор
        for (const { table, column } of SET_NULL_FROM_ADMIN) {
          for (const row of tables[table]) if (doomed.has(row[column])) row[column] = null
        }
      }
      return { count: doomed.size }
    },
  })

  const prisma = {}
  for (const name of ALL_MODELS) prisma[name] = model(name)
  prisma.$executeRawUnsafe = async (sql) => { calls.raw.push(sql); return 0 }
  prisma.$transaction = async (fn) => fn(prisma)

  return { prisma, tables, calls }
}

// ─── Загрузка модуля ─────────────────────────────────────────────────────────

let dir = null

function loadBackup(prisma, logger = silentLogger) {
  process.env.BACKUP_PATH = dir
  process.env.BACKUP_KEEP = '50'
  return loadCjs('src/utils/backup.js', {
    stubs: {
      './prisma': { prisma },
      './logger': logger,
      'node-cron': { schedule() {} },
      '../middleware/errorHandler': {
        createError: (message, status = 400) => Object.assign(new Error(message), { status }),
      },
      '../controllers/occupancyController': { invalidateGridCache() {} },
      '../socket/socketManager': { getIO: () => ({ to: () => ({ emit() {} }) }) },
    },
  })
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-backup-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const files = () => fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
const readDump = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

function writeDump(name, dump) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(dump), 'utf8')
  return name
}

// ─── Фикстура: бронь с начислением, платежом, возвратом и услугой ────────────

const D = (s) => new Date(`${s}T00:00:00.000Z`)
const T = (s) => new Date(s)

function fixture() {
  return {
    admin: [{
      id: 1, username: 'admin', password: 'x', name: 'Главный администратор',
      role: 'SUPER_ADMIN', isActive: true, createdAt: T('2026-01-01T00:00:00Z'), updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    category: [{ id: 2, name: 'Двухместный', color: '#123456', description: null }],
    building: [{
      id: 3, code: 'main', name: 'ГЛАВНЫЙ', description: null, order: 0, isActive: true,
      createdAt: T('2026-01-01T00:00:00Z'), updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    roomFeature: [{
      id: 4, code: 'balcony', name: 'Балкон', emoji: '🌿', order: 0, isActive: true,
      createdAt: T('2026-01-01T00:00:00Z'), updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    roomCapacity: [{
      id: 5, code: 'double', label: 'Двухместный', value: 2, order: 0, isActive: true,
      createdAt: T('2026-01-01T00:00:00Z'), updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    reportDefinition: [{
      id: 6, key: 'my-report', title: 'Мой отчёт', description: null,
      definition: { columns: [] }, createdById: 1,
      createdAt: T('2026-01-01T00:00:00Z'), updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    room: [{
      id: 10, number: '101', categoryId: 2, building: 'ГЛАВНЫЙ', floor: 1,
      features: ['Балкон'], capacity: 'double', isActive: true, createdAt: T('2026-01-01T00:00:00Z'),
    }],
    service: [{
      id: 20, code: 'breakfast', name: 'Завтрак', price: 2000, childPrice: 1000,
      unit: 'per_person_night', kind: 'meal', includedByDefault: true, isActive: true, order: 0,
    }],
    // Реквизиты объекта: единственное место, где они хранятся. Потерять их при
    // восстановлении — значит получить установку, которая не может напечатать
    // счёт, и восстанавливать их будет неоткуда.
    hotelSettings: [{
      id: 1, name: 'Туран', city: 'Караганда', currency: 'KZT', pricingBase: 'person',
      lateArrivalHour: null, setupCompletedAt: T('2026-01-01T00:00:00Z'),
      legalName: 'ИП Оралбеков А.', bin: '990514300123',
      address: 'Карагандинская обл., п. Каркаралинск, ул. Лесная, 1',
      phone: '+7 (7212) 55-55-55', email: 'turan@example.kz',
      bankName: 'АО «Kaspi Bank»', iban: 'KZ868562000000327523',
      signerName: 'Оралбеков А.', signerTitle: 'Директор',
      updatedAt: T('2026-01-01T00:00:00Z'),
    }],
    booking: [{
      id: 41, roomId: 10, guestName: 'Асель', guestPhone: '+77010000000',
      checkIn: D('2026-08-25'), checkOut: D('2026-08-28'), status: 'CONFIRMED',
      source: null, notes: null,
      // Документ гостя: состав копии собирается из DMMF, и новая колонка обязана
      // попадать в файл САМА. Это ровно та дыра, на которую наступали дважды
      // (касса не попадала в копию), поэтому проверяем, а не верим механизму.
      guestCitizenship: 'Казахстан', guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestDocExpiry: D('2030-05-14'), guestBirthDate: D('1999-05-14'), guestSex: 'f',
      adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
      extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
      discountPercent: 0, prepaymentPercent: 50,
      totalAmount: 90000, prepaidAmount: 45000, paidAmount: 50000,
      flags: [], partnerId: null, shiftId: null, adminId: 1,
      // Волна 5b: голова счёта цепочки и «продана поверх квоты». Колонки берутся
      // из DMMF сами, но проверять надо факт, а не механизм: на «забыли колонку»
      // в этом проекте наступали дважды.
      accountBookingId: null, allotmentOverride: true,
      createdAt: T('2026-08-01T10:00:00Z'), updatedAt: T('2026-08-02T10:00:00Z'),
    }],
    bookingCharge: [{
      id: 71, bookingId: 41, kind: 'stay', label: 'Проживание', quantity: 1,
      unitPrice: 90000, amount: 90000, date: D('2026-08-25'), source: 'auto', reason: null,
      createdById: 1, createdAt: T('2026-08-01T10:00:00Z'), updatedAt: T('2026-08-01T10:00:00Z'),
    }],
    bookingService: [{
      id: 81, bookingId: 41, serviceId: 20, adults: 2, children: 0, quantity: 1,
      createdAt: T('2026-08-01T10:00:00Z'), updatedAt: T('2026-08-01T10:00:00Z'),
    }],
    snapshot: [
      // Точки отката этой установки: в копию не входят и восстановление их
      // не трогает. У ручного есть автор (ссылка на Admin), у авто-снимка
      // автора нет — его делает сама программа.
      {
        id: 91, kind: 'manual', label: 'Перед переселением', bookingCount: 109,
        data: { version: 2, bookings: [] }, createdById: 1, createdAt: T('2026-09-01T10:00:00Z'),
      },
      {
        id: 92, kind: 'auto', label: 'Авто', bookingCount: 109,
        data: { version: 2, bookings: [] }, createdById: null, createdAt: T('2026-09-02T10:00:00Z'),
      },
    ],
    payment: [
      {
        id: 5, bookingId: 41, kind: 'payment', amount: 60000, method: 'cash',
        adminId: 1, adminName: 'Главный администратор', shiftId: null,
        businessDate: D('2026-08-25'), paidAt: T('2026-08-25T09:00:00Z'), comment: null,
        refundOfId: null, voidedAt: null, voidedById: null, voidReason: null,
        createdAt: T('2026-08-25T09:00:00Z'), updatedAt: T('2026-08-25T09:00:00Z'),
      },
      {
        // Возврат ссылается на платёж #5 — самая хрупкая связь при восстановлении
        id: 6, bookingId: 41, kind: 'refund', amount: 10000, method: 'cash',
        adminId: 1, adminName: 'Главный администратор', shiftId: null,
        businessDate: D('2026-08-26'), paidAt: T('2026-08-26T09:00:00Z'), comment: 'Съехал раньше',
        refundOfId: 5, voidedAt: null, voidedById: null, voidReason: null,
        createdAt: T('2026-08-26T09:00:00Z'), updatedAt: T('2026-08-26T09:00:00Z'),
      },
    ],
  }
}

// ─── 1. Состав дампа собирается из схемы ─────────────────────────────────────

describe('состав копии', () => {
  it('покрывает ВСЕ модели схемы, кроме журнала самих копий', async () => {
    const { prisma } = createDb()
    const backup = loadBackup(prisma)
    const { Prisma } = await import('@prisma/client')

    const inSchema = Prisma.dmmf.datamodel.models.map((m) => m.name)
    const inPlan = new Set(backup._schemaPlan().order)

    // Ради этого всё и затевалось: новая таблица попадает в копию сама.
    // Если тест упал — в backup.js добавили исключение, которое надо обосновать.
    // Исключений ровно два, и причины у них разные: BackupLog — журнал самих
    // копий, Snapshot — точки отката установки (они же 87 % веса файла).
    expect([...inSchema].filter((m) => !inPlan.has(m)).sort()).toEqual(['BackupLog', 'Snapshot'])
  })

  it('в файл попадают касса, услуги, отчёты и справочники номерного фонда', async () => {
    const { prisma } = createDb(fixture())
    const backup = loadBackup(prisma)

    const { filename } = await backup.createBackup()
    const dump = readDump(filename)

    expect(dump.version).toBe(2)
    // Ровно те таблицы, которых не было в списке руками
    expect(dump.tables.Payment).toHaveLength(2)
    expect(dump.tables.BookingService).toHaveLength(1)
    expect(dump.tables.ReportDefinition).toHaveLength(1)
    expect(dump.tables.Building).toHaveLength(1)
    expect(dump.tables.RoomFeature).toHaveLength(1)
    expect(dump.tables.RoomCapacity).toHaveLength(1)
    // Журнал копий в дамп не входит
    expect(dump.tables.BackupLog).toBeUndefined()
    // Снимки — тоже: они весили 87 % файла и восстанавливать их незачем
    expect(dump.tables.Snapshot).toBeUndefined()
  })

  it('документ гостя попадает в копию и возвращается из неё', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)

    const { filename } = await backup.createBackup()
    const dump = readDump(filename)

    expect(dump.tables.Booking[0]).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestSex: 'f',
    })
    // Даты в файле — ISO-строки, как и остальные даты копии
    expect(dump.tables.Booking[0].guestBirthDate).toContain('1999-05-14')

    // И обратно: восстановление кладёт документ на место, а не теряет его
    tables.booking.length = 0
    await backup.restoreBackup(filename)
    expect(tables.booking[0]).toMatchObject({
      guestDocNumber: '990514300123',
      guestDocType: 'id_card',
    })
  })

  it('реквизиты объекта попадают в копию и возвращаются из неё', async () => {
    // Проверка того же механизма на другой таблице: состав копии берётся из
    // DMMF, значит девять новых колонок HotelSettings обязаны уехать в файл
    // сами. Цена ошибки здесь выше, чем у брони: строка ОДНА, и если она
    // вернётся пустой, реквизиты юрлица восстанавливать будет неоткуда —
    // печать счёта останется без шапки до тех пор, пока их не введут заново.
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)

    const { filename } = await backup.createBackup()
    const dump = readDump(filename)

    expect(dump.tables.HotelSettings).toHaveLength(1)
    expect(dump.tables.HotelSettings[0]).toMatchObject({
      legalName: 'ИП Оралбеков А.',
      bin: '990514300123',
      address: 'Карагандинская обл., п. Каркаралинск, ул. Лесная, 1',
      phone: '+7 (7212) 55-55-55',
      email: 'turan@example.kz',
      bankName: 'АО «Kaspi Bank»',
      iban: 'KZ868562000000327523',
      signerName: 'Оралбеков А.',
      signerTitle: 'Директор',
    })

    // Восстановление кладёт их обратно на ту же единственную строку id = 1
    tables.hotelSettings.length = 0
    const res = await backup.restoreBackup(filename)
    expect(res.restored.HotelSettings).toBe(1)
    expect(tables.hotelSettings[0]).toMatchObject({
      id: 1,
      name: 'Туран',
      legalName: 'ИП Оралбеков А.',
      bin: '990514300123',
      iban: 'KZ868562000000327523',
      signerTitle: 'Директор',
    })
  })
})

// ─── 1a. Снимки: не в копии и не в очистке ───────────────────────────────────

describe('снимки', () => {
  it('переживают восстановление вместе с тяжёлым полем data', async () => {
    const { prisma, tables, calls } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()

    const res = await backup.restoreBackup(filename, 1)

    // Ни удаления, ни вставки: точки отката — не данные отеля, а страховка
    // от ошибочного восстановления, и она должна пережить восстановление
    expect(calls.deleteMany).not.toContain('snapshot')
    expect(calls.createMany.some((c) => c.model === 'snapshot')).toBe(false)
    expect(res.restored.Snapshot).toBeUndefined()
    expect(tables.snapshot.map((s) => s.id)).toEqual([91, 92])
    expect(tables.snapshot[0].data).toEqual({ version: 2, bookings: [] })
  })

  it('авторство снимка переживает пересоздание администраторов', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()

    await backup.restoreBackup(filename, 1)

    // Admin удаляется и создаётся заново, FK у снимка — ON DELETE SET NULL.
    // Без пары «запомнили до / вернули после» здесь был бы null
    expect(tables.snapshot.find((s) => s.id === 91).createdById).toBe(1)
    // У авто-снимка автора не было и не появилось
    expect(tables.snapshot.find((s) => s.id === 92).createdById).toBe(null)
  })

  it('снимок автора, которого нет в копии, остаётся без автора', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()

    // Сотрудник заведён уже ПОСЛЕ копии и успел снять снимок
    await prisma.admin.create({
      data: {
        id: 2, username: 'nurlan', password: 'x', name: 'Нурлан', role: 'ADMIN',
        isActive: true, createdAt: T('2026-09-03T00:00:00Z'), updatedAt: T('2026-09-03T00:00:00Z'),
      },
    })
    await prisma.snapshot.create({
      data: {
        id: 93, kind: 'manual', label: 'Снимок Нурлана', bookingCount: 1,
        data: { version: 2, bookings: [] }, createdById: 2, createdAt: T('2026-09-03T10:00:00Z'),
      },
    })

    await backup.restoreBackup(filename, 1)

    // Сам снимок на месте, но приписать его некому: админа #2 в файле нет
    expect(tables.snapshot.find((s) => s.id === 93).createdById).toBe(null)
    expect(tables.snapshot.find((s) => s.id === 91).createdById).toBe(1)
  })

  it('копия, снятая ДО исключения, восстанавливается без подтверждения', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()

    // Вчерашний файл того же формата v2: в нём Snapshot ещё был
    const dump = readDump(filename)
    dump.tables.Snapshot = [{
      id: 555, kind: 'auto', label: 'Из вчерашней копии', bookingCount: 7,
      data: { version: 2, bookings: [] }, createdById: 1, createdAt: '2026-09-03T10:00:00.000Z',
    }]
    const name = writeDump('backup_yesterday.json', dump)

    // Лишняя таблица — это НАШЕ решение её не восстанавливать, а не поломка
    // файла: пугать пользователя и требовать allowDataLoss тут не за что
    const info = await backup.describeRestore(name)
    expect(info.requiresConfirmation).toBe(false)
    expect(info.unknownTables).toEqual([])
    expect(info.emptiedTables).toEqual([])
    expect(info.warning).toBe(null)
    expect(info.rows.Snapshot).toBeUndefined()

    const res = await backup.restoreBackup(name, 1)
    expect(res.restored.Booking).toBe(1)
    // Снимок из файла не приехал, свои остались нетронутыми
    expect(tables.snapshot.map((s) => s.id)).toEqual([91, 92])
  })
})

// ─── 2. Порядок по внешним ключам ────────────────────────────────────────────

describe('порядок таблиц', () => {
  it('родители вставляются раньше детей, а удаляются позже', async () => {
    const { prisma, calls } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await backup.restoreBackup(filename, 1)

    const order = backup._schemaPlan().order
    const before = (a, b) => order.indexOf(a) < order.indexOf(b)
    expect(before('Category', 'Room')).toBe(true)
    expect(before('Room', 'Booking')).toBe(true)
    expect(before('Admin', 'Booking')).toBe(true)
    expect(before('Booking', 'Payment')).toBe(true)
    expect(before('Booking', 'BookingCharge')).toBe(true)
    expect(before('Service', 'BookingService')).toBe(true)
    expect(before('Allotment', 'Release')).toBe(true)

    // Удаление — строго в обратном порядке
    expect(calls.deleteMany).toEqual([...order].reverse().map((t) => t[0].toLowerCase() + t.slice(1)))
  })
})

// ─── 3. Круговой прогон: файл → база ─────────────────────────────────────────

describe('восстановление', () => {
  it('возвращает строки один в один, включая деньги и услуги', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()

    // Испортили состояние: удалили бронь — вместе с ней ушли деньги и услуги
    await prisma.booking.deleteMany({ where: { id: 41 } })
    expect(tables.payment).toHaveLength(0)
    expect(tables.bookingCharge).toHaveLength(0)
    expect(tables.bookingService).toHaveLength(0)

    const res = await backup.restoreBackup(filename, 1)

    expect(res.restored.Payment).toBe(2)
    expect(res.restored.BookingService).toBe(1)
    expect(res.restored.BookingCharge).toBe(1)
    expect(tables.payment.map((p) => p.id).sort()).toEqual([5, 6])
    expect(tables.payment.find((p) => p.id === 5).amount).toBe(60000)
    expect(tables.bookingService[0]).toMatchObject({ id: 81, bookingId: 41, serviceId: 20, adults: 2 })
    // Даты вернулись объектами Date, а не ISO-строками
    expect(tables.booking[0].checkIn).toBeInstanceOf(Date)
    expect(tables.booking[0].checkIn.toISOString()).toBe('2026-08-25T00:00:00.000Z')
  })

  it('самоссылка возврата проставляется вторым проходом и не портит updatedAt', async () => {
    const { prisma, tables, calls } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await prisma.booking.deleteMany({})

    await backup.restoreBackup(filename, 1)

    // Вставка идёт с пустой ссылкой — иначе результат зависел бы от порядка строк
    const inserted = calls.update.find((u) => u.model === 'payment' && u.id === 6)
    expect(inserted).toBeTruthy()
    expect(inserted.data.refundOfId).toBe(5)
    // updatedAt передан явно: у @updatedAt Prisma иначе проставила бы «сейчас»
    expect(inserted.data.updatedAt.toISOString()).toBe('2026-08-26T09:00:00.000Z')
    expect(tables.payment.find((p) => p.id === 6).refundOfId).toBe(5)
    // У платежа без возврата второго прохода быть не должно
    expect(calls.update.some((u) => u.model === 'payment' && u.id === 5)).toBe(false)
  })

  it('сбрасывает счётчик автоинкремента у каждой восстановленной таблицы', async () => {
    const { prisma, calls } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await backup.restoreBackup(filename, 1)

    const reset = new Set(calls.raw.map((sql) => sql.match(/pg_get_serial_sequence\('"(\w+)"'/)?.[1]))
    // Именно эта ошибка была в снимках: сбрасывали только у Booking
    for (const t of ['Booking', 'Payment', 'BookingCharge', 'BookingService', 'Room', 'Admin']) {
      expect(reset.has(t), `нет сброса последовательности для ${t}`).toBe(true)
    }
    // У License и HotelSettings id = 1 без последовательности — их трогать нечего
    expect(reset.has('License')).toBe(false)
    expect(reset.has('HotelSettings')).toBe(false)
  })
})

// ─── 4. Старый формат: честный отказ ─────────────────────────────────────────

describe('файл старого формата', () => {
  /** Копия версии 1: состав вёлся руками, кассы и услуг в ней нет вовсе. */
  function legacyDump() {
    const f = fixture()
    return {
      version: 1,
      createdAt: '2026-09-03T10:06:52.462Z',
      tables: {
        Category: f.category, Admin: f.admin, Partner: [], BookingFlag: [], License: [],
        Room: f.room, Shift: [], Allotment: [], Release: [], Booking: f.booking,
        Contact: [], HotelSettings: [], RatePrice: [], Service: f.service, MealPlan: [],
        BookingCharge: f.bookingCharge, Snapshot: [], AuditLog: [],
      },
    }
  }

  it('без подтверждения не восстанавливается и не создаёт файлов', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const name = writeDump('backup_legacy.json', legacyDump())

    await expect(backup.restoreBackup(name, 1)).rejects.toMatchObject({ status: 409 })
    // Данные на месте
    expect(tables.payment).toHaveLength(2)
    expect(tables.bookingService).toHaveLength(1)
    // Защитная копия при отказе не создаётся: ротация вытеснила бы настоящую
    expect(files()).toEqual([name])
  })

  it('в отказе названы и деньги, и таблицы, которых в файле нет', async () => {
    const { prisma } = createDb(fixture())
    const backup = loadBackup(prisma)
    const name = writeDump('backup_legacy.json', legacyDump())

    const err = await backup.restoreBackup(name, 1).catch((e) => e)
    expect(err.impact.payments.lost).toBe(2)
    expect(err.impact.payments.lostAmount).toBe(50000)   // 60000 принято − 10000 возврат
    expect(err.impact.legacyFormat).toBe(true)
    expect(err.impact.emptiedTables.map((t) => t.table).sort()).toEqual(
      ['Building', 'BookingService', 'Payment', 'ReportDefinition', 'RoomCapacity', 'RoomFeature'].sort(),
    )
    expect(err.message).toContain('Payment')
    expect(err.message).toContain('allowDataLoss')
  })

  it('describeRestore считает то же самое, но ничего не меняет', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const name = writeDump('backup_legacy.json', legacyDump())

    const info = await backup.describeRestore(name)
    expect(info.version).toBe(1)
    expect(info.requiresConfirmation).toBe(true)
    expect(info.payments.lost).toBe(2)
    expect(info.rows.Booking).toBe(1)
    expect(info.rows.Payment).toBe(0)
    expect(info.warning).toBeTruthy()
    expect(tables.payment).toHaveLength(2)   // сводка ничего не тронула
  })

  it('с явным подтверждением восстанавливается — и честно говорит, что стёрло', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const name = writeDump('backup_legacy.json', legacyDump())

    const res = await backup.restoreBackup(name, 1, { allowDataLoss: true })

    expect(res.version).toBe(1)
    expect(res.lostPayments).toBe(2)
    expect(res.emptiedTables).toContain('Payment')
    expect(tables.payment).toHaveLength(0)
    expect(tables.booking).toHaveLength(1)
    // Защитная копия перед восстановлением — уже в новом формате, в ней касса есть
    const safety = readDump(res.safetyBackup)
    expect(safety.version).toBe(2)
    expect(safety.tables.Payment).toHaveLength(2)
  })

  it('пустая таблица, отсутствующая в файле, подтверждения не требует', async () => {
    // В базе нет ни платежей, ни услуг, ни отчётов — старому файлу нечего терять
    const f = fixture()
    delete f.payment; delete f.bookingService; delete f.reportDefinition
    delete f.building; delete f.roomFeature; delete f.roomCapacity
    const { prisma, tables } = createDb(f)
    const backup = loadBackup(prisma)
    const name = writeDump('backup_legacy.json', legacyDump())

    const res = await backup.restoreBackup(name, 1)
    expect(res.restored.Booking).toBe(1)
    expect(tables.booking).toHaveLength(1)
  })
})

// ─── 5. Прочая защита от кривых файлов ───────────────────────────────────────

describe('проверки файла', () => {
  it('версия из будущего не читается', async () => {
    const { prisma } = createDb(fixture())
    const backup = loadBackup(prisma)
    const name = writeDump('backup_future.json', { version: 99, tables: {} })
    await expect(backup.restoreBackup(name, 1)).rejects.toMatchObject({ status: 400 })
  })

  it('таблицы из файла, которых нет в схеме, требуют подтверждения', async () => {
    const { prisma } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    const dump = readDump(filename)
    dump.tables.LoyaltyCard = [{ id: 1 }]     // файл от более новой версии программы
    const name = writeDump('backup_newer.json', dump)

    const err = await backup.restoreBackup(name, 1).catch((e) => e)
    expect(err.status).toBe(409)
    expect(err.impact.unknownTables).toEqual(['LoyaltyCard'])
  })

  it('файл без обязательной колонки отвергается до всяких изменений', async () => {
    const { prisma, tables } = createDb(fixture())
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    const dump = readDump(filename)
    delete dump.tables.Booking[0].guestName    // NOT NULL без значения по умолчанию
    const name = writeDump('backup_broken.json', dump)

    await expect(backup.restoreBackup(name, 1)).rejects.toMatchObject({ status: 400 })
    expect(tables.booking).toHaveLength(1)
    expect(files().sort()).toEqual([filename, name].sort())   // защитной копии нет
  })

  it('имя файла с путём не принимается', async () => {
    const { prisma } = createDb(fixture())
    const backup = loadBackup(prisma)
    await expect(backup.restoreBackup('../../etc/backup_x.json', 1)).rejects.toMatchObject({ status: 400 })
  })
})

// ─── Цепочка «один счёт» (волна 5b) ──────────────────────────────────────────

/**
 * `Booking.accountBookingId` — вторая самоссылка в схеме после `Payment.refundOfId`,
 * и обработчик у неё общий: `deferred` в `_schemaPlan()` берёт из DMMF любое поле,
 * ссылающееся на свою же модель. Проверяем не механизм, а факт — на «забыли новую
 * колонку» в этом проекте наступали дважды (касса в копии, деньги в снимках), и оба
 * раза потеря была молчаливой.
 */
describe('копия и восстановление цепочки после переезда', () => {
  /** Голова №41 из общей фикстуры + продолжение №43 с нулевыми деньгами. */
  function withChain() {
    const f = fixture()
    f.booking.push({
      ...f.booking[0],
      id: 43, checkIn: D('2026-08-28'), checkOut: D('2026-08-30'), status: 'CHECKED_IN',
      totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
      accountBookingId: 41, allotmentOverride: false,
      createdAt: T('2026-08-28T10:00:00Z'), updatedAt: T('2026-08-28T10:00:00Z'),
    })
    return createDb(f)
  }

  it('обе новые колонки уезжают в файл', async () => {
    const { prisma } = withChain()
    const backup = loadBackup(prisma)

    const { filename } = await backup.createBackup()
    const rows = readDump(filename).tables.Booking

    expect(rows.find((b) => b.id === 41)).toMatchObject({ accountBookingId: null, allotmentOverride: true })
    expect(rows.find((b) => b.id === 43)).toMatchObject({ accountBookingId: 41, allotmentOverride: false })
  })

  it('ссылка на голову вставляется вторым проходом, как у возврата', async () => {
    // Порядок строк внутри createMany зависит от разбиения на пачки, и класть
    // самоссылку сразу значит поставить восстановление в зависимость от него.
    const { prisma, tables, calls } = withChain()
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await prisma.booking.deleteMany({})

    await backup.restoreBackup(filename, 1)

    const second = calls.update.find((u) => u.model === 'booking' && u.id === 43)
    expect(second, 'ссылка должна ставиться отдельным update, а не при вставке').toBeTruthy()
    expect(second.data.accountBookingId).toBe(41)
    expect(tables.booking.find((b) => b.id === 43).accountBookingId).toBe(41)
  })

  it('«продана поверх квоты» возвращается из копии', async () => {
    const { prisma, tables } = withChain()
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await prisma.booking.deleteMany({})

    await backup.restoreBackup(filename, 1)

    expect(tables.booking.find((b) => b.id === 41).allotmentOverride).toBe(true)
    expect(tables.booking.find((b) => b.id === 43).allotmentOverride).toBe(false)
  })

  it('у головы второго прохода нет: ссылки на себя она не имеет', async () => {
    const { prisma, calls } = withChain()
    const backup = loadBackup(prisma)
    const { filename } = await backup.createBackup()
    await prisma.booking.deleteMany({})

    await backup.restoreBackup(filename, 1)

    expect(calls.update.some((u) => u.model === 'booking' && u.id === 41)).toBe(false)
  })
})
