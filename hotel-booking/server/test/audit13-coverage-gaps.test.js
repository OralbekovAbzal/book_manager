/**
 * Аудит 2026-09-13, направление «тесты/зависимости/документация».
 *
 * Здесь закрыты четыре дыры покрытия, найденные при разборе карты тестов. Все
 * четыре — код, который до сегодня не загружал ни один тест, и при этом он
 * стоит на пути покупателя: встроенные отчёты, переход смены, валидаторы самого
 * большого роута (брони) и квоты партнёров.
 *
 * Правило направления: НАСТОЯЩИЕ ошибки не чиним — помечаем `it.fails`, чтобы
 * прогон оставался зелёным, а находка не потерялась (как в `moneyKnownIssues`).
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { loadCjs, SERVER_ROOT } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

const { validate } = loadCjs('src/middleware/validate.js')

function fakeRes() {
  const r = { code: 200, body: null }
  r.status = (c) => { r.code = c; return r }
  r.json = (b) => { r.body = b; return r }
  return r
}

// ─────────────────── 1. Встроенные определения отчётов ──────────────────────
// `registry.loadBuiltins()` бросает исключение на кривом определении. Вопреки
// комментарию в самом файле («проверяются при старте»), зовётся он лениво — при
// первом открытии раздела «Отчёты». То есть опечатка в JSON доезжает до отеля и
// превращается в 500 на экране, а не в упавшую сборку. Проверяем при прогоне.

describe('встроенные отчёты грузятся и проходят проверку определения', () => {
  const DEF_DIR = path.join(SERVER_ROOT, 'src/reports/definitions')
  const registry = loadCjs('src/reports/registry.js', { stubs: { '../utils/prisma': { prisma: {} } } })
  const files = fs.readdirSync(DEF_DIR).filter((f) => f.endsWith('.json'))

  it('определений в поставке ровно столько, сколько ждёт интерфейс', () => {
    expect(files.sort()).toEqual([
      'bookings-registry.json', 'cash-register.json', 'debts.json', 'occupancy.json', 'revenue.json',
    ])
  })

  for (const file of files) {
    it(`${file}: validateDefinition не находит замечаний`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(DEF_DIR, file), 'utf8'))
      expect(registry.validateDefinition(raw)).toEqual([])
    })
  }
})

// ───────────────────────── 2. Переход на следующий день ─────────────────────
// Сутки отеля двигает только человек кнопкой. Границы здесь стоят номера: гость
// с выездом СЕГОДНЯ ещё в номере (переход запрещён), с выездом ЗАВТРА — нет.

function loadShift(prisma) {
  return loadCjs('src/controllers/shiftController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      './occupancyController': { invalidateGridCache: () => {} },
      '../utils/snapshot': { createSnapshot: async () => ({}) },
      '../socket/socketManager': { emitShiftChanged: () => {} },
    },
  })
}

/** Связи смены (`createdBy`, `_count`) фикстура хранить не может — отдаём вычислителями. */
const SHIFT_VIRTUAL = {
  shift: {
    createdBy: () => ({ id: 1, name: 'Админ' }),
    _count: () => ({ bookings: 0 }),
  },
}

function shiftFixture(bookings, shifts) {
  return createFakePrisma({
    shift: shifts || [{ id: 1, date: d('2026-07-10'), createdById: 1 }],
    booking: bookings,
  }, { virtual: SHIFT_VIRTUAL })
}

function checkedIn(over) {
  return {
    id: 5, guestName: 'Гость', checkOut: d('2026-07-11'), status: 'CHECKED_IN',
    roomId: 1, room: { number: '101', building: 'A' }, ...over,
  }
}

describe('сутки отеля: переход на следующий день', () => {
  it('новая смена — ровно следующая календарная дата, UTC-полночь', async () => {
    const { prisma } = shiftFixture([])
    const res = fakeRes()
    await loadShift(prisma).nextDay({ admin: { id: 1 }, body: {} }, res, (e) => { throw e })
    expect(res.code).toBe(201)
    expect(res.body.data.date).toEqual(d('2026-07-11'))
  })

  it('выезд в день заезда следующего дня (завтра) переходу не мешает', async () => {
    const { prisma } = shiftFixture([checkedIn({ checkOut: d('2026-07-11') })])
    const res = fakeRes()
    await loadShift(prisma).nextDay({ admin: { id: 1 }, body: {} }, res, (e) => { throw e })
    expect(res.code).toBe(201)
  })

  it('заселённый гость с выездом СЕГОДНЯ останавливает переход (409 со списком номеров)', async () => {
    const { prisma } = shiftFixture([checkedIn({ checkOut: d('2026-07-10') })])
    const res = fakeRes()
    await loadShift(prisma).nextDay({ admin: { id: 1 }, body: {} }, res, (e) => { throw e })
    expect(res.code).toBe(409)
    expect(res.body.overdueCheckouts).toHaveLength(1)
    expect(res.body.overdueCheckouts[0].room.number).toBe('101')
  })

  it('выехавший вчера гость (CHECKED_OUT) переход не держит', async () => {
    const { prisma } = shiftFixture([checkedIn({ checkOut: d('2026-07-09'), status: 'CHECKED_OUT' })])
    const res = fakeRes()
    await loadShift(prisma).nextDay({ admin: { id: 1 }, body: {} }, res, (e) => { throw e })
    expect(res.code).toBe(201)
  })

  /**
   * НАХОДКА T13-014. `upsert` в `shiftController.nextDay:86` подписан «create if
   * not exists, do nothing if already exists», но ключом идёт `latest + 1 день` —
   * то есть дата, которой заведомо ещё нет. Идемпотентности нет: второй запрос
   * (двойное нажатие, повтор после таймаута сети, два рабочих места подтвердили
   * один диалог) двигает сутки отеля ЕЩЁ на день. Вернуться назад нечем: рабочая
   * дата — это максимум `Shift.date`, а роута на удаление смены нет, только
   * правка в базе. В UI защита есть (`window.confirm` с датой), у API — нет.
   * Как надо: принимать ожидаемую текущую дату и отвечать 409 при расхождении —
   * ровно так уже сделан замок версии брони (`expectedUpdatedAt`).
   * Не чиним: `shiftController.js` — чужая зона.
   */
  it.fails('повторный запрос перехода не двигает сутки отеля дважды', async () => {
    const { prisma } = shiftFixture([])
    const ctrl = loadShift(prisma)
    await ctrl.nextDay({ admin: { id: 1 }, body: {} }, fakeRes(), (e) => { throw e })
    const second = fakeRes()
    await ctrl.nextDay({ admin: { id: 1 }, body: {} }, second, (e) => { throw e })
    expect(second.body.data.date).toEqual(d('2026-07-11'))
  })
})

// ─────────────────── 3. Валидаторы роута броней (без supertest) ─────────────
// Правила роута не экспортируются — достаём их дописанным экспортом, файл не
// трогая (приём из `roles.test.js`). До сегодня из 23 роутов правила проверялись
// только у `users` и `setup`; `bookings` — самый большой набор в проекте.

function bookingRules() {
  return loadCjs('src/routes/bookings.js', {
    append: 'module.exports.__test = { bookingBodyRules, bookingUpdateRules, previewRules, chargeCreateRules, listRules }',
    stubs: {
      '../controllers/bookingController': new Proxy({}, { get: () => () => {} }),
      '../controllers/settlementController': { ACTIONS: ['cancel', 'checkout', 'none'], preview: () => {}, settle: () => {} },
      '../controllers/paymentController': { METHODS: ['cash', 'card'] },
      '../middleware/auth': { authenticate: (_q, _s, n) => n(), requireRole: () => (_q, _s, n) => n() },
      '../middleware/validate': { validate },
    },
  }).__test
}

/** Прогон тела через правила роута и `middleware/validate` — путь настоящего запроса. */
async function runRules(rules, body, query = {}) {
  const req = { body: JSON.parse(JSON.stringify(body)), params: {}, query, headers: {}, cookies: {} }
  for (const rule of rules) await rule.run(req)
  let rejected = null
  const res = {
    status(code) { this.code = code; return this },
    json(payload) { rejected = { status: this.code, fields: payload.details.map((x) => x.field) }; return this },
  }
  let passed = false
  validate(req, res, () => { passed = true })
  return passed ? null : rejected
}

const NEW_BOOKING = { roomId: 1, guestName: 'Иванов Иван', checkIn: '2026-07-10', checkOut: '2026-07-12' }

describe('валидаторы POST /api/bookings', () => {
  const rules = bookingRules()

  it('минимальное корректное тело проходит', async () => {
    expect(await runRules(rules.bookingBodyRules, NEW_BOOKING)).toBeNull()
  })

  it('дата без ведущих нулей («2026-7-3») отвергается, а не разбирается на свой лад', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, checkIn: '2026-7-3' })
    expect(r && r.fields).toEqual(['checkIn'])
  })

  it('дата с временем («2026-07-10T00:00:00Z») в checkIn отвергается: колонка календарная', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, checkIn: '2026-07-10T00:00:00Z' })
    expect(r && r.fields).toEqual(['checkIn'])
  })

  it('30 февраля не проходит', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, checkOut: '2026-02-30' })
    expect(r && r.fields).toEqual(['checkOut'])
  })

  it('имя гостя из одних пробелов не проходит', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, guestName: '   ' })
    expect(r && r.fields).toContain('guestName')
  })

  it('услуга без serviceId не проходит (иначе питание молча потерялось бы)', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, services: [{ adults: 2 }] })
    expect(r && r.fields).toContain('services[0].serviceId')
  })

  it('скидка 100,5 % не проходит', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, discountPercent: 100.5 })
    expect(r && r.fields).toContain('discountPercent')
  })

  it('flags строкой вместо массива не проходит', async () => {
    const r = await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, flags: 'late_checkout' })
    expect(r && r.fields).toContain('flags')
  })

  it('документ гостя: чужой тип документа не проходит, пустая строка — проходит (поле очистили)', async () => {
    expect(await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, guestDocType: 'visa' })).not.toBeNull()
    expect(await runRules(rules.bookingBodyRules, { ...NEW_BOOKING, guestDocType: '' })).toBeNull()
  })

  it('ручная строка начисления без причины не сохраняется', async () => {
    const r = await runRules(rules.chargeCreateRules, { kind: 'extra', label: 'Штраф', unitPrice: 5000 })
    expect(r && r.fields).toContain('reason')
  })

  it('limit больше 500 в списке броней не проходит', async () => {
    const r = await runRules(rules.listRules, {}, { limit: '5000' })
    expect(r && r.fields).toContain('limit')
  })

  /**
   * НАХОДКА T13-012. У количества в ручной строке начисления нет верхней
   * границы, хотя у цены она есть (±100 000 000). `quantity: 1e15` при цене
   * 100 000 000 даёт строку на 1e23 тенге: `Number.isFinite` в контроллере
   * такую сумму пропускает (она конечная), колонка `Float` её принимает, и
   * итог счёта после этого нельзя привести к правильному иначе как удалением
   * строки. Ожидаемое поведение — 400, как у цены. Не чиним: правка в
   * `src/routes/bookings.js` — чужая зона.
   */
  it.fails('количество в ручной строке ограничено сверху так же, как цена', async () => {
    const r = await runRules(rules.chargeCreateRules, {
      kind: 'extra', label: 'Услуга', quantity: 1e15, unitPrice: 100000000, reason: 'опечатка',
    })
    expect(r && r.fields).toContain('quantity')
  })
})

// ──────────────────────── 4. Квоты партнёров (аллотменты) ───────────────────
// Роут `/api/allotments` — единственный из пишущих, у которого нет ни одного
// правила express-validator: всё, что проверяется, проверяет контроллер.

function loadAllotmentCtrl(prisma) {
  return loadCjs('src/controllers/allotmentController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      './occupancyController': { invalidateGridCache: () => {} },
    },
  })
}

const ALLOTMENT_VIRTUAL = {
  allotment: {
    partner: (rec) => ({ id: rec.partnerId, name: 'Тур-Оператор', color: '#0a0' }),
    room: (rec) => ({ id: rec.roomId, number: '101', building: 'A', floor: 1 }),
  },
}

function allotmentFixture(rows = []) {
  return createFakePrisma({
    allotment: rows.map((r) => ({
      id: r.id, partnerId: r.partnerId, roomId: r.roomId, dateFrom: r.dateFrom, dateTo: r.dateTo,
      notes: null,
    })),
  }, { virtual: ALLOTMENT_VIRTUAL })
}

describe('квоты партнёров: границы периода', () => {
  it('период «задом наперёд» не сохраняется', async () => {
    const { prisma } = allotmentFixture()
    const res = fakeRes()
    let err = null
    await loadAllotmentCtrl(prisma).create(
      { body: { partnerId: 7, roomId: 1, dateFrom: '2026-07-20', dateTo: '2026-07-10' } },
      res, (e) => { err = e },
    )
    expect(err && err.status).toBe(400)
    expect((await prisma.allotment.findMany({ where: {} })).length).toBe(0)
  })

  it('квота нулевой длины (дата «с» = дата «по») не сохраняется', async () => {
    const { prisma } = allotmentFixture()
    const res = fakeRes()
    let err = null
    await loadAllotmentCtrl(prisma).create(
      { body: { partnerId: 7, roomId: 1, dateFrom: '2026-07-10', dateTo: '2026-07-10' } },
      res, (e) => { err = e },
    )
    expect(err && err.status).toBe(400)
  })

  it('новая квота встык к прежней (с 20-го, прежняя по 20-е) конфликтом не считается', async () => {
    const { prisma } = allotmentFixture([
      { id: 1, partnerId: 7, roomId: 1, dateFrom: d('2026-07-10'), dateTo: d('2026-07-20') },
    ])
    const res = fakeRes()
    await loadAllotmentCtrl(prisma).create(
      { body: { partnerId: 8, roomId: 1, dateFrom: '2026-07-20', dateTo: '2026-07-25' } },
      res, (e) => { throw e },
    )
    expect(res.code).toBe(201)
  })

  it('квота, наезжающая на чужую одним днём, отвергается с именем партнёра', async () => {
    const { prisma } = allotmentFixture([
      { id: 1, partnerId: 7, roomId: 1, dateFrom: d('2026-07-10'), dateTo: d('2026-07-20') },
    ])
    const res = fakeRes()
    let err = null
    await loadAllotmentCtrl(prisma).create(
      { body: { partnerId: 8, roomId: 1, dateFrom: '2026-07-19', dateTo: '2026-07-25' } },
      res, (e) => { err = e },
    )
    expect(err && err.status).toBe(400)
    expect(err.message).toMatch(/Тур-Оператор/)
  })

  /**
   * НАХОДКА T13-013. У роута квот нет ни одного правила express-validator
   * (`src/routes/allotments.js:10-11`), а контроллер проверяет только наличие
   * полей. Нечисловая дата доходит до `new Date(...)` → Invalid Date; сравнение
   * `to <= from` с двумя NaN ложно, поэтому проверка «дата окончания позже»
   * пропускает, и запрос уходит в Prisma. Для стойки это 500 «Ошибка сервера»
   * вместо внятного «Проверьте даты». Ожидаемое поведение — 400.
   * Не чиним: `routes/allotments.js` и контроллер — чужая зона.
   */
  it.fails('мусор в дате квоты отвечает 400, а не падает внутрь Prisma', async () => {
    const { prisma } = allotmentFixture()
    const res = fakeRes()
    let err = null
    await loadAllotmentCtrl(prisma).create(
      { body: { partnerId: 7, roomId: 1, dateFrom: 'завтра', dateTo: '2026-07-25' } },
      res, (e) => { err = e },
    )
    expect(err && err.status).toBe(400)
  })
})
