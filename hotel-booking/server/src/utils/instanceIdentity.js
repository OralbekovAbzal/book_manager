/**
 * Личность установки: по ней рабочее место узнаёт СВОЙ хост в локальной сети.
 *
 * Почему она вообще нужна. Рабочие места ходят на хост по адресу, а адрес в
 * гостиничном вайфае живёт до следующей раздачи DHCP или до смены роутера. Искать
 * хост по IP нельзя: сегодня он 192.168.1.7, завтра .12, а в соседнем корпусе
 * может стоять вторая база отдыха того же владельца — и рабочее место радостно
 * подключится к чужим броням. Поэтому у установки есть неизменный `instanceId`
 * и пара ключей Ed25519: хост подписывает ответ на запрос поиска, клиент
 * проверяет подпись публичным ключом — и знает, что нашёл именно свой хост, а не
 * чужую программу и не того, кто притворился ею в общей сети.
 *
 * Почему личность в БАЗЕ, а не в `config.json` Electron. `config.json` лежит в
 * `%APPDATA%` и при переезде на новый ноутбук не едет — едет резервная копия
 * базы. Личность внутри базы переезжает вместе с бронями: восстановили копию —
 * и все рабочие места находят хост сами, без обхода стойки с перенастройкой.
 * Обратное означало бы, что смена ноутбука = новая личность = «программа
 * перестала видеть сервер» у всех сразу.
 *
 * Приватный ключ НИКОГДА не покидает сервер: ни в ответе API (`GET /api/hotel`
 * отдаёт настройки по белому списку), ни в объявлении по сети, ни в логах.
 * Наружу уходит только `publicIdentity()` — id и публичная половина.
 */

const crypto = require('crypto')
const logger = require('./logger')

/**
 * Кэш живёт 30 секунд, а не вечно. Личность почти неизменна, но «почти»: после
 * восстановления резервной копии в строке настроек оказывается ЧУЖАЯ (правильная)
 * личность, а процесс сервера тот же. Без TTL хост продолжал бы объявлять
 * прежний id до перезапуска, и клиенты не нашли бы его после переноса данных.
 */
const CACHE_TTL_MS = 30 * 1000

const SELECT = { instanceId: true, instancePublicKey: true, instancePrivateKey: true }

let cached = null
/** Когда последний раз ХОДИЛИ в базу (а не когда получили ответ) — см. getIdentity. */
let cachedAt = 0

/** Пара Ed25519 в PEM + новый id. Ключи генерируются здесь, а не в SQL: дефолта нет. */
function generateIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    instanceId: crypto.randomUUID(),
    instancePublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    instancePrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** Строка настроек → личность. Неполная (не все три поля) считается отсутствующей. */
function fromRow(row) {
  if (!row || !row.instanceId || !row.instancePublicKey || !row.instancePrivateKey) return null
  return { id: row.instanceId, publicKey: row.instancePublicKey, privateKey: row.instancePrivateKey }
}

function remember(identity) {
  if (identity) {
    cached = identity
    cachedAt = Date.now()
  }
  return identity
}

function read(prisma) {
  return prisma.hotelSettings.findUnique({ where: { id: 1 }, select: SELECT })
}

/**
 * Личность установки; если её ещё нет — создаёт. Зовётся один раз при старте.
 *
 * Обе гонки здесь настоящие, а не теоретические: надзор Electron поднимает
 * сервер заново через секунду после падения, и старый процесс в этот момент может
 * быть ещё жив; строку `id = 1` независимо создаёт мастер первого запуска и
 * `hotelController.getSettings()`. Поэтому запись идёт условно (`updateMany` с
 * `instanceId: null` в `where`) и проигравший гонку просто перечитывает
 * победителя — две личности у одной базы недопустимы: половина рабочих мест
 * искала бы хост с id, которого уже нет.
 */
async function ensureIdentity(prisma) {
  const row = await read(prisma)
  const existing = fromRow(row)
  if (existing) return remember(existing)

  if (!row) {
    try {
      const created = await prisma.hotelSettings.create({ data: { id: 1, ...generateIdentity() } })
      const identity = fromRow(created)
      if (identity) return remember(identity)
    } catch (err) {
      // P2002 — строку успел создать кто-то другой (мастер, соседний процесс).
      // Это не ошибка старта: перечитываем и работаем с тем, что там оказалось.
      if (!err || err.code !== 'P2002') throw err
    }
    const after = fromRow(await read(prisma))
    if (after) return remember(after)
  }

  // Строка есть, личности нет (база из копии старого образца или созданная
  // мастером). Пишем свою — но только если её действительно ещё никто не записал.
  const { count } = await prisma.hotelSettings.updateMany({
    where: { id: 1, instanceId: null },
    data: generateIdentity(),
  })
  const fresh = fromRow(await read(prisma))
  if (!fresh) {
    // Ни своей записи, ни чужой — значит поля в базе неполные (например, есть id
    // без ключей). Молчать нельзя: без личности хост в сети не найдут.
    logger.warn('instance: личность установки не записана — поиск хоста в сети работать не будет')
    return null
  }
  if (count === 0) logger.info('instance: личность установки записал другой процесс — используем её')
  return remember(fresh)
}

/**
 * Текущая личность из кэша или из базы.
 *
 * При ЛЮБОЙ ошибке базы отдаём последнее известное значение, а не ошибку:
 * `/api/health` и объявление хоста в сети нужны ровно тогда, когда база лежит, —
 * это единственный способ для рабочего места отличить «хост не отвечает» от
 * «хост жив, но у него беда с базой». Если известного нет — `null`, и тогда
 * ответ просто идёт без блока `instance`.
 *
 * Окно TTL считается от ПОПЫТКИ, а не от удачного ответа: пока база лежит,
 * health и сторож клиента дёргаются по разу в секунду, и без этого каждый такой
 * запрос добавлял бы к упавшей базе ещё один заведомо неудачный.
 */
async function getIdentity(prisma) {
  if (Date.now() - cachedAt < CACHE_TTL_MS) return cached
  cachedAt = Date.now()
  try {
    // База ответила — её ответ и есть правда, даже если это «личности нет»
    // (свежая установка): старую в таком случае не выдаём.
    cached = fromRow(await read(prisma))
    return cached
  } catch {
    return cached
  }
}

/** То, что можно показывать наружу. Приватный ключ сюда физически не попадает. */
function publicIdentity(idn) {
  if (!idn) return null
  return { id: idn.id, publicKey: idn.publicKey }
}

/**
 * Подпись строки-вызова приватным ключом, base64url.
 *
 * Подписывается именно СТРОКА, собранная вызывающим (`${id}|${port}|${nonce}`
 * в сети, `${id}|${nonce}` в health): что подписано, то и проверяется, без
 * зависимости от порядка полей в JSON. `nonce` от клиента обязателен — иначе
 * старый перехваченный ответ годился бы как доказательство навсегда.
 */
function signChallenge(idn, str) {
  if (!idn || !idn.privateKey) return null
  try {
    return crypto.sign(null, Buffer.from(String(str), 'utf8'), idn.privateKey).toString('base64url')
  } catch (err) {
    logger.warn(`instance: не удалось подписать вызов: ${err.message}`)
    return null
  }
}

/** Только для тестов: кэш — модульный, между проверками его надо обнулять. */
function resetIdentityCache() {
  cached = null
  cachedAt = 0
}

module.exports = {
  generateIdentity,
  ensureIdentity,
  getIdentity,
  publicIdentity,
  signChallenge,
  resetIdentityCache,
  CACHE_TTL_MS,
}
