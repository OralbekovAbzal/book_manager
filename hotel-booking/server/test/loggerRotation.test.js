import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * Ротация логов и тишина в консоли под упаковкой (D8-008).
 *
 * Два разных решения в одном файле `utils/logger.js`, и оба проверяются
 * СОСТОЯНИЕМ транспортов, а не намерением:
 *
 *  1. **Предел размера.** До волны `error.log` и `combined.log` росли без
 *     границы, а в них ПД (см. `logPrivacy.test.js`). Ограничение — это ровно
 *     тройка опций `maxsize` + `maxFiles` + `tailable`, и все три обязаны быть
 *     на КАЖДОМ файловом транспорте: `maxsize` без `maxFiles` режет файл, но
 *     старые куски не удаляет — папка растёт так же, только мелкими файлами.
 *     Поэтому здесь есть и живая проверка: настоящий winston с теми же тремя
 *     опциями (только маленьким пределом) не должен оставить в папке больше
 *     файлов, чем `maxFiles`.
 *
 *  2. **Консоль под Electron.** Сервер запущен дочерним процессом, его stdout
 *     построчно уходит в `host-debug.log`. Значит в упаковке (production, не
 *     TTY) в консоль не должен идти ни поток `info` (это дублирование
 *     `combined.log` в файл без ротации), ни коды раскраски.
 *
 * Логгер — синглтон, читающий окружение в момент require: поэтому каждый тест
 * грузит его заново через `loadCjs` с нужным `NODE_ENV` и своей папкой логов.
 */

let dir
let savedEnv
let savedTTY

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-logtest-'))
  savedEnv = process.env.NODE_ENV
  savedTTY = process.stdout.isTTY
  process.env.LOG_PATH = dir
})

afterEach(() => {
  process.env.NODE_ENV = savedEnv
  process.stdout.isTTY = savedTTY
  delete process.env.LOG_PATH
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* держит открытый транспорт */ }
})

function loadLogger({ env = 'production', tty = false } = {}) {
  process.env.NODE_ENV = env
  process.stdout.isTTY = tty
  return loadCjs('src/utils/logger.js')
}

/** Транспорты по типу: консоль и два файла. */
function transportsOf(logger) {
  const files = logger.transports.filter((t) => t.filename || t.dirname)
  const console_ = logger.transports.find((t) => !t.filename && !t.dirname)
  return { files, console: console_ }
}

/**
 * Перехват записи в stdout: именно её собирает host-debug.log.
 * Транспорт winston пишет в `console._stdout`, если он есть (под vitest это
 * не process.stdout, а его перехватчик), иначе через console.log.
 */
async function captureStdout(fn) {
  const chunks = []
  const sink = console._stdout || process.stdout
  const originalWrite = sink.write
  const originalLog = console.log
  sink.write = (chunk) => { chunks.push(String(chunk)); return true }
  console.log = (...a) => { chunks.push(a.join(' ')) }
  try {
    fn()
    await new Promise((r) => setTimeout(r, 30))
  } finally {
    sink.write = originalWrite
    console.log = originalLog
  }
  return chunks.join('')
}

describe('logger — предел размера файлов', () => {
  it('у обоих файловых транспортов есть все три опции ограничения', () => {
    const logger = loadLogger()
    const { files } = transportsOf(logger)
    expect(files).toHaveLength(2)
    for (const t of files) {
      expect(t.maxsize).toBe(5 * 1024 * 1024)
      // maxsize без maxFiles = папка растёт теми же темпами, только кусками
      expect(t.maxFiles).toBe(5)
      // tailable: свежие записи всегда в error.log/combined.log, а не в .5 —
      // иначе путь в диалогах и подсказках указывает на старьё
      expect(t.tailable).toBe(true)
    }
  })

  it('ошибки — в отдельный файл, общий поток — в combined.log', () => {
    const logger = loadLogger()
    const { files } = transportsOf(logger)
    const byName = Object.fromEntries(files.map((t) => [path.basename(t.filename), t]))
    expect(Object.keys(byName).sort()).toEqual(['combined.log', 'error.log'])
    expect(byName['error.log'].level).toBe('error')
    expect(byName['combined.log'].level).toBeUndefined()
  })

  it('папка логов берётся из LOG_PATH — в упаковке она в данных пользователя, а не рядом с exe', () => {
    const logger = loadLogger()
    for (const t of transportsOf(logger).files) {
      expect(path.resolve(t.dirname)).toBe(path.resolve(dir))
    }
  })

  it('живая проверка: с этими тремя опциями старые куски удаляются, а не копятся', { timeout: 20000 }, async () => {
    // Тот же winston и тот же набор опций, что в logger.js, только предел
    // маленький: 5 МБ × 5 файлов писать в тесте незачем, проверяется поведение
    // связки maxsize+maxFiles+tailable, а не конкретное число.
    const { createLogger, transports, format } = await import('winston')
    const file = path.join(dir, 'rot.log')
    const logger = createLogger({
      format: format.printf(({ message }) => message),
      transports: [new transports.File({ filename: file, maxsize: 1024, maxFiles: 3, tailable: true })],
    })
    const line = 'x'.repeat(200)
    // Порциями с паузой: ротация асинхронная, залпом в один тик она не успевает
    // и всё уходит в буфер одного файла.
    for (let batch = 0; batch < 10; batch++) {
      for (let i = 0; i < 20; i++) logger.info(`${line} ${batch}-${i}`)
      await new Promise((r) => setTimeout(r, 120))
    }
    await new Promise((r) => setTimeout(r, 500))

    // Имена ротации у winston — rot.log, rot1.log, rot2.log (НЕ «rot.log.1»)
    const written = fs.readdirSync(dir).filter((f) => /^rot\d*\.log$/.test(f)).sort()
    logger.close()

    // ~40 КБ при пределе 1 КБ: без удаления старых здесь лежали бы десятки файлов
    expect(written.length).toBeGreaterThan(1)      // ротация вообще случилась
    expect(written.length).toBeLessThanOrEqual(3)  // …и старое удаляется: maxFiles соблюдён
    // tailable: свежая запись — в файле без номера, путь в подсказках остаётся верным
    expect(written).toContain('rot.log')
  })
})

describe('logger — консоль в упаковке', () => {
  it('в production поток info в stdout не идёт: host-debug.log не дублирует combined.log', async () => {
    const logger = loadLogger({ env: 'production', tty: false })
    expect(transportsOf(logger).console.level).toBe('warn')

    const out = await captureStdout(() => logger.info('GET /api/bookings'))
    expect(out).toBe('')
  })

  it('предупреждения и ошибки в production в консоль всё-таки идут — иначе падение не видно нигде', async () => {
    const logger = loadLogger({ env: 'production', tty: false })
    const out = await captureStdout(() => logger.error('Uncaught exception'))
    expect(out).toContain('Uncaught exception')
  })

  it('не TTY — ни одной цветовой последовательности в строке', async () => {
    const logger = loadLogger({ env: 'production', tty: false })
    const out = await captureStdout(() => logger.warn('мало места на диске'))
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false)
    expect(out).toContain('[warn]: мало места на диске')
  })

  it('живой терминал — раскраска включается', async () => {
    const logger = loadLogger({ env: 'development', tty: true })
    const out = await captureStdout(() => logger.warn('внимание'))
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(true)
  })

  it('в разработке в консоль идёт весь поток, включая info', async () => {
    const logger = loadLogger({ env: 'development', tty: false })
    expect(transportsOf(logger).console.level).toBeUndefined()
    const out = await captureStdout(() => logger.info('GET /api/bookings'))
    expect(out).toContain('GET /api/bookings')
  })

  it('сбой записи в файл не роняет процесс — у логгера есть свой обработчик error', () => {
    const logger = loadLogger()
    expect(logger.listenerCount('error')).toBeGreaterThan(0)
    // ENOSPC при полном диске: без слушателя это необработанное событие = падение
    expect(() => logger.emit('error', new Error('ENOSPC: no space left on device'))).not.toThrow()
  })
})
