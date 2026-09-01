const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')

// ─── Пути к ресурсам (dev vs упакованное) ────────────────────────────────────
const isDev = !app.isPackaged
function resourcePath(...p) {
  return isDev
    ? path.join(__dirname, '..', ...p)        // dev: рядом с electron/
    : path.join(process.resourcesPath, ...p)  // prod: resources/
}
const DB_PORT = 5433
const DEFAULT_HOST_PORT = 3001

// ─── Конфиг (userData, переживает переустановку) ─────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json')
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { return {} }
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
}
function ensureSecrets(cfg) {
  if (!cfg.dbPassword) cfg.dbPassword = crypto.randomBytes(18).toString('hex')
  if (!cfg.jwtSecret)  cfg.jwtSecret  = crypto.randomBytes(48).toString('base64')
  if (!cfg.hostPort)   cfg.hostPort   = DEFAULT_HOST_PORT
  return cfg
}

// ─── Диагностический лог (host-режим) ────────────────────────────────────────
const DEBUG_LOG = path.join(app.getPath('userData'), 'host-debug.log')
function hlog(...a) {
  const line = `[${new Date().toISOString()}] ` +
    a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'
  try { fs.appendFileSync(DEBUG_LOG, line) } catch {}
}

// ─── Состояние процессов хоста ───────────────────────────────────────────────
let pgInstance = null
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

  const dataDir = path.join(app.getPath('userData'), 'pgdata')
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'))
  hlog('dataDir=', dataDir, 'fresh=', fresh)

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
    if (fresh) { hlog('initialise (initdb)...'); await pgInstance.initialise(); hlog('initialise OK') }
    hlog('start postgres...'); await pgInstance.start(); hlog('postgres started')

    if (fresh) {
      hlog('createDatabase...'); await pgInstance.createDatabase('hotel_booking')
      const client = pgInstance.getPgClient('hotel_booking')
      await client.connect()
      hlog('apply init.sql from', resourcePath('db', 'init.sql'))
      await client.query(fs.readFileSync(resourcePath('db', 'init.sql'), 'utf8'))
      hlog('apply seed.sql'); await client.query(fs.readFileSync(resourcePath('db', 'seed.sql'), 'utf8'))
      await client.end()
      hlog('schema+seed applied')
    }
  } catch (e) {
    hlog('POSTGRES SETUP FAIL:', e && (e.stack || e.message || String(e)))
    throw e
  }

  const dbUrl = `postgresql://postgres:${cfg.dbPassword}@127.0.0.1:${DB_PORT}/hotel_booking`
  const serverEntry = resourcePath('server', 'server.js')

  // Логи и бэкапы — в userData (resources/ в Program Files доступен только на чтение).
  const logPath = path.join(app.getPath('userData'), 'logs')
  const backupPath = path.join(app.getPath('userData'), 'backups')
  fs.mkdirSync(logPath, { recursive: true })
  fs.mkdirSync(backupPath, { recursive: true })

  serverProc = spawn(process.execPath, [serverEntry], {
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
    },
  })
  serverProc.stdout?.on('data', (d) => hlog('[server]', String(d).trim()))
  serverProc.stderr?.on('data', (d) => hlog('[server-err]', String(d).trim()))
  serverProc.on('exit', (code, sig) => hlog('[server] EXIT code=', code, 'sig=', sig))
  serverProc.on('error', (e) => hlog('[server] SPAWN ERROR:', String(e && (e.stack || e.message))))
  hlog('server spawned, entry=', serverEntry, 'execPath=', process.execPath)

  await waitForHealth(cfg.hostPort, 30000)
  hlog('health OK on port', cfg.hostPort)
  return `http://localhost:${cfg.hostPort}`
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
      additionalArguments: [`--server-url=${serverUrl}`],
    },
  })
  mainWindow.once('ready-to-show', () => { closeSplash(); mainWindow.show() })
  if (isDev) mainWindow.loadURL('http://localhost:5173')
  else mainWindow.loadFile(resourcePath('renderer', 'index.html'))
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  mainWindow.on('closed', () => { mainWindow = null })
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    width: 560, height: 520, resizable: false, title: 'Настройка подключения',
    parent: mainWindow || undefined, modal: !!mainWindow,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  })
  settingsWindow.setMenuBarVisibility(false)
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'))
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
    const url = await startHost(ensureSecrets(cfg))
    createMainWindow(url)
  } catch (err) {
    hlog('boot HOST FAIL:', String(err && (err.stack || err.message || err)))
    closeSplash()
    dialog.showErrorBox('Не удалось запустить сервер', String(err && err.message || err))
    createSettingsWindow()
  }
}

// ─── IPC (окно настроек) ─────────────────────────────────────────────────────
ipcMain.handle('config:get', () => readConfig())

ipcMain.handle('config:test', async (_e, serverUrl) => {
  const url = String(serverUrl || '').trim().replace(/\/+$/, '')
  if (!url) return { ok: false, error: 'Пустой адрес' }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch(`${url}/api/health`, { signal: ctrl.signal })
    clearTimeout(t)
    return { ok: res.ok, status: res.status }
  } catch (err) { return { ok: false, error: err.message } }
})

// Применить выбранный режим и (пере)загрузить приложение.
ipcMain.handle('config:apply', async (_e, payload) => {
  const cfg = ensureSecrets(readConfig())
  cfg.mode = payload.mode
  if (payload.mode === 'client') {
    cfg.serverUrl = String(payload.serverUrl || '').trim().replace(/\/+$/, '')
  }
  writeConfig(cfg)

  if (settingsWindow) settingsWindow.close()
  if (mainWindow) { mainWindow.close() }

  if (cfg.mode === 'host') {
    createSplash('Запуск базы данных и сервера…')
    try {
      const url = serverProc ? `http://localhost:${cfg.hostPort}` : await startHost(cfg)
      createMainWindow(url)
    } catch (err) {
      closeSplash()
      dialog.showErrorBox('Не удалось запустить сервер', String(err && err.message || err))
    }
  } else {
    createMainWindow(cfg.serverUrl)
  }
  return { ok: true }
})

ipcMain.on('open-settings', () => createSettingsWindow())

// ─── Меню ────────────────────────────────────────────────────────────────────
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Файл', submenu: [
      { label: 'Настройка подключения…', click: () => createSettingsWindow() },
      { type: 'separator' }, { role: 'quit', label: 'Выход' },
    ] },
    { label: 'Вид', submenu: [
      { role: 'reload', label: 'Обновить' },
      { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      { type: 'separator' },
      { role: 'resetZoom', label: 'Масштаб 100%' },
      { role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' },
      { role: 'togglefullscreen', label: 'Полный экран' },
    ] },
  ]))
}

// ─── Жизненный цикл ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus() }
  })

  app.whenReady().then(() => { buildMenu(); boot() })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })

  // Корректное завершение: гасим сервер и базу, чтобы не повредить данные.
  app.on('before-quit', async (e) => {
    if (isQuitting) return
    if (!serverProc && !pgInstance) return
    e.preventDefault()
    isQuitting = true
    try { serverProc?.kill() } catch {}
    try { if (pgInstance) await pgInstance.stop() } catch {}
    app.quit()
  })

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}
