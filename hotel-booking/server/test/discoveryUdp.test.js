import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import dgram from 'node:dgram'
import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Поиск хоста в локальной сети — сквозная проверка обеих половин протокола:
 * ответчик сервера (`src/discovery/udpResponder.js`) против клиента рабочего
 * места (`electron/lib/discovery.js`). Половины писались раздельно, и
 * разойтись им достаточно в одном символе подписываемой строки.
 *
 * Что стоит за каждой проверкой:
 *  • «нашёл не тот хост» — у владельца две базы отдыха, и в одной сети рабочее
 *    место может подключиться к чужим броням. Отсюда `find` с чужим id → тишина;
 *  • «поддельный хост» — гостевой Wi-Fi слышит то же широковещание, и без
 *    подписи любой ноутбук ответил бы «хост теперь я», собирая пароли стойки;
 *  • «хост не отвечает вообще» — чужой мусор на широковещательном порту не
 *    имеет права уронить ответчик, иначе поиск умрёт от первого же пакета
 *    соседнего принтера;
 *  • «выдали лишнее» — на анонимный `who` название отеля не отдаём.
 *
 * Сокеты закрываются в afterEach: висящий UDP-порт подвешивает прогон.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = path.resolve(here, '../../electron/lib/discovery.js')

/** Клиентская половина — тот же файл, что грузит main-процесс Electron. */
function loadClient() {
  delete requireCjs.cache[CLIENT_PATH]
  return requireCjs(CLIENT_PATH)
}

const identityMod = loadCjs('src/utils/instanceIdentity.js', { stubs: { './logger': silentLogger } })

function loadResponder() {
  return loadCjs('src/discovery/udpResponder.js', {
    stubs: { '../utils/instanceIdentity': identityMod },
  })
}

function makeIdentity() {
  const gen = identityMod.generateIdentity()
  return { id: gen.instanceId, publicKey: gen.instancePublicKey, privateKey: gen.instancePrivateKey }
}

const client = loadClient()
const responderMod = loadResponder()
const { startResponder, parseQuery, buildReply, isPrivateAddress, createRateLimiter, MAX_DATAGRAM } = responderMod

const SERVER_PORT = 4780
const NONCE = 'a3f19c0d5b7e4812a3f19c0d5b7e4812'
/** Хватает с запасом: на loopback ответ приходит за единицы миллисекунд. */
const SEARCH_MS = 400

let identity = null
let logger = null
let responder = null
let port = 0
const openSockets = []

/** Ответчик привязывается асинхронно — до этого `address()` честно отдаёт null. */
async function waitPort(resp, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const a = resp.address()
    if (a && a.port) return a.port
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('ответчик не привязался к порту')
}

/**
 * Сырой обмен: шлём готовые датаграммы и собираем всё, что прилетело назад.
 * Нужен там, где важно число ОТВЕТОВ, а не результат поиска: лимит частоты,
 * мусор на порту, повтор запроса.
 */
function rawExchange(payloads, { waitMs = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4' })
    openSockets.push(sock)
    const got = []
    sock.on('error', reject)
    sock.on('message', (buf) => got.push(buf))
    sock.bind(0, '127.0.0.1', () => {
      for (const p of payloads) sock.send(p, port, '127.0.0.1')
      setTimeout(() => {
        try { sock.close() } catch { /* уже закрыт */ }
        resolve(got)
      }, waitMs)
    })
    sock.unref()
  })
}

const query = (obj) => Buffer.from(JSON.stringify(obj), 'utf8')

const search = (opts = {}) => client.findHosts({
  port,
  targets: ['127.0.0.1'],
  timeoutMs: SEARCH_MS,
  dgram,
  ...opts,
})

beforeEach(async () => {
  identity = makeIdentity()
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  responder = startResponder({
    host: '127.0.0.1',
    port: 0,
    getIdentity: async () => identity,
    getHotelName: async () => 'База отдыха «Туран»',
    serverPort: SERVER_PORT,
    version: '1.0.0',
    logger,
  })
  port = await waitPort(responder)
})

afterEach(() => {
  try { responder?.close() } catch { /* уже закрыт */ }
  while (openSockets.length) {
    const s = openSockets.pop()
    try { s.close() } catch { /* уже закрыт */ }
  }
})

// ─── Сквозные сценарии ───────────────────────────────────────────────────────

describe('«Кто здесь Roomline?» — кнопка «Найти в сети»', () => {
  it('хост находится и подсказывает адрес вместе с портом сервера', async () => {
    const hosts = await search({ t: 'who' })

    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({
      id: identity.id,
      port: SERVER_PORT,
      address: '127.0.0.1',
      url: `http://127.0.0.1:${SERVER_PORT}`,
    })
  })

  it('на анонимный запрос название отеля не отдаётся', async () => {
    // Кричать в общую сеть, какой отель здесь стоит, мы не обязаны: имя уходит
    // только тому, кто уже знает наш id (то есть своему рабочему месту).
    const hosts = await search({ t: 'who' })

    expect(hosts[0].hotel).toBe('')
  })

  it('без запомненного ключа находка помечается непроверенной', async () => {
    // `verified: false` — это «адрес показать человеку можно, переезжать нельзя».
    const hosts = await search({ t: 'who' })

    expect(hosts[0].verified).toBe(false)
  })
})

describe('«Где мой хост?» — сторож адреса', () => {
  it('свой хост находится, подпись сходится, название отеля приходит', async () => {
    const hosts = await search({ t: 'find', id: identity.id, publicKey: identity.publicKey })

    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({
      id: identity.id,
      hotel: 'База отдыха «Туран»',
      verified: true,
      url: `http://127.0.0.1:${SERVER_PORT}`,
    })
  })

  it('соседняя база отдыха того же владельца молчит — это не наш хост', async () => {
    // Главная защита от «рабочее место переехало на чужие брони».
    const stranger = makeIdentity()

    const hosts = await search({ t: 'find', id: stranger.id, publicKey: stranger.publicKey })

    expect(hosts).toEqual([])
  })

  it('ответ, не подписанный запомненным ключом, отбрасывается', async () => {
    // Подделка в гостевом Wi-Fi: id угадать легко (он уходит в каждом ответе),
    // а вот подписать ответ чужим ключом — нет.
    const other = makeIdentity()

    const hosts = await search({ t: 'find', id: identity.id, publicKey: other.publicKey })

    expect(hosts).toEqual([])
  })

  it('хост без личности (свежая база или лежащая база) не отвечает вовсе', async () => {
    identity = null

    const hosts = await search({ t: 'who' })

    expect(hosts).toEqual([])
  })

  it('имя компьютера в ответе есть — по нему человек узнаёт нужный ноутбук в списке', async () => {
    const hosts = await search({ t: 'who' })

    expect(typeof hosts[0].computer).toBe('string')
    expect(hosts[0].computer.length).toBeGreaterThan(0)
  })
})

// ─── Ответчик под мусором ────────────────────────────────────────────────────

describe('Ответчик переживает чужой трафик на своём порту', () => {
  it('4 КБ мусора, не-JSON и чужой протокол не мешают следующему нормальному запросу', async () => {
    const replies = await rawExchange([
      crypto.randomBytes(4096),
      Buffer.from('это вообще не json', 'utf8'),
      query({ roomline: 2, t: 'who', nonce: NONCE }),
      query({ roomline: 1, t: 'ping', nonce: NONCE }),
      query({ roomline: 1, t: 'who', nonce: 'коротко' }),
      query({ roomline: 1, t: 'who', nonce: NONCE }),
    ])

    expect(replies).toHaveLength(1)
    expect(client.parseReply(replies[0]).id).toBe(identity.id)
  })

  it('пустая датаграмма и JSON-массив тоже проходят мимо', async () => {
    const replies = await rawExchange([Buffer.alloc(0), Buffer.from('[1,2,3]', 'utf8')])

    expect(replies).toEqual([])
  })

  it('второй запрос с того же адреса в ту же секунду остаётся без ответа', async () => {
    // Лимит не от злоумышленника (в локальной сети так не защититься), а от
    // заклинившего клиента, который превратил бы хост в источник шторма.
    const replies = await rawExchange([
      query({ roomline: 1, t: 'who', nonce: NONCE }),
      query({ roomline: 1, t: 'who', nonce: 'b3f19c0d5b7e4812a3f19c0d5b7e4812' }),
    ])

    expect(replies).toHaveLength(1)
  })

  it('чужой id съедает лимит не больше, чем нужно: следующий свой запрос получает ответ', async () => {
    // Иначе сосед по сети, ищущий СВОЙ хост раз в 10 секунд, глушил бы наш.
    const stranger = makeIdentity()
    const replies = await rawExchange([
      query({ roomline: 1, t: 'find', id: stranger.id, nonce: NONCE }),
      query({ roomline: 1, t: 'find', id: identity.id, nonce: NONCE }),
    ])

    expect(replies).toHaveLength(1)
    expect(client.parseReply(replies[0]).hotel).toBe('База отдыха «Туран»')
  })

  it('ответчик не роняет процесс, когда название отеля прочитать не удалось', async () => {
    // Задокументировано как есть: ответа на `find` не будет, но и падения тоже.
    // В `server.js` эта функция ошибок не выпускает, так что до сети не доходит.
    responder.close()
    responder = startResponder({
      host: '127.0.0.1',
      port: 0,
      getIdentity: async () => identity,
      getHotelName: async () => { throw new Error('база лежит') },
      serverPort: SERVER_PORT,
      version: '1.0.0',
      logger,
    })
    port = await waitPort(responder)

    const hosts = await search({ t: 'find', id: identity.id })

    expect(hosts).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
  })
})

// ─── Подъём и остановка ──────────────────────────────────────────────────────

describe('Ответчик не имеет права уронить сервер', () => {
  /** Сокет-обманка: bind сообщает об ошибке так же, как настоящий dgram. */
  function fakeDgram({ throwOnBind = null, bindError = null } = {}) {
    const handlers = {}
    const socket = {
      closed: 0,
      on(ev, fn) { (handlers[ev] ||= []).push(fn) },
      emit(ev, arg) { for (const fn of handlers[ev] || []) fn(arg) },
      bind() {
        if (throwOnBind) throw throwOnBind
        if (bindError) setTimeout(() => socket.emit('error', bindError), 0)
      },
      address() { throw new Error('ERR_SOCKET_DGRAM_NOT_RUNNING') },
      close() { socket.closed += 1 },
      send() {},
    }
    return { createSocket: () => socket, socket }
  }

  it('порт уже занят другой программой — warn в журнал, а не падение сервера', async () => {
    // В server.js стоит uncaughtException → exit(1), а надзор Electron поднимает
    // сервер заново: исключение здесь превратилось бы в вечный перезапуск.
    const err = Object.assign(new Error('bind EADDRINUSE 0.0.0.0:4781'), { code: 'EADDRINUSE' })
    const fake = fakeDgram({ bindError: err })
    const log = { warn: vi.fn(), debug: vi.fn() }

    const resp = startResponder({ port: 4781, getIdentity: async () => identity, logger: log, dgram: fake })
    await new Promise((r) => setTimeout(r, 5))

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(String(log.warn.mock.calls[0][0])).toContain('EADDRINUSE')
    expect(fake.socket.closed).toBe(1)
    expect(resp.address()).toBeNull()
    expect(() => resp.close()).not.toThrow()
  })

  it('bind бросил синхронно — тот же исход', () => {
    const fake = fakeDgram({ throwOnBind: new Error('нет прав на порт') })
    const log = { warn: vi.fn(), debug: vi.fn() }

    expect(() => startResponder({ port: 80, getIdentity: async () => identity, logger: log, dgram: fake }))
      .not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })

  it('повторный close безопасен и в журнал ничего не добавляет', () => {
    responder.close()
    responder.close()

    expect(logger.warn).not.toHaveBeenCalled()
    expect(responder.address()).toBeNull()
  })

  it('после close порт отпущен — на запросы больше не отвечаем', async () => {
    responder.close()

    const hosts = await search({ t: 'who' })

    expect(hosts).toEqual([])
  })
})

// ─── Разбор запроса ──────────────────────────────────────────────────────────

describe('parseQuery — что считается нашим запросом', () => {
  it('датаграмма длиннее 512 байт не разбирается вовсе', () => {
    const fat = query({ roomline: 1, t: 'find', id: 'x'.repeat(600), nonce: NONCE })

    expect(fat.length).toBeGreaterThan(MAX_DATAGRAM)
    expect(parseQuery(fat)).toBeNull()
  })

  it.each([
    ['чужой протокол', { roomline: 2, t: 'who', nonce: NONCE }],
    ['без номера протокола', { t: 'who', nonce: NONCE }],
    ['неизвестный тип', { roomline: 1, t: 'hello', nonce: NONCE }],
    ['nonce не hex', { roomline: 1, t: 'who', nonce: 'z'.repeat(32) }],
    ['nonce короткий', { roomline: 1, t: 'who', nonce: 'abc' }],
    ['nonce числом', { roomline: 1, t: 'who', nonce: 12345 }],
    ['find без id', { roomline: 1, t: 'find', nonce: NONCE }],
    ['find с пустым id', { roomline: 1, t: 'find', id: '', nonce: NONCE }],
    ['find с id-числом', { roomline: 1, t: 'find', id: 7, nonce: NONCE }],
  ])('%s — не наш запрос', (_name, msg) => {
    expect(parseQuery(query(msg))).toBeNull()
  })

  it('лишние поля в запросе не мешают — разбираем только своё', () => {
    const q = parseQuery(query({ roomline: 1, t: 'who', nonce: NONCE, mood: 'хорошее' }))

    expect(q).toEqual({ t: 'who', nonce: NONCE })
  })

  it('запрос клиента разбирается ответчиком как есть', () => {
    // Тот самый стык: encodeQuery пишет клиент, parseQuery читает сервер.
    expect(parseQuery(client.encodeQuery({ t: 'who', nonce: NONCE })))
      .toEqual({ t: 'who', nonce: NONCE })
    expect(parseQuery(client.encodeQuery({ t: 'find', id: identity.id, nonce: NONCE })))
      .toEqual({ t: 'find', id: identity.id, nonce: NONCE })
  })
})

// ─── Сборка ответа ───────────────────────────────────────────────────────────

describe('buildReply — что уходит в сеть', () => {
  const find = { t: 'find', id: null, nonce: NONCE }

  it('на who ответ идёт без названия отеля, на find — с ним', () => {
    const who = JSON.parse(buildReply({
      identity, query: { t: 'who', nonce: NONCE }, serverPort: SERVER_PORT, version: '1.0.0', hotel: 'Туран',
    }))
    const mine = JSON.parse(buildReply({
      identity, query: { ...find, id: identity.id }, serverPort: SERVER_PORT, version: '1.0.0', hotel: 'Туран',
    }))

    expect(who).not.toHaveProperty('hotel')
    expect(mine.hotel).toBe('Туран')
  })

  it('приватный ключ в датаграмму не попадает', () => {
    const reply = buildReply({ identity, query: { t: 'who', nonce: NONCE }, serverPort: SERVER_PORT })

    expect(reply.toString('utf8')).not.toContain('PRIVATE')
  })

  it('ищут не нас — ответа нет', () => {
    expect(buildReply({ identity, query: { ...find, id: makeIdentity().id }, serverPort: SERVER_PORT })).toBeNull()
  })

  it('нет личности или нет вменяемого порта — ответа нет', () => {
    expect(buildReply({ identity: null, query: { t: 'who', nonce: NONCE }, serverPort: SERVER_PORT })).toBeNull()
    expect(buildReply({ identity, query: { t: 'who', nonce: NONCE }, serverPort: 0 })).toBeNull()
    expect(buildReply({ identity, query: { t: 'who', nonce: NONCE }, serverPort: 'не число' })).toBeNull()
  })

  it('подписью не удалось — молчим, а не отдаём id и версию просто так', () => {
    const broken = { ...identity, privateKey: '-----BEGIN PRIVATE KEY-----\nмусор\n-----END PRIVATE KEY-----' }

    expect(buildReply({ identity: broken, query: { t: 'who', nonce: NONCE }, serverPort: SERVER_PORT })).toBeNull()
  })

  it('длинное название отеля обрезается — датаграмма должна оставаться маленькой', () => {
    const reply = JSON.parse(buildReply({
      identity, query: { ...find, id: identity.id }, serverPort: SERVER_PORT, hotel: 'Б'.repeat(300),
    }))

    expect(reply.hotel).toHaveLength(96)
  })

  it('предельно длинный ответ на find всё равно влезает в 512 байт', () => {
    // Было находкой тестов (исправлено 2026-09-12: buildReply убирает название,
    // если ответ не влезает). Название отеля режется по 96 СИМВОЛОВ, а ограничение датаграммы
    // (и у ответчика, и у клиента) — в БАЙТАХ. 96 кириллических символов это
    // 192 байта, и вместе с длинным именем компьютера ответ переваливает за 512:
    // клиент молча отбрасывает его в parseReply, а человек видит «хост не
    // найден» без единой строки в журнале. Своей проверки размера у buildReply
    // нет. Практически достижимо на хосте с длинным сетевым именем (Windows
    // ограничивает имя компьютера 15 знаками, поэтому опасность невелика).
    const reply = buildReply({
      identity,
      query: { ...find, id: identity.id },
      serverPort: SERVER_PORT,
      version: '1.0.0',
      computer: 'w'.repeat(63),
      hotel: 'Б'.repeat(120),
    })

    expect(reply.length).toBeLessThanOrEqual(MAX_DATAGRAM)
  })
})

// ─── Частные адреса ──────────────────────────────────────────────────────────

describe('isPrivateAddress — отвечаем только в локальную сеть', () => {
  it.each(['10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.7', '169.254.10.1', '127.0.0.1', '::ffff:192.168.1.7'])(
    '%s — своя сеть', (ip) => expect(isPrivateAddress(ip)).toBe(true))

  it.each(['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '11.0.0.1', '', null, 'не адрес', '999.1.1.1'])(
    '%s — не отвечаем', (ip) => expect(isPrivateAddress(ip)).toBe(false))

  it('обе половины протокола считают частной одну и ту же сеть', () => {
    // Разъедутся — хост будет отвечать туда, где клиент ответ уже не примет.
    for (const ip of ['10.0.0.5', '172.16.0.1', '192.168.1.7', '169.254.1.1', '127.0.0.1', '8.8.8.8', '172.32.0.1']) {
      expect(client.isPrivateAddress(ip), ip).toBe(isPrivateAddress(ip))
    }
  })
})

// ─── Лимит частоты ───────────────────────────────────────────────────────────

describe('createRateLimiter — хост не превращается в источник шторма', () => {
  const limiter = (now) => createRateLimiter({ now })

  it('один ответ в секунду на адрес', () => {
    let t = 1_000_000
    const allow = limiter(() => t)

    expect(allow('192.168.1.9')).toBe(true)
    t += 999
    expect(allow('192.168.1.9')).toBe(false)
    t += 2
    expect(allow('192.168.1.9')).toBe(true)
  })

  it('лимит на адрес, а не на всех: соседнее рабочее место отвечает своё', () => {
    let t = 1_000_000
    const allow = limiter(() => t)

    expect(allow('192.168.1.9')).toBe(true)
    expect(allow('192.168.1.10')).toBe(true)
  })

  it('десять ответов в секунду суммарно — одиннадцатый ждёт следующей секунды', () => {
    let t = 1_000_000
    const allow = limiter(() => t)

    for (let i = 0; i < 10; i++) expect(allow(`192.168.1.${i}`)).toBe(true)
    expect(allow('192.168.1.50')).toBe(false)

    t += 1000
    expect(allow('192.168.1.50')).toBe(true)
  })

  it('карта адресов не растёт бесконечно — записи чистятся со сменой окна', () => {
    let t = 1_000_000
    const allow = limiter(() => t)
    for (let i = 0; i < 5; i++) allow(`10.0.0.${i}`)

    t += 5000
    // Адрес, который «светился» давно, снова обслуживается как новый
    expect(allow('10.0.0.1')).toBe(true)
  })

  it('перевод часов назад не глушит поиск хоста', () => {
    // Было находкой тестов (исправлено 2026-09-12: монотонные часы + сброс окна
    // при t < windowStart). Окно и запись по адресу считались по Date.now(), и отрицательная
    // разница нигде не обрабатывается. Часы на ноутбуке перевели назад (сверка
    // времени, ручная правка, севшая батарейка BIOS) — и `t - last` становится
    // отрицательным, то есть «меньше секунды назад» навсегда: ответчик молчит
    // на все запросы ровно столько, на сколько часы ушли назад. Для рабочих мест
    // это «хост пропал из сети» без единой записи в журнале. Тот же счётчик
    // глушит и общее окно: inWindow не сбрасывается, и после десяти ответов
    // замолкает вообще всё.
    let t = 3_600_000
    const allow = limiter(() => t)
    expect(allow('192.168.1.9')).toBe(true)

    t = 600_000   // часы ушли на час назад; десять минут спустя хост обязан отвечать
    expect(allow('192.168.1.9')).toBe(true)
  })
})
