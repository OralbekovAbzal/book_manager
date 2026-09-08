/**
 * Конфиг хоста и спутник с паролем базы.
 *
 * Модуль намеренно НЕ требует `electron`: его зовёт main-процесс, но его же
 * читают юнит-тесты сервера (`server/test/electron-*.test.js`) обычным node.
 * Поэтому пути и логгер приходят параметрами, а из встроенного берём только
 * fs/path/crypto.
 *
 * ПОЧЕМУ АТОМАРНАЯ ЗАПИСЬ. `config.json` — единственное место, где живёт пароль
 * встроенного Postgres (D8-004), и он перезаписывался обычным writeFileSync при
 * КАЖДОМ старте хоста. Отключение питания в этот момент оставляло обрезанный
 * файл; повреждённый файл читается как `{}`, и следующий старт выпускал НОВЫЙ
 * пароль, которого кластер в pgdata не знает, — данные целы, но недоступны.
 * Отсюда две меры: tmp+fsync+rename (файл либо старый, либо новый целиком) и
 * спутник с паролем рядом с самим кластером (см. ниже).
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Пауза без async: писать конфиг приходится и из синхронных путей (выход из
// программы), а SharedArrayBuffer+Atomics — единственный способ поспать
// синхронно, не сжигая процессор.
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* SAB может быть запрещён политикой — тогда просто без паузы */
  }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY'])
const RENAME_RETRIES = 3

/**
 * Синхронная атомарная запись текстового файла.
 * Пишем во временный файл В ТОЙ ЖЕ ПАПКЕ (rename атомарен только внутри тома),
 * сбрасываем на диск (fsync — иначе rename может обогнать данные в кэше) и
 * переименовываем поверх. На Windows rename поверх открытого файла отвечает
 * EPERM/EBUSY (антивирус, индексатор, вторая копия программы) — это лечится
 * повтором, а не отказом.
 */
function writeFileAtomic(filePath, text) {
  const suffix = `${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  const tmp = `${filePath}.${suffix}.tmp`

  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(tmp, text, 'utf8')
      const fd = fs.openSync(tmp, 'r+')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, filePath)
      return filePath
    } catch (err) {
      try { fs.unlinkSync(tmp) } catch { /* мог и не создаться */ }
      if (RETRY_CODES.has(err && err.code) && attempt < RENAME_RETRIES) {
        sleepMs(50)
        continue
      }
      throw err
    }
  }
}

/**
 * JSON-файл → объект. Любая беда (нет файла, битый JSON, в файле массив или
 * число) → `{}`: конфиг и маркер схемы читаются на самом раннем этапе запуска,
 * и падать здесь нельзя.
 */
function readJsonFile(filePath) {
  let raw
  try { raw = fs.readFileSync(filePath, 'utf8') } catch { return {} }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

/**
 * Записать конфиг, только если содержимое реально изменилось.
 * Старт хоста перезаписывал config.json всегда — то есть каждый запуск открывал
 * окно, в котором питание могло пропасть при живом файле с паролем. Ничего не
 * поменялось — не трогаем файл вовсе.
 * @returns {boolean} true — файл записан
 */
function writeConfigIfChanged(configPath, cfg) {
  const text = JSON.stringify(cfg, null, 2)
  let current = null
  try { current = fs.readFileSync(configPath, 'utf8') } catch { current = null }
  if (current === text) return false
  writeFileAtomic(configPath, text)
  return true
}

// ─── Спутник с паролем базы ──────────────────────────────────────────────────
//
// Пароль лежит ВТОРОЙ копией рядом с самим кластером (в папке данных). Смысл:
// потерянный или очищенный `config.json` больше не означает потерю доступа к
// данным — пароль восстанавливается оттуда, где стоит база. Обратное неверно:
// без PG_VERSION спутник игнорируется (папка данных сменилась — пароль от
// чужого кластера подставлять нельзя).
const SECRET_FILE = 'hotel-booking-secret.json'

function secretSidecarPath(dataDir) {
  return path.join(dataDir, SECRET_FILE)
}

/**
 * @returns {{ dbPassword: string }|null} null — файла нет, он битый или пароль пустой
 */
function readSecretSidecar(dataDir) {
  const data = readJsonFile(secretSidecarPath(dataDir))
  const pwd = data.dbPassword
  if (typeof pwd !== 'string' || pwd === '') return null
  return { dbPassword: pwd }
}

/** Папку не создаём: спутник пишется только рядом с существующим кластером. */
function writeSecretSidecar(dataDir, dbPassword) {
  const file = secretSidecarPath(dataDir)
  writeFileAtomic(file, JSON.stringify({ dbPassword, writtenAt: new Date().toISOString() }, null, 2))
  return file
}

/**
 * Свести пароль базы из трёх источников и записать результат в `cfg.dbPassword`.
 *
 * Приоритет спутника над конфигом — намеренный: спутник лежит в той же папке,
 * что и кластер, а значит описывает ИМЕННО ЭТОТ кластер. `config.json` может
 * быть новым (переустановка, «почистили AppData») и содержать свежесгенерированный
 * пароль, которым существующая база не откроется.
 *
 * @param {object} cfg конфиг (мутируется)
 * @param {{ hasPgVersion: boolean, sidecar: {dbPassword:string}|null, generate: () => string }} opts
 * @returns {{ source: 'sidecar'|'config'|'generated', changed: boolean }}
 */
function reconcileSecret(cfg, { hasPgVersion, sidecar, generate } = {}) {
  const fromSidecar = sidecar && typeof sidecar.dbPassword === 'string' && sidecar.dbPassword !== ''
    ? sidecar.dbPassword
    : null

  // Спутник учитываем ТОЛЬКО при существующем кластере — иначе это остаток от
  // удалённой базы, и подставлять его пароль в свежий initdb бессмысленно.
  if (hasPgVersion === true && fromSidecar) {
    if (cfg.dbPassword !== fromSidecar) {
      cfg.dbPassword = fromSidecar
      return { source: 'sidecar', changed: true }
    }
    return { source: 'sidecar', changed: false }
  }

  if (cfg.dbPassword) return { source: 'config', changed: false }

  cfg.dbPassword = generate()
  return { source: 'generated', changed: true }
}

module.exports = {
  writeFileAtomic,
  readJsonFile,
  writeConfigIfChanged,
  secretSidecarPath,
  readSecretSidecar,
  writeSecretSidecar,
  reconcileSecret,
}
