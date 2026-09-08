import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Логи упакованной программы — `electron/lib/logs.js` (D8-008).
 *
 * Два разных сюжета в одном файле:
 *
 *  1. **Цветовые коды.** Сервер пишет в stdout раскрашенные строки; Electron
 *     складывает этот поток в `host-debug.log`. В файле от них остаётся
 *     `\x1b[32m` — мусор, который мешает и человеку, и поиску по логу.
 *
 *  2. **Ротация.** `host-debug.log` рос без ограничений: у клиента, который
 *     не выключает программу, это файл на гигабайты — и он же уезжает в
 *     поддержку вместе с ПД. Границы здесь ровно две и обе стоят диска:
 *     файл РОВНО в предел не режется (иначе на каждом старте будет лишняя
 *     ротация пустого хвоста), а отсутствующий файл — не ошибка: первый
 *     запуск программы не должен падать из-за отсутствия вчерашнего лога.
 *
 * Файловая система настоящая (`vi.mock('fs')` для CommonJS не работает), но
 * во временной папке; Electron не требуется — модуль его не тянет.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/logs.js')

function loadLogsLib() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

let dir = null
const p = (name) => path.join(dir, name)

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-logs-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('stripAnsi — лог без цветовых кодов', () => {
  it('коды раскраски убираются, текст остаётся целиком', () => {
    const { stripAnsi } = loadLogsLib()
    expect(stripAnsi('\x1b[32mServer started\x1b[0m on 3001')).toBe('Server started on 3001')
  })

  it('строка без кодов не меняется — включая квадратные скобки в тексте', () => {
    const { stripAnsi } = loadLogsLib()
    const line = '2026-09-08 [info] GET /api/bookings [200] 12ms'
    expect(stripAnsi(line)).toBe(line)
  })

  it('несколько кодов подряд и многострочный вывод', () => {
    const { stripAnsi } = loadLogsLib()
    expect(stripAnsi('\x1b[1m\x1b[31mОшибка\x1b[0m\n\x1b[33mповтор\x1b[0m')).toBe('Ошибка\nповтор')
  })

  it('не строка — пустая строка, а не падение записи в лог', () => {
    const { stripAnsi } = loadLogsLib()
    expect(stripAnsi(undefined)).toBe('')
    expect(stripAnsi(null)).toBe('')
    expect(stripAnsi(Buffer.from('x'))).toBe('')
  })
})

describe('rotateLogFile — предел размера лога', () => {
  it('файл больше предела уезжает в .1, на его месте пусто', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), 'x'.repeat(100))
    const res = rotateLogFile(p('host-debug.log'), 50)
    expect(res).toMatchObject({ rotated: true, size: 100 })
    expect(fs.existsSync(p('host-debug.log'))).toBe(false)
    expect(fs.readFileSync(p('host-debug.log.1'), 'utf8')).toBe('x'.repeat(100))
  })

  it('файл ровно в предел не трогается — иначе ротация на каждом старте', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), 'x'.repeat(50))
    const res = rotateLogFile(p('host-debug.log'), 50)
    expect(res).toMatchObject({ rotated: false, size: 50 })
    expect(fs.existsSync(p('host-debug.log.1'))).toBe(false)
    expect(fs.readFileSync(p('host-debug.log'), 'utf8')).toBe('x'.repeat(50))
  })

  it('файл на один байт больше предела — уже режется', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), 'x'.repeat(51))
    expect(rotateLogFile(p('host-debug.log'), 50)).toMatchObject({ rotated: true, size: 51 })
  })

  it('предел считается в байтах, а не в символах: кириллица весит вдвое', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), 'я'.repeat(20))       // 20 символов = 40 байт
    expect(rotateLogFile(p('host-debug.log'), 30)).toMatchObject({ rotated: true, size: 40 })
  })

  it('прошлая копия .1 заменяется новой, старая не копится', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log.1'), 'вчерашний')
    fs.writeFileSync(p('host-debug.log'), 'сегодняшний лог'.repeat(20))
    expect(rotateLogFile(p('host-debug.log'), 50).rotated).toBe(true)
    expect(fs.readFileSync(p('host-debug.log.1'), 'utf8')).toBe('сегодняшний лог'.repeat(20))
    expect(fs.existsSync(p('host-debug.log.2'))).toBe(false)
  })

  it('keep: 2 — прошлый .1 сдвигается в .2, а не пропадает', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log.1'), 'позавчера')
    fs.writeFileSync(p('host-debug.log'), 'вчера'.repeat(50))
    expect(rotateLogFile(p('host-debug.log'), 50, { keep: 2 }).rotated).toBe(true)
    expect(fs.readFileSync(p('host-debug.log.2'), 'utf8')).toBe('позавчера')
    expect(fs.readFileSync(p('host-debug.log.1'), 'utf8')).toBe('вчера'.repeat(50))
  })

  it('файла нет (первый запуск) — тихий отказ, а не исключение при старте', () => {
    const { rotateLogFile } = loadLogsLib()
    const res = rotateLogFile(p('нет-такого.log'), 50)
    expect(res).toMatchObject({ rotated: false, size: 0 })
    expect(fs.existsSync(p('нет-такого.log.1'))).toBe(false)
  })

  it('пустой файл не режется', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), '')
    expect(rotateLogFile(p('host-debug.log'), 50)).toMatchObject({ rotated: false, size: 0 })
    expect(fs.existsSync(p('host-debug.log'))).toBe(true)
  })
})

describe('rotateLogFile — вырожденные аргументы', () => {
  it('предел не задан или ноль — ротация выключена, даже если файл велик', () => {
    const { rotateLogFile } = loadLogsLib()
    fs.writeFileSync(p('host-debug.log'), 'x'.repeat(1000))
    expect(rotateLogFile(p('host-debug.log'), 0)).toMatchObject({ rotated: false, size: 1000 })
    expect(rotateLogFile(p('host-debug.log'), -1)).toMatchObject({ rotated: false })
    expect(fs.existsSync(p('host-debug.log'))).toBe(true)
    expect(fs.existsSync(p('host-debug.log.1'))).toBe(false)
  })

  it('путь не задан — тихий отказ: старт программы не зависит от лога', () => {
    const { rotateLogFile } = loadLogsLib()
    expect(rotateLogFile(undefined, 50)).toMatchObject({ rotated: false, size: 0 })
    expect(rotateLogFile('', 50)).toMatchObject({ rotated: false, size: 0 })
  })
})
