const { app, BrowserWindow, ipcMain, Menu, shell, dialog, powerMonitor } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')
const { spawn } = require('child_process')

// Отдельные модули без зависимости от `electron` — их же читают юнит-тесты
// сервера (`server/test/electron-*.test.js`). Не забыть про `lib/**` в
// package.json → build.files, иначе упаковка соберётся, а старт упадёт на require.
const {
  readJsonFile, writeConfigIfChanged,
  readSecretSidecar, writeSecretSidecar, secretSidecarPath, reconcileSecret,
} = require('./lib/config')
const {
  listMigrationFolders, pendingMigrations, failedMigrations,
  copyDataDirBeforeUpdate, describeMigrationFailure,
} = require('./lib/migrations')
const { freeBytes, toMb, MB } = require('./lib/disk')
const { stripAnsi, rotateLogFile } = require('./lib/logs')
const {
  isPortFree, findFreePort, readPostmasterPid, isProcessAlive,
  describePortOwner, describePortBusy,
} = require('./lib/ports')
const { findHosts, makeNonce } = require('./lib/discovery')

// ─── Пути к ресурсам (dev vs упакованное) ────────────────────────────────────
const isDev = !app.isPackaged
// В dev — отдельный userData: иначе dev и установленная версия делят config.json
// и pgdata. Обязательно ДО первого app.getPath('userData') (CONFIG_PATH ниже).
if (isDev) app.setPath('userData', app.getPath('userData') + '-dev')
// Изолированная проверка собранной программы: своя папка данных, не трогающая
// рабочую установку. Именно переменной приложения, а не APPDATA: Electron на
// Windows берёт userData из системного пути профиля и подменённый APPDATA
// игнорирует — проверено 08.09.2026.
if (process.env.HOTEL_BOOKING_USERDATA) {
  app.setPath('userData', process.env.HOTEL_BOOKING_USERDATA)
}

function resourcePath(...p) {
  if (!isDev) return path.join(process.resourcesPath, ...p)   // prod: resources/
  // dev: init.sql/seed.sql лежат в electron/db, сервер — в hotel-booking/server
  const [head, ...rest] = p
  if (head === 'db') return path.join(__dirname, 'db', ...rest)
  return path.join(__dirname, '..', head, ...rest)
}
const DB_NAME = 'hotel_booking'
// Порт встроенной базы. 5433 — предпочтение, а не закон: у клиента на ноутбуке
// может стоять свой PostgreSQL или остаться висеть кластер прошлой копии
// программы. Свободный порт выбирается при старте (resolveDbPort) и остаётся в
// config.json, чтобы следующий запуск пришёл туда же.
const DEFAULT_DB_PORT = 5433
let dbPort = DEFAULT_DB_PORT
// Порт сервера. 3001 в dev — там же работает `npm run dev:server` и прокси Vite;
// в упакованной программе 4780: 3001 слишком популярен (его занимают Node-проекты
// и всякий софт разработчика), а порт хоста должен быть свободен на чужом
// ноутбуке без разговоров. isDev объявлен выше — порядок важен.
const DEFAULT_HOST_PORT = isDev ? 3001 : 4780
// UDP-ответчик хоста: по нему рабочие места находят хост после смены IP.
// Включается серверу переменной DISCOVERY_PORT (см. spawnServer).
const DISCOVERY_PORT = 4781

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
//
// В config.json лежат пароль встроенной базы и секрет JWT. Про пароль базы
// важны две вещи (D8-004):
//  1) файл пишется АТОМАРНО и только при изменении — раньше он перезаписывался
//     на каждом старте хоста, и обрыв питания в этот момент делал данные
//     недоступными: битый файл читается как {}, а дальше выпускался бы новый
//     пароль, которого кластер в pgdata не знает;
//  2) у пароля есть ВТОРАЯ копия — `hotel-booking-secret.json` в самой папке
//     данных (lib/config.js). Она главнее конфига: спутник лежит рядом с
//     кластером и описывает именно его. Поэтому «почистили AppData» или
//     «удалили config.json по телефонной подсказке» больше не означает потерю
//     доступа к броням.
// Папка данных — от `name` в electron/package.json (`hotel-booking-desktop`), а НЕ
// от productName. Поэтому при переименовании продукта Qonaq → Roomline PMS
// (09.09.2026) сменили только видимые человеку строки: `name` и `appId`
// (`com.hotelbooking.desktop`) остались прежними. Тронешь их — установленная копия
// перестанет находить свой config.json, pgdata и лицензию, то есть у клиента
// «пропадут все брони». Имя базы `hotel_booking` техническое по той же причине.
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
function readConfig() {
  return readJsonFile(CONFIG_PATH)
}
// Пишем атомарно и только при реальном изменении (D8-004): в config.json лежит
// пароль встроенной базы, а файл перезаписывался при КАЖДОМ старте хоста —
// каждый запуск был окном, в котором отключение питания оставляло обрезанный
// файл. Битый файл читается как {}, и следующий старт выпускал бы новый пароль,
// которого существующий кластер не знает.
function writeConfig(cfg) {
  return writeConfigIfChanged(CONFIG_PATH, cfg)
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
  // ПОРЯДОК ВАЖЕН: сначала папка данных, потом пароль. Пароль базы теперь ищется
  // и рядом с самим кластером (спутник hotel-booking-secret.json), а где кластер —
  // знает только dataDir. Раньше пароль существовал единственной копией в
  // config.json: потеря файла означала потерю доступа к целым данным (D8-004).
  if (!cfg.hostPort)   cfg.hostPort   = d.hostPort
  if (!cfg.dataDir)    cfg.dataDir    = d.dataDir
  if (!cfg.backupDir)  cfg.backupDir  = d.backupDir

  const dataDir = cfg.dataDir || d.dataDir
  const { source, changed } = reconcileSecret(cfg, {
    hasPgVersion: fs.existsSync(path.join(dataDir, 'PG_VERSION')),
    sidecar: readSecretSidecar(dataDir),
    generate: () => crypto.randomBytes(18).toString('hex'),
  })
  // В лог — только ОТКУДА взят пароль. Сам пароль в host-debug.log не пишем:
  // лог отдают в поддержку.
  hlog('пароль базы:', source, changed ? '(конфиг обновлён)' : '(без изменений)')

  if (!cfg.jwtSecret)  cfg.jwtSecret  = crypto.randomBytes(48).toString('base64')
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
// Ротация ДО первой записи: файл открывается на дозапись каждым hlog, и
// переименовать его проще всего сейчас, пока в нём ничего от этого запуска нет
// (D8-008 — лог рос без предела, за 2,5 месяца редкого использования 1,2 МБ).
rotateLogFile(DEBUG_LOG, 5 * 1024 * 1024)
function hlog(...a) {
  const line = `[${new Date().toISOString()}] ` +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'
  try { fs.appendFileSync(DEBUG_LOG, line) } catch {}
}

// Текст ошибки запуска для диалога. embedded-postgres иногда реджектит без объекта
// ошибки — String(err.message || err) показывал пользователю «undefined».
function describeStartError(err) {
  // Ошибка с собственным заголовком (обновление базы) уже несёт готовый текст
  // для пользователя — путь к логу в нём тоже есть, второй раз не приписываем.
  if (err && err.title && err.message) return err.message
  const msg = err && (typeof err === 'string' ? err : err.message)
  if (msg) return `${msg}\n\nПодробности: ${DEBUG_LOG}`
  // Догадки про занятый порт здесь больше нет: занятый порт базы ловится до
  // старта (resolveDbPort), и своя ошибка у него отдельная и точная.
  return `База данных не запустилась. Подробности: ${DEBUG_LOG}`
}

// ─── Состояние процессов хоста ───────────────────────────────────────────────
let pgInstance = null
let pgDataDir = null   // папка кластера — нужна для штатной остановки через pg_ctl
let serverProc = null
let mainWindow = null
let settingsWindow = null
let splashWindow = null
let isQuitting = false
// Путь копии папки данных, снятой перед обновлением схемы, — его показываем в
// диалоге, если миграция всё-таки не прошла.
let preUpdateCopyPath = null
// Идёт перезапуск упавшего Postgres: второй watcher в это время не нужен.
let pgRestarting = false

/**
 * Порт для встроенной базы: запомненный, иначе первый свободный от 5433.
 *
 * Порт был зашит константой, и любой чужой PostgreSQL на 5433 (а он там бывает
 * у всех, кто когда-то ставил PostgreSQL руками) превращал запуск в «база не
 * запустилась» без объяснений. Выбранный порт кладём в config.json: следующий
 * запуск должен прийти к ТОМУ ЖЕ кластеру, а не поднять рядом второй.
 *
 * Выбор делается один раз за запуск: restartPostgres переиспользует тот же
 * экземпляр EmbeddedPostgres и порт не пересматривает.
 *
 * @throws {Error} с `title`, если база этой же папки уже кем-то запущена
 */
async function resolveDbPort(cfg, dataDir) {
  // postmaster.pid остаётся и после аварийного завершения, поэтому одного файла
  // мало. Проверяем И живой PID, И занятость записанного порта: PID в Windows
  // переиспользуются после перезагрузки, и «живой» номер из старого файла легко
  // принадлежит постороннему процессу — отказать в запуске из-за этого нельзя.
  const running = readPostmasterPid(dataDir, { fs })
  if (running && isProcessAlive(running.pid)) {
    const port = running.port || DEFAULT_DB_PORT
    const busy = !(await isPortFree(port))
    if (busy) {
      hlog('база уже запущена: pid=', running.pid, 'port=', port)
      const err = new Error(
        `База данных уже работает в другой копии программы (процесс ${running.pid}). ` +
        'Закройте её и запустите программу снова.')
      err.title = 'База уже запущена'
      throw err
    }
    hlog('postmaster.pid от прошлого запуска: pid=', running.pid, 'жив, но порт', port, 'свободен — файл устарел')
  }

  const wanted = Number.isInteger(cfg.dbPort) && cfg.dbPort >= 1024 && cfg.dbPort <= 65535
    ? cfg.dbPort
    : DEFAULT_DB_PORT
  dbPort = (await isPortFree(wanted)) ? wanted : await findFreePort({ start: wanted })
  if (cfg.dbPort !== dbPort) {
    cfg.dbPort = dbPort
    writeConfig(cfg)
  }
  hlog('порт базы:', dbPort, wanted === dbPort ? '(как в конфиге)' : `(${wanted} занят — взят свободный)`)
  return dbPort
}

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
  preUpdateCopyPath = null   // прошлый запуск хоста в этом же процессе (config:apply)
  hlog('dataDir=', dataDir, 'fresh=', fresh, 'schemaReady=', fs.existsSync(markerPath))

  // Порт базы выбираем ДО создания экземпляра: databaseUrl и сам EmbeddedPostgres
  // берут уже решённый dbPort.
  await resolveDbPort(cfg, dataDir)

  pgInstance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: cfg.dbPassword,
    port: dbPort,
    persistent: true,
    // UTF8 обязательно — иначе кириллица в именах гостей ломается.
    //
    // ЛОКАЛЬ (D8-001). Раньше здесь был `--locale=C`: под ней PostgreSQL
    // сворачивает регистр только у ASCII, и в упакованной программе поиск
    // «асель» не находил «Асель Каримову» — ровно та боль стойки, ради которой
    // поиск и делался. У разработчика база в Russian_Kazakhstan.1251, поэтому
    // дефект был не виден. Берём ВСТРОЕННЫЙ провайдер `C.UTF-8` (PostgreSQL 17+,
    // у нас 18.4): он знает регистр всего Юникода, не зависит от версии ICU на
    // машине клиента и не требует установленных системных локалей. `--locale=C`
    // остаётся для lc_* (сообщения, деньги, время) — по ним ничего не ищут, а
    // embedded-postgres разбирает вывод initdb на английском.
    // Существующие кластеры (у первого клиента — с 05.09) чинит отдельная
    // миграция коллации, initdb на них уже не выполняется.
    initdbFlags: [
      '--encoding=UTF8',
      '--locale-provider=builtin',
      '--builtin-locale=C.UTF-8',
      '--locale=C',
    ],
    onLog: (m) => hlog('[pg]', String(m)),
    onError: (e) => hlog('[pg-err]', String(e && (e.message || e))),
  })

  try {
    if (fresh) {
      // initdb требует пустую папку — устаревшая отметка без PG_VERSION ему помешает
      try { fs.unlinkSync(markerPath) } catch {}
      // Спутник с паролем — тоже от прошлого кластера: оставленный, он бы
      // пережил initdb и врал про пароль новой базы.
      try { fs.unlinkSync(secretSidecarPath(dataDir)) } catch {}
      hlog('initialise (initdb)...'); await pgInstance.initialise(); hlog('initialise OK')
      // Кластер создан ЭТИМ паролем — сохраняем его рядом с кластером сразу,
      // не дожидаясь удачного старта: иначе первое же падение между initdb и
      // записью оставило бы данные без известного пароля.
      try { writeSecretSidecar(dataDir, cfg.dbPassword); hlog('спутник с паролем записан') }
      catch (e) { hlog('спутник записать не удалось:', String(e && (e.message || e))) }
    }

    // Копия папки данных ПЕРЕД миграциями (D8-005) — до старта Postgres, пока
    // файлы кластера точно никто не пишет. Снимаем только если есть что
    // применять: на обычном запуске без обновления копировать гигабайты незачем.
    if (!fresh) {
      const marker = readJsonFile(markerPath)
      const pending = pendingMigrations(
        listMigrationFolders(resourcePath('server', 'prisma', 'migrations')),
        marker.migrations,
      )
      if (pending.length) {
        hlog('обновление базы, новых миграций', pending.length, ':', pending.join(', '))
        const copy = copyDataDirBeforeUpdate(dataDir, { freeBytes, log: hlog })
        if (copy.ok) {
          preUpdateCopyPath = copy.path
          hlog('копия до обновления:', copy.path)
        } else if (copy.reason === 'space') {
          // Продолжаем без копии осознанно: на PostgreSQL упавшая миграция
          // откатывается целиком (проверено 08.09.2026), а JSON-копия при
          // прошлом выходе из программы уже снята. Освобождать место, отказывая
          // в запуске, было бы хуже.
          hlog('копия до обновления пропущена: мало места, продолжаем')
        } else {
          hlog('копия до обновления не удалась:', copy.reason)
        }
      }
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
      // Сюда мы дошли, значит к базе успешно подключились этим паролем
      // (inspectSchemaState внутри applyMigrations). Только теперь спутник можно
      // писать: подтверждённый пароль, а не тот, что лежал в конфиге.
      if (!fresh) {
        const known = readSecretSidecar(dataDir)
        if (!known || known.dbPassword !== cfg.dbPassword) {
          try { writeSecretSidecar(dataDir, cfg.dbPassword); hlog('спутник с паролем обновлён') }
          catch (e) { hlog('спутник записать не удалось:', String(e && (e.message || e))) }
        }
      }
    } catch (e) {
      // Базу, созданную в ЭТОМ запуске, удаляем — иначе пустая база без таблиц
      // при следующем старте считалась бы готовой.
      if (needSchema) {
        hlog('SCHEMA APPLY FAIL, dropping database:', String(e && (e.message || e)))
        console.error('[host] SCHEMA APPLY FAIL:', String(e && (e.message || e)))
        try { await pgInstance.dropDatabase(DB_NAME) } catch (de) { hlog('dropDatabase fail:', String(de && (de.message || de))) }
      }
      throw e
    }
    // Маркер пишем ВСЕГДА после удачного deploy, а не только на свежей базе:
    // в нём теперь список применённых миграций, по которому следующий запуск
    // решает, нужна ли копия папки данных перед обновлением.
    try {
      fs.writeFileSync(markerPath, JSON.stringify({
        appliedAt: new Date().toISOString(),
        schema: 'prisma-migrate',
        migrations: listMigrationFolders(resourcePath('server', 'prisma', 'migrations')),
      }, null, 2), 'utf8')
      hlog('schema marker written:', markerPath)
    } catch (e) {
      // Маркер — оптимизация, а не условие работы: без него следующий запуск
      // просто снимет копию лишний раз.
      hlog('schema marker write fail:', String(e && (e.message || e)))
    }
  } catch (e) {
    hlog('POSTGRES SETUP FAIL:', e && (e.stack || e.message || String(e)))
    console.error('[host] POSTGRES SETUP FAIL:', e && (e.stack || e.message || String(e)))
    throw e
  }

  // Порт сервера проверяем ЗДЕСЬ, а не по факту падения: сервер на занятом порту
  // умирает с EADDRINUSE, надзор перезапускает его ещё раз, и человек получает
  // «Сервер остановился (код 1)» вместо «порт 4780 занят программой такой-то».
  // Слушать будем 0.0.0.0 — и проверяем ровно его: порт бывает свободен на
  // 127.0.0.1 и занят на сетевом адресе.
  if (!(await isPortFree(cfg.hostPort, { host: '0.0.0.0' }))) {
    const owner = await describePortOwner(cfg.hostPort)
    hlog('порт сервера занят:', cfg.hostPort, JSON.stringify(owner))
    const err = new Error(describePortBusy(cfg.hostPort, owner))
    err.title = 'Порт занят'
    throw err
  }

  spawnServer(cfg)
  await waitForHealth(cfg.hostPort, 30000)
  hlog('health OK on port', cfg.hostPort)
  // Надзор за процессом базы ставим только после подтверждённого старта:
  // раньше за postgres.exe не следил никто (D8-002).
  armPgWatch()
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
  return `postgresql://postgres:${cfg.dbPassword}@127.0.0.1:${dbPort}/${DB_NAME}`
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
    proc.stdout?.on('data', (d) => hlog('[prisma]', stripAnsi(String(d)).trim()))
    proc.stderr?.on('data', (d) => hlog('[prisma-err]', stripAnsi(String(d)).trim()))
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

  // Незакрытые миграции — те, из-за которых deploy отвечает P3009 «failed
  // migrations… new migrations will not be applied» и программа не поднимается
  // больше НИКОГДА, включая откат на прежний установщик (D8-005).
  //
  // Лечим сами, потому что это безопасно: на PostgreSQL упавшая миграция
  // откатывается целиком (проверено на клоне 08.09.2026 — схема остаётся
  // прежней, мешает только строка в журнале). Значит `resolve --rolled-back`
  // не оставляет полусхему, а честно возвращает базу в состояние «эту миграцию
  // ещё не применяли», после чего deploy пробует её заново.
  let stuck = managed ? await loadFailedMigrations() : []
  if (stuck.length) {
    try {
      for (const m of stuck) {
        hlog('незакрытая миграция:', m.name, '— помечаю откаченной')
        await runPrisma(['migrate', 'resolve', '--rolled-back', m.name], dbUrl)
      }
    } catch (e) {
      // resolve не смог — обычно потому, что этой миграции нет в папке сборки:
      // человек откатился на СТАРЫЙ установщик, а база помнит миграцию из новой.
      hlog('resolve --rolled-back FAIL:', String(e && (e.message || e)))
      throw migrationFailureError(stuck)
    }
  }

  hlog('prisma migrate deploy...')
  try {
    await runPrisma(['migrate', 'deploy'], dbUrl)
  } catch (first) {
    hlog('migrate deploy FAIL:', String(first && (first.message || first)))
    stuck = managed ? await loadFailedMigrations() : []
    // Deploy упал, но незакрытых миграций нет — дело не в P3009 (нет CLI, нет
    // связи с базой): отдаём исходную ошибку как есть.
    if (!stuck.length) throw first

    // Повтор ровно один. Миграция, падающая дважды подряд, не пройдёт и на
    // третий раз — данные клиента ей не подходят, и это уже разговор с
    // разработчиком, а не бесконечный цикл при каждом запуске.
    try {
      for (const m of stuck) {
        hlog('после падения помечаю откаченной:', m.name)
        await runPrisma(['migrate', 'resolve', '--rolled-back', m.name], dbUrl)
      }
      await runPrisma(['migrate', 'deploy'], dbUrl)
      hlog('migrations applied (со второй попытки)')
      return
    } catch (second) {
      hlog('повторный deploy FAIL:', String(second && (second.message || second)))
      throw migrationFailureError(stuck)
    }
  }
  hlog('migrations applied')
}

// Ошибка для диалога: своим заголовком отличается от «Не удалось запустить
// сервер» — обновление базы это отдельная беда со своими действиями.
function migrationFailureError(stuck) {
  const bad = (stuck && stuck[0]) || {}
  const err = new Error(describeMigrationFailure({
    name: bad.name,
    logs: bad.logs,
    copyPath: preUpdateCopyPath,
    logPath: DEBUG_LOG,
  }))
  err.title = 'Обновление базы не удалось'
  return err
}

// Строки `_prisma_migrations`, которые начались и не закончились.
// Отдельным запросом, а не разбором вывода Prisma: текст сообщений CLI меняется
// от версии к версии, а таблица — нет.
async function loadFailedMigrations() {
  const client = pgInstance.getPgClient(DB_NAME)
  try {
    await client.connect()
    const r = await client.query(
      `SELECT migration_name, finished_at, rolled_back_at, logs
         FROM _prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL`,
    )
    return failedMigrations(r.rows)
  } catch (e) {
    hlog('не прочитал _prisma_migrations:', String(e && (e.message || e)))
    return []
  } finally {
    try { await client.end() } catch {}
  }
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

  const env = {
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
    // Папка кластера — серверу нужна только чтобы мерить свободное место на
    // том томе, где лежит база (GET /api/system/status → disk).
    PG_DATA_DIR: cfg.dataDir || defaultPaths().dataDir,
    // Ночная копия в 03:00 по местному времени хоста, а не по UTC
    BACKUP_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty',
    // Та же зона — для календарных дней отчётов («дата создания», «дата приёма»):
    // сервер живёт в UTC, и без неё ночные операции уезжали бы на вчера.
    HOTEL_TZ: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty',
    // Ноутбук ночью выключают: при старте догоняем пропущенную копию,
    // а в течение дня снимаем каждые 4 часа работы.
    BACKUP_MAX_AGE_HOURS: '20',
    BACKUP_EVERY_HOURS: '4',
    INTERNAL_TOKEN,
  }
  // UDP-ответчик «я здесь» для рабочих мест. `cfg.discovery: false` — аварийный
  // выключатель на случай, если в чьей-то сети широковещание окажется вредным;
  // в окне настроек его нет намеренно: лишний тумблер, который нечем объяснить.
  if (cfg.discovery !== false) env.DISCOVERY_PORT = String(DISCOVERY_PORT)

  const proc = spawn(process.execPath, [serverEntry], {
    cwd: resourcePath('server'),
    env,
  })
  // Коды цвета из winston здесь — мусор: консоль сервера это файл, а не терминал.
  proc.stdout?.on('data', (d) => hlog('[server]', stripAnsi(String(d)).trim()))
  // Метку [server-err] сохраняем: стек uncaughtException приходит именно сюда,
  // и по ней в логе находят падение сервера.
  proc.stderr?.on('data', (d) => hlog('[server-err]', stripAnsi(String(d)).trim()))
  proc.on('error', (e) => hlog('[server] SPAWN ERROR:', String(e && (e.stack || e.message))))
  proc.on('exit', async (code, sig) => {
    hlog('[server] EXIT code=', code, 'sig=', sig)
    if (serverProc !== proc) return   // уже остановлен/заменён (stopHostProcesses)
    serverProc = null
    if (isQuitting || code === 0) return
    // Код 3 — «порт занят» (сервер отвечает им на EADDRINUSE). Перезапуск такое
    // не лечит: порт будет занят и через секунду, и через минуту. Поэтому не
    // перезапускаем, а называем виновника и открываем настройки.
    if (code === 3) {
      const owner = await describePortOwner(cfg.hostPort)
      hlog('[server] порт занят:', cfg.hostPort, JSON.stringify(owner))
      dialog.showErrorBox('Порт занят', describePortBusy(cfg.hostPort, owner))
      createSettingsWindow()
      return
    }
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

// ─── Надзор за встроенным Postgres (D8-002) ──────────────────────────────────
// За процессом postgres.exe после старта не следил никто: библиотека слушает
// 'close' только внутри своего start(). Упавшая база (PANIC при нехватке места,
// антивирус, ручное убийство) оставалась незамеченной — сервер отвечал 503 на
// каждое действие, а health говорил «всё хорошо». Хуже того, при закрытии
// программы stop() вешал обработчик 'exit' на УЖЕ мёртвый процесс и не
// дожидался его никогда: окно исчезало, процесс висел, и следующий запуск тихо
// гасился блокировкой единственного экземпляра.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function armPgWatch() {
  const proc = pgInstance && pgInstance.process
  if (!proc) { hlog('[pg] надзор не поставлен: процесса нет'); return }
  proc.once('exit', (code, sig) => {
    // Ссылку обнуляем ВСЕГДА, даже при штатном выходе: тогда и stop() библиотеки,
    // и её exit-хук становятся no-op, и выход из программы не виснет.
    if (pgInstance && pgInstance.process === proc) pgInstance.process = undefined
    hlog('[pg] процесс базы завершился, code=', code, 'sig=', String(sig))
    if (isQuitting || pgRestarting) return
    console.error('[host] postgres завершился неожиданно, code=', code)
    restartPostgres()
  })
}

// Поднять базу заново. Prisma в серверном процессе переподключится сама —
// перезапускать сервер не нужно.
async function restartPostgres() {
  if (!pgInstance || pgRestarting) return
  pgRestarting = true
  hlog('[pg] база остановилась — пробую поднять заново')

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Пауза перед попыткой: если база упала из-за нехватки места или конфликта
    // за файлы кластера, немедленный повтор упрётся в то же самое.
    await delay(3000)
    // За время паузы программу могли начать закрывать (тогда база уже не нужна)
    if (isQuitting || !pgInstance) { pgRestarting = false; return }
    let timer = null
    try {
      await Promise.race([
        pgInstance.start(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('старт базы не уложился в 60 с')), 60000)
        }),
      ])
      hlog('[pg] база поднята с попытки', attempt)
      armPgWatch()
      pgRestarting = false
      return
    } catch (e) {
      // start() реджектит без объекта ошибки, если процесс закрылся сразу
      hlog('[pg] попытка', attempt, 'не удалась:',
        String((e && (e.message || e)) || 'процесс базы завершился при старте'))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  pgRestarting = false
  dialog.showErrorBox('База данных остановилась',
    'Встроенная база данных завершилась и не смогла перезапуститься. ' +
    'Закройте программу и откройте снова. Подробности: ' + DEBUG_LOG)
  createSettingsWindow()
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
    // pg_ctl зовём только при живом процессе: у остановившейся базы он ответит
    // «сервер не запущен», и мы зря подождём его 35 секунд при выходе.
    let stopped = false
    if (pgInstance.process) stopped = await stopPostgresGracefully(pgDataDir)
    else hlog('база уже не работает — pg_ctl stop пропущен')
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

// ─── Сторож адреса хоста (режим «Клиент») ────────────────────────────────────
//
// Беда, которую он лечит. Адрес хоста рабочее место получает один раз, руками
// сисадмина. Сменили роутер, переехали на другой Wi-Fi, DHCP выдал ноутбуку-хосту
// другой IP — и на всех рабочих местах «нет связи с сервером», хотя хост стоит
// в двух метрах и работает. Раньше это чинил только звонок тому, кто умеет
// смотреть ipconfig.
//
// Как лечим. Раз в 15 с стучимся в /api/health. Два отказа подряд — спрашиваем
// сеть, где наш хост (UDP-широковещание, lib/discovery.js), и переезжаем на
// найденный адрес.
//
// ПОЧЕМУ ЭТО БЕЗОПАСНО. Переезд происходит только на хост с ТОЙ ЖЕ личностью:
// у хоста есть Ed25519-пара в базе, публичный ключ рабочее место запоминает при
// первом удачном подключении (TOFU — адрес тогда ввёл сисадмин, ему и верим), и
// дальше принимается только ответ, подписанный этим ключом, плюс подтверждающий
// HTTP-запрос с одноразовым nonce. Без этого любой в сети отеля (включая
// гостевой Wi-Fi) мог бы ответить «хост теперь я» и собирать пароли сотрудников.
const HOST_PROBE_INTERVAL = 15000   // как часто проверяем связь с хостом
const HOST_SEARCH_INTERVAL = 10000  // как часто спрашиваем сеть, пока хост потерян
const HOST_PROBE_TIMEOUT = 4000
const HOST_FAILS_BEFORE_SEARCH = 2
let hostWatchTimer = null
let hostSearchTimer = null
let hostWatchFails = 0
let hostWatchBusy = false
let hostSearchBusy = false

/**
 * Один запрос к /api/health хоста.
 * @returns {Promise<{reached:boolean, ok:boolean, db:string|null, instance:object|null, status:number|null}>}
 *   reached — ответ получен (пусть и 503): значит хост по этому адресу ЕСТЬ и
 *   искать его по сети не нужно.
 */
async function probeHost(url, { nonce = null } = {}) {
  const base = normalizeServerUrl(url)
  if (!base) return { reached: false, ok: false, db: null, instance: null, status: null }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HOST_PROBE_TIMEOUT)
  try {
    const suffix = nonce ? `?nonce=${encodeURIComponent(nonce)}` : ''
    const res = await fetch(`${base}/api/health${suffix}`, { signal: ctrl.signal })
    let body = {}
    try { body = await res.json() } catch { /* не JSON — считаем, что полей нет */ }
    const inst = body && typeof body.instance === 'object' ? body.instance : null
    return {
      reached: true,
      ok: res.ok,
      db: body && typeof body.db === 'string' ? body.db : null,
      instance: inst,
      status: res.status,
    }
  } catch {
    return { reached: false, ok: false, db: null, instance: null, status: null }
  } finally {
    clearTimeout(timer)
  }
}

/** Личность хоста из ответа health, если она полная. */
function instanceIdentity(instance) {
  if (!instance || typeof instance !== 'object') return null
  const id = typeof instance.id === 'string' ? instance.id : ''
  const publicKey = typeof instance.publicKey === 'string' ? instance.publicKey : ''
  if (!id || !publicKey) return null
  return { id, publicKey }
}

/**
 * Подпись из health: Ed25519 над `${id}|${nonce}`. Это второй рубеж после
 * подписанного UDP-ответа: подтверждает, что по новому адресу отвечает ИМЕННО
 * наш хост, а не тот, кто переслал чужой ответ.
 */
function verifyHealthSignature(instance, { nonce, publicKey, id }) {
  if (!instance || !instance.sig || !nonce || !publicKey || !id) return false
  if (instance.id !== id) return false
  try {
    return crypto.verify(null, Buffer.from(`${id}|${nonce}`, 'utf8'),
      publicKey, Buffer.from(String(instance.sig), 'base64url'))
  } catch {
    return false
  }
}

function startHostWatch(cfg) {
  if (!cfg || cfg.mode !== 'client' || hostWatchTimer) return
  hostWatchFails = 0
  hostWatchTimer = setInterval(() => { hostWatchTick() }, HOST_PROBE_INTERVAL)
  // Ноутбук закрыли и унесли в другую сеть — просыпаться там надо сразу, а не
  // через 15 секунд «нет связи».
  try { powerMonitor.on('resume', hostWatchTick) } catch { /* нет powerMonitor — не беда */ }
  hlog('[watch] сторож адреса хоста запущен:', cfg.serverUrl)
}

function stopHostWatch() {
  if (hostWatchTimer) { clearInterval(hostWatchTimer); hostWatchTimer = null }
  stopHostSearch()
  hostWatchFails = 0
  try { powerMonitor.removeListener('resume', hostWatchTick) } catch { /* уже снят */ }
}

function stopHostSearch() {
  if (hostSearchTimer) { clearInterval(hostSearchTimer); hostSearchTimer = null }
}

function startHostSearch() {
  if (hostSearchTimer) return
  hlog('[watch] хост не отвечает — ищу его в сети')
  hostSearchTimer = setInterval(() => { searchForHost() }, HOST_SEARCH_INTERVAL)
  searchForHost()
}

async function hostWatchTick() {
  if (isQuitting || hostWatchBusy) return
  hostWatchBusy = true
  try {
    const cfg = readConfig()
    if (cfg.mode !== 'client' || !cfg.serverUrl) return
    const nonce = makeNonce()
    const r = await probeHost(cfg.serverUrl, { nonce })
    if (r.reached) {
      hostWatchFails = 0
      stopHostSearch()
      // TOFU: личность запоминаем при первом удачном подключении по адресу,
      // который ввёл сисадмин. Перезаписывать её здесь нельзя — иначе подмена
      // хоста на известном адресе тихо переучила бы рабочее место.
      const identity = instanceIdentity(r.instance)
      if (r.ok && r.db === 'ok' && identity && !cfg.hostInstance) {
        cfg.hostInstance = identity
        writeConfig(cfg)
        hlog('[watch] личность хоста запомнена:', identity.id)
      }
      return
    }
    hostWatchFails++
    if (hostWatchFails >= HOST_FAILS_BEFORE_SEARCH && cfg.hostInstance) startHostSearch()
  } catch (e) {
    hlog('[watch] тик не удался:', String(e && (e.message || e)))
  } finally {
    hostWatchBusy = false
  }
}

async function searchForHost() {
  if (isQuitting || hostSearchBusy) return
  hostSearchBusy = true
  try {
    const cfg = readConfig()
    const known = cfg.hostInstance
    if (cfg.mode !== 'client' || !known || !known.id || !known.publicKey) return
    const hosts = await findHosts({
      port: DISCOVERY_PORT, t: 'find', id: known.id, publicKey: known.publicKey,
    })
    const current = normalizeServerUrl(cfg.serverUrl)
    for (const h of hosts) {
      if (!h.url || h.url === current) continue
      // Подтверждающий запрос: UDP-ответ подписан, но подтвердить живой сервер
      // на новом адресе может только сам сервер.
      const nonce = makeNonce()
      const r = await probeHost(h.url, { nonce })
      if (!r.reached || !r.instance) continue
      if (!verifyHealthSignature(r.instance, { nonce, publicKey: known.publicKey, id: known.id })) {
        hlog('[watch] ответ с', h.url, 'не прошёл проверку подписи — пропускаю')
        continue
      }
      moveToHost(h.url, cfg)
      return
    }
  } catch (e) {
    hlog('[watch] поиск хоста не удался:', String(e && (e.message || e)))
  } finally {
    hostSearchBusy = false
  }
}

/**
 * Переезд на новый адрес хоста. Перезапускаем программу целиком, а не
 * пересоздаём окно: между закрытием старого окна и созданием нового срабатывает
 * window-all-closed → app.quit(), и программа просто исчезла бы с экрана.
 */
function moveToHost(url, cfg) {
  stopHostWatch()
  cfg.serverUrl = url
  writeConfig(cfg)
  hlog('host moved:', url)
  try {
    createSplash(`Хост найден по новому адресу ${escapeHtml(url)} — перезапускаю программу. ` +
      'Возможно, потребуется войти заново.')
  } catch { /* окно не обязательно */ }
  setTimeout(() => {
    isQuitting = true
    app.relaunch()
    app.exit(0)
  }, 2000)
}

// ─── Окна ────────────────────────────────────────────────────────────────────
// Текст сплэша подставляется в HTML — адрес приходит из сети, пусть и
// проверенный подписью. Экранируем.
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

function createSplash(text) {
  splashWindow = new BrowserWindow({
    width: 420, height: 200, frame: false, resizable: false, center: true,
    backgroundColor: '#1f2430', show: true,
  })
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`
    <body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
      font-family:'Segoe UI',sans-serif;background:#1f2430;color:#fff;text-align:center">
      <div><div style="font-size:16px;font-weight:600">Roomline PMS</div>
      <div style="margin-top:10px;font-size:13px;color:#9aa4b2">${text}</div></div>
    </body>`))
}
function closeSplash() { if (splashWindow) { splashWindow.close(); splashWindow = null } }

function createMainWindow(serverUrl) {
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1024, minHeight: 640, show: false,
    title: 'Roomline PMS',
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

  if (cfg.mode === 'client') {
    createMainWindow(cfg.serverUrl || '')
    startHostWatch(cfg)   // хост мог переехать, пока рабочее место было выключено
    return
  }

  // HOST
  hlog('boot: HOST mode')
  createSplash('Запуск базы данных и сервера…')
  try {
    ensureSecrets(cfg)
    writeConfig(cfg)   // секреты и пути должны быть одинаковыми от запуска к запуску
    const url = await startHost(cfg)
    createMainWindow(url)
    // Предупреждение о месте — ПОСЛЕ окна и не за сплэшем: иначе модальный
    // диалог висит поверх заставки, и пользователь думает, что программа
    // зависла на запуске. Запуску оно не мешает — просто предупреждение.
    warnLowDisk(cfg)
  } catch (err) {
    hlog('boot HOST FAIL:', String(err && (err.stack || err.message || err)))
    console.error('[host] boot HOST FAIL:', String(err && (err.stack || err.message || err)))
    closeSplash()
    dialog.showErrorBox(err && err.title ? err.title : 'Не удалось запустить сервер', describeStartError(err))
    createSettingsWindow()
  }
}

// Мало места на диске (D8-006). Полный диск роняет Postgres по PANIC, оставляет
// копию недописанной и превращает ошибку записи лога в падение сервера —
// а до сих пор об этом никто не предупреждал. Показываем один раз при запуске:
// постоянный контроль — дело статуса системы в самом приложении.
const LOW_DISK_BYTES = 500 * MB
function warnLowDisk(cfg) {
  try {
    const dataDir = cfg.dataDir || defaultPaths().dataDir
    const free = freeBytes(dataDir)
    if (free === null) { hlog('свободное место измерить не удалось:', dataDir); return }
    hlog('свободно на диске данных:', toMb(free), 'МБ')
    if (free >= LOW_DISK_BYTES) return
    // Не await: предупреждение не должно задерживать запуск программы
    dialog.showMessageBox({
      type: 'warning',
      title: 'Мало места на диске',
      message: `На диске с данными программы осталось ${toMb(free)} МБ.\n\n` +
        'При заполнении диска база данных остановится, а резервные копии перестанут ' +
        'записываться. Освободите место или перенесите резервные копии на флешку ' +
        '(«Настройка системы» → папка резервных копий).',
    }).catch((e) => hlog('диалог о месте не показан:', String(e && (e.message || e))))
  } catch (e) {
    hlog('проверка места не удалась:', String(e && (e.message || e)))
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
  const { dbPassword, jwtSecret, sysadmin, hostInstance, ...safe } = cfg // eslint-disable-line no-unused-vars
  return {
    ...safe,
    hasSysadmin: hasSysadmin(cfg),
    firstRun: !cfg.mode,
    lanIps: lanIps(),
    defaults: defaultPaths(),
    // Только факт: публичный ключ хоста наружу не отдаём — окну настроек он не
    // нужен, а лишняя копия ключа в renderer'е ничего не улучшает.
    hasHostInstance: !!(cfg.hostInstance && cfg.hostInstance.id),
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
    let body = {}
    try { body = await res.json() } catch { /* не JSON — просто нет полей */ }
    const identity = instanceIdentity(body && body.instance)
    const cfg = readConfig()
    // `known` — это «тот же хост, с которым рабочее место уже работало». Старый
    // сервер и лежащая база личность не отдают: это «неизвестно», а НЕ «чужой».
    const known = !!(identity && cfg.hostInstance && cfg.hostInstance.id === identity.id)
    return { ok: res.ok, status: res.status, instance: identity, known }
  } catch (err) { return { ok: false, error: err.message } }
})

// «Найти в сети»: широковещательный опрос без привязки к сохранённому хосту.
// Названия отеля в ответе на `who` нет намеренно — его слышит вся сеть.
ipcMain.handle('config:discover', async () => {
  try {
    const cfg = readConfig()
    const knownId = cfg.hostInstance && cfg.hostInstance.id
    const hosts = await findHosts({ port: DISCOVERY_PORT, t: 'who', timeoutMs: 2500 })
    hlog('[discover] найдено хостов:', hosts.length)
    return hosts.map((h) => ({
      computer: h.computer || '',
      url: h.url,
      known: !!knownId && knownId === h.id,
    }))
  } catch (e) {
    hlog('[discover] не удалось:', String(e && (e.message || e)))
    return []
  }
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
    // Сисадмин указал ДРУГОЙ адрес — значит и хост, возможно, другой. Забываем
    // прежнюю личность: иначе сторож нашёл бы старый хост в сети и вернул бы
    // рабочее место туда, откуда его только что увели.
    if (cfg.serverUrl !== url) delete cfg.hostInstance
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

  // Привязка к личности хоста — по возможности прямо сейчас. Это же и
  // перепривязка: хост переустановили, у него новая пара ключей, и без этого
  // шага сторож искал бы в сети машину, которой больше нет. Недоступный хост
  // сохранение НЕ блокирует: сисадмин мог настроить рабочее место заранее.
  if (cfg.mode === 'client') {
    const r = await probeHost(cfg.serverUrl)
    const identity = instanceIdentity(r.instance)
    if (r.ok && r.db === 'ok' && identity) {
      cfg.hostInstance = identity
      writeConfig(cfg)
      hlog('config:apply: личность хоста сохранена:', identity.id)
    } else {
      hlog('config:apply: личность хоста не получена (reached=', r.reached, 'db=', String(r.db), ')')
    }
  }

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
      warnLowDisk(cfg)
    } catch (err) {
      hlog('apply HOST FAIL:', String(err && (err.stack || err.message || err)))
      console.error('[host] apply HOST FAIL:', String(err && (err.stack || err.message || err)))
      closeSplash()
      dialog.showErrorBox(err && err.title ? err.title : 'Не удалось запустить сервер', describeStartError(err))
      createSettingsWindow()
    }
  } else {
    createMainWindow(cfg.serverUrl)
    startHostWatch(cfg)
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
      // Поля — в ДЮЙМАХ и только top/bottom/left/right (PrintToPDFMargins).
      // Ключ marginType сюда попал от webContents.print(): у printToPDF с
      // Electron 21 набор опций повторяет Chrome DevTools Protocol и такого
      // поля не знает — лишний ключ молча игнорировался.
      margins: { top: 0.5, bottom: 0.5, left: 0.4, right: 0.4 },
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
    // Сторож адреса хоста больше не нужен — и не должен успеть перезапустить
    // программу, которую сейчас закрывают.
    stopHostWatch()
    // Хост уже остановлен (или его и не было) — выходим без задержки.
    if (!serverProc && !pgInstance) return
    // Хост ещё жив — выход только после штатной остановки. ПОРЯДОК ВАЖЕН:
    // раньше первой стояла проверка isQuitting, и второй quit проходил насквозь.
    // А второй quit приходит всегда: закрытие сплэша «Сохраняю копию…» ниже —
    // это последнее окно, window-all-closed зовёт app.quit() ещё раз, и
    // программа завершалась, не дождавшись pg_ctl stop: Postgres погибал вместе
    // с процессом, в папке оставался postmaster.pid, следующий старт шёл через
    // восстановление. Найдено на упакованной сборке 08.09.2026.
    e.preventDefault()
    if (isQuitting) return
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
