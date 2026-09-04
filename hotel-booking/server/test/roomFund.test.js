import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Справочники номерного фонда (корпуса, особенности, вместимости).
 *
 * Проверяется главным образом то, ради чего эти таблицы вообще заведены:
 * связь справочника с номерами держится на СТРОКЕ, а не на внешнем ключе
 * (Room.building — название, Room.features — названия, Room.capacity — код).
 * Поэтому цена ошибки — молча оторванные от справочника номера, и именно это
 * тесты и стерегут: переименование тянет за собой номера, «удаление» не рвёт
 * связь, а повторная заливка localStorage не плодит дублей.
 */

/** Номера рабочей базы в миниатюре: два корпуса, две особенности, два кода вместимости. */
function rooms() {
  return [
    { id: 1, building: 'КОРПУС A', features: ['Односпальная кровать'], capacity: 'double' },
    { id: 2, building: 'КОРПУС A', features: ['Двуспальная кровать', 'Балкон'], capacity: 'triple' },
    { id: 3, building: 'B', features: [], capacity: 'triple' },
  ]
}

function directories() {
  return {
    building: [
      { id: 1, code: 'корпус_a', name: 'КОРПУС A', description: null, order: 1, isActive: true },
      { id: 2, code: 'b', name: 'B', description: 'Старый корпус', order: 2, isActive: true },
    ],
    roomFeature: [
      { id: 1, code: 'balcony', name: 'Балкон', emoji: '🪟', order: 0, isActive: true },
      { id: 2, code: 'single_bed', name: 'Односпальная кровать', emoji: null, order: 3, isActive: true },
      { id: 3, code: 'double_bed', name: 'Двуспальная кровать', emoji: '🛏', order: 4, isActive: true },
    ],
    roomCapacity: [
      { id: 1, code: 'double', label: 'Двухместный', value: 2, order: 1, isActive: true },
      { id: 2, code: 'triple', label: 'Трёхместный', value: 3, order: 2, isActive: true },
      // Код из localStorage, расшифровки которого миграция знать не могла.
      { id: 3, code: '1781675520618', label: 'Вместимость 1781675520618', value: 0, order: 101, isActive: true },
    ],
  }
}

/** Свежий экземпляр контроллера со своей базой-заглушкой. */
function setup(fixtures = {}) {
  const { prisma, calls } = createFakePrisma({
    room: rooms(),
    ...directories(),
    ...fixtures,
  })
  // Переименование особенности правит ЭЛЕМЕНТ массива — это сырой SQL.
  // Заглушка не выполняет его, а записывает: тест проверяет, что запрос ушёл
  // с нужными названиями.
  const rawCalls = []
  prisma.$executeRaw = async (strings, ...values) => {
    rawCalls.push({ sql: strings.join('?'), values })
    return values.length
  }

  const ctrl = loadCjs('src/controllers/roomFundController.js', {
    stubs: {
      '../utils/prisma': { prisma },
      '../utils/logger': silentLogger,
      // Сброс кэша сетки — побочный эффект, к справочнику отношения не имеющий.
      './occupancyController': { invalidateGridCache() {} },
    },
  })
  return { ctrl, prisma, calls, rawCalls }
}

/** Вызов express-обработчика: возвращает то, чем он ответил (или ошибку из next). */
async function call(handler, req = {}) {
  const out = { status: 200, body: undefined, error: undefined }
  const res = {
    status(code) { out.status = code; return res },
    json(payload) { out.body = payload; return res },
  }
  await handler({ params: {}, query: {}, body: {}, ...req }, res, (err) => {
    out.error = err
    out.status = err?.statusCode || err?.status || 500
  })
  return out
}

// ─── Чтение ───────────────────────────────────────────────────────────────────

describe('GET /api/room-fund', () => {
  it('отдаёт три справочника разом и считает, сколько номеров держат запись', async () => {
    const { ctrl } = setup()
    const { body } = await call(ctrl.all)

    const byName = Object.fromEntries(body.data.buildings.map((b) => [b.name, b.usedByRooms]))
    expect(byName).toEqual({ 'КОРПУС A': 2, B: 1 })

    const features = Object.fromEntries(body.data.features.map((f) => [f.name, f.usedByRooms]))
    expect(features['Односпальная кровать']).toBe(1)
    expect(features['Балкон']).toBe(1)

    const caps = Object.fromEntries(body.data.capacities.map((c) => [c.code, c.usedByRooms]))
    expect(caps.triple).toBe(2)
    // Код есть в справочнике, но им никто не пользуется — такую строку можно удалить насовсем.
    expect(caps['1781675520618']).toBe(0)
  })

  it('скрытые записи по умолчанию не отдаются, с includeHidden — отдаются', async () => {
    const hidden = directories()
    hidden.roomFeature[0].isActive = false
    const { ctrl } = setup(hidden)

    const visible = await call(ctrl.all)
    expect(visible.body.data.features.map((f) => f.name)).not.toContain('Балкон')

    const withHidden = await call(ctrl.all, { query: { includeHidden: 'true' } })
    expect(withHidden.body.data.features.map((f) => f.name)).toContain('Балкон')
  })
})

describe('ensureSeeded — пустой справочник', () => {
  it('засевает стандартный набор, если таблица пуста', async () => {
    const { ctrl, prisma } = setup({ roomFeature: [], roomCapacity: [] })
    await call(ctrl.all)
    expect(prisma.roomFeature.rows.map((f) => f.code)).toContain('balcony')
    expect(prisma.roomCapacity.rows.map((c) => c.code)).toContain('single')
  })

  it('не воскрешает то, что пользователь скрыл: непустую таблицу не трогает', async () => {
    const onlyHidden = directories()
    for (const f of onlyHidden.roomFeature) f.isActive = false
    const { ctrl, prisma } = setup(onlyHidden)

    await call(ctrl.all)
    expect(prisma.roomFeature.rows).toHaveLength(3)
    expect(prisma.roomFeature.rows.map((f) => f.code)).not.toContain('safe')
  })
})

// ─── Переименование тянет за собой номера ─────────────────────────────────────

describe('переименование корпуса', () => {
  it('переписывает Room.building — иначе номера выпали бы из фильтра', async () => {
    const { ctrl, prisma } = setup()
    const { body } = await call(ctrl.updateBuilding, { params: { id: '1' }, body: { name: 'Корпус А' } })

    expect(body.data.name).toBe('КОРПУС А')
    expect(body.renamedRooms).toBe(2)
    expect(prisma.room.rows.filter((r) => r.building === 'КОРПУС А')).toHaveLength(2)
    expect(prisma.room.rows.some((r) => r.building === 'КОРПУС A')).toBe(false)
  })

  it('приводит название к верхнему регистру — так его пишет roomController', async () => {
    const { ctrl } = setup()
    const { body } = await call(ctrl.createBuilding, { body: { name: '  корпус в ' } })
    expect(body.data.name).toBe('КОРПУС В')
  })

  it('чужое название — 409, а не 500: база отбивает по уникальности имени', async () => {
    const { ctrl, prisma } = setup()
    // Заглушка уникальность не стережёт — подставляем ту самую ошибку Prisma,
    // которой ответит настоящая база (unique constraint на Building.name).
    prisma.building.update = async () => {
      const e = new Error('Unique constraint failed on the fields: (`name`)')
      e.code = 'P2002'
      throw e
    }
    const { status, error } = await call(ctrl.updateBuilding, { params: { id: '1' }, body: { name: 'B' } })
    expect(status).toBe(409)
    expect(error.message).toMatch(/уже есть/)
  })
})

describe('переименование особенности', () => {
  it('уходит в Room.features тем же запросом (array_replace)', async () => {
    const { ctrl, rawCalls } = setup()
    const { body } = await call(ctrl.updateFeature, { params: { id: '2' }, body: { name: 'Односпальная кровать (новая)' } })

    expect(body.data.name).toBe('Односпальная кровать (новая)')
    expect(rawCalls).toHaveLength(1)
    expect(rawCalls[0].sql).toMatch(/array_replace/)
    // Старое название встречается в запросе дважды: в array_replace и в WHERE.
    expect(rawCalls[0].values).toEqual([
      'Односпальная кровать',
      'Односпальная кровать (новая)',
      'Односпальная кровать',
    ])
  })

  it('правка одного значка номера не трогает', async () => {
    const { ctrl, rawCalls } = setup()
    await call(ctrl.updateFeature, { params: { id: '2' }, body: { emoji: '🛌' } })
    expect(rawCalls).toHaveLength(0)
  })
})

describe('переименование вместимости', () => {
  it('номера не трогает: они ссылаются на код, а не на подпись', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.updateCapacity, { params: { id: '2' }, body: { label: 'Трёхместный номер', value: 3 } })
    expect(prisma.room.rows.map((r) => r.capacity)).toEqual(['double', 'triple', 'triple'])
  })
})

// ─── Удаление = скрытие ───────────────────────────────────────────────────────

describe('DELETE — скрыть, а не удалить', () => {
  it('по умолчанию прячет запись и говорит, сколько номеров её держат', async () => {
    const { ctrl, prisma } = setup()
    const { body } = await call(ctrl.removeFeature, { params: { id: '2' } })

    expect(body.data).toMatchObject({ hidden: true, usedByRooms: 1 })
    expect(prisma.roomFeature.rows.find((f) => f.id === 2).isActive).toBe(false)
    // Строка у номера осталась — связь не порвана, особенность просто не в списке.
    expect(prisma.room.rows[0].features).toEqual(['Односпальная кровать'])
  })

  it('purge занятой записи — 409 с числом номеров', async () => {
    const { ctrl, prisma } = setup()
    const { status, error } = await call(ctrl.removeFeature, { params: { id: '2' }, query: { purge: 'true' } })

    expect(status).toBe(409)
    expect(error.message).toMatch(/1/)
    expect(prisma.roomFeature.rows).toHaveLength(3)
  })

  it('purge свободной записи удаляет строку — иначе опечатки копятся навсегда', async () => {
    const { ctrl, prisma } = setup()
    const { body } = await call(ctrl.removeCapacity, { params: { id: '3' }, query: { purge: 'true' } })

    expect(body.data).toMatchObject({ purged: true })
    expect(prisma.roomCapacity.rows.map((c) => c.code)).not.toContain('1781675520618')
  })

  it('скрытую запись возвращает обычный PUT', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.removeFeature, { params: { id: '1' } })
    await call(ctrl.updateFeature, { params: { id: '1' }, body: { isActive: true } })
    expect(prisma.roomFeature.rows.find((f) => f.id === 1).isActive).toBe(true)
  })
})

// ─── Разовая заливка localStorage ─────────────────────────────────────────────

/** Ровно та форма, что лежит в localStorage клиента (RoomFundConfig). */
const LOCAL_STORAGE = {
  buildings: [
    { id: '1781675520000', name: 'Корпус А', description: 'Главное здание' },
    { id: '1781675520999', name: 'Корпус Б', description: '' },
  ],
  features: [
    { id: 'balcony', name: 'Балкон', emoji: '🪟' },
    { id: '1781675521111', name: 'Односпальная кровать', emoji: '🛌' },
    { id: 'safe', name: 'Сейф', emoji: '🔒' },
  ],
  capacities: [
    { id: 'double', label: 'Двухместный', value: 2 },
    { id: '1781675520618', label: 'Полулюкс', value: 2 },
  ],
}

describe('POST /api/room-fund/import', () => {
  it('первая заливка добавляет только то, чего в базе нет', async () => {
    const { ctrl, prisma } = setup()
    const { body } = await call(ctrl.importFund, { body: LOCAL_STORAGE })

    // «Корпус А» на сервере уже есть под именем «КОРПУС A» — совпадение по названию.
    expect(body.data.buildings.created).toBe(1)
    expect(prisma.building.rows.map((b) => b.name)).toEqual(['КОРПУС A', 'B', 'КОРПУС Б'])
    // Из особенностей нет только сейфа.
    expect(body.data.features.created).toBe(1)
    expect(prisma.roomFeature.rows.map((f) => f.name)).toContain('Сейф')
    // Вместимости совпадают по коду — новых нет.
    expect(body.data.capacities.created).toBe(0)
  })

  it('повторная заливка (второй ноутбук, второй запуск) ничего не плодит', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, { body: LOCAL_STORAGE })
    const before = {
      b: prisma.building.rows.length,
      f: prisma.roomFeature.rows.length,
      c: prisma.roomCapacity.rows.length,
    }

    const second = await call(ctrl.importFund, { body: LOCAL_STORAGE })

    expect(second.body.data.buildings.created).toBe(0)
    expect(second.body.data.features.created).toBe(0)
    expect(second.body.data.capacities.created).toBe(0)
    expect(prisma.building.rows).toHaveLength(before.b)
    expect(prisma.roomFeature.rows).toHaveLength(before.f)
    expect(prisma.roomCapacity.rows).toHaveLength(before.c)
  })

  it('название корпуса приводится к верхнему регистру — иначе не сойдётся с Room.building', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, { body: LOCAL_STORAGE })
    expect(prisma.building.rows.map((b) => b.name)).toContain('КОРПУС Б')
    expect(prisma.building.rows.map((b) => b.name)).not.toContain('Корпус Б')
  })

  it('заполняет пустое: у корпуса появилось описание, у особенности — значок', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, { body: LOCAL_STORAGE })

    expect(prisma.building.rows.find((b) => b.name === 'КОРПУС A').description).toBe('Главное здание')
    expect(prisma.roomFeature.rows.find((f) => f.code === 'single_bed').emoji).toBe('🛌')
  })

  it('НЕ перебивает то, что уже введено на сервере: localStorage второго ноутбука старее', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, {
      body: {
        buildings: [{ id: 'b', name: 'B', description: 'Описание из localStorage' }],
        features: [{ id: 'balcony', name: 'Балкон', emoji: '🌅' }],
      },
    })

    expect(prisma.building.rows.find((b) => b.name === 'B').description).toBe('Старый корпус')
    expect(prisma.roomFeature.rows.find((f) => f.code === 'balcony').emoji).toBe('🪟')
  })

  it('заглушку «Вместимость <код>» заменяет: это не данные, а признак их отсутствия', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, { body: LOCAL_STORAGE })

    const cap = prisma.roomCapacity.rows.find((c) => c.code === '1781675520618')
    expect(cap.label).toBe('Полулюкс')
    expect(cap.value).toBe(2)
  })

  it('заполненную подпись вместимости не трогает', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, {
      body: { capacities: [{ id: 'double', label: 'Двушка', value: 2 }] },
    })
    expect(prisma.roomCapacity.rows.find((c) => c.code === 'double').label).toBe('Двухместный')
  })

  it('ничего не удаляет и не прячет: чего в заливке нет — остаётся как было', async () => {
    const { ctrl, prisma } = setup()
    await call(ctrl.importFund, { body: { buildings: [], features: [], capacities: [] } })

    expect(prisma.building.rows).toHaveLength(2)
    expect(prisma.roomFeature.rows.every((f) => f.isActive)).toBe(true)
  })

  it('пустые и мусорные записи пропускает, а не падает', async () => {
    const { ctrl, prisma } = setup()
    const { body } = await call(ctrl.importFund, {
      body: { buildings: [{ id: 'x', name: '   ' }, null], features: [{ id: 'y' }] },
    })

    expect(body.data.buildings.created).toBe(0)
    expect(body.data.features.created).toBe(0)
    expect(prisma.building.rows).toHaveLength(2)
  })
})

// ─── Коды ─────────────────────────────────────────────────────────────────────

describe('код записи', () => {
  it('собирается из названия, кириллица сохраняется (как в genCode у меток)', async () => {
    const { ctrl } = setup()
    expect(ctrl.slugify('Корпус Б', 'building')).toBe('корпус_б')
    expect(ctrl.slugify('  ---  ', 'building')).toBe('building')
  })

  it('при занятом коде берёт другой, а не падает', async () => {
    const { ctrl, prisma } = setup()
    // Название латиницей даёт слаг 'balcony' — он уже занят стандартной записью.
    await call(ctrl.createFeature, { body: { name: 'Balcony view' } })
    const created = prisma.roomFeature.rows.find((f) => f.name === 'Balcony view')
    expect(created.code).not.toBe('balcony')
    expect(created.code).toMatch(/^balcony_view/)
  })

  it('повтор названия — 409 от базы, а не 500', async () => {
    const { ctrl, prisma } = setup()
    prisma.roomFeature.create = async () => {
      const e = new Error('Unique constraint failed on the fields: (`name`)')
      e.code = 'P2002'
      throw e
    }
    const { status } = await call(ctrl.createFeature, { body: { name: 'Балкон' } })
    expect(status).toBe(409)
  })
})

describe('буквы-двойники в названиях', () => {
  it('«Корпус А» с русской раскладки узнаётся в «КОРПУС A» с латинской', async () => {
    const { ctrl, prisma } = setup()
    // Именно так и лежит в рабочей базе: КОРПУС + латинская A.
    await call(ctrl.importFund, { body: { buildings: [{ id: 'x', name: 'Корпус А' }] } })
    expect(prisma.building.rows).toHaveLength(2)
  })

  it('ключ сравнения гасит раскладку, но не меняет то, что сохраняется', async () => {
    const { ctrl } = setup()
    expect(ctrl.matchKey('КОРПУС A')).toBe(ctrl.matchKey('корпус а'))
    expect(ctrl.normalizeBuildingName(' Корпус Б ')).toBe('КОРПУС Б')
  })
})
