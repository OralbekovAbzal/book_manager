import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Порты — `electron/lib/ports.js`.
 *
 * Две беды с одинаково непонятным для человека концом. Занят порт встроенного
 * Postgres (5433) — программа не стартует, и раньше в диалоге было «undefined».
 * Занят порт сервера — сервер падал с EADDRINUSE, надзор перезапускал его
 * снова, и всё кончалось «Сервер остановился (код 1)» без намёка, кто виноват.
 *
 * Отсюда три вещи, которые здесь проверяются всерьёз:
 *  • «свободен ли порт» — вопрос к системе, а не к netstat: отвечать должна
 *    попытка сесть на порт;
 *  • разбор вывода Windows идёт ТОЛЬКО по позиции — слово состояния в русской
 *    системе «ПРОСЛУШИВАНИЕ», в английской «LISTENING», а кодировка консоли
 *    (866) в UTF-8 всё равно мусор;
 *  • `postmaster.pid` остаётся и после аварии, поэтому PID из него надо
 *    проверять, а не верить факту существования файла.
 *
 * Модуль не требует `electron` — грузится обычным require, как lib/disk.js.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/ports.js')

function loadPorts() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

const {
  isPortFree, findFreePort, readPostmasterPid, isProcessAlive,
  parseNetstat, parseTasklistCsv, describePortOwner, describePortBusy,
} = loadPorts()

const servers = []
const dirs = []

/** Занимает порт по-настоящему: только так проверка «свободен» имеет смысл. */
function occupy(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    servers.push(srv)
    srv.once('error', reject)
    srv.listen(port, host, () => resolve(srv.address().port))
  })
}

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hb-ports-${name}-`))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (servers.length) servers.pop().close()
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true })
})

// ─── Свободен ли порт ────────────────────────────────────────────────────────

describe('isPortFree и findFreePort', () => {
  it('занятый порт честно считается занятым, свободный — свободным', async () => {
    const busy = await occupy()

    expect(await isPortFree(busy, { host: '127.0.0.1' })).toBe(false)
    servers.pop().close()
    await new Promise((r) => setTimeout(r, 20))
    expect(await isPortFree(busy, { host: '127.0.0.1' })).toBe(true)
  })

  it('после проверки порт остаётся свободным — сами его не держим', async () => {
    // close() асинхронен: ответь мы «свободен» раньше времени, следующий listen
    // получил бы EADDRINUSE от нас же.
    const free = await occupy()
    servers.pop().close()
    await new Promise((r) => setTimeout(r, 20))

    expect(await isPortFree(free, { host: '127.0.0.1' })).toBe(true)
    await expect(occupy(free)).resolves.toBe(free)
  })

  it('занятый порт перескакивается на следующий', async () => {
    const busy = await occupy()

    const got = await findFreePort({ start: busy, tries: 20, host: '127.0.0.1' })

    expect(got).toBeGreaterThan(busy)
    expect(await isPortFree(got, { host: '127.0.0.1' })).toBe(true)
  })

  it('шаг именно +1 — человеку понятнее «5433 занят, взяли 5434»', async () => {
    const busy = await occupy()
    // Следующий порт может быть занят чужой программой — проверяем только при свободном
    if (await isPortFree(busy + 1, { host: '127.0.0.1' })) {
      expect(await findFreePort({ start: busy, host: '127.0.0.1' })).toBe(busy + 1)
    }
  })

  it('весь диапазон занят — русская ошибка с номерами, а не «undefined»', async () => {
    const busy = await occupy()

    await expect(findFreePort({ start: busy, tries: 1, host: '127.0.0.1' }))
      .rejects.toThrow(new RegExp(`Не нашлось свободного порта в диапазоне ${busy}`))
  })

  it('ошибка подсказывает, что делать, а не только что случилось', async () => {
    const busy = await occupy()

    await expect(findFreePort({ start: busy, tries: 1, host: '127.0.0.1' }))
      .rejects.toThrow(/Настройке системы/)
  })

  it.each([undefined, 0, -1, 70000, 'ерунда', null])('начальный порт %s — понятный отказ', async (start) => {
    await expect(findFreePort({ start, host: '127.0.0.1' })).rejects.toThrow(/Не задан начальный порт/)
  })

  it('у самого края диапазона поиск не уходит за 65535', async () => {
    await expect(findFreePort({ start: 65535, tries: 5, host: '127.0.0.1' })).resolves.toBe(65535)
  })
})

// ─── netstat ─────────────────────────────────────────────────────────────────

describe('parseNetstat — вывод Windows на любом языке', () => {
  const RU = [
    'Активные подключения',
    '',
    '  Имя    Локальный адрес        Внешний адрес          Состояние       PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              ПРОСЛУШИВАНИЕ   1044',
    '  TCP    0.0.0.0:4780           0.0.0.0:0              ПРОСЛУШИВАНИЕ   9876',
    '  TCP    [::]:4780              [::]:0                 ПРОСЛУШИВАНИЕ   9876',
  ].join('\r\n')

  const EN = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:4780           0.0.0.0:0              LISTENING       9876',
  ].join('\r\n')

  it('русская консоль: PID берётся по позиции, а не по слову «ПРОСЛУШИВАНИЕ»', () => {
    expect(parseNetstat(RU, 4780)).toBe(9876)
  })

  it('английская консоль даёт тот же ответ', () => {
    expect(parseNetstat(EN, 4780)).toBe(9876)
  })

  it('IPv6-строка [::]:4780 тоже разбирается', () => {
    const only6 = '  TCP    [::]:4780              [::]:0                 ПРОСЛУШИВАНИЕ   4242'
    expect(parseNetstat(only6, 4780)).toBe(4242)
  })

  it('порт 14780 не выдаётся за 4780 — иначе диалог обвинил бы чужую программу', () => {
    const other = '  TCP    0.0.0.0:14780          0.0.0.0:0              ПРОСЛУШИВАНИЕ   777'

    expect(parseNetstat(other, 4780)).toBeNull()
    expect(parseNetstat(other, 14780)).toBe(777)
  })

  it('чужой порт в столбце «внешний адрес» не считается нашим', () => {
    // Исходящее соединение НА порт 4780 — это клиент, а не тот, кто занял порт.
    const outgoing = '  TCP    192.168.1.5:51234      192.168.1.7:4780       ESTABLISHED     333'

    expect(parseNetstat(outgoing, 4780)).toBeNull()
  })

  it('UDP-строка без состояния разбирается — у неё столбцов меньше', () => {
    const udp = '  UDP    0.0.0.0:4781           *:*                                    5555'

    expect(parseNetstat(udp, 4781)).toBe(5555)
  })

  it('строка без PID пропускается, а не даёт NaN', () => {
    const broken = '  TCP    0.0.0.0:4780           0.0.0.0:0              ПРОСЛУШИВАНИЕ'

    expect(parseNetstat(broken, 4780)).toBeNull()
  })

  it('PID 0 (системный псевдопроцесс) за владельца не выдаётся', () => {
    const zero = '  TCP    0.0.0.0:4780           0.0.0.0:0              TIME_WAIT       0'

    expect(parseNetstat(zero, 4780)).toBeNull()
  })

  it('пустой вывод и мусор — null', () => {
    expect(parseNetstat('', 4780)).toBeNull()
    expect(parseNetstat(null, 4780)).toBeNull()
    expect(parseNetstat('netstat: команда не найдена', 4780)).toBeNull()
  })
})

// ─── tasklist ────────────────────────────────────────────────────────────────

describe('parseTasklistCsv — имя программы', () => {
  it('обычная строка CSV даёт имя процесса', () => {
    expect(parseTasklistCsv('"node.exe","9876","Console","1","54 321 КБ"')).toBe('node.exe')
  })

  it('имя с пробелом не обрезается', () => {
    expect(parseTasklistCsv('"Roomline PMS.exe","9876","Console","1","54 321 КБ"')).toBe('Roomline PMS.exe')
  })

  it('«задач не найдено» на любом языке распознаётся по форме, а не по тексту', () => {
    expect(parseTasklistCsv('INFO: No tasks are running which match the specified criteria.')).toBeNull()
    expect(parseTasklistCsv('ИНФОРМАЦИЯ: не запущено ни одной задачи, отвечающей заданным критериям.')).toBeNull()
  })

  it('пустой вывод — null, а не пустая строка в диалоге', () => {
    expect(parseTasklistCsv('')).toBeNull()
    expect(parseTasklistCsv('\r\n\r\n')).toBeNull()
    expect(parseTasklistCsv(null)).toBeNull()
  })

  it('пустое имя в кавычках не превращается в «программа »', () => {
    expect(parseTasklistCsv('"","9876","Console","1","0 КБ"')).toBeNull()
  })
})

// ─── postmaster.pid ──────────────────────────────────────────────────────────

describe('readPostmasterPid — файл живого кластера', () => {
  /** Настоящий формат PostgreSQL: 8 строк, PID в первой, порт в четвёртой. */
  function writePid(dir, lines) {
    fs.writeFileSync(path.join(dir, 'postmaster.pid'), lines.join('\n'), 'utf8')
    return dir
  }

  it('читает PID и порт из настоящего файла', () => {
    const dir = writePid(tempDir('live'), [
      '12345',
      'C:\\Users\\admin\\AppData\\Roaming\\hotel-booking-desktop\\pgdata',
      '1757650000',
      '5433',
      'C:/Users/admin/AppData/Roaming/hotel-booking-desktop/pgdata',
      'localhost',
      '  5433001   1441792',
      'ready',
      '',
    ])

    expect(readPostmasterPid(dir)).toEqual({ pid: 12345, port: 5433 })
  })

  it('файл с CRLF (его писала Windows) читается так же', () => {
    const dir = tempDir('crlf')
    fs.writeFileSync(path.join(dir, 'postmaster.pid'), '777\r\nC:\\pgdata\r\n1757650000\r\n5432\r\n', 'utf8')

    expect(readPostmasterPid(dir)).toEqual({ pid: 777, port: 5432 })
  })

  it('файла нет — null, а не исключение при старте', () => {
    expect(readPostmasterPid(tempDir('empty'))).toBeNull()
  })

  it('битый файл (обрыв записи) — null', () => {
    expect(readPostmasterPid(writePid(tempDir('broken'), ['', 'мусор']))).toBeNull()
    expect(readPostmasterPid(writePid(tempDir('broken2'), ['не число', 'C:\\pgdata']))).toBeNull()
    expect(readPostmasterPid(writePid(tempDir('broken3'), ['-1', 'C:\\pgdata']))).toBeNull()
  })

  it('PID есть, порта нет — PID всё равно отдаём: по нему проверяют, жив ли кластер', () => {
    expect(readPostmasterPid(writePid(tempDir('noport'), ['4242', 'C:\\pgdata'])))
      .toEqual({ pid: 4242, port: null })
  })

  it('путь не задан — null', () => {
    expect(readPostmasterPid(null)).toBeNull()
    expect(readPostmasterPid('')).toBeNull()
    expect(readPostmasterPid(42)).toBeNull()
  })
})

// ─── Жив ли процесс ──────────────────────────────────────────────────────────

describe('isProcessAlive', () => {
  it('свой собственный процесс — жив', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('процесса нет — мёртв', () => {
    // Именно этот случай остаётся после аварии: postmaster.pid есть, кластера нет.
    const kill = () => { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e }

    expect(isProcessAlive(4242, { kill })).toBe(false)
  })

  it('чужой процесс (EPERM) считается живым — кластер мог поднять другой пользователь', () => {
    // Ошибись здесь — и программа решила бы, что порт свободен, поверх живого Postgres.
    const kill = () => { const e = new Error('kill EPERM'); e.code = 'EPERM'; throw e }

    expect(isProcessAlive(4242, { kill })).toBe(true)
  })

  it.each([0, -1, 1.5, null, undefined, 'нет'])('PID %s — мёртв без похода в систему', (pid) => {
    const kill = () => { throw new Error('в систему ходить не должны') }
    expect(isProcessAlive(pid, { kill })).toBe(false)
  })
})

// ─── Кто занял порт ──────────────────────────────────────────────────────────

describe('describePortOwner и текст для человека', () => {
  /** Заглушка execFile: отдаём заготовленный вывод по имени команды. */
  function fakeExec(outputs) {
    return (file, args, opts, cb) => {
      const out = outputs[file]
      setTimeout(() => cb(out === undefined ? new Error('ENOENT') : null, out ?? ''), 0)
      return { on() {} }
    }
  }

  it('находит PID и имя программы', async () => {
    const execFile = fakeExec({
      netstat: '  TCP    0.0.0.0:4780           0.0.0.0:0              ПРОСЛУШИВАНИЕ   9876',
      tasklist: '"node.exe","9876","Console","1","54 321 КБ"',
    })

    await expect(describePortOwner(4780, { execFile })).resolves.toEqual({ pid: 9876, name: 'node.exe' })
  })

  it('порт свободен — владельца нет', async () => {
    const execFile = fakeExec({ netstat: 'Активные подключения\r\n', tasklist: '' })

    await expect(describePortOwner(4780, { execFile })).resolves.toBeNull()
  })

  it('tasklist промолчал — PID всё равно полезен', async () => {
    const execFile = fakeExec({
      netstat: '  TCP    0.0.0.0:4780           0.0.0.0:0              LISTENING       9876',
      tasklist: 'INFO: No tasks are running which match the specified criteria.',
    })

    await expect(describePortOwner(4780, { execFile })).resolves.toEqual({ pid: 9876, name: null })
  })

  it('netstat недоступен (не Windows, нет прав) — null, а не падение', async () => {
    await expect(describePortOwner(4780, { execFile: fakeExec({}) })).resolves.toBeNull()
    await expect(describePortOwner(4780, { execFile: () => { throw new Error('EPERM') } })).resolves.toBeNull()
  })

  it('текст диалога называет программу, а не только номер порта', () => {
    expect(describePortBusy(4780, { pid: 9876, name: 'node.exe' }))
      .toBe('Порт 4780 занят программой node.exe (PID 9876). ' +
        'Закройте её или укажите другой порт сервера в «Настройке системы».')
  })

  it('имени нет — остаётся PID', () => {
    expect(describePortBusy(4780, { pid: 9876, name: null })).toContain('другой программой (PID 9876)')
  })

  it('владелец неизвестен — текст всё равно осмысленный', () => {
    for (const owner of [null, undefined, {}]) {
      expect(describePortBusy(5433, owner)).toContain('Порт 5433 занят другой программой.')
    }
  })
})
