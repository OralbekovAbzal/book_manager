/**
 * Аудит 2026-09-13, сервер. Находки, которые видны только на уровне ПРИЛОЖЕНИЯ:
 * порядок middleware в `src/app.js`. Контроллеры тут ни при чём — важно, что
 * успевает произойти до проверки токена и что считает лимитер входа.
 *
 * База НЕ участвует: все запросы падают на `authenticate` (нет заголовка
 * Authorization) или на парсере тела, то есть до первого обращения к Prisma.
 * Гейт лицензии и журнал действий подменены заглушками ровно поэтому — оба
 * ходят в базу до роутов.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

// Логи — во временную папку: тесты не должны писать в server/logs/.
process.env.LOG_PATH = path.join(os.tmpdir(), 'roomline-audit13-logs')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit13-test-secret'

/** Загружает `src/app.js` свежим экземпляром без гейта лицензии и журнала. */
function loadApp() {
  return loadCjs('src/app.js', {
    stubs: {
      './middleware/license': { maintenanceGate: (_req, _res, next) => next() },
      './middleware/audit': { auditMiddleware: (_req, _res, next) => next() },
      './utils/logger': silentLogger,
    },
  })
}

async function withServer(app, fn) {
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

describe('S13-002 · тело загрузки копии читается до проверки токена', () => {
  let app
  beforeAll(() => { app = loadApp() })

  it('без токена тело в 3 МБ всё равно разбирается парсером (текущее поведение)', async () => {
    const body = `{"broken": "${'x'.repeat(3 * 1024 * 1024)}"`   // намеренно незакрытый JSON
    const res = await withServer(app, (base) => fetch(`${base}/api/system/backup/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-File-Name': 'a.json' },
      body,
    }))
    const json = await res.json()
    // 400 вместо 401 доказывает: парсер (лимит 200 МБ, app.js:51) отработал
    // раньше, чем authenticate успел отказать анониму.
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/не файл резервной копии/i)
  })

  it.fails('аноним получает 401 и его тело не читается', async () => {
    const body = `{"broken": "${'x'.repeat(3 * 1024 * 1024)}"`
    const res = await withServer(app, (base) => fetch(`${base}/api/system/backup/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-File-Name': 'a.json' },
      body,
    }))
    expect(res.status).toBe(401)
  })
})

describe('S13-006 · лимитер входа считает и /auth/me', () => {
  let prodApp
  beforeAll(() => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'   // max: 20 за 15 минут — как у клиента
    try { prodApp = loadApp() } finally { process.env.NODE_ENV = was }
  })

  it.fails('после двадцати проверок сессии вход всё ещё возможен', async () => {
    const status = await withServer(prodApp, async (base) => {
      // Столько запросов /auth/me делает клиент за 15 минут, если рабочее место
      // перезагружали или связь рвалась: каждый старт приложения — один вызов.
      for (let i = 0; i < 20; i++) {
        await fetch(`${base}/api/auth/me`, { headers: { Authorization: 'Bearer нет' } })
      }
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'whatever' }),
      })
      return res.status
    })
    // Ожидание: вход не заблокирован (401 «неверный пароль» или иной ответ входа).
    // Фактически — 429 «Слишком много попыток входа».
    expect(status).not.toBe(429)
  })
})

afterAll(() => { /* серверы закрыты в withServer */ })
