import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Волна «Упаковка» — `electron/lib/migrations.js`.
 *
 * Что здесь на самом деле проверяется: **обновление программы у клиента,
 * которое нельзя откатить руками**. Установщик ставится поверх, при старте
 * идёт `migrate deploy`, и если миграция упала на середине (P3009), база
 * остаётся помеченной как сломанная и программа не поднимется НИКОГДА —
 * без нашего участия по телефону. Единственная страховка — копия папки
 * данных, снятая ДО миграций.
 *
 * Отсюда границы, по которым бьют тесты:
 *  - копия делается только если на диске хватает места; иначе мы обязаны
 *    честно отказаться, а не оставить полкопии и заполнить диск под ноль
 *    (полный диск — D8-006, отдельная беда: Postgres на нём не стартует);
 *  - копия собирается во ВРЕМЕННОЙ папке и переименовывается в итоговую
 *    только целиком — иначе после обрыва останется «копия», которой нельзя
 *    доверять;
 *  - `postmaster.pid` из копии убирается: с чужим pid-файлом восстановленный
 *    кластер отказывается стартовать, и человек получает вторую поломку
 *    поверх первой;
 *  - список «непринятых» миграций считается и на старой установке, где
 *    маркера со списком нет вовсе (тогда ожидаемо всё — это лучше, чем
 *    молча решить, что применять нечего).
 *
 * Модуль — чистый CommonJS без `require('electron')`; файловая система
 * настоящая, но во временной папке.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/migrations.js')

function loadMigrationsLib() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

let root = null

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-mig-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Папка миграции в стиле Prisma: `20260908065802_wave5b/migration.sql`. */
function putMigration(dir, name, sql = 'ALTER TABLE "Booking" ADD COLUMN "x" INT;') {
  fs.mkdirSync(path.join(dir, name), { recursive: true })
  fs.writeFileSync(path.join(dir, name, 'migration.sql'), sql, 'utf8')
}

/** Файл заданного размера — чтобы `dirSizeBytes` считался в известных байтах. */
function putBytes(file, n) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.alloc(n, 0x61))
}

describe('migrations.js — список миграций на диске', () => {
  it('возвращает только папки с migration.sql, в порядке применения', () => {
    const { listMigrationFolders } = loadMigrationsLib()
    const dir = path.join(root, 'migrations')
    putMigration(dir, '20260907054315_add_admin_token_version')
    putMigration(dir, '20260101000000_init')
    putMigration(dir, '20260908065802_wave5b_account_and_quota')

    expect(listMigrationFolders(dir)).toEqual([
      '20260101000000_init',
      '20260907054315_add_admin_token_version',
      '20260908065802_wave5b_account_and_quota',
    ])
  })

  it('migration_lock.toml и пустая папка без migration.sql в список не попадают', () => {
    const { listMigrationFolders } = loadMigrationsLib()
    const dir = path.join(root, 'migrations')
    putMigration(dir, '20260101000000_init')
    fs.writeFileSync(path.join(dir, 'migration_lock.toml'), 'provider = "postgresql"', 'utf8')
    fs.mkdirSync(path.join(dir, '20260102000000_черновик'), { recursive: true })
    fs.writeFileSync(path.join(dir, '20260102000000_черновик', 'README.md'), 'не миграция', 'utf8')

    expect(listMigrationFolders(dir)).toEqual(['20260101000000_init'])
  })

  it('отсутствующая папка миграций — пустой список, а не исключение', () => {
    const { listMigrationFolders } = loadMigrationsLib()
    expect(listMigrationFolders(path.join(root, 'нет-такой'))).toEqual([])
  })
})

describe('migrations.js — что осталось применить', () => {
  it('в непринятые попадают только те, которых нет в применённых', () => {
    const { pendingMigrations } = loadMigrationsLib()
    const folders = ['20260101_init', '20260907_tv', '20260908_wave5b']

    expect(pendingMigrations(folders, ['20260101_init', '20260907_tv']))
      .toEqual(['20260908_wave5b'])
  })

  it('все применены — список пуст', () => {
    const { pendingMigrations } = loadMigrationsLib()
    const folders = ['20260101_init', '20260907_tv']
    expect(pendingMigrations(folders, ['20260907_tv', '20260101_init'])).toEqual([])
  })

  it('старая установка без списка применённых считается «не применено ничего»', () => {
    const { pendingMigrations } = loadMigrationsLib()
    const folders = ['20260101_init', '20260907_tv']

    expect(pendingMigrations(folders, null)).toEqual(folders)
    expect(pendingMigrations(folders, undefined)).toEqual(folders)
    expect(pendingMigrations(folders, 'что-то не то')).toEqual(folders)
  })
})

describe('migrations.js — упавшие миграции', () => {
  it('незавершённая миграция (нет finished_at и нет отката) — упавшая', () => {
    const { failedMigrations } = loadMigrationsLib()

    const rows = [
      { migration_name: '20260101_init', finished_at: new Date(), rolled_back_at: null, logs: null },
      { migration_name: '20260908_wave5b', finished_at: null, rolled_back_at: null, logs: 'ERROR: column exists' },
    ]

    expect(failedMigrations(rows)).toEqual([
      { name: '20260908_wave5b', logs: 'ERROR: column exists' },
    ])
  })

  it('откаченная миграция упавшей не считается — она уже разобрана', () => {
    const { failedMigrations } = loadMigrationsLib()

    const rows = [
      { migration_name: '20260908_wave5b', finished_at: null, rolled_back_at: new Date(), logs: 'ERROR' },
    ]

    expect(failedMigrations(rows)).toEqual([])
  })

  it('нечитаемый ответ базы вместо строк — пустой список, а не падение старта', () => {
    const { failedMigrations } = loadMigrationsLib()
    expect(failedMigrations(null)).toEqual([])
    expect(failedMigrations(undefined)).toEqual([])
    expect(failedMigrations({ error: 'no such table' })).toEqual([])
  })
})

describe('migrations.js — размер папки данных', () => {
  it('считает файлы вложенных папок, а не только верхний уровень', () => {
    const { dirSizeBytes } = loadMigrationsLib()
    const data = path.join(root, 'pgdata')
    putBytes(path.join(data, 'PG_VERSION'), 3)
    putBytes(path.join(data, 'base', '1', '2619'), 1000)
    putBytes(path.join(data, 'base', '1', '2620'), 24)
    putBytes(path.join(data, 'pg_wal', '000000010000000000000001'), 500)

    expect(dirSizeBytes(data)).toBe(1527)
  })

  it('отсутствующая папка — нулевой размер, а не исключение', () => {
    const { dirSizeBytes } = loadMigrationsLib()
    expect(dirSizeBytes(path.join(root, 'нет-такой'))).toBe(0)
  })
})

describe('migrations.js — копия папки данных перед обновлением', () => {
  const paths = (dataDir) => loadMigrationsLib().preUpdateCopyPaths(dataDir)

  /** Папка данных «как у Postgres»: с вложенностью и с pid-файлом живого кластера. */
  function makeDataDir(name = 'pgdata') {
    const data = path.join(root, name)
    putBytes(path.join(data, 'PG_VERSION'), 3)
    putBytes(path.join(data, 'base', '1', '2619'), 100)
    fs.writeFileSync(path.join(data, 'postmaster.pid'), '4242\n', 'utf8')
    return data
  }

  const plenty = () => 1024 * 1024 * 1024 * 100

  it('имена копий строятся от папки данных и не зависят от текущей даты', () => {
    const { preUpdateCopyPaths } = loadMigrationsLib()
    const data = path.join(root, 'pgdata')

    expect(preUpdateCopyPaths(data)).toEqual({
      final: `${data}-before-update`,
      tmp: `${data}-before-update.tmp`,
    })
  })

  it('копия содержит файлы оригинала, включая вложенные', () => {
    const { copyDataDirBeforeUpdate } = loadMigrationsLib()
    const data = makeDataDir()

    const res = copyDataDirBeforeUpdate(data, { freeBytes: plenty, log: () => {} })

    expect(res.ok).toBe(true)
    expect(res.path).toBe(paths(data).final)
    expect(fs.existsSync(path.join(res.path, 'PG_VERSION'))).toBe(true)
    expect(fs.readFileSync(path.join(res.path, 'base', '1', '2619')).length).toBe(100)
  })

  it('в копии нет postmaster.pid — иначе восстановленный кластер не стартует', () => {
    const { copyDataDirBeforeUpdate } = loadMigrationsLib()
    const data = makeDataDir()

    const res = copyDataDirBeforeUpdate(data, { freeBytes: plenty, log: () => {} })

    expect(fs.existsSync(path.join(res.path, 'postmaster.pid'))).toBe(false)
    expect(fs.existsSync(path.join(data, 'postmaster.pid'))).toBe(true) // оригинал не тронут
  })

  it('временная папка после удачной копии не остаётся', () => {
    const { copyDataDirBeforeUpdate } = loadMigrationsLib()
    const data = makeDataDir()

    copyDataDirBeforeUpdate(data, { freeBytes: plenty, log: () => {} })

    expect(fs.existsSync(paths(data).tmp)).toBe(false)
  })

  it('не хватает места на удвоенный размер данных — отказ без единого файла копии', () => {
    const { copyDataDirBeforeUpdate, dirSizeBytes } = loadMigrationsLib()
    const data = makeDataDir()
    const size = dirSizeBytes(data)

    // Свободно ровно вдвое минус байт — граница «впритык не считается».
    const res = copyDataDirBeforeUpdate(data, { freeBytes: () => size * 2 - 1, log: () => {} })

    expect(res).toEqual({ ok: false, reason: 'space' })
    expect(fs.existsSync(paths(data).tmp)).toBe(false)
    expect(fs.existsSync(paths(data).final)).toBe(false)
  })

  it('места ровно вдвое — копия делается', () => {
    const { copyDataDirBeforeUpdate, dirSizeBytes } = loadMigrationsLib()
    const data = makeDataDir()
    const size = dirSizeBytes(data)

    const res = copyDataDirBeforeUpdate(data, { freeBytes: () => size * 2, log: () => {} })

    expect(res.ok).toBe(true)
  })

  it('неизмеримое место (флешка, сетевой диск) копию не отменяет', () => {
    const { copyDataDirBeforeUpdate } = loadMigrationsLib()
    const data = makeDataDir()

    // freeBytes вернул «не знаю» — это не повод остаться без страховки перед
    // обновлением; попытка копирования упрётся в ENOSPC сама, если места нет.
    const res = copyDataDirBeforeUpdate(data, { freeBytes: () => null, log: () => {} })

    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(res.path, 'PG_VERSION'))).toBe(true)
  })

  // ЗАМЕЧАНИЕ, а не требование к текущему коду (тест намеренно ожидаемо падает).
  // Сейчас прошлая копия удаляется ДО проверки места: обновление на забитом
  // диске уносит копию от прошлого обновления и не создаёт новую — клиент
  // остаётся вообще без снимка папки данных. Порядок «сначала проверить место,
  // потом удалять» стоил бы одной перестановки строк, но решение — за
  // владельцем кода (electron/lib/migrations.js).
  it('нехватка места не должна уносить копию от прошлого обновления', () => {
    const { copyDataDirBeforeUpdate, dirSizeBytes } = loadMigrationsLib()
    const data = makeDataDir()
    const { final } = paths(data)
    fs.mkdirSync(final, { recursive: true })
    fs.writeFileSync(path.join(final, 'PG_VERSION'), '16', 'utf8')

    const res = copyDataDirBeforeUpdate(data, {
      freeBytes: () => dirSizeBytes(data) * 2 - 1,
      log: () => {},
    })

    expect(res).toEqual({ ok: false, reason: 'space' })
    expect(fs.existsSync(path.join(final, 'PG_VERSION'))).toBe(true)
  })

  it('копия от прошлого обновления заменяется новой, а не смешивается с ней', () => {
    const { copyDataDirBeforeUpdate } = loadMigrationsLib()
    const data = makeDataDir()
    const { final, tmp } = paths(data)

    // Прошлая копия и обрывок прошлой попытки.
    fs.mkdirSync(final, { recursive: true })
    fs.writeFileSync(path.join(final, 'старый-файл.txt'), 'от прошлого обновления', 'utf8')
    fs.mkdirSync(tmp, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'обрывок.txt'), 'недокопированное', 'utf8')

    const res = copyDataDirBeforeUpdate(data, { freeBytes: plenty, log: () => {} })

    expect(res.ok).toBe(true)
    expect(fs.existsSync(path.join(final, 'старый-файл.txt'))).toBe(false)
    expect(fs.existsSync(path.join(final, 'обрывок.txt'))).toBe(false)
    expect(fs.existsSync(path.join(final, 'PG_VERSION'))).toBe(true)
    expect(fs.existsSync(tmp)).toBe(false)
  })
})

describe('migrations.js — что показать человеку при упавшей миграции', () => {
  it('сообщение называет миграцию, первые строки журнала, путь копии и говорит, что данные целы', () => {
    const { describeMigrationFailure } = loadMigrationsLib()

    const text = describeMigrationFailure({
      name: '20260908065802_wave5b_account_and_quota',
      logs: 'ERROR: column "accountBookingId" of relation "Booking" already exists\nSTATEMENT: ALTER TABLE',
      copyPath: 'C:\\Users\\admin\\AppData\\Roaming\\Qonaq\\pgdata-before-update',
      logPath: 'C:\\Users\\admin\\AppData\\Roaming\\Qonaq\\logs\\migrate.log',
    })

    expect(typeof text).toBe('string')
    expect(text).toContain('20260908065802_wave5b_account_and_quota')
    expect(text).toContain('already exists')
    expect(text).toContain('pgdata-before-update')
    // Регистр первой буквы — дело вёрстки сообщения; важна сама фраза.
    expect(text.toLowerCase()).toContain('данные не изменены')
  })

  it('без журнала и без копии сообщение не показывает «undefined»', () => {
    const { describeMigrationFailure } = loadMigrationsLib()

    const text = describeMigrationFailure({ name: '20260101_init' })

    expect(text).toContain('20260101_init')
    expect(text.toLowerCase()).toContain('данные не изменены')
    expect(text).not.toMatch(/undefined|null|\[object Object\]/)
  })

  it('длинный журнал обрезается до первых строк, а не вываливается целиком', () => {
    const { describeMigrationFailure } = loadMigrationsLib()
    const logs = Array.from({ length: 40 }, (_, i) => `строка журнала ${i + 1}`).join('\n')

    const text = describeMigrationFailure({ name: '20260101_init', logs })

    expect(text).toContain('строка журнала 1')
    expect(text).not.toContain('строка журнала 40')
  })
})
