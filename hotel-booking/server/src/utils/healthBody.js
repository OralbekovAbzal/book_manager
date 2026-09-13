/**
 * Тело ответа `GET /api/health`.
 *
 * Вынесено из `app.js` отдельной чистой функцией по двум причинам. Первая: этот
 * ответ читают трое — надзор Electron («сервер поднялся»), кнопка «Проверить
 * связь» на рабочем месте и поиск хоста в сети, — и формат для них должен быть
 * один, проверяемый без поднятия Express. Вторая: сюда добавился блок `instance`,
 * то есть health стал ещё и подтверждением личности хоста, а это место, где
 * ошибка тихо превращается в «клиент подключился не туда».
 *
 * Почему подтверждение личности живёт именно в health. Объявление по UDP
 * рассказывает, ГДЕ хост; но датаграмму мог послать кто угодно. Прежде чем
 * сохранить адрес, рабочее место обращается к найденному адресу по HTTP со своим
 * одноразовым `nonce` и сверяет подпись с публичным ключом, который у него уже
 * записан. Health для этого подходит лучше нового роута: он публичный (иначе
 * проверять было бы нечем — токена ещё нет) и есть на любой версии сервера.
 *
 * `nonce` обязателен для ПОДПИСИ, но не для ответа: без него отдаются только `id`
 * и публичный ключ — то, что и так объявляется в сети. Мусор вместо nonce — не
 * ошибка запроса (400), а просто «подписи не будет»: health зовут надзор и
 * мониторинг, и уронить им проверку живости из-за кривого параметра нельзя.
 */

const os = require('os')
const { publicIdentity, signChallenge } = require('./instanceIdentity')

/**
 * Ровно 32 шестнадцатеричные цифры в нижнем регистре — как их шлёт клиент.
 * Жёстко, потому что nonce попадает в подписываемую строку: свободный формат
 * означал бы подпись под произвольным текстом, который выбирает чужой.
 */
const NONCE_RE = /^[0-9a-f]{32}$/

/**
 * Имя компьютера хоста и порт сервера.
 *
 * Зачем оно в health. IP хоста меняет DHCP, а имя компьютера — нет, и Windows
 * умеет резолвить его сама (NetBIOS/LLMNR/mDNS) там, где наше широковещание не
 * проходит: гостевой Wi-Fi изолирует устройства, а правило брандмауэра на
 * входящие датаграммы есть не в каждой сети. Рабочее место запоминает имя при
 * первом удачном подключении и после смены сети пробует `http://<имя>:<порт>`
 * ПЕРВЫМ делом — до всякого поиска (`electron/lib/hostRebind.js`).
 *
 * Отдаём ровно два поля и ничего больше: health публичный, отвечает без токена,
 * и всё лишнее в нём (пользователь, версия Windows, список адресов) — это
 * подарок тому, кто просто слушает сеть отеля.
 */
function hostDescriptor({ hostname, port } = {}) {
  const computer = String(
    hostname === undefined ? (os.hostname() || '') : (hostname == null ? '' : hostname),
  ).trim()
  const raw = port === undefined ? process.env.PORT : port
  // Тот же разбор, что в `server.js` (`process.env.PORT || 3001`): порт в ответе
  // обязан совпадать с тем, на котором сервер реально слушает, иначе клиент
  // построит по имени адрес с чужим портом.
  const n = Number(raw)
  const value = Number.isInteger(n) && n > 0 && n < 65536 ? n : 3001
  return { computer, port: value }
}

/**
 * @param {{ db: 'ok'|'down', identity?: object|null, nonce?: unknown,
 *           hostname?: string, port?: number|string }} args
 * @returns {{ status: string, db: string, timestamp: string, host: object, instance?: object }}
 */
function buildHealthBody({ db, identity = null, nonce, hostname, port } = {}) {
  const body = {
    status: db === 'ok' ? 'ok' : 'degraded',
    db,
    timestamp: new Date().toISOString(),
    host: hostDescriptor({ hostname, port }),
  }

  // Личности нет (свежая база, беда с базой и пустой кэш) — блока `instance`
  // нет вовсе. Пустой объект здесь хуже отсутствия: клиент решил бы, что хост
  // отвечает «моя личность — ничто», и записал бы это себе.
  if (!identity) return body

  body.instance = publicIdentity(identity)
  if (typeof nonce === 'string' && NONCE_RE.test(nonce)) {
    const sig = signChallenge(identity, `${identity.id}|${nonce}`)
    if (sig) body.instance.sig = sig
  }
  return body
}

module.exports = { buildHealthBody, hostDescriptor, NONCE_RE }
