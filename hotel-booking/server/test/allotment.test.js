import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'
import { createFakePrisma, d } from './helpers/fakePrisma.js'

/**
 * Квоты партнёров. Правило: чужая квота мешает прямой брони, но дни, покрытые
 * релизами, конфликтом не считаются — релиз временно возвращает их в продажу.
 * Даты полуоткрытые, как у броней.
 */

const PARTNER = { id: 7, name: 'Тур-Оператор' }

/** Квота партнёра 7 на номер 101, 10-20 июля. */
function allotment(overrides = {}) {
  return {
    id: 1,
    roomId: 101,
    partnerId: 7,
    dateFrom: d('2026-07-10'),
    dateTo: d('2026-07-20'),
    partner: PARTNER,
    releases: [],
    ...overrides,
  }
}

function setup(allotments = [allotment()]) {
  const { prisma, calls } = createFakePrisma({ allotment: allotments })
  const mod = loadCjs('src/utils/allotment.js', { stubs: { './prisma': { prisma } } })
  return { ...mod, calls }
}

describe('findAllotmentConflict — сама квота', () => {
  it('прямая бронь внутрь чужой квоты — конфликт с именем партнёра', async () => {
    const { findAllotmentConflict } = setup()
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })
    expect(hit).not.toBeNull()
    expect(hit.partnerName).toBe('Тур-Оператор')
  })

  it('бронь самого партнёра в свою квоту — не конфликт, это её назначение', async () => {
    const { findAllotmentConflict } = setup()
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), partnerId: 7 })
    expect(hit).toBeNull()
  })

  it('partnerId строкой из тела запроса распознаётся как тот же партнёр', async () => {
    const { findAllotmentConflict } = setup()
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), partnerId: '7' })
    expect(hit).toBeNull()
  })

  it('бронь ДРУГОГО партнёра в чужую квоту — всё равно конфликт', async () => {
    const { findAllotmentConflict } = setup()
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14'), partnerId: 8 })
    expect(hit?.partnerName).toBe('Тур-Оператор')
  })

  it('выезд ровно в день начала квоты — не конфликт', async () => {
    const { findAllotmentConflict } = setup()
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-05'), checkOut: d('2026-07-10') })).toBeNull()
  })

  it('заезд ровно в день окончания квоты — не конфликт', async () => {
    const { findAllotmentConflict } = setup()
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-20'), checkOut: d('2026-07-25') })).toBeNull()
  })

  it('перекрытие хвостом на одну ночь — конфликт', async () => {
    const { findAllotmentConflict } = setup()
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-19'), checkOut: d('2026-07-25') })).not.toBeNull()
  })

  it('квота в другом номере не мешает', async () => {
    const { findAllotmentConflict } = setup()
    expect(await findAllotmentConflict({ roomId: 102, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).toBeNull()
  })

  it('roomId строкой обрабатывается как число', async () => {
    const { findAllotmentConflict } = setup()
    expect(await findAllotmentConflict({ roomId: '101', checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).not.toBeNull()
  })

  it('нулевой период (выезд не позже заезда) отсекается до похода в базу', async () => {
    const { findAllotmentConflict, calls } = setup()
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-12') })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('из нескольких квот возвращается та, что реально мешает', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ id: 1, partnerId: 7, partner: PARTNER, releases: [{ id: 1, dateFrom: d('2026-07-10'), dateTo: d('2026-07-20') }] }),
      allotment({ id: 2, partnerId: 9, partner: { id: 9, name: 'Второй партнёр' }, dateFrom: d('2026-07-12'), dateTo: d('2026-07-16') }),
    ])
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-13'), checkOut: d('2026-07-15') })
    expect(hit?.partnerName).toBe('Второй партнёр')
  })
})

describe('findAllotmentConflict — релизы', () => {
  it('релиз на весь период пересечения снимает конфликт', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ releases: [{ id: 1, dateFrom: d('2026-07-12'), dateTo: d('2026-07-14') }] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).toBeNull()
  })

  it('релиз покрывает лишь часть ночей брони — конфликт остаётся', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ releases: [{ id: 1, dateFrom: d('2026-07-12'), dateTo: d('2026-07-13') }] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).not.toBeNull()
  })

  it('релиз шире квоты — конфликта нет, лишние дни не мешают', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ releases: [{ id: 1, dateFrom: d('2026-07-01'), dateTo: d('2026-08-01') }] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).toBeNull()
  })

  it('релиз рядом, но не на ночах брони — не помогает', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ releases: [{ id: 1, dateFrom: d('2026-07-15'), dateTo: d('2026-07-18') }] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })).not.toBeNull()
  })

  it('несколько релизов встык покрывают период целиком', async () => {
    const { findAllotmentConflict } = setup([
      allotment({ releases: [
        { id: 1, dateFrom: d('2026-07-12'), dateTo: d('2026-07-13') },
        { id: 2, dateFrom: d('2026-07-13'), dateTo: d('2026-07-15') },
      ] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-15') })).toBeNull()
  })

  it('бронь длиннее квоты: важны только ночи внутри квоты, свободные снаружи не считаются', async () => {
    // Квота 10-20, релиз 10-20 → пересечение освобождено целиком,
    // хотя бронь 05-25 выходит за пределы квоты с обеих сторон.
    const { findAllotmentConflict } = setup([
      allotment({ releases: [{ id: 1, dateFrom: d('2026-07-10'), dateTo: d('2026-07-20') }] }),
    ])
    expect(await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-05'), checkOut: d('2026-07-25') })).toBeNull()
  })
})

describe('allotmentConflictMessage', () => {
  it('печатает период квоты в UTC — без сдвига на день из-за часового пояса машины', async () => {
    const { findAllotmentConflict, allotmentConflictMessage } = setup()
    const hit = await findAllotmentConflict({ roomId: 101, checkIn: d('2026-07-12'), checkOut: d('2026-07-14') })
    const msg = allotmentConflictMessage(hit)

    expect(msg).toContain('10.07.2026')
    expect(msg).toContain('20.07.2026')
    expect(msg).toContain('Тур-Оператор')
  })
})
