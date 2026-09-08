import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * Волна «Упаковка» — `server/src/utils/disk.js` (сводка места для `/system/status`).
 *
 * Полный диск (D8-006) обнаруживается сейчас постфактум: база не пишется,
 * копия не создаётся, миграция обрывается. Сводка нужна, чтобы сказать об
 * этом ЗАРАНЕЕ и в терминах человека — «на диске 300 МБ, это мало».
 *
 * Границы, из-за которых сводка может соврать:
 *  - **путь недоступен** (флешка вынута, сетевой диск отвалился, путь в
 *    настройках пустой). Такой путь обязан выпадать из расчёта, а не
 *    приносить ноль: «0 МБ свободно» на вынутой флешке — ложная тревога,
 *    от которой перестают читать предупреждения;
 *  - **несколько путей** (данные на C:, копии на E:). Показывать надо худший,
 *    иначе полный диск с копиями спрячется за просторным системным;
 *  - **проверять нечего** — ответ «не знаю» (null), а не «0» и не отказ.
 *
 * Живая база не нужна; файловая система настоящая, но во временной папке.
 */

const loadDisk = () => loadCjs('src/utils/disk.js')

const isWin = process.platform === 'win32'
/** Заведомо отсутствующий том — «флешку вынули». */
const NO_DRIVE = isWin ? ['Z:', 'nope', 'backups'].join(path.sep) : '/nope-volume-hb/backups'

let root = null
let dataDir = null
let backupDir = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-disk-'))
  dataDir = path.join(root, 'pgdata')
  backupDir = path.join(root, 'backups')
  fs.mkdirSync(dataDir)
  fs.mkdirSync(backupDir)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('utils/disk — замер свободного места', () => {
  it('для существующей папки возвращает положительное число байт', () => {
    const { freeBytes } = loadDisk()
    expect(freeBytes(dataDir)).toBeGreaterThan(0)
  })

  it('для ещё не созданной папки меряет ближайший существующий родитель', () => {
    const { freeBytes } = loadDisk()
    expect(freeBytes(path.join(dataDir, 'ещё', 'нет'))).toBeGreaterThan(0)
  })

  it('недоступный диск — «не знаю» (null), без исключения', () => {
    const { freeBytes } = loadDisk()
    if (isWin) {
      expect(freeBytes(NO_DRIVE)).toBeNull()
    } else {
      expect(typeof freeBytes(NO_DRIVE)).toBe('number')
    }
  })
})

describe('utils/disk — сводка по путям программы', () => {
  it('перечисляет проверенные роли и показывает худшую из них', () => {
    const { diskStatus } = loadDisk()

    const res = diskStatus({
      paths: [{ role: 'data', path: dataDir }, { role: 'backup', path: backupDir }],
      thresholdMb: 1,
    })

    expect(res.checked.map((c) => c.role)).toEqual(['data', 'backup'])
    expect(res.checked.every((c) => c.freeMb > 0)).toBe(true)
    expect(res.freeMb).toBe(Math.min(...res.checked.map((c) => c.freeMb)))
    expect(res.thresholdMb).toBe(1)
    expect(res.warning).toBe(false)
  })

  it('свободного меньше порога — предупреждение', () => {
    const { diskStatus } = loadDisk()

    const probe = diskStatus({ paths: [{ role: 'data', path: dataDir }], thresholdMb: 1 })
    const res = diskStatus({
      paths: [{ role: 'data', path: dataDir }],
      thresholdMb: probe.freeMb + 1000,
    })

    expect(res.warning).toBe(true)
    expect(res.freeMb).toBeGreaterThan(0)
  })

  it('пустой и недоступный пути пропускаются, а не считаются нулём свободного места', () => {
    const { diskStatus } = loadDisk()

    const res = diskStatus({
      paths: [
        { role: 'data', path: dataDir },
        { role: 'backup', path: '' },
        { role: 'usb', path: NO_DRIVE },
      ],
      thresholdMb: 1,
    })

    expect(res.checked.map((c) => c.role)).toEqual(isWin ? ['data'] : ['data', 'usb'])
    expect(res.freeMb).toBeGreaterThan(0)
    expect(res.warning).toBe(false)
  })

  it('проверять нечего — «не знаю» и никакой тревоги', () => {
    const { diskStatus } = loadDisk()

    const empty = diskStatus({ paths: [], thresholdMb: 500 })
    expect(empty).toMatchObject({ freeMb: null, warning: false, thresholdMb: 500, checked: [] })

    const unusable = diskStatus({ paths: [{ role: 'backup', path: '' }, { role: 'usb', path: null }], thresholdMb: 500 })
    expect(unusable.freeMb).toBeNull()
    expect(unusable.warning).toBe(false)
    expect(unusable.checked).toEqual([])
  })
})
