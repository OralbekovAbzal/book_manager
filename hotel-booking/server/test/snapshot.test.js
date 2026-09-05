import { describe, it, expect, beforeEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Снимки и откат.
 *
 * Что здесь на самом деле проверяется: откат физически удаляет ВСЕ брони
 * (`booking.deleteMany({})`), а `BookingCharge`, `Payment` и `BookingService`
 * привязаны к брони каскадом. Значит любая строка, которой нет в снимке, после
 * отката исчезает навсегда. Поэтому тесты бьют в три точки:
 *   1. снимок захватывает денежные таблицы (иначе откатывать нечем);
 *   2. восстановление кладёт их обратно с теми же id, чинит внешние ключи
 *      и сбрасывает счётчики автоинкремента у КАЖДОЙ таблицы;
 *   3. откат, который стёр бы платежи, отсутствующие в снимке, без явного
 *      подтверждения не выполняется.
 *
 * `helpers/fakePrisma.js` умеет только чтение, а здесь нужны deleteMany/createMany/
 * update/$transaction и каскад — поэтому мини-база своя, локальная.
 */

// ─── Мини-Prisma с записью и каскадом ────────────────────────────────────────────

/** Каскад от брони: ровно те таблицы, что в схеме помечены onDelete: Cascade. */
const CASCADE_FROM_BOOKING = ['bookingCharge', 'payment', 'bookingService']

function createDb(fixture = {}) {
  const tables = {
    admin: [], room: [], shift: [], partner: [], service: [],
    booking: [], bookingCharge: [], payment: [], bookingService: [], snapshot: [],
    ...fixture,
  }
  for (const [name, rows] of Object.entries(tables)) tables[name] = rows.map(r => ({ ...r }))

  const calls = { createMany: [], raw: [], update: [], findMany: [] }

  /** where: только то, что реально использует snapshot.js — равенство и id.in */
  const match = (row, where = {}) => Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && Array.isArray(cond.in)) return cond.in.includes(row[field])
    return row[field] === cond
  })

  const query = (name, args = {}) => {
    let rows = tables[name].filter(r => match(r, args.where))
    if (args.orderBy) {
      const [field, dir] = Object.entries(args.orderBy)[0]
      rows = [...rows].sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1))
    }
    if (args.skip) rows = rows.slice(args.skip)
    if (args.take) rows = rows.slice(0, args.take)
    return rows
  }

  /**
   * `select` как в Prisma: в ответе только перечисленные поля. Фейку это нужно,
   * чтобы тест мог поймать «а не притащили ли мы в список тяжёлую колонку data».
   * Связи (`createdBy: { select: … }`) фейк не разворачивает — в таблице снимков
   * у него лежит только `createdById`.
   */
  const applySelect = (row, select) => {
    if (!select) return { ...row }
    const out = {}
    for (const [field, want] of Object.entries(select)) {
      if (want) out[field] = row[field]
    }
    return out
  }

  const model = (name) => ({
    async findMany(args = {}) {
      calls.findMany.push({ model: name, args })
      return query(name, args).map(r => applySelect(r, args.select))
    },
    async findUnique(args) {
      const hit = tables[name].find(r => r.id === args.where.id)
      return hit ? { ...hit } : null
    },
    async create(args) {
      const id = tables[name].reduce((m, r) => Math.max(m, r.id || 0), 0) + 1
      const rec = { id, createdAt: new Date(), ...args.data }
      tables[name].push(rec)
      return { ...rec }
    },
    async createMany(args) {
      calls.createMany.push({ model: name, rows: args.data.map(r => ({ ...r })) })
      for (const row of args.data) {
        if (tables[name].some(r => r.id === row.id)) {
          throw new Error(`fakeDb: ${name}.id=${row.id} уже существует — откат вставил бы дубль`)
        }
        tables[name].push({ ...row })
      }
      return { count: args.data.length }
    },
    async update(args) {
      const hit = tables[name].find(r => r.id === args.where.id)
      if (!hit) throw new Error(`fakeDb: ${name}#${args.where.id} не найден для update`)
      calls.update.push({ model: name, id: args.where.id, data: { ...args.data } })
      Object.assign(hit, args.data)
      return { ...hit }
    },
    async deleteMany(args = {}) {
      const doomed = new Set(query(name, args).map(r => r.id))
      tables[name] = tables[name].filter(r => !doomed.has(r.id))
      // Каскад: без него тест не заметил бы, что деньги улетели вместе с бронями
      if (name === 'booking') {
        for (const child of CASCADE_FROM_BOOKING) {
          tables[child] = tables[child].filter(r => !doomed.has(r.bookingId))
        }
      }
      return { count: doomed.size }
    },
    async delete(args) {
      tables[name] = tables[name].filter(r => r.id !== args.where.id)
      return {}
    },
  })

  const prisma = {}
  for (const name of Object.keys(tables)) prisma[name] = model(name)
  prisma.$executeRawUnsafe = async (sql) => { calls.raw.push(sql); return 0 }
  // Поддержан ровно один запрос — выборка версий для списка. Любой другой должен
  // падать, а не молча отвечать пустотой.
  prisma.$queryRaw = async (strings, ...values) => {
    const sql = (strings.raw || strings).join('?')
    calls.raw.push(sql)
    if (!/from\s+"Snapshot"/i.test(sql)) throw new Error(`fakeDb: неизвестный сырой запрос: ${sql}`)
    if (values.length > 0) throw new Error('fakeDb: параметров в этом запросе не ждали')
    // `->>` в Postgres отдаёт ТЕКСТ или NULL, а не число — список обязан это учитывать
    return tables.snapshot.map(s => ({
      id: s.id,
      version: s.data?.version == null ? null : String(s.data.version),
    }))
  }
  prisma.$transaction = async (fn) => fn(prisma)

  return { prisma, tables, calls }
}

const events = []
const warnings = []
function loadSnapshot(prisma, logger = { ...silentLogger, warn: (m) => warnings.push(m) }) {
  events.length = 0
  warnings.length = 0
  return loadCjs('src/utils/snapshot.js', {
    stubs: {
      './prisma': { prisma },
      './logger': logger,
      '../middleware/errorHandler': {
        createError: (message, status = 400) => Object.assign(new Error(message), { status }),
      },
      '../controllers/occupancyController': { invalidateGridCache() {} },
      '../socket/socketManager': {
        getIO: () => ({ to: () => ({ emit: (name, payload) => events.push({ name, payload }) }) }),
      },
    },
  })
}

// ─── Фикстура: одна бронь с деньгами, вторая без ─────────────────────────────────

const ADMIN = { id: 1, name: 'Главный администратор' }

function fixture() {
  return {
    admin: [ADMIN, { id: 2, name: 'Кассир' }],
    room: [{ id: 10 }, { id: 11 }],
    shift: [{ id: 5 }],
    partner: [{ id: 3 }],
    service: [{ id: 100 }],
    booking: [
      {
        id: 41, roomId: 10, guestName: 'Асель', guestPhone: '+77010000000',
        checkIn: d('2026-08-25'), checkOut: d('2026-08-28'), status: 'CONFIRMED',
        source: null, notes: null,
        // Документ гостя: заселившийся человек, паспорт записан. Откат обязан
        // вернуть его целиком — иначе журнал регистрации теряет постояльца.
        guestCitizenship: 'Казахстан', guestDocType: 'id_card',
        guestDocNumber: '990514300123',
        guestDocExpiry: d('2030-05-14'), guestBirthDate: d('1999-05-14'), guestSex: 'f',
        adultsWithMeals: 2, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
        extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
        discountPercent: 0, prepaymentPercent: 50,
        totalAmount: 90000, prepaidAmount: 45000, paidAmount: 50000,
        flags: [], partnerId: 3, shiftId: 5, adminId: 1,
        createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-02T10:00:00Z'),
      },
      {
        // Старая бронь: сумма стоит числом, строк начислений у неё нет вовсе
        id: 42, roomId: 11, guestName: 'Ержан', guestPhone: null,
        checkIn: d('2026-09-01'), checkOut: d('2026-09-03'), status: 'CONFIRMED',
        source: null, notes: null,
        // Бронь по телефону: гость ещё не приехал, документа нет и не должно быть
        guestCitizenship: null, guestDocType: null, guestDocNumber: null,
        guestDocExpiry: null, guestBirthDate: null, guestSex: null,
        adultsWithMeals: 1, childrenWithMeals: 0, adultsNoMeals: 0, childrenNoMeals: 0,
        extraBedsWithMeals: 0, extraBedsNoMeals: 0, disabledAdults: 0, disabledChildren: 0,
        discountPercent: 0, prepaymentPercent: 50,
        totalAmount: 30000, prepaidAmount: 15000, paidAmount: 7000,
        flags: [], partnerId: null, shiftId: null, adminId: 2,
        createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-02T10:00:00Z'),
      },
    ],
    bookingCharge: [
      {
        id: 71, bookingId: 41, kind: 'stay', label: 'Проживание · 2 взр.',
        quantity: 1, unitPrice: 30000, amount: 30000, date: d('2026-08-25'),
        source: 'auto', reason: null, createdById: 1,
        createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-01T10:00:00Z'),
      },
      {
        id: 72, bookingId: 41, kind: 'stay', label: 'Проживание · полсуток',
        quantity: 1, unitPrice: 15000, amount: 15000, date: d('2026-08-26'),
        source: 'manual', reason: 'Поздний заезд', createdById: 2,
        createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-01T10:00:00Z'),
      },
    ],
    payment: [
      {
        id: 5, bookingId: 41, kind: 'payment', amount: 60000, method: 'cash',
        adminId: 1, adminName: 'Главный администратор', shiftId: 5,
        businessDate: d('2026-08-25'), paidAt: new Date('2026-08-25T09:00:00Z'),
        comment: null, refundOfId: null, voidedAt: null, voidedById: null, voidReason: null,
        createdAt: new Date('2026-08-25T09:00:00Z'), updatedAt: new Date('2026-08-25T09:00:00Z'),
      },
      {
        // Возврат ссылается на платёж #5 — самая хрупкая связь при восстановлении
        id: 6, bookingId: 41, kind: 'refund', amount: 10000, method: 'cash',
        adminId: 2, adminName: 'Кассир', shiftId: 5,
        businessDate: d('2026-08-26'), paidAt: new Date('2026-08-26T09:00:00Z'),
        comment: 'Съехал раньше', refundOfId: 5, voidedAt: null, voidedById: null, voidReason: null,
        createdAt: new Date('2026-08-26T09:00:00Z'), updatedAt: new Date('2026-08-26T09:00:00Z'),
      },
      {
        // Отменённая запись: в суммы не входит, но из кассы не исчезает
        id: 7, bookingId: 41, kind: 'payment', amount: 999, method: 'card',
        adminId: 1, adminName: 'Главный администратор', shiftId: 5,
        businessDate: d('2026-08-26'), paidAt: new Date('2026-08-26T10:00:00Z'),
        comment: null, refundOfId: null,
        voidedAt: new Date('2026-08-26T11:00:00Z'), voidedById: 1, voidReason: 'Не та бронь',
        createdAt: new Date('2026-08-26T10:00:00Z'), updatedAt: new Date('2026-08-26T11:00:00Z'),
      },
    ],
    bookingService: [
      {
        id: 21, bookingId: 41, serviceId: 100, adults: 2, children: 0, quantity: 1,
        createdAt: new Date('2026-08-01T10:00:00Z'), updatedAt: new Date('2026-08-01T10:00:00Z'),
      },
    ],
  }
}

/** Снимок старого формата: только колонки броней, как их писал код до версии 2. */
function legacySnapshot(bookings, extra = {}) {
  return {
    id: 900, kind: 'auto', label: 'Старый снимок', bookingCount: bookings.length,
    data: { bookings: JSON.parse(JSON.stringify(bookings)) },
    createdById: 1, createdAt: new Date('2026-09-01T00:00:00Z'), ...extra,
  }
}

/** Свежий снимок из текущего состояния фикстуры (тем же кодом, что и в бою). */
async function snapshotOf(db) {
  const mod = loadSnapshot(db.prisma)
  return mod.createSnapshot({ kind: 'manual', label: 'Точка', createdById: 1 })
}

let db
let snapshot
beforeEach(() => {
  db = createDb(fixture())
  snapshot = loadSnapshot(db.prisma)
})

// ─── Захват ──────────────────────────────────────────────────────────────────────

describe('снимок', () => {
  it('захватывает начисления, платежи и услуги, а не только брони', async () => {
    await snapshot.createSnapshot({ kind: 'manual', label: 'Точка', createdById: 1 })
    const { data } = db.tables.snapshot[0]

    expect(data.version).toBe(2)
    expect(data.bookings).toHaveLength(2)
    expect(data.charges).toHaveLength(2)
    expect(data.payments).toHaveLength(3)
    expect(data.services).toHaveLength(1)
  })

  it('bookingCount по-прежнему считает брони, а не строки', async () => {
    const snap = await snapshot.createSnapshot({ kind: 'manual', label: 'Точка' })
    expect(snap.bookingCount).toBe(2)
  })

  it('данные лежат чистым JSON (даты — строками), иначе колонка Json их не примет', async () => {
    await snapshot.createSnapshot({ kind: 'manual', label: 'Точка' })
    const { data } = db.tables.snapshot[0]
    expect(typeof data.payments[0].paidAt).toBe('string')
    expect(() => JSON.parse(JSON.stringify(data))).not.toThrow()
  })
})

// ─── Список ──────────────────────────────────────────────────────────────────────

describe('список снимков', () => {
  it('отдаёт версию формата: у старого снимка 1, у нового 2', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))
    const fresh = await snapshot.createSnapshot({ kind: 'manual', label: 'Точка', createdById: 1 })

    const byId = new Map((await snapshot.listSnapshots()).map(s => [s.id, s]))

    // В старом снимке поля version нет вовсе — это и есть формат 1. Версия нужна
    // списку, чтобы «откат сотрёт кассу» было видно ДО выбора точки отката.
    expect(byId.get(900).version).toBe(1)
    expect(byId.get(fresh.id).version).toBe(2)
  })

  it('версия приходит из SQL строкой, а в ответе она число', async () => {
    await snapshot.createSnapshot({ kind: 'manual', label: 'Точка' })
    const [item] = await snapshot.listSnapshots()

    expect(item.version).toBe(2)
    expect(typeof item.version).toBe('number')
  })

  it('не читает тяжёлую колонку data — ни в select, ни в ответе', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))

    const list = await snapshot.listSnapshots()

    expect(list[0]).not.toHaveProperty('data')
    const listCall = db.calls.findMany.filter(c => c.model === 'snapshot').at(-1)
    expect(listCall.args.select.data).toBeFalsy()
    // Версию достаём выражением, а не колонкой целиком
    expect(db.calls.raw.join('\n')).toMatch(/data->>'version'/)
  })

  it('остальные поля списка на месте', async () => {
    const fresh = await snapshot.createSnapshot({ kind: 'manual', label: 'Точка', createdById: 1 })
    const [item] = await snapshot.listSnapshots()

    expect(item).toMatchObject({ id: fresh.id, kind: 'manual', label: 'Точка', bookingCount: 2 })
  })
})

// ─── Восстановление ──────────────────────────────────────────────────────────────

describe('восстановление', () => {
  it('возвращает начисления, платежи и услуги с теми же id', async () => {
    const snap = await snapshotOf(db)
    // Всё стёрли: и брони, и деньги
    await db.prisma.booking.deleteMany({})
    expect(db.tables.payment).toHaveLength(0)

    const res = await snapshot.restoreSnapshot(snap.id, 1)

    expect(res).toMatchObject({ restored: 2, charges: 2, payments: 3, services: 1 })
    expect(db.tables.payment.map(p => p.id).sort()).toEqual([5, 6, 7])
    expect(db.tables.bookingCharge.map(c => c.id).sort()).toEqual([71, 72])
    expect(db.tables.bookingService.map(s => s.id)).toEqual([21])
  })

  it('документ гостя переживает откат', async () => {
    const snap = await snapshotOf(db)
    await db.prisma.booking.deleteMany({})
    await snapshot.restoreSnapshot(snap.id, 1)

    const back = db.tables.booking.find(b => b.id === 41)
    expect(back).toMatchObject({
      guestCitizenship: 'Казахстан',
      guestDocType: 'id_card',
      guestDocNumber: '990514300123',
      guestSex: 'f',
    })
    // Даты обязаны вернуться Date, а не ISO-строкой из JSON снимка: строку
    // Prisma в колонку @db.Date не примет, и откат упал бы посреди вставки.
    expect(back.guestBirthDate).toBeInstanceOf(Date)
    expect(back.guestBirthDate.toISOString().slice(0, 10)).toBe('1999-05-14')
    expect(back.guestDocExpiry.toISOString().slice(0, 10)).toBe('2030-05-14')
  })

  it('откат не теряет НИ ОДНОЙ колонки брони: белый список сверяется со снимком', async () => {
    // Сторож на будущее. Восстановление идёт по BOOKING_FIELDS, и колонка, которую
    // забыли туда дописать, исчезает МОЛЧА — так уже дважды теряли данные
    // (деньги в снимках, касса в резервной копии). Этот тест ломается сразу,
    // как только в схеме появится седьмое поле, а в списке — нет.
    const before = { ...db.tables.booking.find(b => b.id === 41) }
    const snap = await snapshotOf(db)
    await db.prisma.booking.deleteMany({})
    await snapshot.restoreSnapshot(snap.id, 1)

    const after = db.tables.booking.find(b => b.id === 41)
    expect(Object.keys(before).filter(k => !(k in after))).toEqual([])
  })

  it('ручная строка начисления возвращается вместе с причиной', async () => {
    const snap = await snapshotOf(db)
    await db.prisma.booking.deleteMany({})
    await snapshot.restoreSnapshot(snap.id, 1)

    const manual = db.tables.bookingCharge.find(c => c.id === 72)
    expect(manual).toMatchObject({ source: 'manual', reason: 'Поздний заезд', amount: 15000 })
  })

  it('отменённый платёж остаётся отменённым (дыра в кассе хуже лишней строки)', async () => {
    const snap = await snapshotOf(db)
    await db.prisma.booking.deleteMany({})
    await snapshot.restoreSnapshot(snap.id, 1)

    const voided = db.tables.payment.find(p => p.id === 7)
    expect(voided.voidedAt).toBeInstanceOf(Date)
    expect(voided.voidReason).toBe('Не та бронь')
  })

  it('возврат ссылается на исходный платёж, но ссылка ставится ВТОРЫМ проходом', async () => {
    const snap = await snapshotOf(db)
    await db.prisma.booking.deleteMany({})
    await snapshot.restoreSnapshot(snap.id, 1)

    // В самой вставке ссылки нет — иначе FK зависел бы от порядка строк в снимке
    const inserted = db.calls.createMany.find(c => c.model === 'payment')
    expect(inserted.rows.every(r => r.refundOfId === null)).toBe(true)
    // …а в итоговом состоянии она есть
    const refund = db.tables.payment.find(p => p.id === 6)
    expect(refund.refundOfId).toBe(5)
    expect(db.calls.update).toHaveLength(1)
    // Второй проход не должен «омолаживать» строку: @updatedAt Prisma иначе
    // проставит «сейчас», и восстановленный платёж перестанет совпадать со снятым
    expect(refund.updatedAt).toEqual(new Date('2026-08-26T09:00:00Z'))
  })

  it('сбрасывает sequence у КАЖДОЙ восстановленной таблицы', async () => {
    const snap = await snapshotOf(db)
    await snapshot.restoreSnapshot(snap.id, 1)

    const raw = db.calls.raw.join('\n')
    for (const table of ['Booking', 'BookingCharge', 'Payment', 'BookingService']) {
      expect(raw).toContain(`pg_get_serial_sequence('"${table}"', 'id')`)
    }
  })

  it('оповещает подключённые рабочие места', async () => {
    const snap = await snapshotOf(db)
    await snapshot.restoreSnapshot(snap.id, 1)
    expect(events.map(e => e.name)).toContain('snapshot:restored')
  })
})

// ─── Кэши сумм ───────────────────────────────────────────────────────────────────

describe('кэши сумм в брони', () => {
  it('totalAmount и paidAmount пересчитываются из восстановленных строк', async () => {
    // Портим кэши в снимке: после отката они обязаны сойтись со строками
    const db2 = createDb(fixture())
    db2.tables.booking[0].totalAmount = 777
    db2.tables.booking[0].paidAmount = 777
    const mod = loadSnapshot(db2.prisma)
    const snap = await mod.createSnapshot({ kind: 'manual', label: 'Точка' })

    await mod.restoreSnapshot(snap.id, 1)

    const b = db2.tables.booking.find(x => x.id === 41)
    expect(b.totalAmount).toBe(45000)      // 30 000 + 15 000
    expect(b.paidAmount).toBe(50000)       // 60 000 − 10 000 возврата, отменённый не в счёт
  })

  it('бронь без строк сохраняет свою сумму — обнулять её нельзя', async () => {
    const snap = await snapshotOf(db)
    await snapshot.restoreSnapshot(snap.id, 1)

    const old = db.tables.booking.find(x => x.id === 42)
    expect(old.totalAmount).toBe(30000)
    expect(old.paidAmount).toBe(7000)
    expect(old.prepaidAmount).toBe(15000)
  })
})

// ─── Внешние ключи, которых больше нет ───────────────────────────────────────────

describe('битые внешние ключи', () => {
  it('удалённый автор строки и кассир обнуляются, имя в платеже остаётся', async () => {
    const snap = await snapshotOf(db)
    // Кассира #2 уволили и удалили
    db.tables.admin = db.tables.admin.filter(a => a.id !== 2)

    await snapshot.restoreSnapshot(snap.id, 1)

    expect(db.tables.bookingCharge.find(c => c.id === 72).createdById).toBeNull()
    const refund = db.tables.payment.find(p => p.id === 6)
    expect(refund.adminId).toBeNull()
    expect(refund.adminName).toBe('Кассир')       // ради этого имя и продублировано
    // Бронь #42 была заведена удалённым админом — уходит на того, кто откатывает
    expect(db.tables.booking.find(b => b.id === 42).adminId).toBe(1)
  })

  it('удалённая смена обнуляется, businessDate платежа остаётся', async () => {
    const snap = await snapshotOf(db)
    db.tables.shift = []
    await snapshot.restoreSnapshot(snap.id, 1)

    const p = db.tables.payment.find(x => x.id === 5)
    expect(p.shiftId).toBeNull()
    expect(p.businessDate).toBeInstanceOf(Date)
  })

  it('услуга, удалённая из справочника, пропускается — начисление за неё живёт отдельно', async () => {
    const snap = await snapshotOf(db)
    db.tables.service = []

    const res = await snapshot.restoreSnapshot(snap.id, 1)

    expect(res.services).toBe(0)
    expect(res.skippedServices).toBe(1)
    expect(res.charges).toBe(2)   // деньги за услугу остались строкой начисления
  })

  it('бронь удалённого номера пропускается вместе со своими деньгами', async () => {
    const snap = await snapshotOf(db)
    db.tables.room = db.tables.room.filter(r => r.id !== 10)

    // Деньги брони #41 после отката исчезнут → нужно осознанное подтверждение
    const res = await snapshot.restoreSnapshot(snap.id, 1, { allowMoneyLoss: true })

    expect(res.restored).toBe(1)
    expect(res.skipped).toBe(1)
    expect(res.payments).toBe(0)
    expect(res.charges).toBe(0)
    expect(db.tables.payment).toHaveLength(0)
  })
})

// ─── Защита денег ────────────────────────────────────────────────────────────────

describe('защита от молчаливой потери денег', () => {
  it('снимок старого формата не откатывается без подтверждения', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))

    await expect(snapshot.restoreSnapshot(900, 1)).rejects.toThrow(/старом формате/)
    // База не тронута
    expect(db.tables.payment).toHaveLength(3)
    expect(db.tables.bookingCharge).toHaveLength(2)
  })

  it('в отказе сказано, сколько платежей и на какую сумму исчезнет', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))
    const err = await snapshot.restoreSnapshot(900, 1).catch(e => e)

    expect(err.status).toBe(409)
    expect(err.message).toMatch(/платежей — 3/)
    // 60 000 − 10 000 возврата, отменённый не в счёт
    const NBSP = String.fromCharCode(160)   // Intl разделяет разряды неразрывным пробелом
    expect(err.message.split(NBSP).join(' ')).toMatch(/50 000 ₸/)
    expect(err.impact.requiresConfirmation).toBe(true)
    expect(err.impact.legacyFormat).toBe(true)
  })

  it('с подтверждением откат старого снимка проходит, а деньги уходят в защитный снимок', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))

    const res = await snapshot.restoreSnapshot(900, 1, { allowMoneyLoss: true })

    expect(res.restored).toBe(2)
    expect(res.lostPayments).toBe(3)
    expect(db.tables.payment).toHaveLength(0)     // деньги действительно стёрты

    // Защитный снимок обязан быть в НОВОМ формате, иначе откат отката снова потеряет кассу
    const safety = db.tables.snapshot.find(s => s.kind === 'safety')
    expect(safety.data.version).toBe(2)
    expect(safety.data.payments).toHaveLength(3)
    expect(safety.data.charges).toHaveLength(2)
  })

  it('новый снимок без свежего платежа тоже требует подтверждения', async () => {
    const snap = await snapshotOf(db)
    // После снимка приняли ещё 20 000 — откат их сотрёт
    db.tables.payment.push({
      id: 8, bookingId: 41, kind: 'payment', amount: 20000, method: 'card',
      adminId: 1, adminName: 'Главный администратор', shiftId: 5,
      businessDate: d('2026-08-27'), paidAt: new Date('2026-08-27T09:00:00Z'),
      comment: null, refundOfId: null, voidedAt: null, voidedById: null, voidReason: null,
      createdAt: new Date('2026-08-27T09:00:00Z'), updatedAt: new Date('2026-08-27T09:00:00Z'),
    })

    const err = await snapshot.restoreSnapshot(snap.id, 1).catch(e => e)
    expect(err.status).toBe(409)
    expect(err.impact.payments.lost).toBe(1)
    expect(err.impact.payments.lostAmount).toBe(20000)
    expect(err.impact.legacyFormat).toBe(false)
    expect(db.tables.payment).toHaveLength(4)     // ничего не тронуто
  })

  it('откат на снимок, где все платежи на месте, подтверждения не требует', async () => {
    const snap = await snapshotOf(db)
    // Начисление после снимка — это не касса, откат из-за него не блокируем
    db.tables.bookingCharge.push({
      id: 73, bookingId: 41, kind: 'extra', label: 'Мини-бар',
      quantity: 1, unitPrice: 1500, amount: 1500, date: null,
      source: 'manual', reason: 'Взял воду', createdById: 1,
      createdAt: new Date(), updatedAt: new Date(),
    })

    const res = await snapshot.restoreSnapshot(snap.id, 1)
    expect(res.restored).toBe(2)
    expect(res.payments).toBe(3)
  })

  it('describeRestore показывает последствия и ничего не меняет', async () => {
    db.tables.snapshot.push(legacySnapshot(db.tables.booking))

    const info = await snapshot.describeRestore(900, 1)

    expect(info.version).toBe(1)
    expect(info.requiresConfirmation).toBe(true)
    expect(info.payments).toMatchObject({ current: 3, restored: 0, lost: 3, lostAmount: 50000 })
    expect(info.bookings).toMatchObject({ inSnapshot: 2, restored: 2, skipped: 0 })
    expect(info.warning).toMatch(/allowMoneyLoss/)
    // Ни снимков, ни изменений в базе
    expect(db.tables.snapshot.filter(s => s.kind === 'safety')).toHaveLength(0)
    expect(db.tables.payment).toHaveLength(3)
  })

  it('колонка, которой нет в списке восстановления, попадает в лог', async () => {
    // Схему ведёт другой агент: новая колонка брони не должна теряться молча
    const bookings = db.tables.booking.map(b => ({ ...b, loyaltyCardId: 7 }))
    db.tables.snapshot.push(legacySnapshot(bookings))

    await snapshot.describeRestore(900, 1)

    expect(warnings.join('\n')).toMatch(/Booking.*loyaltyCardId/)
  })

  it('несуществующий снимок — понятная ошибка, а не падение', async () => {
    await expect(snapshot.restoreSnapshot(12345, 1)).rejects.toThrow('Снимок не найден')
  })
})
