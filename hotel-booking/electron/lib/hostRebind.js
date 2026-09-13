/**
 * Перепривязка рабочего места к хосту: чистая логика без `electron`.
 *
 * Зачем отдельный модуль. Сторож адреса (`main.js`) умеет искать хост
 * широковещанием, но у широковещания есть слепые зоны: гостевой Wi-Fi часто
 * изолирует устройства друг от друга, а правило брандмауэра на входящие
 * датаграммы есть не в каждой сети. Второй путь надёжнее и проще —
 * **имя компьютера хоста**: Windows резолвит его сама (NetBIOS/LLMNR/mDNS),
 * без DHCP и без нашего UDP-порта. Имя запоминается при первом удачном
 * подключении, рядом с личностью хоста (TOFU).
 *
 * Что здесь решается:
 *  • какие адреса пробовать по имени (`hostNameCandidates`);
 *  • сменилась ли сеть под ногами (`localIpv4s` + `addressSetChanged`) — это
 *    повод искать хост НЕ ДОЖИДАЯСЬ отказов;
 *  • можно ли считать найденный в сети хост «своим с новой личностью»
 *    (`decideWhoRebind`) — переустановка программы на хосте или восстановление
 *    копии на другом ноутбуке меняет пару ключей, и по личности его больше не
 *    найти никогда;
 *  • какой текст показать человеку у полосы «нет связи» (`rebindMessage`).
 *
 * Границы доверия. Совпадения имени компьютера МАЛО для переезда само по себе:
 * решение здесь только отбирает кандидата, а подтверждает его живой сервер по
 * HTTP (`/api/health?nonce=…` с подписью). Имя — фильтр «это та же машина, что и
 * раньше», а не доказательство. Поэтому `decideWhoRebind` отказывается решать,
 * когда в сети несколько хостов или имя не совпало: в такой ситуации рабочее
 * место остаётся на месте, а человек читает лог.
 */

/** Символы, из которых состоит настоящее имя компьютера. Всё прочее — не имя. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

/**
 * Имя компьютера к сравнимому виду: регистр не важен (Windows его не различает),
 * хвостовая точка — форма записи абсолютного DNS-имени (`host.`).
 */
function normalizeComputer(name) {
  return String(name == null ? '' : name).trim().replace(/\.+$/, '').toLowerCase()
}

/**
 * Та же машина? `NB-HOST` и `nb-host` — да; `nb-host` и `nb-host.local` — тоже
 * да (второе имя дала той же машине mDNS). А вот `nb-host.corp` и `nb-host.evil`
 * — нет: два разных домена сравниваем целиком.
 */
function sameComputer(a, b) {
  const x = normalizeComputer(a)
  const y = normalizeComputer(b)
  if (!x || !y) return false
  if (x === y) return true
  const xs = x.split('.')
  const ys = y.split('.')
  // Короткое имя против доменного — сравниваем первую метку. Две разные
  // доменные записи так не сойдутся: это уже разные имена.
  if (xs.length === 1 || ys.length === 1) return xs[0] === ys[0]
  return false
}

/** Порт из сохранённого адреса хоста. Без порта в адресе — 80 (как у браузера). */
function portOfUrl(serverUrl) {
  let raw = String(serverUrl == null ? '' : serverUrl).trim()
  if (!raw) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'http://' + raw
  try {
    const u = new URL(raw)
    if (u.port) {
      const p = Number(u.port)
      return Number.isInteger(p) && p > 0 && p < 65536 ? p : null
    }
    return u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/** Адрес без хвостовых слэшей — в том же виде, в каком его хранит config. */
function normalizeUrl(raw) {
  let url = String(raw == null ? '' : raw).trim()
  if (!url) return ''
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url
  return url.replace(/\/+$/, '')
}

/**
 * Адреса, по которым стоит попробовать хост ПО ИМЕНИ, — до всякого UDP.
 *
 * Порт берём из текущего адреса: его задаёт сисадмин на хосте, и при переезде
 * между сетями он не меняется — меняется как раз IP.
 *
 * `.local` добавляем вторым: в сетях без NetBIOS (некоторые роутеры его режут)
 * имя резолвится только через mDNS, а там оно живёт именно с этим суффиксом.
 *
 * @param {{computer?: string, serverUrl?: string}} args
 * @returns {string[]} уникальные адреса, текущего среди них нет
 */
function hostNameCandidates({ computer, serverUrl } = {}) {
  const name = String(computer == null ? '' : computer).trim().replace(/\.+$/, '')
  if (!name || !NAME_RE.test(name)) return []
  const port = portOfUrl(serverUrl)
  if (!port) return []

  const names = [name]
  // Уже доменное имя (`nb-host.local`, `nb-host.corp`) вторым вариантом не
  // обрастает: `nb-host.local.local` не резолвится нигде.
  if (!name.includes('.')) names.push(name + '.local')

  const current = normalizeUrl(serverUrl)
  const out = []
  for (const n of names) {
    const url = 'http://' + n + ':' + port
    // Текущий адрес пропускаем: сторож только что убедился, что там не отвечают.
    if (url.toLowerCase() === current.toLowerCase()) continue
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/**
 * Свои IPv4-адреса (без loopback), отсортированные. По смене этого набора видно,
 * что ноутбук переключили в другую сеть, — а это единственный надёжный признак
 * «искать хост прямо сейчас, не дожидаясь отказов опроса».
 *
 * @param {object} interfaces результат os.networkInterfaces()
 */
function localIpv4s(interfaces) {
  const out = []
  for (const list of Object.values(interfaces || {})) {
    for (const ni of list || []) {
      if (!ni) continue
      const isV4 = ni.family === 'IPv4' || ni.family === 4
      if (!isV4 || ni.internal) continue
      if (typeof ni.address !== 'string' || !ni.address) continue
      if (!out.includes(ni.address)) out.push(ni.address)
    }
  }
  return out.sort()
}

/**
 * Набор адресов изменился? `null` слева — первое измерение (сравнивать не с чем),
 * это НЕ смена сети: иначе сторож начинал бы поиск при каждом запуске программы.
 */
function addressSetChanged(prev, next) {
  if (!Array.isArray(prev)) return false
  const a = [...prev].sort()
  const b = [...(next || [])].sort()
  if (a.length !== b.length) return true
  return a.some((x, i) => x !== b[i])
}

/**
 * Решение по ответам «кто здесь» (`who`), когда свой хост по личности не нашёлся.
 *
 * Такое бывает по одной бытовой причине: программу на хосте переустановили или
 * развернули копию на новом ноутбуке — личность в базе другая, и по ней хост не
 * отзовётся уже никогда. Единственная зацепка, оставшаяся у рабочего места, —
 * имя компьютера, записанное при первом знакомстве.
 *
 * Условия переезда жёсткие намеренно: в сети ровно ОДИН хост и его имя совпадает
 * с записанным. Два хоста — это две базы отдыха одного владельца в одной сети
 * (так у первого клиента и есть), и угадывать, чья стойка перед нами, нельзя.
 * Имя не совпало — перед нами чужая установка, ей рабочее место не отдаём.
 *
 * @param {{hosts?: Array<object>, hostComputer?: string}} args
 * @returns {{action:'move'|'ambiguous'|'mismatch'|'none', reason:string,
 *            host?:object, candidates?:Array<object>, ids?:string[]}}
 */
function decideWhoRebind({ hosts, hostComputer } = {}) {
  const list = Array.isArray(hosts) ? hosts.filter((h) => h && h.id && h.url) : []
  if (!list.length) return { action: 'none', reason: 'никто не ответил' }
  if (!normalizeComputer(hostComputer)) {
    return { action: 'none', reason: 'имя компьютера хоста не записано' }
  }

  // Один хост с двумя сетевыми картами отвечает дважды — это не «несколько
  // хостов». Считаем по личностям, а не по адресам.
  const ids = [...new Set(list.map((h) => String(h.id)))]
  if (ids.length > 1) {
    return { action: 'ambiguous', reason: 'в сети хостов: ' + ids.length, ids, candidates: list }
  }

  const candidates = list.filter((h) => String(h.id) === ids[0])
  const host = candidates[0]
  if (!sameComputer(host.computer, hostComputer)) {
    return { action: 'mismatch', reason: 'имя компьютера не совпало', host, candidates, ids }
  }
  return { action: 'move', reason: 'имя компьютера совпало', host, candidates, ids }
}

/**
 * Текст для человека у полосы «Нет связи с сервером». Кнопку жмёт администратор
 * стойки, а не сисадмин, поэтому в тексте — что делать руками, а не код ошибки.
 *
 * @param {{ok?:boolean, url?:string, reason?:string, computer?:string}} res
 * @returns {{ok:boolean, message:string, url?:string}}
 */
function rebindMessage(res = {}) {
  if (res.ok && res.url) {
    return { ok: true, url: res.url, message: 'Хост найден по адресу ' + res.url + ', перезапускаю' }
  }
  if (res.reason === 'other-install') {
    const who = res.computer ? '«' + res.computer + '»' : 'другой компьютер'
    return { ok: false, message: 'Найден хост ' + who + ', но это другая установка — обратитесь к сисадмину' }
  }
  if (res.reason === 'already-here') {
    // Кнопку часто жмут в ту секунду, когда связь уже вернулась. Честный ответ
    // здесь лучше «не найден»: искать нечего, хост на месте.
    return { ok: false, message: 'Хост отвечает по прежнему адресу — связь вот-вот восстановится' }
  }
  if (res.reason === 'not-client') {
    return { ok: false, message: 'Это рабочее место настроено как хост — искать хост в сети незачем' }
  }
  return {
    ok: false,
    message: 'Хост не найден: проверьте, что оба ноутбука в одной сети Wi-Fi ' +
      '(гостевая сеть часто изолирует устройства) и что на хосте запущена программа',
  }
}

module.exports = {
  NAME_RE,
  normalizeComputer,
  sameComputer,
  portOfUrl,
  normalizeUrl,
  hostNameCandidates,
  localIpv4s,
  addressSetChanged,
  decideWhoRebind,
  rebindMessage,
}
