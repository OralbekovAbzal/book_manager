import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { d } from './helpers/fakePrisma.js'

/**
 * Дымовое покрытие ЧИСТЫХ функций оптимизатора: совместимость номера и брони,
 * конфликты с учётом буферов, подсчёт окон. Сам контроллер (походы в базу,
 * транзакция apply) здесь не запускается.
 *
 * Функции модулем не экспортируются, поэтому загружаем его через loadCjs с
 * дописанным в конец экспортом — исходник при этом не меняется.
 */
const EXPOSE = `module.exports.__test = {
  DEFAULT_SETTINGS, mergeSettings, roomSignature, compatibilityCheck,
  bookingsOverlap, requiredGap, bookingsConflict, effectiveGapDays,
  canPlace, calcMetrics, scoreLayout,
};`

// Свёртка эффектов меток у оптимизатора и у проверки броней теперь ОДНА — берём
// её настоящую, а не заглушку, иначе тест проверял бы копию, которой больше нет.
const realFlagEffects = loadCjs('src/utils/flagEffects.js', { stubs: { './prisma': { prisma: {} } } })

const {
  DEFAULT_SETTINGS, mergeSettings, roomSignature, compatibilityCheck,
  bookingsOverlap, requiredGap, bookingsConflict, effectiveGapDays,
  canPlace, calcMetrics,
} = loadCjs('src/controllers/optimizeController.js', {
  append: EXPOSE,
  stubs: {
    '../utils/prisma': { prisma: {} },
    '../utils/businessDate': { getCurrentBusinessDate: async () => d('2026-07-01') },
    '../utils/flagEffects': { ...realFlagEffects, getFlagEffectsMap: async () => ({}) },
    '../utils/snapshot': { createSnapshot: async () => ({}) },
    '../socket/socketManager': { emitBookingEvent: () => {} },
    './bookingController': { BOOKING_SELECT: {} },
    '../utils/logger': silentLogger,
  },
}).__test

/** Бронь в том виде, в каком её строит optimize(). */
function bk(from, to, over = {}) {
  return {
    id: over.id ?? 1,
    checkInMs: d(from).getTime(),
    checkOutMs: d(to).getTime(),
    flags: [],
    bufferAfter: 0,
    bufferBefore: 0,
    exceptAfterFlag: null,
    movable: true,
    originalFloor: 1,
    originalCapacity: 'double',
    originalFeatures: ['балкон'],
    lockFloor: false,
    requireFeature: null,
    ...over,
  }
}

const ROOM = { id: 101, floor: 1, capacity: 'double', features: ['балкон'] }

describe('mergeSettings', () => {
  it('без входа отдаёт дефолты', () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
  })

  it('null и undefined в присланных настройках не затирают дефолт', () => {
    const S = mergeSettings({ movePenalty: null, capacityRule: undefined })
    expect(S.movePenalty).toBe(DEFAULT_SETTINGS.movePenalty)
    expect(S.capacityRule).toBe(DEFAULT_SETTINGS.capacityRule)
  })

  it('ноль — осмысленное значение и должен применяться, а не считаться «пусто»', () => {
    expect(mergeSettings({ movePenalty: 0 }).movePenalty).toBe(0)
  })

  it('посторонние ключи с клиента в настройки не просачиваются', () => {
    expect(mergeSettings({ dropDatabase: true }).dropDatabase).toBeUndefined()
  })
})

describe('roomSignature', () => {
  it('порядок особенностей не влияет на сигнатуру номера', () => {
    expect(roomSignature({ capacity: 'double', features: ['балкон', 'вид на горы'] }))
      .toBe(roomSignature({ capacity: 'double', features: ['вид на горы', 'балкон'] }))
  })

  it('разная вместимость даёт разные сигнатуры', () => {
    expect(roomSignature({ capacity: 'single', features: [] }))
      .not.toBe(roomSignature({ capacity: 'double', features: [] }))
  })
})

describe('compatibilityCheck — можно ли переселить бронь в номер', () => {
  const S = (over) => mergeSettings(over)

  it('полностью совпадающий номер разрешён и без штрафа', () => {
    expect(compatibilityCheck(ROOM, bk('2026-07-10', '2026-07-12'), S())).toEqual({ allowed: true, penalty: 0 })
  })

  it('строгая вместимость: номер другой вместимости запрещён', () => {
    const room = { ...ROOM, capacity: 'single' }
    expect(compatibilityCheck(room, bk('2026-07-10', '2026-07-12'), S({ capacityRule: 'strict' })).allowed).toBe(false)
  })

  it('мягкая вместимость: номер разрешён, но со штрафом', () => {
    const room = { ...ROOM, capacity: 'single' }
    const res = compatibilityCheck(room, bk('2026-07-10', '2026-07-12'), S({ capacityRule: 'soft' }))
    expect(res.allowed).toBe(true)
    expect(res.penalty).toBe(DEFAULT_SETTINGS.capacityMismatchPenalty)
  })

  it('ignore: вместимость не проверяется и штрафа нет', () => {
    const room = { ...ROOM, capacity: 'single' }
    expect(compatibilityCheck(room, bk('2026-07-10', '2026-07-12'), S({ capacityRule: 'ignore' })))
      .toEqual({ allowed: true, penalty: 0 })
  })

  it('строгие особенности: другой набор особенностей запрещён', () => {
    const room = { ...ROOM, features: ['балкон', 'вид на горы'] }
    expect(compatibilityCheck(room, bk('2026-07-10', '2026-07-12'), S({ featuresRule: 'strict' })).allowed).toBe(false)
  })

  it('мягкие правила складывают штрафы за вместимость и особенности', () => {
    const room = { id: 9, floor: 1, capacity: 'single', features: [] }
    const res = compatibilityCheck(room, bk('2026-07-10', '2026-07-12'), S({ capacityRule: 'soft', featuresRule: 'soft' }))
    expect(res.allowed).toBe(true)
    expect(res.penalty).toBe(DEFAULT_SETTINGS.capacityMismatchPenalty + DEFAULT_SETTINGS.featuresMismatchPenalty)
  })

  it('метка «только этот этаж» запрещает другой этаж даже при мягких правилах', () => {
    const room = { ...ROOM, floor: 3 }
    const booking = bk('2026-07-10', '2026-07-12', { lockFloor: true, originalFloor: 1 })
    expect(compatibilityCheck(room, booking, S({ floorRule: 'ignore', capacityRule: 'ignore', featuresRule: 'ignore' })).allowed).toBe(false)
  })

  it('метка «требует особенность» запрещает номер без неё и разрешает с ней', () => {
    const withFeature = { ...ROOM, features: ['балкон', 'односпальные кровати'] }
    const booking = bk('2026-07-10', '2026-07-12', { requireFeature: 'односпальные кровати' })
    const S1 = S({ capacityRule: 'ignore', featuresRule: 'ignore' })
    expect(compatibilityCheck(ROOM, booking, S1).allowed).toBe(false)
    expect(compatibilityCheck(withFeature, booking, S1).allowed).toBe(true)
  })

  it('floorRule=strict запрещает смену этажа, floorRule=soft разрешает', () => {
    const room = { ...ROOM, floor: 3 }
    const booking = bk('2026-07-10', '2026-07-12', { originalFloor: 1 })
    expect(compatibilityCheck(room, booking, S({ floorRule: 'strict' })).allowed).toBe(false)
    expect(compatibilityCheck(room, booking, S({ floorRule: 'soft' })).allowed).toBe(true)
  })
})

describe('bookingsOverlap / bookingsConflict', () => {
  it('выезд в день заезда следующего гостя не считается пересечением', () => {
    expect(bookingsOverlap(bk('2026-07-10', '2026-07-15'), bk('2026-07-15', '2026-07-18'))).toBe(false)
  })

  it('общая ночь — пересечение, в любом порядке аргументов', () => {
    const a = bk('2026-07-10', '2026-07-15')
    const b = bk('2026-07-14', '2026-07-18')
    expect(bookingsOverlap(a, b)).toBe(true)
    expect(bookingsOverlap(b, a)).toBe(true)
  })

  it('без буферов соседство встык конфликтом не является', () => {
    expect(bookingsConflict(bk('2026-07-10', '2026-07-15'), bk('2026-07-15', '2026-07-18'))).toBe(false)
  })

  it('поздний выезд делает соседство день-в-день конфликтом, в любом порядке аргументов', () => {
    const a = bk('2026-07-10', '2026-07-15', { bufferAfter: 1 })
    const b = bk('2026-07-15', '2026-07-18')
    expect(bookingsConflict(a, b)).toBe(true)
    expect(bookingsConflict(b, a)).toBe(true)
  })

  it('одной свободной ночи хватает, чтобы снять конфликт по буферу', () => {
    expect(bookingsConflict(bk('2026-07-10', '2026-07-15', { bufferAfter: 1 }), bk('2026-07-16', '2026-07-18'))).toBe(false)
  })

  it('ранний заезд второй брони тоже требует зазора', () => {
    expect(bookingsConflict(bk('2026-07-10', '2026-07-15'), bk('2026-07-15', '2026-07-18', { bufferBefore: 1 }))).toBe(true)
  })
})

describe('requiredGap', () => {
  it('берётся максимум из буфера «после» первой и буфера «до» второй', () => {
    expect(requiredGap(bk('2026-07-10', '2026-07-15', { bufferAfter: 2 }), bk('2026-07-17', '2026-07-19', { bufferBefore: 1 }))).toBe(2)
    expect(requiredGap(bk('2026-07-10', '2026-07-15', { bufferAfter: 1 }), bk('2026-07-17', '2026-07-19', { bufferBefore: 3 }))).toBe(3)
  })

  it('метка-исключение у второй брони снимает буфер «после» у первой', () => {
    const first = bk('2026-07-10', '2026-07-15', { bufferAfter: 1, exceptAfterFlag: 'lateIn' })
    expect(requiredGap(first, bk('2026-07-15', '2026-07-18', { flags: ['lateIn'] }))).toBe(0)
    expect(requiredGap(first, bk('2026-07-15', '2026-07-18', { flags: [] }))).toBe(1)
  })

  it('у буфера без исключения зазор остаётся при любых метках соседа', () => {
    const first = bk('2026-07-10', '2026-07-15', { bufferAfter: 1 })
    expect(requiredGap(first, bk('2026-07-15', '2026-07-18', { flags: ['lateIn'] }))).toBe(1)
  })

  // Была ошибка: у оптимизатора была своя копия свёртки меток, и исключение
  // ОДНОЙ метки снимало общий максимум буфера. Уборка на 2 суток обнулялась
  // меткой позднего заезда, к уборке отношения не имеющей.
  it('исключение одной метки не снимает буфер ДРУГОЙ метки', () => {
    const first = bk('2026-07-10', '2026-07-15', {
      bufferAfter: 2,
      afterRules: [{ days: 2, exceptFlag: null }, { days: 1, exceptFlag: 'lateIn' }],
    })
    expect(requiredGap(first, bk('2026-07-17', '2026-07-19', { flags: ['lateIn'] }))).toBe(2)
    expect(requiredGap(first, bk('2026-07-17', '2026-07-19', { flags: [] }))).toBe(2)
  })
})

describe('effectiveGapDays — что считается «окном»', () => {
  it('брони встык — окна нет', () => {
    expect(effectiveGapDays(bk('2026-07-10', '2026-07-15'), bk('2026-07-15', '2026-07-18'))).toBe(0)
  })

  it('три свободные ночи — окно в три ночи', () => {
    expect(effectiveGapDays(bk('2026-07-10', '2026-07-12'), bk('2026-07-15', '2026-07-18'))).toBe(3)
  })

  it('намеренная буферная ночь окном не считается — её нельзя продать', () => {
    expect(effectiveGapDays(bk('2026-07-10', '2026-07-12', { bufferAfter: 1 }), bk('2026-07-13', '2026-07-18'))).toBe(0)
  })

  it('из трёх свободных ночей при буфере в одну ночь окном считаются две', () => {
    expect(effectiveGapDays(bk('2026-07-10', '2026-07-12', { bufferAfter: 1 }), bk('2026-07-15', '2026-07-18'))).toBe(2)
  })

  it('пересечение даёт 0, а не отрицательное окно', () => {
    expect(effectiveGapDays(bk('2026-07-10', '2026-07-15'), bk('2026-07-12', '2026-07-18'))).toBe(0)
  })
})

describe('canPlace', () => {
  it('в свободный промежуток положить можно', () => {
    const list = [bk('2026-07-10', '2026-07-12', { id: 1 }), bk('2026-07-20', '2026-07-22', { id: 2 })]
    expect(canPlace(list, bk('2026-07-13', '2026-07-18', { id: 3 }))).toBe(true)
  })

  it('на занятые даты положить нельзя', () => {
    const list = [bk('2026-07-10', '2026-07-15', { id: 1 })]
    expect(canPlace(list, bk('2026-07-14', '2026-07-18', { id: 2 }))).toBe(false)
  })

  it('буфер соседней брони не даёт положить встык', () => {
    const list = [bk('2026-07-10', '2026-07-15', { id: 1, bufferAfter: 1 })]
    expect(canPlace(list, bk('2026-07-15', '2026-07-18', { id: 2 }))).toBe(false)
    expect(canPlace(list, bk('2026-07-16', '2026-07-18', { id: 2 }))).toBe(true)
  })
})

describe('calcMetrics — подсчёт окон', () => {
  const S = mergeSettings({ shortGapThreshold: 2 })

  it('считает число окон, коротких окон и потерянных ночей', () => {
    const layout = new Map([
      [101, [bk('2026-07-10', '2026-07-12', { id: 1 }), bk('2026-07-15', '2026-07-18', { id: 2 })]], // окно 3 ночи
      [102, [bk('2026-07-10', '2026-07-12', { id: 3 }), bk('2026-07-13', '2026-07-15', { id: 4 })]], // окно 1 ночь (короткое)
      [103, [bk('2026-07-10', '2026-07-12', { id: 5 }), bk('2026-07-12', '2026-07-15', { id: 6 })]], // встык
    ])
    expect(calcMetrics(layout, S)).toEqual({ totalGaps: 2, shortGaps: 1, lostNights: 4 })
  })

  it('буферные ночи в потерянные не попадают', () => {
    const layout = new Map([
      [101, [bk('2026-07-10', '2026-07-12', { id: 1, bufferAfter: 1 }), bk('2026-07-13', '2026-07-15', { id: 2 })]],
    ])
    expect(calcMetrics(layout, S)).toEqual({ totalGaps: 0, shortGaps: 0, lostNights: 0 })
  })

  it('номер с одной бронью и пустой номер окон не дают', () => {
    const layout = new Map([[101, [bk('2026-07-10', '2026-07-12')]], [102, []]])
    expect(calcMetrics(layout, S)).toEqual({ totalGaps: 0, shortGaps: 0, lostNights: 0 })
  })
})
