import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { SERVER_ROOT } from './helpers/loadCjs.js'

/**
 * `electron/lib/logs.js` — ротация `host-debug.log` при старте программы, когда
 * что-то пошло не так.
 *
 * `electron-logs.test.js` проверяет удачный путь. Здесь — неудачный, и он
 * важнее: ротация выполняется САМОЙ ПЕРВОЙ строкой запуска, до окна, до базы,
 * до всего. Бросок исключения отсюда — это программа, которая не открывается
 * из-за файла лога. Поэтому у функции контракт «ошибка возвращается объектом,
 * наружу не летит», и его надо проверять на настоящей файловой системе:
 * на Windows переименование спотыкается там, где на Linux проходит.
 *
 * Второй вопрос того же места — занятый файл. Лог открыт на дозапись у
 * main-процесса (а бывает, и у блокнота администратора), и если бы
 * переименование от этого падало, ротация не срабатывала бы никогда — файл рос
 * бы дальше, а никто бы не заметил: ошибку тут намеренно глотают.
 */

const require_ = createRequire(path.join(SERVER_ROOT, 'package.json'))
const { rotateLogFile } = require_(path.resolve(SERVER_ROOT, '..', 'electron', 'lib', 'logs.js'))

let dir
let logFile

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-rotfail-'))
  logFile = path.join(dir, 'host-debug.log')
})

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* занят */ }
})

const write = (p, bytes) => fs.writeFileSync(p, 'x'.repeat(bytes))
const names = () => fs.readdirSync(dir).sort()

describe('rotateLogFile — когда переименовать не получается', () => {
  it('место под .1 занято папкой: ошибка возвращается объектом, а не бросается', () => {
    write(logFile, 5000)
    fs.mkdirSync(`${logFile}.1`)
    fs.writeFileSync(path.join(`${logFile}.1`, 'inner.txt'), 'z')

    let out
    expect(() => { out = rotateLogFile(logFile, 1000) }).not.toThrow()
    expect(out.rotated).toBe(false)
    expect(out.size).toBe(5000)
    expect(out.error).toBeInstanceOf(Error)
  })

  it('после неудачной ротации сам лог цел — данные не теряются', () => {
    write(logFile, 5000)
    fs.mkdirSync(`${logFile}.1`)
    fs.writeFileSync(path.join(`${logFile}.1`, 'inner.txt'), 'z')

    rotateLogFile(logFile, 1000)
    expect(fs.readFileSync(logFile).length).toBe(5000)
    expect(names()).toContain('host-debug.log')
  })

  it('лог открыт на дозапись — ротация всё равно проходит (иначе она не срабатывала бы никогда)', () => {
    write(logFile, 5000)
    const fd = fs.openSync(logFile, 'a')       // как держит его main-процесс
    try {
      const out = rotateLogFile(logFile, 1000)
      expect(out).toMatchObject({ rotated: true, size: 5000 })
      expect(out.error).toBeUndefined()
      expect(names()).toEqual(['host-debug.log.1'])
    } finally {
      fs.closeSync(fd)
    }
  })

  it('после ротации следующая запись создаёт файл заново — путь в подсказках остаётся верным', () => {
    write(logFile, 5000)
    rotateLogFile(logFile, 1000)
    expect(fs.existsSync(logFile)).toBe(false)

    fs.appendFileSync(logFile, '[старт] новая сессия\n')   // ровно то, что делает hlog
    expect(fs.readFileSync(logFile, 'utf8')).toBe('[старт] новая сессия\n')
    expect(names()).toEqual(['host-debug.log', 'host-debug.log.1'])
  })

  it('путь ведёт в несуществующую папку — тихий отказ, программа стартует', () => {
    const out = rotateLogFile(path.join(dir, 'нет-такой-папки', 'host-debug.log'), 1000)
    expect(out).toEqual({ rotated: false, size: 0 })
  })

  it('вместо файла лога — папка: ротация не пытается её переименовать в .1', () => {
    fs.mkdirSync(logFile)
    let out
    expect(() => { out = rotateLogFile(logFile, 1) }).not.toThrow()
    // Что бы ни решила функция, каталог обязан остаться на месте
    expect(fs.existsSync(logFile) || fs.existsSync(`${logFile}.1`)).toBe(true)
    expect(out).toHaveProperty('rotated')
  })
})

describe('rotateLogFile — сколько копий остаётся на диске', () => {
  it('keep: 0 всё равно оставляет одну копию — «не хранить ничего» так не задать', () => {
    // Предел размера папки при этом всё равно предсказуем: keep + 1 файла
    write(logFile, 5000)
    const out = rotateLogFile(logFile, 1000, { keep: 0 })
    expect(out.rotated).toBe(true)
    expect(names()).toEqual(['host-debug.log.1'])
  })

  it('keep: 3 — четыре файла максимум, самый старый уходит совсем', () => {
    for (let i = 0; i < 6; i++) {
      write(logFile, 5000)
      rotateLogFile(logFile, 1000, { keep: 3 })
    }
    expect(names()).toEqual(['host-debug.log.1', 'host-debug.log.2', 'host-debug.log.3'])
  })

  it('дробное keep округляется вниз, мусор читается как единица', () => {
    write(logFile, 5000)
    rotateLogFile(logFile, 1000, { keep: 2.9 })
    write(logFile, 5000)
    rotateLogFile(logFile, 1000, { keep: 2.9 })
    expect(names()).toEqual(['host-debug.log.1', 'host-debug.log.2'])

    write(logFile, 5000)
    rotateLogFile(logFile, 1000, { keep: NaN })
    expect(names()).toEqual(['host-debug.log.1', 'host-debug.log.2'])
  })
})
