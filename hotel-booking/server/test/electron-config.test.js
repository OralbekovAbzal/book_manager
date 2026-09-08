import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Волна «Упаковка» — `electron/lib/config.js`.
 *
 * Здесь живут две вещи, которыми у клиента можно потерять доступ к базе:
 *
 *  1. **Запись файла настроек.** `config.json` переписывается при каждом старте
 *     программы. Обрыв питания посреди записи (или антивирус, держащий файл)
 *     обязан оставить старый файл целым, а не половину нового. Отсюда
 *     атомарная запись через временный файл + rename и требование «мусора в
 *     папке не остаётся»: россыпь `config.json.tmp123` рядом с настройками —
 *     первое, на что смотрит человек, разбирая сломанную установку.
 *
 *  2. **Пароль встроенного Postgres.** До сих пор `config.json` был его
 *     ЕДИНСТВЕННОЙ копией (D8-004): потеряли файл — кластер с данными жив, а
 *     войти в него нечем. Спутник (sidecar) — вторая копия. Но у него есть
 *     обратная опасность: если кластера ещё нет (`PG_VERSION` отсутствует,
 *     `initdb` заведёт НОВЫЙ с новым паролем), спутник от прошлой установки
 *     подсунет чужой пароль и программа не войдёт в свою же свежую базу.
 *     Поэтому `reconcileSecret` спрашивает `hasPgVersion` — это её главная
 *     граница, и на неё здесь два теста с обеих сторон.
 *
 * Живой Electron и живая база не нужны: модуль — чистый CommonJS без
 * `require('electron')`, файловая система настоящая, но во временной папке.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/config.js')

function loadConfigLib() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

let dir = null

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cfg-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Час назад — чтобы «файл не переписан» проверялось по mtime без гонки с точностью ФС. */
const LONG_AGO = Math.floor(Date.now() / 1000) - 3600

describe('config.js — атомарная запись файла', () => {
  it('создаёт файл с точным текстом, включая кириллицу', () => {
    const { writeFileAtomic } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    const text = JSON.stringify({ hotel: 'Дорожник', пароль: 'п@роль «ёж»' }, null, 2)

    writeFileAtomic(file, text)

    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  })

  it('заменяет существующий файл целиком, а не дописывает к нему', () => {
    const { writeFileAtomic } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, 'очень длинный старый текст настроек', 'utf8')

    writeFileAtomic(file, 'коротко')

    expect(fs.readFileSync(file, 'utf8')).toBe('коротко')
  })

  it('после записи в папке не остаётся временных файлов', () => {
    const { writeFileAtomic } = loadConfigLib()
    const file = path.join(dir, 'config.json')

    writeFileAtomic(file, '{"a":1}')
    writeFileAtomic(file, '{"a":2}')

    expect(fs.readdirSync(dir)).toEqual(['config.json'])
  })

  it('при отказе записи бросает и не оставляет временный файл', () => {
    const { writeFileAtomic } = loadConfigLib()
    // Путь ведёт «сквозь» существующий файл: папки такой нет и быть не может.
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x', 'utf8')
    const impossible = path.join(blocker, 'config.json')

    expect(() => writeFileAtomic(impossible, '{}')).toThrow()
    expect(fs.readdirSync(dir)).toEqual(['blocker'])
  })
})

describe('config.js — чтение JSON', () => {
  it('отсутствующий файл читается как пустой объект, а не как отказ', () => {
    const { readJsonFile } = loadConfigLib()
    expect(readJsonFile(path.join(dir, 'нет-такого.json'))).toEqual({})
  })

  it('битый JSON (оборванная запись) читается как пустой объект', () => {
    const { readJsonFile } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    fs.writeFileSync(file, '{"dbPassword": "секрет"', 'utf8')

    expect(readJsonFile(file)).toEqual({})
  })

  it('валидный JSON, но не объект, читается как пустой объект', () => {
    const { readJsonFile } = loadConfigLib()
    const num = path.join(dir, 'num.json')
    const str = path.join(dir, 'str.json')
    const nul = path.join(dir, 'null.json')
    fs.writeFileSync(num, '42', 'utf8')
    fs.writeFileSync(str, '"строка"', 'utf8')
    fs.writeFileSync(nul, 'null', 'utf8')

    expect(readJsonFile(num)).toEqual({})
    expect(readJsonFile(str)).toEqual({})
    expect(readJsonFile(nul)).toEqual({})
  })

  it('читает записанный объект обратно', () => {
    const { readJsonFile, writeFileAtomic } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    writeFileAtomic(file, JSON.stringify({ dbPassword: 'п1', port: 3001 }, null, 2))

    expect(readJsonFile(file)).toEqual({ dbPassword: 'п1', port: 3001 })
  })
})

describe('config.js — запись настроек только при изменении', () => {
  it('первая запись создаёт файл и сообщает об изменении', () => {
    const { writeConfigIfChanged } = loadConfigLib()
    const file = path.join(dir, 'config.json')

    expect(writeConfigIfChanged(file, { port: 3001 })).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ port: 3001 })
  })

  it('совпадающее содержимое не переписывает файл (mtime не меняется)', () => {
    const { writeConfigIfChanged } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    const cfg = { port: 3001, dbPassword: 'секрет' }
    writeConfigIfChanged(file, cfg)
    fs.utimesSync(file, LONG_AGO, LONG_AGO)
    const before = fs.statSync(file).mtimeMs

    expect(writeConfigIfChanged(file, { ...cfg })).toBe(false)
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('изменённое содержимое переписывает файл и сообщает об изменении', () => {
    const { writeConfigIfChanged } = loadConfigLib()
    const file = path.join(dir, 'config.json')
    writeConfigIfChanged(file, { port: 3001 })
    fs.utimesSync(file, LONG_AGO, LONG_AGO)

    expect(writeConfigIfChanged(file, { port: 3002 })).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ port: 3002 })
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(LONG_AGO * 1000)
  })
})

describe('config.js — спутник с паролем базы', () => {
  it('путь спутника лежит рядом с данными и называется одинаково всегда', () => {
    const { secretSidecarPath } = loadConfigLib()
    expect(secretSidecarPath(dir)).toBe(path.join(dir, 'hotel-booking-secret.json'))
  })

  it('записанный пароль читается обратно', () => {
    const { writeSecretSidecar, readSecretSidecar } = loadConfigLib()
    writeSecretSidecar(dir, 'п@роль-с-кириллицей')

    expect(readSecretSidecar(dir)).toMatchObject({ dbPassword: 'п@роль-с-кириллицей' })
  })

  it('отсутствующий, битый и бессодержательный спутник читаются как «пароля нет»', () => {
    const { readSecretSidecar, secretSidecarPath } = loadConfigLib()
    const file = secretSidecarPath(dir)

    expect(readSecretSidecar(dir)).toBeNull()

    fs.writeFileSync(file, '{"dbPassword": ', 'utf8')
    expect(readSecretSidecar(dir)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({ writtenAt: '2026-09-08' }), 'utf8')
    expect(readSecretSidecar(dir)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({ dbPassword: '' }), 'utf8')
    expect(readSecretSidecar(dir)).toBeNull()

    fs.writeFileSync(file, JSON.stringify({ dbPassword: 12345 }), 'utf8')
    expect(readSecretSidecar(dir)).toBeNull()
  })

  it('спутник не создаёт папку данных — пишет только в существующую', () => {
    const { writeSecretSidecar } = loadConfigLib()
    const missing = path.join(dir, 'нет-папки')

    expect(() => writeSecretSidecar(missing, 'пароль')).toThrow()
    expect(fs.existsSync(missing)).toBe(false)
  })
})

describe('config.js — согласование пароля базы (reconcileSecret)', () => {
  const generate = () => 'НОВЫЙ-СГЕНЕРИРОВАННЫЙ'

  it('при живом кластере пароль из спутника побеждает пароль из настроек', () => {
    const { reconcileSecret } = loadConfigLib()
    const cfg = { dbPassword: 'из-config' }

    const res = reconcileSecret(cfg, {
      hasPgVersion: true,
      sidecar: { dbPassword: 'из-спутника' },
      generate,
    })

    expect(res).toEqual({ source: 'sidecar', changed: true })
    expect(cfg.dbPassword).toBe('из-спутника')
  })

  it('совпадающий пароль спутника не считается изменением', () => {
    const { reconcileSecret } = loadConfigLib()
    const cfg = { dbPassword: 'одинаковый' }

    const res = reconcileSecret(cfg, {
      hasPgVersion: true,
      sidecar: { dbPassword: 'одинаковый' },
      generate,
    })

    expect(res).toEqual({ source: 'sidecar', changed: false })
    expect(cfg.dbPassword).toBe('одинаковый')
  })

  it('без кластера спутник игнорируется — старый пароль не подставляется в свежую базу', () => {
    const { reconcileSecret } = loadConfigLib()
    const cfg = { dbPassword: 'из-config' }

    const res = reconcileSecret(cfg, {
      hasPgVersion: false,
      sidecar: { dbPassword: 'от-прошлой-установки' },
      generate,
    })

    expect(res).toEqual({ source: 'config', changed: false })
    expect(cfg.dbPassword).toBe('из-config')
  })

  it('без кластера и без пароля в настройках пароль генерируется, спутник не спасает', () => {
    const { reconcileSecret } = loadConfigLib()
    const cfg = {}

    const res = reconcileSecret(cfg, {
      hasPgVersion: false,
      sidecar: { dbPassword: 'от-прошлой-установки' },
      generate,
    })

    expect(res).toEqual({ source: 'generated', changed: true })
    expect(cfg.dbPassword).toBe('НОВЫЙ-СГЕНЕРИРОВАННЫЙ')
  })

  it('пустой или нестроковый пароль в спутнике равносилен его отсутствию', () => {
    const { reconcileSecret } = loadConfigLib()

    const empty = { dbPassword: 'из-config' }
    expect(reconcileSecret(empty, { hasPgVersion: true, sidecar: { dbPassword: '' }, generate }))
      .toEqual({ source: 'config', changed: false })
    expect(empty.dbPassword).toBe('из-config')

    const wrongType = { dbPassword: 'из-config' }
    expect(reconcileSecret(wrongType, { hasPgVersion: true, sidecar: { dbPassword: 777 }, generate }))
      .toEqual({ source: 'config', changed: false })
    expect(wrongType.dbPassword).toBe('из-config')
  })

  it('живой кластер без спутника и без пароля в настройках — пароль генерируется', () => {
    const { reconcileSecret } = loadConfigLib()
    const cfg = {}

    const res = reconcileSecret(cfg, { hasPgVersion: true, sidecar: null, generate })

    expect(res).toEqual({ source: 'generated', changed: true })
    expect(cfg.dbPassword).toBe('НОВЫЙ-СГЕНЕРИРОВАННЫЙ')
  })
})
