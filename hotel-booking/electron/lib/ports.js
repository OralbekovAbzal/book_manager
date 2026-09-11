/**
 * Порты: свободен ли, кто занял, как об этом сказать человеку.
 *
 * Зачем модуль. До сих пор порт встроенного Postgres (5433) был зашит
 * константой, а порт сервера брался из конфига без единой проверки. На чужом
 * ноутбуке это две разные беды с одинаково непонятным концом:
 *  - 5433 занят чем угодно (вторая копия программы, чужой PostgreSQL) →
 *    embedded-postgres реджектит без текста, и пользователь видел «undefined»;
 *  - порт сервера занят → сервер падал с EADDRINUSE, надзор перезапускал его
 *    ещё раз, и всё заканчивалось «Сервер остановился (код 1)» без намёка,
 *    КТО занял порт.
 * Здесь — обе проверки и человеческий текст: «Порт 4780 занят программой
 * node.exe (PID 1234)».
 *
 * Модуль намеренно НЕ требует `electron`: его зовёт main-процесс, но его же
 * читают юнит-тесты сервера обычным node (как lib/config.js и lib/disk.js).
 * Всё, что трогает систему (net, fs, execFile), внедряется параметрами.
 */
const path = require('path')

/**
 * Свободен ли порт: пробуем на него сесть сами. Единственная честная проверка —
 * netstat отвечает на вопрос «кто слушал секунду назад», а нам нужно «сможем ли
 * мы сесть сейчас».
 *
 * ПОЧЕМУ ХОСТ ВАЖЕН. Сервер слушает 0.0.0.0 (клиенты подключаются по сети), и
 * порт, свободный на 127.0.0.1, может быть занят другой программой на конкретном
 * сетевом адресе. Поэтому для серверного порта зовём с host: '0.0.0.0'.
 *
 * @returns {Promise<boolean>} исключений не бросает
 */
function isPortFree(port, { host = '127.0.0.1', net = require('net') } = {}) {
  return new Promise((resolve) => {
    let server
    try {
      server = net.createServer()
    } catch {
      return resolve(false)
    }
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    server.once('error', () => done(false))
    server.once('listening', () => {
      // close() асинхронен: отвечаем «свободен» только когда порт реально отпущен,
      // иначе следующий listen на него же получит EADDRINUSE от нас самих.
      server.close(() => done(true))
    })
    try {
      server.listen(port, host)
    } catch {
      done(false)
    }
  })
}

/**
 * Первый свободный порт начиная с `start`. Шаг — 1, потому что «5433 занят,
 * берём 5434» человеку понятнее случайного порта из эфемерного диапазона.
 *
 * @returns {Promise<number>}
 * @throws {Error} с русским текстом, если весь диапазон занят
 */
async function findFreePort({ start, tries = 20, host, net } = {}) {
  const first = Number(start)
  if (!Number.isInteger(first) || first < 1 || first > 65535) {
    throw new Error('Не задан начальный порт для поиска свободного')
  }
  const count = Number.isInteger(tries) && tries > 0 ? tries : 20
  for (let i = 0; i < count; i++) {
    const port = first + i
    if (port > 65535) break
    if (await isPortFree(port, { host, net })) return port
  }
  throw new Error(
    `Не нашлось свободного порта в диапазоне ${first}–${first + count - 1}. ` +
    'Закройте лишние программы или укажите другой порт в «Настройке системы».',
  )
}

/**
 * `postmaster.pid` в папке кластера: строка 1 — PID, строка 4 — порт.
 * Формат фиксирован в самом PostgreSQL (src/include/utils/pidfile.h) и не
 * менялся с 9.x. Файл остаётся и после аварийного завершения — поэтому один
 * только факт его существования ничего не доказывает, PID надо проверять.
 *
 * @returns {{ pid: number, port: number }|null} нет файла / битый → null
 */
function readPostmasterPid(dataDir, { fs = require('fs') } = {}) {
  if (!dataDir || typeof dataDir !== 'string') return null
  let raw
  try {
    raw = fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8')
  } catch {
    return null
  }
  const lines = String(raw).split(/\r?\n/)
  const pid = Number.parseInt(String(lines[0] || '').trim(), 10)
  const port = Number.parseInt(String(lines[3] || '').trim(), 10)
  if (!Number.isInteger(pid) || pid <= 0) return null
  return { pid, port: Number.isInteger(port) && port > 0 ? port : null }
}

/**
 * Жив ли процесс. Сигнал 0 ничего не посылает — только проверяет право послать.
 * EPERM означает «процесс есть, но чужой» — это ЖИВ (частый случай: кластер
 * поднят из-под другой учётной записи).
 */
function isProcessAlive(pid, { kill = process.kill.bind(process) } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return !!(err && err.code === 'EPERM')
  }
}

/**
 * PID слушателя порта из вывода `netstat -ano`.
 *
 * Разбор ТОЛЬКО ПО ПОЗИЦИИ. Слово состояния сравнивать нельзя: в русской
 * Windows это «ПРОСЛУШИВАНИЕ», в английской «LISTENING», а вывод приходит в
 * кодировке консоли (866/1251) и в UTF-8 уже мусор. Позиции же одинаковы:
 * второй столбец — локальный адрес, последнее поле строки — PID. У UDP-строк
 * состояния нет вовсе — тоже разбираются.
 *
 * @returns {number|null}
 */
function parseNetstat(text, port) {
  const needle = ':' + String(port)
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const local = parts[1]                       // 0.0.0.0:4780, [::]:4780, 127.0.0.1:4780
    if (!local || !local.endsWith(needle)) continue
    const pid = Number.parseInt(parts[parts.length - 1], 10)
    if (!Number.isInteger(pid) || pid <= 0) continue
    return pid
  }
  return null
}

/**
 * Имя процесса из `tasklist /FI "PID eq N" /FO CSV /NH`.
 *
 * Строка «не найдено» приходит на языке системы («INFO: No tasks…» /
 * «ИНФОРМАЦИЯ: не запущено задач…»), поэтому опознаём её не по тексту, а по
 * форме: CSV всегда начинается с кавычки.
 *
 * @returns {string|null}
 */
function parseTasklistCsv(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    if (!s.startsWith('"')) return null      // «не найдено» или заголовок ошибки
    const m = /^"([^"]*)"/.exec(s)
    const name = m ? m[1].trim() : ''
    return name || null
  }
  return null
}

function execText(execFile, file, args, timeoutMs) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = execFile(
        file, args,
        { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => resolve(err && !stdout ? null : String(stdout || '')),
      )
    } catch {
      return resolve(null)
    }
    // execFile может и не вызвать колбэк, если процесса нет вовсе
    if (proc && typeof proc.on === 'function') proc.on('error', () => resolve(null))
  })
}

/**
 * Кто занял порт: PID и имя программы. Ответ идёт человеку в диалог, поэтому
 * любая беда (нет netstat, нет прав, не Windows) — это просто `null`, а не
 * ошибка: сообщение «порт занят» полезно и без имени.
 *
 * Кодировку консоли не переключаем (`chcp` не зовём): разбор идёт по позиции,
 * а имена процессов в подавляющем большинстве латиницей.
 *
 * @returns {Promise<{ pid: number, name: string|null }|null>}
 */
async function describePortOwner(port, { execFile = require('child_process').execFile } = {}) {
  try {
    const netstat = await execText(execFile, 'netstat', ['-ano'], 5000)
    if (!netstat) return null
    const pid = parseNetstat(netstat, port)
    if (!pid) return null
    const tasks = await execText(execFile, 'tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], 5000)
    return { pid, name: tasks ? parseTasklistCsv(tasks) : null }
  } catch {
    return null
  }
}

/** Текст для диалога «Порт занят». */
function describePortBusy(port, owner) {
  const who = owner && owner.name
    ? `программой ${owner.name} (PID ${owner.pid})`
    : owner && owner.pid
      ? `другой программой (PID ${owner.pid})`
      : 'другой программой'
  return `Порт ${port} занят ${who}. ` +
    'Закройте её или укажите другой порт сервера в «Настройке системы».'
}

module.exports = {
  isPortFree,
  findFreePort,
  readPostmasterPid,
  isProcessAlive,
  parseNetstat,
  parseTasklistCsv,
  describePortOwner,
  describePortBusy,
}
