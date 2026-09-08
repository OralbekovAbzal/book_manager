import { describe, it, expect, vi } from 'vitest'
import bcrypt from 'bcryptjs'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Гейт мастера первого запуска (D1-001).
 *
 * Мастер `POST /api/setup/complete` публичен — на свежей установке входить
 * некому. До этой волны единственной защитой была отметка
 * `HotelSettings.setupCompletedAt`, и это ломалось ровно там, где страшнее
 * всего: восстановили копию базы, в которой строки `HotelSettings` нет (или
 * база старше самого мастера) — отметка пропала, мастер снова открыт, и любой
 * в локальной сети переписывает SUPER_ADMIN своим паролем, не зная старого.
 *
 * Новое условие — «база нетронута», то есть состав учёток сидовый: пусто либо
 * ровно один `admin` со стандартным паролем. Отсюда две границы, каждая ценой
 * в чужую базу:
 *
 *  1. **Сид против настоящей учётки.** `admin` с изменённым паролем — уже
 *     живой отель, мастер обязан быть закрыт. Двух учёток на нетронутой базе
 *     не бывает вовсе.
 *  2. **Самолечение.** Пропавшую отметку чинит не мастер, а сам вызов
 *     `getSetupState`: увидели настоящую учётку — проставили `setupCompletedAt`,
 *     чтобы окно не открылось и в следующий раз. Но лечить сидовую базу нельзя:
 *     это закрыло бы мастер на установке, где им ещё не пользовались.
 */

const load = () => loadCjs('src/utils/setupState.js', {
  stubs: {
    '../utils/logger': silentLogger,
    './logger': silentLogger,
    '../utils/prisma': { prisma: {} },
  },
})

/** Хеш стоимостью 4: модуль сравнивает через bcrypt.compare, cost не важен. */
const hash = (p) => bcrypt.hashSync(p, 4)

const admin = (password, username = 'admin') => ({ username, password: hash(password) })

/**
 * Мини-Prisma под ровно две таблицы этого модуля. Своя, а не `fakePrisma`:
 * там нет `upsert`, а здесь именно факт вызова upsert (и его отсутствие) —
 * половина проверяемого поведения.
 */
function fakeDb({ settings = null, admins = [] } = {}) {
  const upserts = []
  const row = settings ? { id: 1, name: 'Отель', setupCompletedAt: null, ...settings } : null
  const prisma = {
    hotelSettings: {
      findUnique: vi.fn(async () => (row ? { ...row } : null)),
      findFirst: vi.fn(async () => (row ? { ...row } : null)),
      upsert: vi.fn(async (args) => { upserts.push(args); return { ...(row || { id: 1 }), ...(args.update || {}) } }),
      update: vi.fn(async (args) => { upserts.push(args); return { ...(row || { id: 1 }), ...(args.data || {}) } }),
    },
    admin: {
      findMany: vi.fn(async () => admins.map((a) => ({ ...a }))),
      count: vi.fn(async () => admins.length),
    },
  }
  return { prisma, upserts }
}

/** Дата из upsert/update — в каком бы из ключей модуль её ни передал. */
function stampOf(args) {
  return args?.update?.setupCompletedAt ?? args?.create?.setupCompletedAt ?? args?.data?.setupCompletedAt
}

describe('setupState — что считается нетронутой базой', () => {
  it('сидовые константы — те же, что засевает установка', () => {
    const { SEED_USERNAME, SEED_PASSWORDS } = load()
    expect(SEED_USERNAME).toBe('admin')
    expect([...SEED_PASSWORDS].sort()).toEqual(['admin', 'admin123'])
  })

  it('учёток нет вовсе — база нетронута', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([])).resolves.toBe(true)
  })

  it('один admin с паролем «admin» — сид', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([admin('admin')])).resolves.toBe(true)
  })

  it('один admin с паролем «admin123» — тоже сид (вторая версия засева)', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([admin('admin123')])).resolves.toBe(true)
  })

  it('пароль admin сменили — база живая, мастер закрыт', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([admin('Zima2026!')])).resolves.toBe(false)
  })

  it('две учётки — не сид, даже если одна из них сидовая', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([admin('admin'), admin('Zima2026!', 'reception')])).resolves.toBe(false)
  })

  it('единственная учётка с другим логином — не сид, даже с паролем «admin»', async () => {
    const { isSeedOnly } = load()
    await expect(isSeedOnly([admin('admin', 'reception')])).resolves.toBe(false)
  })
})

describe('getSetupState — открыт ли мастер и лечение потерянной отметки', () => {
  it('свежая установка: ни строки настроек, ни учёток — мастер открыт, лечить нечего', async () => {
    const { getSetupState } = load()
    const { prisma, upserts } = fakeDb({ settings: null, admins: [] })
    const state = await getSetupState(prisma)
    expect(state.needsSetup).toBe(true)
    expect(state.healed).toBe(false)
    expect(upserts).toHaveLength(0)
    expect(prisma.hotelSettings.upsert).not.toHaveBeenCalled()
  })

  it('строки настроек нет, но учётка сидовая — мастер открыт', async () => {
    const { getSetupState } = load()
    const { prisma } = fakeDb({ settings: null, admins: [admin('admin')] })
    await expect(getSetupState(prisma)).resolves.toMatchObject({ needsSetup: true })
  })

  it('отметка пустая, но учётка сидовая — мастер открыт и НЕ лечится', async () => {
    const { getSetupState } = load()
    const { prisma, upserts } = fakeDb({ settings: { setupCompletedAt: null }, admins: [admin('admin123')] })
    const state = await getSetupState(prisma)
    expect(state.needsSetup).toBe(true)
    expect(upserts).toHaveLength(0)
  })

  it('отметка пропала, а учётка настоящая — мастер закрыт и отметка восстановлена', async () => {
    const { getSetupState } = load()
    const { prisma, upserts } = fakeDb({
      settings: { setupCompletedAt: null },
      admins: [admin('Zima2026!')],
    })
    const state = await getSetupState(prisma)
    expect(state.needsSetup).toBe(false)
    expect(state.healed).toBe(true)
    expect(upserts).toHaveLength(1)
    expect(stampOf(upserts[0])).toBeInstanceOf(Date)
  })

  it('heal: false — отвечает так же, но базу не трогает (чтение состояния безопасно)', async () => {
    const { getSetupState } = load()
    const { prisma, upserts } = fakeDb({
      settings: { setupCompletedAt: null },
      admins: [admin('Zima2026!')],
    })
    const state = await getSetupState(prisma, { heal: false })
    expect(state.needsSetup).toBe(false)
    expect(state.healed).toBe(false)
    expect(upserts).toHaveLength(0)
  })

  it('восстановленная копия без строки HotelSettings, учётки настоящие — мастер закрыт (D1-001)', async () => {
    const { getSetupState } = load()
    const { prisma } = fakeDb({
      settings: null,
      admins: [admin('Zima2026!'), admin('Osen2026!', 'reception')],
    })
    await expect(getSetupState(prisma)).resolves.toMatchObject({ needsSetup: false })
  })

  it('отметка стоит — мастер закрыт, лечить нечего, название отеля из строки', async () => {
    const { getSetupState } = load()
    const { prisma, upserts } = fakeDb({
      settings: { name: 'Туран', setupCompletedAt: new Date('2026-09-01T10:00:00Z') },
      admins: [admin('admin')],
    })
    const state = await getSetupState(prisma)
    expect(state.needsSetup).toBe(false)
    expect(state.healed).toBe(false)
    expect(state.hotelName).toBe('Туран')
    expect(upserts).toHaveLength(0)
  })
})
