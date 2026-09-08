import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Срок хранения журнала действий (D1-005).
 *
 * `AuditLog.details` — это тело запроса: имя гостя, телефон, а до этой волны
 * ещё и номер удостоверения. Записи копились вечно, то есть персональные
 * данные жили в базе дольше самих броней и без всякого основания.
 *
 * Опасность чистки ровно обратная утечке — стереть лишнее. Поэтому здесь
 * проверяются три границы:
 *
 *  1. **Выключено значит выключено.** `days = 0` (или мусор в настройке) — не
 *     «удалить всё старше сегодня», а НЕ ЗВАТЬ deleteMany вовсе. Разница между
 *     «хранить вечно» и «стереть весь журнал» — один неверный `if`.
 *  2. **Граница даты строгая.** `lt`, а не `lte`, и дата считается ровно от
 *     переданного «сейчас»: сутки ошибки — это сутки чужих действий, которых
 *     не будет при разборе инцидента.
 *  3. **Расписание.** Задача не должна ни стартовать при выключенном сроке,
 *     ни ждать до трёх ночи первого прогона на свежезапущенной программе.
 */

const load = () => loadCjs('src/utils/auditRetention.js', {
  stubs: {
    '../utils/logger': silentLogger,
    './logger': silentLogger,
    '../utils/prisma': { prisma: {} },
  },
})

const NOW = new Date('2026-09-08T00:00:00.000Z')
const CUTOFF = new Date('2026-08-09T00:00:00.000Z')

/** Журнал: две записи заведомо старые, одна ровно на границе, одна свежая. */
const logs = () => [
  { id: 1, action: 'POST /bookings', createdAt: new Date('2026-01-01T12:00:00.000Z') },
  { id: 2, action: 'PUT /bookings/5', createdAt: new Date('2026-08-08T23:59:59.000Z') },
  { id: 3, action: 'POST /payments', createdAt: new Date('2026-08-09T00:00:00.000Z') },
  { id: 4, action: 'DELETE /rooms/2', createdAt: new Date('2026-09-07T10:00:00.000Z') },
]

const deleteCalls = (calls) => calls.filter((c) => c.op === 'deleteMany')

afterEach(() => { vi.useRealTimers() })

describe('purgeOldAuditLogs — что и по какую дату стирается', () => {
  it('срок 30 дней: граница ровно «сейчас минус 30 суток», сравнение строгое', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })

    const res = await purgeOldAuditLogs(prisma, 30, { now: NOW })

    const del = deleteCalls(calls)
    expect(del).toHaveLength(1)
    expect(del[0].model).toBe('auditLog')
    expect(del[0].args.where.createdAt.lt).toEqual(CUTOFF)
    expect(del[0].args.where.createdAt.lte).toBeUndefined()
    expect(res).toMatchObject({ deleted: 2 })
  })

  it('запись ровно на границе остаётся — стирается только то, что СТАРШЕ срока', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma } = createFakePrisma({ auditLog: logs() })
    await purgeOldAuditLogs(prisma, 30, { now: NOW })
    expect(prisma.auditLog.rows.map((r) => r.id)).toEqual([3, 4])
  })

  it('срок 0 — хранение вечное: deleteMany не зовётся вовсе', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    const res = await purgeOldAuditLogs(prisma, 0, { now: NOW })
    expect(res).toMatchObject({ deleted: 0, skipped: true })
    expect(deleteCalls(calls)).toHaveLength(0)
    expect(prisma.auditLog.rows).toHaveLength(4)
  })

  it('отрицательный срок не стирает журнал «наперёд»', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    expect(await purgeOldAuditLogs(prisma, -5, { now: NOW })).toMatchObject({ deleted: 0, skipped: true })
    expect(deleteCalls(calls)).toHaveLength(0)
  })

  it('мусор в настройке (NaN, не задано) — журнал не трогаем', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    expect(await purgeOldAuditLogs(prisma, Number('тридцать'), { now: NOW })).toMatchObject({ deleted: 0, skipped: true })
    expect(await purgeOldAuditLogs(prisma, undefined, { now: NOW })).toMatchObject({ deleted: 0, skipped: true })
    expect(deleteCalls(calls)).toHaveLength(0)
    expect(prisma.auditLog.rows).toHaveLength(4)
  })

  it('без «сейчас» берётся текущее время, а не начало эпохи', async () => {
    const { purgeOldAuditLogs } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    const before = Date.now()
    await purgeOldAuditLogs(prisma, 30)
    const lt = deleteCalls(calls)[0].args.where.createdAt.lt.getTime()
    const expected = before - 30 * 24 * 3600 * 1000
    expect(Math.abs(lt - expected)).toBeLessThan(5000)
  })
})

describe('startAuditRetention — расписание чистки', () => {
  it('срок не задан — задача не заводится', () => {
    const { startAuditRetention } = load()
    const { prisma } = createFakePrisma({ auditLog: logs() })
    const cron = { schedule: vi.fn() }
    startAuditRetention(prisma, { days: 0, cron })
    expect(cron.schedule).not.toHaveBeenCalled()
  })

  it('срок задан — одна ночная задача в 03:30', () => {
    const { startAuditRetention } = load()
    const { prisma } = createFakePrisma({ auditLog: logs() })
    const cron = { schedule: vi.fn() }
    startAuditRetention(prisma, { days: 30, cron })
    expect(cron.schedule).toHaveBeenCalledTimes(1)
    expect(cron.schedule.mock.calls[0][0]).toBe('30 3 * * *')
  })

  it('ночной запуск действительно чистит журнал', async () => {
    const { startAuditRetention } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    const cron = { schedule: vi.fn() }
    startAuditRetention(prisma, { days: 30, cron })
    await cron.schedule.mock.calls[0][1]()
    expect(deleteCalls(calls).length).toBeGreaterThanOrEqual(1)
  })

  it('первый прогон — вскоре после старта, а не следующей ночью', async () => {
    vi.useFakeTimers()
    const { startAuditRetention } = load()
    const { prisma, calls } = createFakePrisma({ auditLog: logs() })
    const cron = { schedule: vi.fn() }

    startAuditRetention(prisma, { days: 30, cron })
    expect(deleteCalls(calls)).toHaveLength(0)   // не синхронно при старте сервера

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10)
    expect(deleteCalls(calls).length).toBeGreaterThanOrEqual(1)
  })
})
