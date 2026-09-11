/**
 * Поиск хоста в локальной сети (UDP-широковещание).
 *
 * Зачем. Адрес хоста рабочее место получает один раз, руками сисадмина. Смена
 * роутера, переезд на другой Wi-Fi, новая аренда DHCP — и на всех рабочих
 * местах «нет связи с сервером», а починить это может только тот, кто знает,
 * где смотреть новый IP. Хост при этом стоит в той же сети и отвечает.
 *
 * Как. Клиент шлёт широковещательный запрос на UDP-порт, хост отвечает
 * unicast'ом со своей личностью (`instanceId` + Ed25519-подпись). Адрес хоста
 * клиент берёт ИЗ КОНВЕРТА (rinfo.address), а не из тела ответа: адрес в теле —
 * это приглашение увести рабочее место на чужую машину.
 *
 * ПОЧЕМУ ПОДПИСЬ. Широковещание в сети отеля слышат все, в том числе гостевой
 * Wi-Fi. Без подписи любой в этой сети мог бы ответить «хост — это я» и собирать
 * пароли сотрудников на своём поддельном сервере. Поэтому автоматический переход
 * на новый адрес происходит только по ответу, подписанному ключом ИМЕННО ТОГО
 * хоста, с которым рабочее место уже работало (ключ запоминается при первом
 * удачном подключении — TOFU).
 *
 * Протокол (заморожен, серверная сторона делается по этому же тексту):
 *   Запрос  (клиент → broadcast):
 *     {"roomline":1,"t":"who","nonce":"<32 hex>"}                — «кто здесь»
 *     {"roomline":1,"t":"find","id":"<uuid>","nonce":"<32 hex>"} — «где мой хост»
 *   Ответ   (хост → unicast отправителю):
 *     who : {"roomline":1,"t":"host","id","computer","port","version","nonce","sig"}
 *     find: то же + "hotel"; хост отвечает ТОЛЬКО при совпадении id
 *   sig: Ed25519 над UTF-8 `${id}|${port}|${nonce}`, base64url.
 *
 * Без `require('electron')`: модуль зовёт main-процесс, но читать его должны и
 * тесты обычным node. dgram/os/crypto внедряются параметрами.
 */
const cryptoDefault = require('crypto')

// Датаграмма больше этого — не наш ответ (и не повод разбирать чужой мусор).
const MAX_DATAGRAM = 512
const NONCE_RE = /^[0-9a-f]{32}$/

/** 16 случайных байт hex. Одноразовый: связывает ответ именно с этим запросом. */
function makeNonce({ crypto = cryptoDefault } = {}) {
  return crypto.randomBytes(16).toString('hex')
}

/** Запрос → Buffer. */
function encodeQuery({ t, id = null, nonce } = {}) {
  const q = { roomline: 1, t: String(t || 'who') }
  if (id) q.id = String(id)
  q.nonce = String(nonce || '')
  return Buffer.from(JSON.stringify(q), 'utf8')
}

/**
 * Ответ хоста → объект. Любая беда (не наш пакет, битый JSON, слишком длинный) →
 * null: в широковещательный порт прилетает что угодно.
 */
function parseReply(buf) {
  if (!buf || buf.length > MAX_DATAGRAM) return null
  let data
  try { data = JSON.parse(buf.toString('utf8')) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.roomline !== 1 || data.t !== 'host') return null
  if (typeof data.id !== 'string' || !data.id) return null
  if (typeof data.nonce !== 'string' || !NONCE_RE.test(data.nonce)) return null
  const port = Number(data.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    id: data.id,
    computer: typeof data.computer === 'string' ? data.computer : '',
    hotel: typeof data.hotel === 'string' ? data.hotel : '',
    port,
    version: typeof data.version === 'string' ? data.version : '',
    nonce: data.nonce,
    sig: typeof data.sig === 'string' ? data.sig : '',
  }
}

/** Ровно та строка, которую подписывает хост. Меняешь — меняй и на сервере. */
function signedString({ id, port, nonce } = {}) {
  return `${id}|${port}|${nonce}`
}

/**
 * Проверка подписи ответа.
 * @param {object} reply разобранный ответ
 * @param {{ nonce: string, publicKey: string, id?: string|null }} opts publicKey — PEM
 * @returns {boolean}
 */
function verifyReply(reply, { nonce, publicKey, id = null, crypto = cryptoDefault } = {}) {
  if (!reply || !publicKey) return false
  if (!nonce || reply.nonce !== nonce) return false
  if (id && reply.id !== id) return false
  if (!reply.sig) return false
  try {
    return crypto.verify(
      null,
      Buffer.from(signedString(reply), 'utf8'),
      publicKey,
      Buffer.from(reply.sig, 'base64url'),
    )
  } catch {
    // Битый ключ или подпись — это «не проверилось», а не падение программы
    return false
  }
}

/**
 * Частный адрес (RFC 1918 + link-local + loopback). Ответ с публичного адреса
 * означает, что «хост» стоит в интернете, — такому рабочее место не подчиняется.
 */
function isPrivateAddress(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '')
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (!m) return false
  const o = m.slice(1).map(Number)
  if (o.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false
  if (o[0] === 10) return true
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true
  if (o[0] === 192 && o[1] === 168) return true
  if (o[0] === 169 && o[1] === 254) return true
  if (o[0] === 127) return true
  return false
}

/**
 * Куда слать широковещание.
 *
 * Одного 255.255.255.255 мало: Windows отправляет его только в один интерфейс
 * (по таблице маршрутизации), а на ноутбуке их обычно несколько — Wi-Fi,
 * Ethernet, виртуальные адаптеры. Поэтому добавляем направленный broadcast
 * каждого IPv4-интерфейса: адрес | ~маска (192.168.1.7/24 → 192.168.1.255).
 *
 * @param {object} interfaces результат os.networkInterfaces()
 * @returns {string[]} уникальные адреса
 */
function broadcastTargets(interfaces) {
  const out = ['255.255.255.255']
  for (const list of Object.values(interfaces || {})) {
    for (const ni of list || []) {
      const isV4 = ni && (ni.family === 'IPv4' || ni.family === 4)
      if (!isV4 || ni.internal) continue
      if (!ni.address || !ni.netmask) continue
      const a = ni.address.split('.').map(Number)
      const m = ni.netmask.split('.').map(Number)
      if (a.length !== 4 || m.length !== 4) continue
      if (a.some((x) => !Number.isInteger(x)) || m.some((x) => !Number.isInteger(x))) continue
      const b = a.map((x, i) => (x | (~m[i] & 255)) & 255).join('.')
      if (!out.includes(b)) out.push(b)
    }
  }
  return out
}

/**
 * Спросить сеть и собрать ответы.
 *
 * Никогда не реджектит: не нашли — пустой массив. Поиск хоста не повод уронить
 * окно настроек или сторожа.
 *
 * @param {object} opts
 * @param {number} opts.port          UDP-порт ответчика (DISCOVERY_PORT)
 * @param {number} [opts.timeoutMs]   сколько слушаем ответы
 * @param {'who'|'find'} [opts.t]     'who' — «кто здесь», 'find' — «где мой хост»
 * @param {string|null} [opts.id]     id своего хоста (для 'find')
 * @param {string|null} [opts.publicKey] PEM своего хоста; задан → берём только
 *                                    ответы с проходящей подписью
 * @returns {Promise<Array<{id,hotel,computer,port,address,url,verified}>>}
 */
function findHosts(opts = {}) {
  const {
    port,
    timeoutMs = 2500,
    t = 'who',
    id = null,
    publicKey = null,
    dgram = require('dgram'),
    os = require('os'),
    crypto = cryptoDefault,
  } = opts
  const nonce = opts.nonce || makeNonce({ crypto })
  const targets = opts.targets || broadcastTargets(os.networkInterfaces())

  return new Promise((resolve) => {
    const found = []
    const seen = new Set()
    let socket
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      return resolve(found)
    }

    let done = false
    let timer = null
    const finish = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try { socket.close() } catch { /* уже закрыт */ }
      resolve(found)
    }

    socket.on('error', finish)   // ошибка сокета → отдаём то, что успели собрать

    socket.on('message', (buf, rinfo) => {
      if (done) return
      // Адрес отправителя — единственный источник адреса хоста. Поля адреса в
      // ответе нет и быть не должно: иначе «хост» уводил бы клиента куда угодно.
      if (!rinfo || !isPrivateAddress(rinfo.address)) return
      const reply = parseReply(buf)
      if (!reply) return
      if (reply.nonce !== nonce) return
      if (id && reply.id !== id) return
      if (publicKey && !verifyReply(reply, { nonce, publicKey, id, crypto })) return
      const key = `${reply.id}|${rinfo.address}`
      if (seen.has(key)) return
      seen.add(key)
      found.push({
        id: reply.id,
        hotel: reply.hotel,
        computer: reply.computer,
        port: reply.port,
        address: rinfo.address,
        url: `http://${rinfo.address}:${reply.port}`,
        verified: !!publicKey,
      })
    })

    // Таймер ставим ДО bind: если bind не позовёт колбэк и не выдаст ошибку
    // (так бывает при перенастройке сети), обещание всё равно завершится.
    timer = setTimeout(finish, timeoutMs)

    socket.bind(0, () => {
      if (done) return
      try { socket.setBroadcast(true) } catch { /* без broadcast долетит только unicast */ }
      const query = encodeQuery({ t, id, nonce })
      for (const target of targets) {
        try {
          socket.send(query, 0, query.length, port, target, () => { /* недоставку игнорируем */ })
        } catch { /* интерфейс мог исчезнуть между перечислением и отправкой */ }
      }
      // Слушаем ответы полный таймаут ПОСЛЕ отправки, а не с момента создания сокета
      clearTimeout(timer)
      timer = setTimeout(finish, timeoutMs)
    })
  })
}

module.exports = {
  MAX_DATAGRAM,
  NONCE_RE,
  makeNonce,
  encodeQuery,
  parseReply,
  signedString,
  verifyReply,
  isPrivateAddress,
  broadcastTargets,
  findHosts,
}
