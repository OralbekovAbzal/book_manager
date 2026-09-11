/**
 * Как рабочее место находит свой хост в локальной сети.
 *
 * Задача бытовая: администратор поменял роутер (или у отеля DHCP с коротким
 * сроком аренды), адрес хоста уехал — и на всех рабочих местах программа
 * «перестала работать». Раньше это лечилось походом к каждому ноутбуку и
 * вписыванием нового адреса руками. Теперь хост отвечает на широковещательный
 * запрос: клиент кричит в сеть «кто здесь Roomline?», хост отвечает адресом,
 * портом и ПОДПИСЬЮ своей личности (`utils/instanceIdentity.js`).
 *
 * Что здесь важнее всего — не находить, а не соврать:
 *
 *  • Отвечаем только в локальные сети (10/8, 172.16/12, 192.168/16, 169.254/16,
 *    127/8). Программа работает в отеле по кабелю и вайфаю; отвечать на
 *    датаграмму с публичного адреса не нужно никогда, а вот выдать наружу имя
 *    отеля и версию сервера — лишнее.
 *  • На автоматический запрос сторожа (`find`, с конкретным id) отвечаем ТОЛЬКО
 *    если ищут именно нас, и молчим иначе. Сторож работает постоянно и в фоне:
 *    если бы на него отвечали все, в сети с двумя базами отдыха одного владельца
 *    рабочее место переехало бы на чужие брони.
 *  • Название отеля отдаётся только в ответе на `find` — то есть тому, кто уже
 *    знает наш id и публичный ключ. Ответ на «кто здесь» (`who`, кнопка «Найти в
 *    сети») названия не содержит: на широковещательный запрос от кого угодно
 *    рассказывать, какой отель стоит в этой сети, мы не обязаны.
 *  • Подпись покрывает `${id}|${port}|${nonce}`. `nonce` даёт клиент, поэтому
 *    записанный чужой ответ нельзя проиграть заново; порт входит в подпись,
 *    чтобы подменой ответа нельзя было увести рабочее место на чужой порт.
 *
 * Приватный ключ в датаграмму не попадает — только подпись.
 *
 * Ответчик включается ТОЛЬКО при заданном `DISCOVERY_PORT` (его ставит Electron
 * в режиме хоста). В dev-режиме и на рабочем месте-клиенте сокет не поднимается:
 * лишний слушающий UDP-порт на чужом ноутбуке — сюрприз, которого никто не просил.
 */

const os = require('os')
const { signChallenge } = require('../utils/instanceIdentity')

/** Номер протокола в каждой датаграмме: чужой UDP-мусор на этом порту не наш. */
const PROTOCOL = 1
/** Больше 512 байт — точно не наш запрос: свои укладываются в сотню. */
const MAX_DATAGRAM = 512
const NONCE_RE = /^[0-9a-f]{32}$/
const QUERY_TYPES = new Set(['who', 'find'])
/**
 * Имя отеля в ответе режем: датаграмма должна оставаться маленькой и влезать в
 * один UDP-пакет без фрагментации, а в списке найденных хостов длинное название
 * всё равно не показать. Режем здесь, а не в базе — в базе оно живое.
 */
const MAX_HOTEL_NAME = 96

/** Монотонные часы для лимитера: перевод системного времени их не трогает. */
function monotonicNow() {
  return Number(process.hrtime.bigint() / 1000000n)
}

/**
 * Разбор запроса. Возвращает `null` на всё, что нам не адресовано, — без логов и
 * без ответа: на широковещательном порту чужой мусор это норма, а не инцидент.
 */
function parseQuery(buf) {
  if (!buf || buf.length === 0 || buf.length > MAX_DATAGRAM) return null

  let msg
  try {
    msg = JSON.parse(buf.toString('utf8'))
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null
  if (msg.roomline !== PROTOCOL) return null
  if (typeof msg.nonce !== 'string' || !NONCE_RE.test(msg.nonce)) return null
  if (typeof msg.t !== 'string' || !QUERY_TYPES.has(msg.t)) return null
  // `find` без id — бессмысленный запрос: сторож всегда знает, кого ищет.
  if (msg.t === 'find' && (typeof msg.id !== 'string' || msg.id === '')) return null

  return msg.t === 'find'
    ? { t: 'find', nonce: msg.nonce, id: msg.id }
    : { t: 'who', nonce: msg.nonce }
}

/**
 * Ответ хоста. `null` — отвечать нечего (нет личности или ищут не нас).
 *
 * @param {{ identity: object|null, query: object, serverPort: number,
 *           version?: string, computer?: string, hotel?: string|null }} args
 */
function buildReply({ identity, query, serverPort, version, computer, hotel }) {
  if (!identity || !query) return null
  if (query.t === 'find' && query.id !== identity.id) return null

  const port = Number(serverPort)
  if (!Number.isInteger(port) || port <= 0) return null

  // Без подписи ответ бесполезен — клиент его всё равно отбросит, а мы бы выдали
  // в сеть id и версию просто так. Поэтому «не подписалось» = «не отвечаем».
  const sig = signChallenge(identity, `${identity.id}|${port}|${query.nonce}`)
  if (!sig) return null

  const reply = {
    roomline: PROTOCOL,
    t: 'host',
    id: identity.id,
    computer: String(computer || os.hostname() || ''),
    port,
    version: String(version || ''),
    nonce: query.nonce,
    sig,
  }
  // Название отеля — только тому, кто уже знает наш id (см. шапку файла).
  if (query.t === 'find' && hotel) reply.hotel = String(hotel).slice(0, MAX_HOTEL_NAME)

  let buf = Buffer.from(JSON.stringify(reply), 'utf8')
  // Лимит датаграммы — в БАЙТАХ, а название режется по символам: 96 кириллических
  // символов это 192 байта, и с длинным именем компьютера ответ переваливал за
  // 512 — клиент молча отбрасывал его, и хост «не находился». Название здесь
  // украшение, а не суть ответа: не влезает — отвечаем без него.
  if (buf.length > MAX_DATAGRAM && reply.hotel) {
    delete reply.hotel
    buf = Buffer.from(JSON.stringify(reply), 'utf8')
  }
  return buf
}

/**
 * Локальные сети, в которых вообще может стоять хост. `::ffff:192.168.0.5` —
 * тот же IPv4, просто пришедший в сокет, где включён IPv6-маппинг: обрезаем
 * префикс, иначе адрес из соседнего номера выглядел бы как чужой.
 */
function isPrivateAddress(ip) {
  if (typeof ip !== 'string' || ip === '') return false
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  const parts = addr.split('.')
  if (parts.length !== 4) return false

  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  if (nums.some((n) => n < 0 || n > 255)) return false

  const [a, b] = nums
  if (a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true   // APIPA: сеть без DHCP, кабель ноутбук-в-ноутбук
  if (a === 127) return true                // свой же клиент на хосте
  return false
}

/**
 * Лимит ответов. Смысл не в защите от злоумышленника (в локальной сети её так не
 * построить), а в том, чтобы заклинивший клиент или чужая программа, шлющая
 * пакеты в цикле, не превратили хост в источник шторма: один ответ в секунду на
 * адрес и десять в секунду суммарно. Поиск это переживает — он разовый.
 */
function createRateLimiter({ perSourceMs = 1000, globalPerSec = 10, now = monotonicNow } = {}) {
  const lastBySource = new Map()
  let windowStart = 0
  let inWindow = 0

  return function allow(ip) {
    const t = now()

    // `t < windowStart` — часы ушли назад (сверка времени, севшая батарейка BIOS).
    // Без этой ветки все разницы становились отрицательными, и ответчик молчал,
    // пока часы не догонят прежнее значение — часами. Окно просто начинаем заново.
    if (t < windowStart) {
      windowStart = t
      inWindow = 0
      lastBySource.clear()
    }
    if (t - windowStart >= 1000) {
      windowStart = t
      inWindow = 0
      // Чистим карту вместе со сменой окна: иначе за сутки в ней накопились бы
      // все адреса сети, а запись нужна ровно `perSourceMs`.
      for (const [addr, at] of lastBySource) if (t - at >= perSourceMs) lastBySource.delete(addr)
    }
    if (inWindow >= globalPerSec) return false

    const last = lastBySource.get(ip)
    if (last !== undefined && t - last < perSourceMs) return false

    lastBySource.set(ip, t)
    inWindow += 1
    return true
  }
}

/**
 * Поднимает ответчик. Никогда не бросает наружу и не роняет процесс: в
 * `server.js` стоит `uncaughtException` → `exit(1)`, а надзор Electron поднимает
 * сервер заново — то есть занятый кем-то UDP-порт превратился бы в бесконечный
 * цикл перезапусков программы. Не смогли слушать — пишем warn и работаем дальше
 * без поиска: адрес хоста можно вписать руками, а вот без сервера отель встанет.
 */
function startResponder({
  port,
  host = '0.0.0.0',
  getIdentity,
  getHotelName,
  serverPort,
  version,
  logger = console,
  dgram = require('dgram'),
} = {}) {
  // Без reuseAddr намеренно: у UDP нет TIME_WAIT, перезапуску надзором он не
  // нужен, а на Windows с ним второй сокет на том же порту привязывается без
  // ошибки и молча перехватывает запросы — «хост не находится» без следа в логе.
  // Так занятый порт честно даёт EADDRINUSE → warn ниже.
  const socket = dgram.createSocket({ type: 'udp4' })
  const allow = createRateLimiter()
  let closed = false

  const shutdown = (err) => {
    if (closed) return
    closed = true
    if (err) logger.warn(`discovery: ответчик остановлен: ${err.message || err}`)
    try { socket.close() } catch { /* уже закрыт — не наша беда */ }
  }

  socket.on('error', (err) => {
    // EADDRINUSE здесь — обычное дело: вторая копия программы на том же
    // ноутбуке или чужой сервис на порту. Это не повод падать.
    shutdown(err)
  })

  socket.on('message', (buf, rinfo) => {
    // Обработчик асинхронный, поэтому ВСЁ внутри — под перехватом: необработанное
    // отклонение здесь означало бы падение сервера при первом же кривом пакете.
    void (async () => {
      try {
        if (!rinfo || !isPrivateAddress(rinfo.address)) return

        const query = parseQuery(buf)
        if (!query) return

        const identity = await getIdentity()
        if (!identity) return
        if (query.t === 'find' && query.id !== identity.id) return

        if (!allow(rinfo.address)) return

        const hotel = query.t === 'find' && getHotelName ? await getHotelName() : null
        const reply = buildReply({ identity, query, serverPort, version, hotel })
        if (!reply) return

        // Ответ — unicast обратно спрашивавшему, а не в широковещательный адрес:
        // остальным в сети наш ответ знать незачем.
        socket.send(reply, rinfo.port, rinfo.address, (err) => {
          if (err) logger.debug?.(`discovery: ответ не ушёл на ${rinfo.address}: ${err.message}`)
        })
      } catch (err) {
        logger.debug?.(`discovery: запрос отброшен: ${err && err.message}`)
      }
    })()
  })

  try {
    socket.bind(port, host)
  } catch (err) {
    shutdown(err)
  }

  return {
    /** Адрес сокета или null, если он ещё не привязан (или уже закрыт). */
    address() {
      if (closed) return null
      try { return socket.address() } catch { return null }
    },
    close() { shutdown() },
  }
}

module.exports = {
  parseQuery,
  buildReply,
  isPrivateAddress,
  createRateLimiter,
  startResponder,
  PROTOCOL,
  MAX_DATAGRAM,
  NONCE_RE,
}
