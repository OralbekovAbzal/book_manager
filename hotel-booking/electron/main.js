const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')

// ─── Пути к ресурсам (dev vs упакованное) ────────────────────────────────────
const isDev = !app.isPackaged
// В dev — отдельный userData: иначе dev и установленная версия делят config.json
// и pgdata. Обязательно ДО первого app.getPath('userData') (CONFIG_PATH ниже).
if (isDev) app.setPath('userData', app.getPath('userData') + '-dev')

function resourcePath(...p) {
  if (!isDev) return path.join(process.resourcesPath, ...p)   // prod: resources/
  // dev: init.sql/seed.sql лежат в electron/db, сервер — в hotel-booking/server
  const [head, ...rest] = p
  if (head === 'db') return path.join(__dirname, 'db', ...rest)
  return path.join(__dirname, '..', head, ...rest)
}
const DB_PORT = 5433
const DB_NAME = 'hotel_booking'
const DEFAULT_HOST_PORT = 3001

/**
 * Разовый секрет для внутренних вызовов API (копия при выходе, кнопка «Сделать
 * копию сейчас» в настройках). У main-процесса нет и не может быть JWT: он не
 * входит в программу под учётной записью. Секрет живёт ТОЛЬКО в памяти и в env
 * запущенного сервера — в config.json он не пишется намеренно: файл переживает
 * переустановку, а этот секрет не должен переживать даже перезапуск.
 */
const INTERNAL_TOKEN = crypto.randomBytes(24).toString('hex')
// Файл копии, принесённый с другого компьютера, читается целиком в память
const MAX_BACKUP_FILE_BYTES = 200 * 1024 * 1024
// Отметка «схема накатана» в папке данных: пишется ПОСЛЕ успешного init.sql + seed.sql
const SCHEMA_MARKER = 'schema-ready.json'
const APP_VERSION = app.getVersion()

// ─── Конфиг (userData, переживает переустановку) ─────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
}
// Значения по умолчанию для порта и папок хоста (сисадмин может переопределить).
function defaultPaths() {
  return {
    hostPort: DEFAULT_HOST_PORT,
    dataDir: path.join(app.getPath('userData'), 'pgdata'),
    backupDir: path.join(app.getPath('userData'), 'backups'),
  }
}
function ensureSecrets(cfg) {
  const d = defaultPaths()
  if (!cfg.dbPassword) cfg.dbPassword = crypto.randomBytes(18).toString('hex')
  if (!cfg.jwtSecret)  cfg.jwtSecret  = crypto.randomBytes(48).toString('base64')
  if (!cfg.hostPort)   cfg.hostPort   = d.hostPort
  if (!cfg.dataDir)    cfg.dataDir    = d.dataDir
  if (!cfg.backupDir)  cfg.backupDir  = d.backupDir
  return cfg
}

// ─── Пароль сисадмина (хранится ЛОКАЛЬНО, scrypt) ────────────────────────────
// Сисадмин — тот, кто ставит программу и настраивает подключение. Его пароль
// лежит в config.json, а не в базе: в системные настройки нужно попадать даже
// когда сервер/база недоступны. Сотрудники отеля этот пароль не используют.
const SYSADMIN_KEYLEN = 32
function hasSysadmin(cfg) {
  return !!(cfg && cfg.sysadmin && cfg.sysadmin.salt && cfg.sysadmin.hash)
}
function hashSysadminPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, SYSADMIN_KEYLEN).toString('hex')
  return { salt, hash }
}
function verifySysadminPassword(cfg, password) {
  if (!hasSysadmin(cfg)) return false
  let expected
  try { expected = Buffer.from(String(cfg.sysadmin.hash), 'hex') } catch { return false }
  if (expected.length !== SYSADMIN_KEYLEN) return false
  const actual = crypto.scryptSync(String(password == null ? '' : password), String(cfg.sysadmin.salt), SYSADMIN_KEYLEN)
  return crypto.timingSafeEqual(actual, expected)
}

// IPv4-адреса этого компьютера в локальной сети — подсказка «адрес для клиентов».
function lanIps() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      const isV4 = ni.family === 'IPv4' || ni.family === 4
      if (isV4 && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

// ─── Диагностический лог (host-режим) ────────────────────────────────────────
const DEBUG_LOG = path.join(app.getPath('userData'), 'host-debug.log')
function hlog(...a) {
  const line = `[${new Date().toISOString()}] ` +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'
  try { fs.appendFileSync(DEBUG_LOG, line) } catch {}
}

// Текст ошибки запуска для диалога. embedded-postgres иногда реджектит без объекта
// ошибки — String(err.message || err) показывал пользователю «undefined».
function describeStartError(err) {
  const msg = err && (typeof err === 'string' ? err : err.message)
  if (msg) return `${msg}\n\nПодробности: ${DEBUG_LOG}`
  return `База данных не запустилась. Возможно, порт ${DB_PORT} занят или программа уже запущена. ` +
    `Подробности: ${DEBUG_LOG}`
}

// ─── Состояние процессов хоста ───────────────────────────────────────────────
let pgInstance = null
let pgDataDir = null   // папка кластера — нужна для штатной остановки через pg_ctl
let serverProc = null
let mainWindow = null
let settingsWindow = null
let splashWindow = null
let isQuitting = false

// ─── Запуск встроенного Postgres + сервера (режим ХОСТ) ──────────────────────
async function startHost(cfg) {
  hlog('startHost begin; isDev=', isDev, 'resourcesPath=', process.resourcesPath || '(dev)')
  let EmbeddedPostgres
  try {
    ;({ default: EmbeddedPostgres } = await import('embedded-postgres'))
    hlog('embedded-postgres import OK')
  } catch (e) {
    hlog('embedded-postgres IMPORT FAIL:', e && (e.stack || e.message || String(e)))
    throw e
  }

  // Папка данных Postgres — из config.json (задаётся сисадмином в настройках системы).
  const dataDir = cfg.dataDir || defaultPaths().dataDir
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'))
  // Есть PG_VERSION, но нет отметки → старая установка (до отметок) или прерванный
  // первый запуск: решаем по факту существования базы после старта Postgres.
  const markerPath = path.join(dataDir, SCHEMA_MARKER)
  pgDataDir = dataDir
  hlog('dataDir=', dataDir, 'fresh=', fresh, 'schemaReady=', fs.existsSync(markerPath))

  pgInstance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: cfg.dbPassword,
    port: DB_PORT,
    persistent: true,
    // UTF8 обязательно — иначе кириллица в именах гостей ломается.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (m) => hlog('[pg]', String(m)),
    onError: (e) => hlog('[pg-err]', String(e && (e.message || e))),
  })

  try {
    if (fresh) {
      // initdb требует пустую папку — устаревшая отметка без PG_VERSION ему помешает
      try { fs.unlinkSync(markerPath) } catch {}
      hlog('initialise (initdb)...'); await pgInstance.initialise(); hlog('initialise OK')
    }
    hlog('start postgres...'); await pgInstance.start(); hlog('postgres started')

    let needSchema = fresh
    if (!fresh && !fs.existsSync(markerPath)) {
      const exists = await databaseExists(DB_NAME)
      hlog('no schema marker; database exists=', exists)
      needSchema = !exists   // база есть — считаем готовой, нет — создаём и накатываем
    }
    // Схема накатывается миграциями Prisma — и на пустой базе, и на базе клиента,
    // где уже есть брони. Поэтому migrate deploy идёт на КАЖДОМ старте, а не
    // только на свежей установке: иначе обновление программы не довезло бы
    // до клиента новые таблицы (см. applyMigrations).
    if (needSchema) await createEmptyDatabase()
    try {
      await applyMigrations(databaseUrl(cfg))
      // Начальные данные (админ, категории, метки) — только для только что
      // созданной базы. На рабочей базе seed не трогаем.
      if (needSchema) await applySeed()
    } catch (e) {
      // Базу, созданную в ЭТОМ запуске, удаляем — иначе пустая база без таблиц
      // при следующем старте считалась бы готовой.
      if (needSchema) {
        hlog('SCHEMA APPLY FAIL, dropping database:', String(e && (e.message || e)))
        try { await pgInstance.dropDatabase(DB_NAME) } catch (de) { hlog('dropDatabase fail:', String(de && (de.message || de))) }
      }
      throw e
    }
    if (needSchema || !fs.existsSync(markerPath)) {
      fs.writeFileSync(markerPath, JSON.stringify({ appliedAt: new Date().toISOString(), schema: 'prisma-migrate' }, null, 2), 'utf8')
      hlog('schema marker written:', markerPath)
    }
  } catch (e) {
    hlog('POSTGRES SETUP FAIL:', e && (e.stack || e.message || String(e)))
    throw e
  }

  spawnServer(cfg)
  await waitForHealth(cfg.hostPort, 30000)
  hlog('health OK on port', cfg.hostPort)
  return `http://localhost:${cfg.hostPort}`
}

async function databaseExists(name) {
  const client = pgInstance.getPgClient('postgres')
  await client.connect()
  try {
    const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])
    return r.rowCount > 0
  } finally {
    await client.end()
  }
}

// Пустая база. Таблицы в ней создадут миграции (applyMigrations).
async function createEmptyDatabase() {
  hlog('createDatabase...'); await pgInstance.createDatabase(DB_NAME)
}

// Начальные данные свежей установки: главный администратор, категории, метки.
// Схемы здесь больше нет — только данные (init.sql удалён, см. applyMigrations).
async function applySeed() {
  const client = pgInstance.getPgClient(DB_NAME)
  try {
    await client.connect()
    hlog('apply seed.sql from', resourcePath('db', 'seed.sql'))
    await client.query(fs.readFileSync(resourcePath('db', 'seed.sql'), 'utf8'))
    hlog('seed applied')
  } finally {
    try { await client.end() } catch {}
  }
}

// ─── Миграции Prisma ─────────────────────────────────────────────────────────
// Единственный источник схемы — server/prisma/migrations. Раньше свежая установка
// разворачивалась из написанного руками electron/db/init.sql, а schema.prisma жила
// отдельно: новая таблица требовала ДВУХ правок, а обновить базу у клиента,
// где уже есть брони, было нечем. Теперь оба сценария — одни и те же файлы.
//
// Prisma CLI зовём напрямую по build/index.js: node_modules/.bin в сборку не
// попадает, а сам Electron умеет работать как node (ELECTRON_RUN_AS_NODE).
const BASELINE_MIGRATION = '0_init'

function databaseUrl(cfg) {
  return `postgresql://postgres:${cfg.dbPassword}@127.0.0.1:${DB_PORT}/${DB_NAME}`
}

function runPrisma(args, dbUrl) {
  const cli = resourcePath('server', 'node_modules', 'prisma', 'build', 'index.js')
  if (!fs.existsSync(cli)) {
    throw new Error(`Не найден Prisma CLI: ${cli}. Схему базы обновить нечем — переустановите программу.`)
  }
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args, '--schema=prisma/schema.prisma'], {
      cwd: resourcePath('server'),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DATABASE_URL: dbUrl,
        // Без этого CLI при каждом старте лезет в сеть за проверкой версии
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
    })
    proc.stdout?.on('data', (d) => hlog('[prisma]', String(d).trim()))
    proc.stderr?.on('data', (d) => hlog('[prisma-err]', String(d).trim()))
    proc.on('error', (e) => reject(new Error(`Не удалось запустить миграции: ${e.message}`)))
    proc.on('exit', (code) => {
      if (code === 0) return resolve()
      reject(new Error(`Обновление схемы базы не удалось (prisma ${args.join(' ')}, код ${code}).\nПодробности: ${DEBUG_LOG}`))
    })
  })
}

// Есть ли в базе таблица учёта миграций и вообще таблицы приложения.
async function inspectSchemaState() {
  const client = pgInstance.getPgClient(DB_NAME)
  await client.connect()
  try {
    const r = await client.query(
      `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS managed,
              to_regclass('public."Booking"')          IS NOT NULL AS "hasTables"`
    )
    return r.rows[0] || { managed: false, hasTables: false }
  } finally {
    try { await client.end() } catch {}
  }
}

// Таблицы, которые создаёт базовая миграция. Список читаем из самого файла
// миграции, чтобы он не разъезжался со схемой при её изменениях.
function baselineTables() {
  const file = resourcePath('server', 'prisma', 'migrations', BASELINE_MIGRATION, 'migration.sql')
  const sql = fs.readFileSync(file, 'utf8')
  return [...sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"([A-Za-z0-9_]+)"/g)].map((m) => m[1])
}

// Каких таблиц базовой миграции в базе НЕ хватает.
async function missingBaselineTables() {
  let expected
  try { expected = baselineTables() } catch (e) {
    hlog('не прочитал базовую миграцию:', String(e && (e.message || e)))
    return []   // проверить нечем — не мешаем обновлению
  }
  if (!expected.length) return []
  const client = pgInstance.getPgClient(DB_NAME)
  await client.connect()
  try {
    const r = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [expected],
    )
    const present = new Set(r.rows.map((x) => x.tablename))
    return expected.filter((t) => !present.has(t))
  } finally {
    try { await client.end() } catch {}
  }
}

async function applyMigrations(dbUrl) {
  const { managed, hasTables } = await inspectSchemaState()
  hlog('schema state: managed=', managed, 'hasTables=', hasTables)

  // База со старой установки: таблицы созданы прежним init.sql, но Prisma о них
  // не знает. Помечаем базовую миграцию применённой — SQL при этом НЕ выполняется,
  // данные не трогаются. Без этого шага migrate deploy отвечает P3005
  // («schema is not empty») и обновление у клиента не проходит.
  if (!managed && hasTables) {
    // ВАЖНО: пометка «0_init применён» — это ОБЕЩАНИЕ, что вся схема из этой
    // миграции в базе уже есть. Если база собрана версией программы старше,
    // чем снимок 0_init, части таблиц в ней нет — а deploy после пометки их уже
    // не создаст: Prisma считает базу актуальной. Программа при этом
    // запускается, но разделы, которым нужны недостающие таблицы, отвечают 500,
    // и починить это обновлением уже нельзя. Поэтому сначала убеждаемся, что
    // схема действительно полная (проверяем по таблицам; расхождения на уровне
    // отдельных колонок так не ловятся), и при расхождении честно
    // останавливаемся — данные при этом не изменяются.
    const missing = await missingBaselineTables()
    if (missing.length) {
      throw new Error(
        `База данных в папке ${pgDataDir} создана более старой версией программы: ` +
        `в ней нет таблиц ${missing.join(', ')}. Автоматически привести такую базу ` +
        `к текущей схеме нельзя. Установите прежнюю версию программы либо перенесите ` +
        `данные в новую базу. Данные не изменены.`,
      )
    }
    hlog('baseline: mark', BASELINE_MIGRATION, 'as applied')
    await runPrisma(['migrate', 'resolve', '--applied', BASELINE_MIGRATION], dbUrl)
  }

  hlog('prisma migrate deploy...')
  await runPrisma(['migrate', 'deploy'], dbUrl)
  hlog('migrations applied')
}

// Запуск Node-сервера как дочернего процесса + надзор: упавший сервер один раз
// перезапускается через 1 с; если он поднялся и ответил на /api/health, следующее
// падение снова получит одну попытку. Повторное падение подряд — диалог с путём
// к логу и окно настроек. При завершении приложения не перезапускаем.
let serverRestarted = false
function spawnServer(cfg) {
  const dbUrl = databaseUrl(cfg)
  const serverEntry = resourcePath('server', 'server.js')

  // Логи — в userData (resources/ в Program Files доступен только на чтение),
  // папка резервных копий — из config.json.
  const logPath = path.join(app.getPath('userData'), 'logs')
  const backupPath = cfg.backupDir || defaultPaths().backupDir
  // Запасная папка на случай вынутой флешки — рядом с данными программы.
  // Её создаём всегда, а вот backupPath — только если он вообще доступен:
  // mkdir по пути на отсутствующем диске (E:\Копии) просто упадёт, и это
  // не повод не запускать сервер (см. resolveBackupDir в utils/backup.js).
  const backupFallbackPath = path.join(app.getPath('userData'), 'backups-local')
  fs.mkdirSync(logPath, { recursive: true })
  fs.mkdirSync(backupFallbackPath, { recursive: true })
  try { fs.mkdirSync(backupPath, { recursive: true }) } catch (e) {
    hlog('backup dir unavailable:', backupPath, String(e && (e.message || e)))
  }

  const proc = spawn(process.execPath, [serverEntry], {
    cwd: resourcePath('server'),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DATABASE_URL: dbUrl,
      PORT: String(cfg.hostPort),
      HOST: '0.0.0.0',            // слушаем LAN — клиенты подключаются к хосту
      JWT_SECRET: cfg.jwtSecret,
      JWT_EXPIRES_IN: '8h',
      NODE_ENV: 'production',
      TZ: 'UTC',
      LOG_PATH: logPath,
      BACKUP_PATH: backupPath,
      BACKUP_FALLBACK_PATH: backupFallbackPath,
      // Ночная копия в 03:00 по местному времени хоста, а не по UTC
      BACKUP_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty',
      // Ноутбук ночью выключают: при старте догоняем пропущенную копию,
      // а в течение дня снимаем каждые 4 часа работы.
      BACKUP_MAX_AGE_HOURS: '20',
      BACKUP_EVERY_HOURS: '4',
      INTERNAL_TOKEN,
    },
  })
  proc.stdout?.on('data', (d) => hlog('[server]', String(d).trim()))
  proc.stderr?.on('data', (d) => hlog('[server-err]', String(d).trim()))
  proc.on('error', (e) => hlog('[server] SPAWN ERROR:', String(e && (e.stack || e.message))))
  proc.on('exit', (code, sig) => {
    hlog('[server] EXIT code=', code, 'sig=', sig)
    if (serverProc !== proc) return   // уже остановлен/заменён (stopHostProcesses)
    serverProc = null
    if (isQuitting || code === 0) return
    if (!serverRestarted) {
      serverRestarted = true
      hlog('[server] crashed, restarting in 1s')
      setTimeout(() => {
        if (isQuitting) return
        try {
          spawnServer(cfg)
          waitForHealth(cfg.hostPort, 30000).then(() => { serverRestarted = false }).catch(() => {})
        } catch (e) {
          hlog('[server] respawn fail:', String(e && (e.message || e)))
        }
      }, 1000)
      return
    }
    dialog.showErrorBox('Сервер остановился',
      `Сервер приложения дважды завершился с ошибкой (код ${code}). ` +
      `Проверьте настройки системы и порт ${cfg.hostPort}.\n\nПодробности: ${DEBUG_LOG}`)
    createSettingsWindow()
  })
  serverProc = proc
  hlog('server spawned, entry=', serverEntry, 'execPath=', process.execPath)
  return proc
}

// pg_ctl из того же дистрибутива Postgres, что запускает embedded-postgres.
// __dirname подходит и в dev (electron/), и в сборке (resources/app/).
function pgCtlPath() {
  const base = path.join(__dirname, 'node_modules', '@embedded-postgres')
  let dirs = []
  try { dirs = fs.readdirSync(base) } catch { return null }
  for (const d of dirs) {
    for (const name of ['pg_ctl.exe', 'pg_ctl']) {
      const p = path.join(base, d, 'native', 'bin', name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// Штатная остановка кластера. embedded-postgres на Windows «останавливает» базу
// командой `taskkill /f /t` — это убийство процесса, а не остановка: каждый
// следующий запуск начинался с «database system was not properly shut down;
// automatic recovery in progress», а в папке данных оставался postmaster.pid.
// Данные спасал журнал WAL, но делать аварийное завершение штатным сценарием
// выхода нельзя. Поэтому сначала просим Postgres завершиться его же pg_ctl
// (-m fast: закрыть клиентов, выполнить контрольную точку), и только если это
// не получилось — отдаём управление библиотеке с её taskkill.
function stopPostgresGracefully(dataDir) {
  const cli = pgCtlPath()
  if (!cli || !dataDir) { hlog('pg_ctl не найден — штатная остановка пропущена'); return Promise.resolve(false) }
  return new Promise((resolve) => {
    let done = false
    const finish = (ok, why) => { if (done) return; done = true; hlog('pg_ctl stop:', ok ? 'ok' : 'не удалось', why || ''); resolve(ok) }
    let proc
    try {
      proc = spawn(cli, ['stop', '-D', dataDir, '-m', 'fast', '-w', '-t', '30'], { windowsHide: true })
    } catch (e) { return finish(false, String(e && (e.message || e))) }
    let out = ''
    proc.stdout?.on('data', (d) => { out += String(d) })
    proc.stderr?.on('data', (d) => { out += String(d) })
    const timer = setTimeout(() => { try { proc.kill() } catch {}; finish(false, 'таймаут') }, 35000)
    proc.on('error', (e) => { clearTimeout(timer); finish(false, String(e && (e.message || e))) })
    proc.on('exit', (code) => { clearTimeout(timer); finish(code === 0, `код ${code} ${out.trim()}`) })
  })
}

/**
 * Копия «прямо сейчас» через внутренний роут сервера. Зовётся при выходе из
 * программы и кнопкой в настройках. Ошибку не бросает: копия — страховка,
 * а не условие выхода.
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function requestInternalBackup(timeoutMs = 20000) {
  if (!serverProc) return { ok: false, error: 'Сервер не запущен' }
  const port = readConfig().hostPort || DEFAULT_HOST_PORT
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
      body: '{}',
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      hlog('[backup] HTTP', res.status, text.slice(0, 300))
      return { ok: false, error: `HTTP ${res.status}` }
    }
    let data = {}
    try { data = JSON.parse(text) } catch { /* ответ не JSON — не беда */ }
    hlog('[backup] ok:', data.filename || text.slice(0, 200))
    return { ok: true, data }
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `копия не уложилась в ${Math.round(timeoutMs / 1000)} с`
      : String(err && (err.message || err))
    hlog('[backup] failed:', message)
    return { ok: false, error: message }
  } finally {
    clearTimeout(timer)
  }
}

// Корректно гасим сервер и базу (иначе можно повредить данные Postgres).
async function stopHostProcesses() {
  try { serverProc?.kill() } catch {}
  serverProc = null
  if (pgInstance) {
    const stopped = await stopPostgresGracefully(pgDataDir)
    if (stopped) {
      // Кластер уже остановлен. Если оставить ссылку на процесс, stop()
      // библиотеки будет ждать события 'exit' от УЖЕ завершившегося процесса
      // и не дождётся — выход приложения повиснет до таймаута exit-хука.
      try { pgInstance.process = undefined } catch {}
    }
    try { await pgInstance.stop() } catch (e) { hlog('pg stop fail:', String(e && (e.message || e))) }
  }
  pgInstance = null
  pgDataDir = null
}

function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`)
        if (res.ok) return resolve(true)
      } catch { /* ещё не поднялся */ }
      if (Date.now() > deadline) return reject(new Error('Сервер не запустился за отведённое время'))
      setTimeout(tick, 400)
    }
    tick()
  })
}

// ─── Окна ────────────────────────────────────────────────────────────────────
function createSplash(text) {
  splashWindow = new BrowserWindow({
    width: 420, height: 200, frame: false, resizable: false, center: true,
    backgroundColor: '#1f2430', show: true,
  })
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
      font-family:'Segoe UI',sans-serif;background:#1f2430;color:#fff;text-align:center">
      <div><div style="font-size:16px;font-weight:600">Система бронирования</div>
      <div style="margin-top:10px;font-size:13px;color:#9aa4b2">${text}</div></div>
    </body>`))
}
function closeSplash() { if (splashWindow) { splashWindow.close(); splashWindow = null } }

function createMainWindow(serverUrl) {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1024, minHeight: 640, show: false,
    title: 'Система бронирования',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      additionalArguments: [`--server-url=${serverUrl}`, `--app-version=${APP_VERSION}`],
    },
  })
  mainWindow.once('ready-to-show', () => { closeSplash(); mainWindow.show() })
  if (isDev) mainWindow.loadURL('http://localhost:5173')
  else mainWindow.loadFile(resourcePath('renderer', 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  attachShortcuts(mainWindow)
  mainWindow.on('closed', () => { mainWindow = null })
}

// Меню приложения убрано целиком, поэтому горячие клавиши вешаем вручную:
// F12 — инструменты разработчика, Ctrl+R / F5 — перезагрузка окна.
function attachShortcuts(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = String(input.key || '').toLowerCase()
    if (key === 'f12') { win.webContents.toggleDevTools(); event.preventDefault(); return }
    if (key === 'f5' || (input.control && !input.alt && !input.meta && key === 'r')) {
      if (input.shift) win.webContents.reloadIgnoringCache()
      else win.webContents.reload()
      event.preventDefault()
    }
  })
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    width: 560, height: 720, resizable: false, title: 'Настройка системы',
    parent: mainWindow || undefined, modal: !!mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
  attachShortcuts(settingsWindow)
  settingsWindow.on('closed', () => { settingsWindow = null })
}

// ─── Загрузка по режиму ──────────────────────────────────────────────────────
async function boot() {
  const cfg = readConfig()
  if (isDev && !cfg.mode) { createMainWindow(''); return }   // dev без настройки — относительные пути/прокси
  if (!cfg.mode) { createSettingsWindow(); return }

  if (cfg.mode === 'client') { createMainWindow(cfg.serverUrl || ''); return }

  // HOST
  hlog('boot: HOST mode')
  createSplash('Запуск базы данных и сервера…')
  try {
    ensureSecrets(cfg)
    writeConfig(cfg)   // секреты и пути должны быть одинаковыми от запуска к запуску
    const url = await startHost(cfg)
    createMainWindow(url)
  } catch (err) {
    hlog('boot HOST FAIL:', String(err && (err.stack || err.message || err)))
    closeSplash()
    dialog.showErrorBox('Не удалось запустить сервер', describeStartError(err))
    createSettingsWindow()
  }
}

// ─── Обновления (electron-updater, generic-провайдер) ────────────────────────
// Адрес сервера обновлений — cfg.updateUrl из config.json (задаёт сисадмин);
// placeholder в package.json → build.publish нужен только сборщику для latest.yml.
// Проверка тихая: через 30 с после старта и раз в сутки; скачивание — только по
// команде пользователя (autoDownload = false). Статусы летят в renderer событием
// 'update:status' { state, version?, percent?, error? }.
let autoUpdater = null
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000

function sendUpdateStatus(state, extra) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('update:status', { state, ...(extra || {}) })
}

function setupAutoUpdater(cfg) {
  if (autoUpdater || isDev || !cfg || !cfg.updateUrl) return
  let updater
  try { ({ autoUpdater: updater } = require('electron-updater')) } catch (e) {
    hlog('electron-updater unavailable:', String(e && (e.message || e)))
    return
  }
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.logger = {
    info: (m) => hlog('[upd]', String(m)), warn: (m) => hlog('[upd-warn]', String(m)),
    error: (m) => hlog('[upd-err]', String(m)), debug: () => {},
  }
  try {
    updater.setFeedURL({ provider: 'generic', url: cfg.updateUrl })
  } catch (e) {
    hlog('setFeedURL fail:', String(e && (e.message || e)))
    return
  }
  updater.on('checking-for-update', () => sendUpdateStatus('checking'))
  updater.on('update-available', (info) => sendUpdateStatus('available', { version: info && info.version }))
  updater.on('update-not-available', (info) => sendUpdateStatus('not-available', { version: info && info.version }))
  updater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round((p && p.percent) || 0) }))
  updater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info && info.version }))
  updater.on('error', (err) => sendUpdateStatus('error', { error: String(err && (err.message || err)) }))
  autoUpdater = updater

  const check = () => autoUpdater.checkForUpdates().catch((e) => hlog('update check fail:', String(e && (e.message || e))))
  setTimeout(check, 30000)
  setInterval(check, UPDATE_CHECK_INTERVAL)
  hlog('auto-updater configured; feed=', cfg.updateUrl)
}

const UPDATER_NOT_CONFIGURED = isDev
  ? 'Обновления недоступны в режиме разработки'
  : 'Сервер обновлений не настроен (окно «Настройка системы»)'

// IPC: проверить / скачать / установить. Ответ { ok, state?, version?, error? }.
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ok: false, state: 'unavailable', error: UPDATER_NOT_CONFIGURED }
  try {
    const r = await autoUpdater.checkForUpdates()
    const available = !!(r && r.isUpdateAvailable)
    return { ok: true, state: available ? 'available' : 'not-available', version: r && r.updateInfo && r.updateInfo.version }
  } catch (err) {
    return { ok: false, state: 'error', error: String(err && (err.message || err)) }
  }
})

ipcMain.handle('update:download', async () => {
  if (!autoUpdater) return { ok: false, error: UPDATER_NOT_CONFIGURED }
  try {
    await autoUpdater.downloadUpdate()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && (err.message || err)) }
  }
})

ipcMain.handle('update:install', async () => {
  if (!autoUpdater) return { ok: false, error: UPDATER_NOT_CONFIGURED }
  // Гасим сервер и базу штатно, иначе установщик упрётся в занятые файлы
  isQuitting = true
  await stopHostProcesses()
  autoUpdater.quitAndInstall(false, true)
  return { ok: true }
})

// ─── IPC (окно настроек системы) ─────────────────────────────────────────────
// Конфиг наружу — без секретов (dbPassword, jwtSecret) и без хеша сисадмина.
ipcMain.handle('config:get', () => {
  const cfg = readConfig()
  const { dbPassword, jwtSecret, sysadmin, ...safe } = cfg // eslint-disable-line no-unused-vars
  return {
    ...safe,
    hasSysadmin: hasSysadmin(cfg),
    firstRun: !cfg.mode,
    lanIps: lanIps(),
    defaults: defaultPaths(),
  }
})

// Выбор папки (данные базы / резервные копии). null — отмена.
ipcMain.handle('config:pickFolder', async (_e, title) => {
  const opts = {
    title: String(title || 'Выберите папку'),
    properties: ['openDirectory', 'createDirectory'],
  }
  const r = settingsWindow
    ? await dialog.showOpenDialog(settingsWindow, opts)
    : await dialog.showOpenDialog(opts)
  return !r.canceled && r.filePaths && r.filePaths[0] ? r.filePaths[0] : null
})

// Адрес хоста для клиента: без схемы → добавляем http://, хвостовые слэши убираем.
function normalizeServerUrl(raw) {
  let url = String(raw || '').trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url
  return url.replace(/\/+$/, '')
}

ipcMain.handle('config:test', async (_e, serverUrl) => {
  const url = normalizeServerUrl(serverUrl)
  if (!url) return { ok: false, error: 'Пустой адрес' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${url}/api/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return { ok: res.ok, status: res.status }
  } catch (err) { return { ok: false, error: err.message } }
})

// Сохранить настройки системы. Первый запуск — стартуем сразу; на работающей
// установке — перезапуск приложения, чтобы порт и папки применились чисто.
// Ответ: { ok: true, relaunch?: true } | { ok: false, error: string }.
ipcMain.handle('config:apply', async (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {}
  const cfg = ensureSecrets(readConfig())
  const firstRun = !cfg.mode
  const d = defaultPaths()

  if (p.mode !== 'host' && p.mode !== 'client') {
    return { ok: false, error: 'Выберите режим работы: хост или клиент' }
  }

  // Пароль сисадмина обязателен, пока не задан (первый запуск / старая установка);
  // дальше — только если решили сменить (заполнено хотя бы одно поле).
  const pwd = p.sysadminPassword == null ? '' : String(p.sysadminPassword)
  const pwd2 = p.sysadminPasswordConfirm == null ? '' : String(p.sysadminPasswordConfirm)
  if (firstRun || !hasSysadmin(cfg) || pwd || pwd2) {
    if (pwd.length < 8) return { ok: false, error: 'Пароль сисадмина: минимум 8 символов' }
    if (pwd !== pwd2) return { ok: false, error: 'Пароли сисадмина не совпадают' }
  }

  if (p.mode === 'host') {
    const port = p.hostPort === undefined || p.hostPort === null || p.hostPort === ''
      ? cfg.hostPort : Number(p.hostPort)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return { ok: false, error: 'Порт сервера: целое число от 1024 до 65535' }
    }
    const dataDir = String(p.dataDir || '').trim() || d.dataDir
    const backupDir = String(p.backupDir || '').trim() || d.backupDir
    if (!path.isAbsolute(dataDir)) return { ok: false, error: 'Папка данных базы: укажите полный путь' }
    if (!path.isAbsolute(backupDir)) return { ok: false, error: 'Папка резервных копий: укажите полный путь' }
    if (path.resolve(dataDir) === path.resolve(backupDir)) {
      return { ok: false, error: 'Папка данных и папка резервных копий должны быть разными' }
    }
    cfg.hostPort = port
    cfg.dataDir = path.resolve(dataDir)
    cfg.backupDir = path.resolve(backupDir)
  } else {
    const url = normalizeServerUrl(p.serverUrl)
    if (!url) return { ok: false, error: 'Укажите адрес хоста' }
    try { new URL(url) } catch { return { ok: false, error: 'Некорректный адрес хоста' } }
    cfg.serverUrl = url
  }

  // Сервер обновлений — необязательный; пустое поле выключает проверку обновлений.
  const updateUrl = String(p.updateUrl == null ? '' : p.updateUrl).trim()
  if (updateUrl) {
    let parsed
    try { parsed = new URL(updateUrl) } catch { parsed = null }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) {
      return { ok: false, error: 'Сервер обновлений: укажите адрес вида http(s)://…' }
    }
    cfg.updateUrl = updateUrl
  } else {
    delete cfg.updateUrl
  }

  cfg.mode = p.mode
  if (pwd) cfg.sysadmin = hashSysadminPassword(pwd)
  writeConfig(cfg)
  hlog('config:apply saved; mode=', cfg.mode, 'firstRun=', firstRun)

  // Настройки изменены на работающей установке → чистый перезапуск.
  if (!firstRun) {
    isQuitting = true
    await stopHostProcesses()
    app.relaunch()
    app.exit(0)
    return { ok: true, relaunch: true }
  }

  // Первый запуск: стартуем сразу, без перезапуска.
  if (settingsWindow) settingsWindow.close()
  if (mainWindow) mainWindow.close()
  setupAutoUpdater(cfg)

  if (cfg.mode === 'host') {
    createSplash('Запуск базы данных и сервера…')
    try {
      const url = serverProc ? `http://localhost:${cfg.hostPort}` : await startHost(cfg)
      createMainWindow(url)
    } catch (err) {
      hlog('apply HOST FAIL:', String(err && (err.stack || err.message || err)))
      closeSplash()
      dialog.showErrorBox('Не удалось запустить сервер', describeStartError(err))
      createSettingsWindow()
    }
  } else {
    createMainWindow(cfg.serverUrl)
  }
  return { ok: true }
})

// Вход сисадмина. Старая установка без пароля → пускаем и просим задать его (needsSetup).
ipcMain.handle('system:login', (_e, password) => {
  const cfg = readConfig()
  if (!hasSysadmin(cfg)) return { ok: true, needsSetup: true }
  return { ok: verifySysadminPassword(cfg, password) }
})

// «Сделать копию сейчас» из окна «Настройка системы»: сисадмин выбрал папку на
// флешке и тут же хочет убедиться, что копия туда пишется. Идёт тем же
// внутренним путём, что и копия при выходе, — JWT в этом окне нет.
// → { ok: true, fileName, path, fallbackUsed } | { ok: false, error }
ipcMain.handle('system:backupNow', async () => {
  const r = await requestInternalBackup(60000)
  if (!r.ok) return { ok: false, error: r.error || 'Не удалось создать копию' }
  const d = r.data || {}
  return { ok: true, fileName: d.filename || '', path: d.path || '', fallbackUsed: !!d.fallbackUsed }
})

// Выбор файла копии для переноса с другого компьютера (мастер первого запуска и
// раздел «Резервная копия»). В Electron `<input type=file>` даёт объект File без
// пути, а нам нужно и содержимое, и исходное имя — читаем файл здесь.
// → { path, name, content } | null (отмена или отказ по размеру)
ipcMain.handle('backup:pickFile', async () => {
  const opts = {
    title: 'Выберите файл резервной копии',
    filters: [{ name: 'Резервная копия (.json)', extensions: ['json'] }],
    properties: ['openFile'],
  }
  const parent = BrowserWindow.getFocusedWindow() || mainWindow
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts)
  const file = !r.canceled && r.filePaths ? r.filePaths[0] : null
  if (!file) return null
  try {
    const size = fs.statSync(file).size
    if (size > MAX_BACKUP_FILE_BYTES) {
      // Причину показываем сами: возвращаем null, чтобы контракт остался простым
      dialog.showErrorBox('Файл слишком большой',
        `Файл копии больше 200 МБ (${Math.round(size / 1048576)} МБ) — такой перенести нельзя.`)
      return null
    }
    return { path: file, name: path.basename(file), content: fs.readFileSync(file, 'utf8') }
  } catch (err) {
    dialog.showErrorBox('Не удалось прочитать файл', String(err && (err.message || err)))
    return null
  }
})

// Открыть окно настроек системы — только по паролю сисадмина (из приложения, preload.js).
ipcMain.handle('system:openSettings', (_e, password) => {
  const cfg = readConfig()
  if (hasSysadmin(cfg) && !verifySysadminPassword(cfg, password)) {
    return { ok: false, error: 'Неверный пароль сисадмина' }
  }
  createSettingsWindow()
  return { ok: true }
})

// ─── Отчёты ──────────────────────────────────────────────────────────────────

// PDF отчёта. Печатаем ТЕКУЩЕЕ окно через printToPDF: Chromium применяет те же
// @media print стили, что и обычная печать, поэтому лист и PDF совпадают.
// Серверный рендер PDF означал бы второй движок вёрстки и расхождение с печатью.
ipcMain.handle('report:savePdf', async (_e, options = {}) => {
  const win = mainWindow
  if (!win) return { ok: false, error: 'Окно приложения не найдено' }
  try {
    const pdf = await win.webContents.printToPDF({
      landscape: options.landscape !== false,
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
    })

    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Сохранить отчёт в PDF',
      defaultPath: path.join(app.getPath('documents'), options.fileName || 'report.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    fs.writeFileSync(filePath, pdf)
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Сохранение готового файла отчёта (xlsx/docx/csv приходят с сервера в base64).
// В упакованном приложении окно живёт на file://, где обычная загрузка по ссылке
// молча ничего не делает — поэтому файл пишем из main и показываем в папке.
ipcMain.handle('report:saveFile', async (_e, { fileName, base64 } = {}) => {
  const win = mainWindow
  if (!base64) return { ok: false, error: 'Пустой файл' }
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Сохранить отчёт',
      defaultPath: path.join(app.getPath('documents'), fileName || 'report'),
    })
    if (canceled || !filePath) return { ok: false, canceled: true }

    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'))
    shell.showItemInFolder(filePath)
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// ─── Меню ────────────────────────────────────────────────────────────────────
// Меню приложения убрано полностью: настройки системы открываются из приложения
// по паролю сисадмина (IPC system:openSettings), горячие клавиши — attachShortcuts().
function buildMenu() {
  Menu.setApplicationMenu(null)
}

// ─── Жизненный цикл ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  app.whenReady().then(() => { buildMenu(); boot(); setupAutoUpdater(readConfig()) })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })

  // Корректное завершение: сначала копия (последнее, что успеет попасть на
  // флешку), потом гасим сервер и базу, чтобы не повредить данные.
  app.on('before-quit', async (e) => {
    if (isQuitting) return
    if (!serverProc && !pgInstance) return
    e.preventDefault()
    isQuitting = true
    if (serverProc) {
      // Ноутбук закрывают, не выходя из программы, поэтому копия при выходе —
      // самый надёжный момент. Но выход она не блокирует: 20 секунд и хватит.
      try { createSplash('Сохраняю резервную копию…') } catch { /* окно не обязательно */ }
      await requestInternalBackup(20000)
      closeSplash()
    }
    await stopHostProcesses()
    app.quit()
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
