import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Волна «Упаковка» — `electron/lib/disk.js`.
 *
 * Полный диск (D8-006) — тихая беда: Postgres не стартует, копия не пишется,
 * миграция обрывается на середине. Замер свободного места должен работать
 * ДО того, как всё это случится, и в двух неудобных случаях:
 *
 *  1. **Папки ещё нет.** Место меряют перед созданием папки данных или копии
 *     («хватит ли на копию рядом?»). Наивный `statfsSync` на несуществующем
 *     пути бросает ENOENT — и проверка места превращается в падение при
 *     старте. Правильное поведение — подняться к ближайшему существующему
 *     родителю: том-то тот же.
 *  2. **Диска нет вовсе.** Путь настроен на флешку `E:` или сетевой диск,
 *     которого сейчас нет. Здесь ответ «не знаю» (null) обязан отличаться от
 *     «ноль байт», иначе программа поднимет ложную тревогу «диск полон».
 *
 * Отсюда и правило `diskWarning`: предупреждаем только при ИЗВЕСТНОМ числе
 * ниже порога. «Не знаю» — не повод пугать.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/disk.js')

function loadDiskLib() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

const isWin = process.platform === 'win32'
/** Заведомо отсутствующий том: буква без диска (проверено — `statfsSync` даёт ENOENT). */
const NO_DRIVE = isWin ? ['Z:', 'nope', 'x'].join(path.sep) : '/nope-volume-hb/x'

describe('disk.js — свободное место', () => {
  it('для существующей папки возвращает положительное число байт', () => {
    const { freeBytes } = loadDiskLib()
    const free = freeBytes(os.tmpdir())

    expect(typeof free).toBe('number')
    expect(free).toBeGreaterThan(0)
  })

  it('для ещё не созданной папки меряет ближайший существующий родитель, а не падает', () => {
    const { freeBytes } = loadDiskLib()
    const missing = path.join(os.tmpdir(), `nope-${Date.now()}`, 'pgdata', 'base')

    const free = freeBytes(missing)

    expect(typeof free).toBe('number')
    expect(free).toBeGreaterThan(0)
    // Тот же том, что и tmp: числа могут разойтись на запись соседних процессов,
    // поэтому сверяем порядок величины, а не байт в байт.
    expect(Math.abs(free - freeBytes(os.tmpdir()))).toBeLessThan(freeBytes(os.tmpdir()) * 0.1)
  })

  it('несуществующий диск даёт «не знаю» (null), а не исключение и не ноль', () => {
    const { freeBytes } = loadDiskLib()

    if (isWin) {
      expect(fs.existsSync(`Z:${path.sep}`)).toBe(false) // предпосылка теста
      expect(freeBytes(NO_DRIVE)).toBeNull()
    } else {
      // На POSIX любой путь упирается в существующий «/», числу тут взяться откуда.
      expect(typeof freeBytes(NO_DRIVE)).toBe('number')
    }
  })

  it('пустой путь не роняет замер', () => {
    const { freeBytes } = loadDiskLib()
    expect(() => freeBytes('')).not.toThrow()
  })
})

describe('disk.js — предупреждение о нехватке места', () => {
  it('предупреждает, когда свободного меньше порога', () => {
    const { diskWarning, MB } = loadDiskLib()
    expect(diskWarning(400 * MB, 500 * MB)).toBe(true)
  })

  it('ровно порог — ещё не предупреждение', () => {
    const { diskWarning, MB } = loadDiskLib()
    expect(diskWarning(500 * MB, 500 * MB)).toBe(false)
    expect(diskWarning(900 * MB, 500 * MB)).toBe(false)
  })

  it('неизвестное свободное место (null) тревогу не поднимает', () => {
    const { diskWarning, MB } = loadDiskLib()
    expect(diskWarning(null, 500 * MB)).toBe(false)
    expect(diskWarning(undefined, 500 * MB)).toBe(false)
    expect(diskWarning('мало', 500 * MB)).toBe(false)
  })
})

describe('disk.js — байты в мегабайты', () => {
  it('мегабайт — двоичный, 1048576 байт', () => {
    const { MB } = loadDiskLib()
    expect(MB).toBe(1048576)
  })

  it('переводит в целые мегабайты', () => {
    const { toMb, MB } = loadDiskLib()
    expect(toMb(512 * MB)).toBe(512)
    expect(Number.isInteger(toMb(1536 * 1024))).toBe(true) // 1,5 МБ — не дробь на экране
  })

  it('неизвестное место остаётся неизвестным, а не превращается в 0 МБ', () => {
    const { toMb } = loadDiskLib()
    expect(toMb(null)).toBeNull()
  })
})
