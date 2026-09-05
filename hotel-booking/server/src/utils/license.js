/**
 * Офлайн-лицензия Qonaq.
 *
 * Почему так, а не онлайн-проверка: программа стоит в отеле, где интернета может
 * не быть неделями. Любой поход на сервер лицензий превращается в «программа не
 * запускается, потому что упал вайфай» — это дороже, чем любая защита.
 * Поэтому ключ самодостаточен: всё, что нужно знать программе, лежит внутри него
 * и подписано Ed25519. Проверка — чистая математика, без сети.
 *
 * Почему НЕ привязываемся к железу: замена ноутбука на стойке — рядовое событие,
 * а перевыпуск ключа по телефону в выходной — главная боль поддержки у всех, кто
 * так делает. Ключ привязан к НАЗВАНИЮ объекта: скопировать его соседней базе
 * отдыха технически можно, но там будет чужое название в шапке программы.
 *
 * Формат ключа:  QONAQ-<payload>.<signature>
 *   payload   — base64url(JSON { v, id, hotel, rooms, issuedAt, maintenanceUntil })
 *   signature — base64url(Ed25519-подпись над СТРОКОЙ payload как она передана)
 *
 * Подписывается именно строка base64url, а не разобранный JSON: так проверка не
 * зависит от порядка полей и от того, как конкретный JSON.stringify расставит
 * пробелы. Байты, которые подписаны, и байты, которые проверяются, — одни и те же.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const KEY_PREFIX = 'QONAQ-'
const SUPPORTED_VERSION = 1

/**
 * Публичная половина ключа выпуска. Приватная лежит ТОЛЬКО у разработчика
 * (см. scripts/license-issue.js --keygen) и в репозиторий не попадает никогда:
 * потеряешь её — новые ключи выпускать нечем, утечёт — ключи сможет печатать кто угодно.
 *
 * `let`, а не `const`, намеренно: приватной половины в репозитории нет, поэтому
 * тесты подменяют пару целиком (test/license.test.js) — иначе проверить путь
 * «ключ из базы → лимит номеров» было бы нечем. Из переменной окружения ключ
 * НЕ читается: это была бы дыра размером со всю подпись.
 */
let PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA6DMURoycmFKkJ8787EqQDwUsnSUlRSLuZFJ43rlgy/A=
-----END PUBLIC KEY-----`

// ————————————————————————————————————————————————————————————————
// base64url
// ————————————————————————————————————————————————————————————————

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Возвращает Buffer либо null, если строка не base64url (а не молча мусор). */
function b64urlDecode(str) {
  if (typeof str !== 'string' || str.length === 0) return null
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
  } catch {
    return null
  }
}

// ————————————————————————————————————————————————————————————————
// Даты
// ————————————————————————————————————————————————————————————————

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(v) {
  if (typeof v !== 'string' || !ISO_DATE.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  // Отсекает 2027-02-31: Date молча перекинет на март, и даты в ключе разъедутся.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/**
 * Даты сравниваем СТРОКАМИ 'YYYY-MM-DD'.
 * Формат фиксированной ширины, поэтому лексикографический порядок совпадает с
 * хронологическим, и мы не втаскиваем сюда часовые пояса: у сборки и у ключа
 * дата — это календарный день, а не момент времени.
 */
function isoToday() {
  // Именно ЛОКАЛЬНЫЙ календарный день, а не toISOString(): скрипт выпуска ключей
  // работает на машине разработчика в UTC+5, и до утра «сегодня» по UTC — это
  // вчера (те же грабли, что у todayUTC() в businessDate.js). В самом сервере
  // разницы нет: server.js принудительно ставит TZ=UTC.
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** '2027-09-06' → '06.09.2027' — для текста, который читает администратор отеля. */
function formatRu(iso) {
  if (!isIsoDate(iso)) return String(iso ?? '')
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** 'YYYY-MM-DD' → Date UTC-полночь (так же, как даты `@db.Date` лежат в базе). */
function isoToUtcDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

/** Date из базы → 'YYYY-MM-DD' по UTC. */
function utcDateToIso(dt) {
  return dt instanceof Date && !Number.isNaN(dt.getTime()) ? dt.toISOString().slice(0, 10) : null
}

// ————————————————————————————————————————————————————————————————
// Выпуск ключа (у разработчика) и проверка (в программе)
// ————————————————————————————————————————————————————————————————

/**
 * Выпускает ключ. Вынесено отдельной функцией, потому что позже отсюда же будет
 * выпускать ключи отдельное приложение «для себя» — скрипт scripts/license-issue.js
 * это тонкая обёртка над этой функцией и ничего своего не считает.
 *
 * @param {string} privateKeyPem приватный ключ Ed25519 в PEM
 * @param {{hotel: string, rooms: number, maintenanceUntil: string, issuedAt?: string, id?: string}} opts
 * @returns {{key: string, payload: object}}
 */
function issueLicense(privateKeyPem, { hotel, rooms, maintenanceUntil, issuedAt, id } = {}) {
  if (typeof hotel !== 'string' || hotel.trim() === '') {
    throw new Error('hotel: название объекта обязательно')
  }
  if (!Number.isInteger(rooms) || rooms < 1) {
    throw new Error('rooms: нужно целое число номеров больше нуля')
  }
  if (!isIsoDate(maintenanceUntil)) {
    throw new Error('maintenanceUntil: дата в формате ГГГГ-ММ-ДД')
  }
  if (issuedAt !== undefined && !isIsoDate(issuedAt)) {
    throw new Error('issuedAt: дата в формате ГГГГ-ММ-ДД')
  }

  let key
  try {
    key = crypto.createPrivateKey(privateKeyPem)
  } catch (e) {
    throw new Error(`Приватный ключ не читается: ${e.message}`)
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`Приватный ключ должен быть Ed25519, а не ${key.asymmetricKeyType}`)
  }

  const payload = {
    v: SUPPORTED_VERSION,
    // id нужен разработчику, а не программе: по нему в своём учёте видно,
    // какой именно ключ у клиента, если их выпущено несколько.
    id: id || crypto.randomUUID(),
    hotel: hotel.trim(),
    rooms,
    issuedAt: issuedAt || isoToday(),
    maintenanceUntil,
  }

  const payloadB64 = b64urlEncode(JSON.stringify(payload))
  const signature = crypto.sign(null, Buffer.from(payloadB64, 'utf8'), key)
  return { key: `${KEY_PREFIX}${payloadB64}.${b64urlEncode(signature)}`, payload }
}

/** Пара ключей для выпуска. Приватный печатается вызывающему, никуда не пишется. */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const PARSE_ERRORS = {
  malformed: 'Ключ повреждён',
  bad_signature: 'Подпись не сходится',
  unknown_version: 'Неизвестная версия ключа — нужна более новая версия программы',
}

/**
 * Проверяет ключ. Ничего не знает про базу и про дату сборки — только математика
 * и форма данных.
 *
 * @returns {{valid: true, payload: object} | {valid: false, code: string, message: string}}
 */
function parseLicenseKey(rawKey, { publicKeyPem = PUBLIC_KEY_PEM } = {}) {
  const bad = (code) => ({ valid: false, code, message: PARSE_ERRORS[code] })

  if (typeof rawKey !== 'string') return bad('malformed')
  // Ключ администратор копирует из письма или из .txt — пробелы и переносы строк
  // прилипают почти всегда. В base64url их быть не может, так что выкидываем молча.
  const key = rawKey.replace(/\s+/g, '')
  if (!key.startsWith(KEY_PREFIX)) return bad('malformed')

  const body = key.slice(KEY_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0 || dot === body.length - 1) return bad('malformed')
  const payloadB64 = body.slice(0, dot)
  const sigB64 = body.slice(dot + 1)

  const payloadBytes = b64urlDecode(payloadB64)
  const signature = b64urlDecode(sigB64)
  if (!payloadBytes || !signature) return bad('malformed')

  let payload
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    return bad('malformed')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad('malformed')

  // Подпись проверяется ДО разбора полей: иначе самодельный payload с v: 2
  // получил бы вежливое «неизвестная версия» вместо честного «подпись не сходится».
  let ok = false
  try {
    ok = crypto.verify(null, Buffer.from(payloadB64, 'utf8'), publicKeyPem, signature)
  } catch {
    ok = false
  }
  if (!ok) return bad('bad_signature')

  if (payload.v !== SUPPORTED_VERSION) return bad('unknown_version')

  if (typeof payload.hotel !== 'string' || payload.hotel.trim() === '') return bad('malformed')
  if (!Number.isInteger(payload.rooms) || payload.rooms < 1) return bad('malformed')
  if (!isIsoDate(payload.issuedAt) || !isIsoDate(payload.maintenanceUntil)) return bad('malformed')

  return { valid: true, payload }
}

// ————————————————————————————————————————————————————————————————
// Дата сборки
// ————————————————————————————————————————————————————————————————

let pkgBuildDateCache
function buildDateFromPackage() {
  if (pkgBuildDateCache !== undefined) return pkgBuildDateCache
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'))
    pkgBuildDateCache = isIsoDate(pkg.buildDate) ? pkg.buildDate : null
  } catch {
    pkgBuildDateCache = null
  }
  return pkgBuildDateCache
}

/**
 * Дата выпуска ЭТОЙ сборки, 'YYYY-MM-DD' или null.
 *
 * Штамп ставится в server/package.json при упаковке (scripts/stamp-build-date.js,
 * вызывается из `npm run build:electron`), поэтому в установленной у клиента
 * программе дата настоящая и не меняется от того, какое сегодня число.
 * QONAQ_BUILD_DATE — ручной обход для тестов и разбора обращений.
 *
 * null (в репозитории поля нет) означает «дата неизвестна» — и тогда гейт
 * обслуживания НЕ включается. Это сознательный выбор в пользу клиента: доказать,
 * что сборка новее оплаченного обслуживания, мы в этом случае не можем.
 */
function getBuildDate() {
  const fromEnv = process.env.QONAQ_BUILD_DATE
  if (isIsoDate(fromEnv)) return fromEnv
  return buildDateFromPackage()
}

// ————————————————————————————————————————————————————————————————
// Состояние лицензии
// ————————————————————————————————————————————————————————————————

/**
 * Чистая функция: строка ключа + дата сборки → состояние.
 *
 *  none    — ключа нет. Программа работает ПОЛНОСТЬЮ (демо, первый показ),
 *            лимита номеров нет, клиент показывает полосу «Лицензия не введена».
 *  invalid — ключ есть, но не проходит проверку. Тоже ничего не ограничиваем:
 *            смысл ключа — учёт и обновления, а не борьба с пользователем.
 *  expired — ключ хороший, но обслуживание кончилось РАНЬШЕ, чем выпущена эта
 *            сборка. Единственный настоящий рычаг: см. maintenanceGate.
 *  ok      — всё в порядке.
 */
function evaluateLicense(keyString, buildDate = getBuildDate()) {
  if (!keyString) return { state: 'none', payload: null, message: null }

  const parsed = parseLicenseKey(keyString)
  if (!parsed.valid) return { state: 'invalid', payload: null, message: parsed.message, code: parsed.code }

  const p = parsed.payload
  const expired = Boolean(buildDate) && p.maintenanceUntil < buildDate
  return { state: expired ? 'expired' : 'ok', payload: p, message: null }
}

/** Сводка для API и для клиента. roomsUsed добавляет вызывающий (он ходит в базу). */
function describeLicense(keyString, buildDate = getBuildDate()) {
  const ev = evaluateLicense(keyString, buildDate)
  const p = ev.payload
  return {
    state: ev.state,
    hotel: p ? p.hotel : null,
    rooms: p ? p.rooms : null,
    issuedAt: p ? p.issuedAt : null,
    maintenanceUntil: p ? p.maintenanceUntil : null,
    buildDate: buildDate || null,
    // Кончилось ли обслуживание ПО СЕГОДНЯШНЕМУ ЧИСЛУ — это не то же самое, что
    // state: 'expired'. Программа с оплаченной когда-то сборкой работает вечно,
    // но клиенту полезно видеть мягкое «пора продлевать», пока он не обновился.
    maintenanceActive: p ? p.maintenanceUntil >= isoToday() : null,
    message: ev.message,
  }
}

// ————————————————————————————————————————————————————————————————
// Кэш: ключ читается из базы один раз за жизнь процесса
// ————————————————————————————————————————————————————————————————

const { prisma } = require('./prisma')

let cachedRow          // { key } | null — сама строка License
let cacheLoaded = false

function resetLicenseCache() {
  cachedRow = undefined
  cacheLoaded = false
}

/**
 * Строка License из базы, с кэшем. Ошибку базы НЕ глотает: вызывающий решает сам
 * (гейт, например, при недоступной базе просто пропускает запрос дальше —
 * иначе падение Postgres выглядело бы как «кончилась лицензия»).
 */
async function loadLicenseRow() {
  if (cacheLoaded) return cachedRow
  const row = await prisma.license.findUnique({ where: { id: 1 } })
  cachedRow = row || null
  cacheLoaded = true
  return cachedRow
}

/** Состояние лицензии по данным из базы (через кэш). */
async function getLicenseState() {
  const row = await loadLicenseRow()
  return evaluateLicense(row ? row.key : null)
}

/**
 * Сколько активных номеров разрешено ключом, или null, если ограничения нет
 * (ключа нет / ключ не читается).
 */
async function getRoomLimit() {
  const { state, payload } = await getLicenseState()
  if (state === 'none' || state === 'invalid') return null
  return payload.rooms
}

const roomLimitMessage = (limit) =>
  `Лицензия на ${limit} номеров; чтобы добавить — обратитесь к поставщику`

module.exports = {
  KEY_PREFIX,
  SUPPORTED_VERSION,
  PUBLIC_KEY_PEM,
  issueLicense,
  generateKeyPair,
  parseLicenseKey,
  evaluateLicense,
  describeLicense,
  getBuildDate,
  getLicenseState,
  getRoomLimit,
  roomLimitMessage,
  loadLicenseRow,
  resetLicenseCache,
  isIsoDate,
  isoToday,
  isoToUtcDate,
  utcDateToIso,
  formatRu,
}
