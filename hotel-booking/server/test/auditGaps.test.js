import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Журнал действий: что остаётся после чистки деталей и чистки по сроку (D1-007).
 *
 * `auditSanitize.test.js` проверяет, что документ гостя вырезан из обычного
 * тела запроса. Здесь — три места, где эта защита может обойтись стороной, и
 * все три встречаются в живом теле запроса, а не в выдуманном:
 *
 *  1. **Длинное тело.** Правка брони с услугами и строками начислений легко
 *     переваливает 2 КБ, и тогда в журнал идёт не объект, а `preview` — срез
 *     СТРОКИ. Если срез делается от исходного тела, а не от очищенного, вся
 *     работа по вырезанию документа отменяется одной строкой кода.
 *  2. **Глубина.** Вырезание рекурсивное, но с пределом глубины — а тело
 *     запроса вкладывается сильнее, чем кажется.
 *  3. **Настройка срока.** Пустое значение в окружении читается не как
 *     «не задано», а как ноль, то есть «хранить вечно».
 *
 * Отказ базы при чистке проверяется отдельно: ночная задача не имеет права
 * уронить сервер — процесс живёт месяцами, и падать ему негде.
 */

const loadAudit = () => loadCjs('src/middleware/audit.js', {
  stubs: {
    '../utils/prisma': { prisma: { auditLog: { create: async () => ({}) } } },
    '../utils/logger': silentLogger,
  },
  append: 'module.exports.__sanitizeBody = sanitizeBody\nmodule.exports.__MAX = MAX_DETAILS',
})

const loadRetention = () => loadCjs('src/utils/auditRetention.js', {
  stubs: { './logger': silentLogger },
})

const DOC = {
  guestCitizenship: 'KZ', guestDocType: 'passport', guestDocNumber: 'N12345678',
  guestDocExpiry: '2030-01-01', guestBirthDate: '1990-03-14', guestSex: 'F',
}

afterEach(() => { vi.useRealTimers() })

describe('sanitizeBody — тело длиннее 2 КБ', () => {
  it('обрезка идёт ПОСЛЕ вырезания: в preview нет ни документа, ни пароля', () => {
    const { __sanitizeBody, __MAX } = loadAudit()
    // Правка брони с полусотней строк начислений — обычное тело для «Сохранить»
    const body = {
      ...DOC,
      guestName: 'Асель Каримова',
      password: 'sekret123',
      charges: Array.from({ length: 60 }, (_, i) => ({
        id: i, kind: 'stay', name: `Проживание ${i}`, amount: 12000, comment: 'строка счёта',
      })),
    }
    const out = __sanitizeBody(body)

    expect(out._truncated).toBe(true)
    expect(out.preview.length).toBeLessThanOrEqual(__MAX)
    expect(out.preview).not.toContain('N12345678')
    expect(out.preview).not.toContain('1990-03-14')
    expect(out.preview).not.toContain('sekret123')
    // Ради чего журнал и ведут — осталось
    expect(out.preview).toContain('Асель Каримова')
  })

  it('тело ровно на границе 2 КБ уходит объектом, а не срезом строки', () => {
    const { __sanitizeBody, __MAX } = loadAudit()
    // Подбираем notes так, чтобы JSON вышел ровно в предел
    const shell = JSON.stringify({ notes: '' }).length
    const body = { notes: 'я'.repeat(__MAX - shell) }
    const out = __sanitizeBody(body)
    expect(JSON.stringify(out).length).toBe(__MAX)
    expect(out._truncated).toBeUndefined()
  })

  it('на байт больше предела — уже срез', () => {
    const { __sanitizeBody, __MAX } = loadAudit()
    const shell = JSON.stringify({ notes: '' }).length
    const out = __sanitizeBody({ notes: 'я'.repeat(__MAX - shell + 1) })
    expect(out._truncated).toBe(true)
  })

  it('тело из одних секретов не превращается в «{}» в журнале', () => {
    const { __sanitizeBody } = loadAudit()
    expect(__sanitizeBody({ ...DOC })).toBeUndefined()
    expect(__sanitizeBody({ password: 'x' })).toBeUndefined()
  })

  it('циклическая ссылка в теле не роняет запись в журнал', () => {
    const { __sanitizeBody } = loadAudit()
    const body = { guestName: 'Асель' }
    body.self = body
    expect(() => __sanitizeBody(body)).not.toThrow()
    // Цикл обрезается на пятом уровне заглушкой (волна 8): детали пишутся, без цикла
    const out = __sanitizeBody(body)
    expect(() => JSON.stringify(out)).not.toThrow()
    expect(out && out.guestName).toBe('Асель')
  })

  /**
   * НАХОДКА (D1-007). `stripSecrets` перестаёт вырезать что-либо глубже пятого
   * уровня вложенности: `if (!value || typeof value !== 'object' || depth > 5)
   * return value` (`src/middleware/audit.js:71`) возвращает поддерево КАК ЕСТЬ,
   * вместе с документом гостя и паролем.
   *
   * Вход: тело с шестью уровнями вложенности, например правка определения
   * отчёта (`/reports` — отслеживаемый префикс) с вложенным деревом формулы,
   * или любое будущее тело вида `{ booking: { guest: { document: {…} } } }`.
   * Сегодняшние тела броней вкладываются на 2–3 уровня, поэтому на живых
   * данных это пока не стреляет — опасность в том, что предел молчаливый:
   * добавили уровень вложенности в форму — журнал начал копить паспорта, и
   * заметить это можно только чтением таблицы.
   *
   * Как чинить — вопрос доменный (обрезать поддерево, а не пропускать его; либо
   * поднять предел), поэтому тест оставлен ожидаемо падающим.
   */
  it('документ и пароль глубже пяти уровней вложенности всё равно должны вырезаться', () => {
    const { __sanitizeBody } = loadAudit()
    const deep = { a: { b: { c: { d: { e: { f: { ...DOC, password: 'sekret123' } } } } } } }
    const out = JSON.stringify(__sanitizeBody(deep))
    expect(out).not.toContain('N12345678')
    expect(out).not.toContain('sekret123')
  })
})

describe('чистка журнала — отказ базы', () => {
  it('сбой deleteMany виден вызывающему, а не проглатывается молча', async () => {
    const { purgeOldAuditLogs } = loadRetention()
    const prisma = { auditLog: { deleteMany: async () => { throw new Error('connection refused') } } }
    await expect(purgeOldAuditLogs(prisma, 365)).rejects.toThrow('connection refused')
  })

  it('ночная задача при лежащей базе не роняет сервер — отель работает и без чистки', async () => {
    const errors = []
    const mod = loadCjs('src/utils/auditRetention.js', {
      stubs: { './logger': { ...silentLogger, error: (m) => errors.push(m) } },
    })
    const prisma = { auditLog: { deleteMany: async () => { throw new Error('connection refused') } } }
    const cron = { schedule: vi.fn() }
    mod.startAuditRetention(prisma, { days: 365, cron })

    // Обработчик node-cron синхронный и промис наружу не отдаёт: значит ошибка
    // обязана быть поймана ВНУТРИ, иначе это unhandledRejection в живом сервере
    expect(() => cron.schedule.mock.calls[0][1]()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(errors.join('\n')).toContain('connection refused')
  })

  it('первый прогон через две минуты тоже не роняет процесс', async () => {
    vi.useFakeTimers()
    const mod = loadCjs('src/utils/auditRetention.js', { stubs: { './logger': silentLogger } })
    const prisma = { auditLog: { deleteMany: async () => { throw new Error('down') } } }
    mod.startAuditRetention(prisma, { days: 365, cron: { schedule: vi.fn() } })
    await expect(vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 10)).resolves.toBeDefined()
  })

  it('таймер первого прогона не держит процесс живым при остановке сервера', () => {
    const mod = loadCjs('src/utils/auditRetention.js', { stubs: { './logger': silentLogger } })
    const started = mod.startAuditRetention({ auditLog: { deleteMany: async () => ({ count: 0 }) } },
      { days: 365, cron: { schedule: vi.fn() } })
    expect(started.first.hasRef()).toBe(false)
    clearTimeout(started.first)
  })
})

describe('срок хранения из окружения', () => {
  const withEnv = (value, fn) => {
    const saved = process.env.AUDIT_RETENTION_DAYS
    if (value === undefined) delete process.env.AUDIT_RETENTION_DAYS
    else process.env.AUDIT_RETENTION_DAYS = value
    try { return fn() } finally {
      if (saved === undefined) delete process.env.AUDIT_RETENTION_DAYS
      else process.env.AUDIT_RETENTION_DAYS = saved
    }
  }

  it('переменная не задана — год по умолчанию, чистка работает', () => {
    const mod = loadCjs('src/utils/auditRetention.js', { stubs: { './logger': silentLogger } })
    const cron = { schedule: vi.fn() }
    withEnv(undefined, () => mod.startAuditRetention({ auditLog: { deleteMany: async () => ({ count: 0 }) } }, { cron }))
    expect(cron.schedule).toHaveBeenCalledTimes(1)
  })

  it('явный 0 выключает чистку — так и задумано, журнал как архив', () => {
    const mod = loadCjs('src/utils/auditRetention.js', { stubs: { './logger': silentLogger } })
    const cron = { schedule: vi.fn() }
    withEnv('0', () => mod.startAuditRetention({ auditLog: { deleteMany: async () => ({ count: 0 }) } }, { cron }))
    expect(cron.schedule).not.toHaveBeenCalled()
  })

  /**
   * НАХОДКА (мелкая, но тихая). `Number(process.env.AUDIT_RETENTION_DAYS ?? 365)`
   * (`src/utils/auditRetention.js:66`): `??` срабатывает только на `undefined`,
   * а пустая строка — не `undefined`. `Number('')` — это 0, то есть «хранить
   * вечно».
   *
   * Вход: строка `AUDIT_RETENTION_DAYS=` в `.env` — ровно то, что получается,
   * когда значение стирают, чтобы «вернуть по умолчанию». Программа при этом
   * пишет в лог «Ретеншн журнала отключён (AUDIT_RETENTION_DAYS = 0)», хотя
   * никто не ставил ноль, и персональные данные копятся в журнале без границы.
   * В упаковке переменная не задаётся вовсе (`electron/main.js` её не
   * передаёт), так что у клиента это не стреляет — только у того, кто правит
   * `.env` руками.
   */
  it('пустое значение в .env — это «не задано», а не «хранить вечно»', () => {
    const mod = loadCjs('src/utils/auditRetention.js', { stubs: { './logger': silentLogger } })
    const cron = { schedule: vi.fn() }
    withEnv('', () => mod.startAuditRetention({ auditLog: { deleteMany: async () => ({ count: 0 }) } }, { cron }))
    expect(cron.schedule).toHaveBeenCalledTimes(1)
  })
})
