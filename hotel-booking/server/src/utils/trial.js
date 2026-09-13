/**
 * Пробный период: 14 дней без ключа лицензии.
 *
 * До 12.09.2026 программа без ключа работала вечно, а «Лицензия не введена»
 * висела полосой, которая ничему не мешала. Теперь без ключа программа работает
 * TRIAL_DAYS дней с первого старта, после чего гейт (`middleware/license.js`)
 * закрывает всё, кроме входа и ввода ключа — так же, как по концу обслуживания.
 *
 * Начало срока хранится в базе (`HotelSettings.trialStartedAt`), а не в
 * `config.json` Electron: при переезде на новый ноутбук едет копия базы, и срок
 * должен ехать вместе с бронями, а не обнуляться от переустановки. Ставит его
 * сервер при первом старте — тогда же, когда пишет личность установки
 * (`instanceIdentity.js`) — и лениво при первом чтении, если строка появилась
 * позже (мастер первого запуска, восстановление копии старого образца).
 *
 * Действующий ключ отменяет пробный период целиком: с ним гейт сюда не смотрит.
 * Ключ, который не читается (`invalid`), пробный период НЕ продлевает — иначе
 * любая строка в таблице License была бы вечной лицензией.
 *
 * ROOMLINE_TRIAL_DAYS (0 — закрыть сразу) — ручной обход ТОЛЬКО В РАЗРАБОТКЕ И
 * ТЕСТАХ; в установленной программе не читается вовсе (`NODE_ENV=production`,
 * `utils/devOverride.js`): она наследует окружение Windows, и `setx` делал бы срок
 * вечным (S13-011). Продлить пробный период у клиента по телефону этой переменной
 * нельзя — для этого выписывается ключ лицензии.
 */

const { localDateISO } = require('./hotelTz')
const { devEnv } = require('./devOverride')

const DEFAULT_TRIAL_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/** Сколько дней длится пробный период. Мусор в переменной — значение по умолчанию. */
function trialDays() {
  const raw = devEnv('ROOMLINE_TRIAL_DAYS')
  if (raw === undefined || raw === '') return DEFAULT_TRIAL_DAYS
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_TRIAL_DAYS
}

/**
 * Чистая функция: момент начала → состояние срока на момент `now`.
 *
 *  startedAt / endsAt — ISO-моменты (endsAt — когда программа закроется);
 *  lastDay  — последний рабочий день по времени отеля, 'YYYY-MM-DD' — для текста
 *             «пробный период до …»;
 *  daysLeft — целых дней до конца, с округлением вверх: за час до конца это ещё
 *             «1 день», а не «0»;
 *  expired  — срок вышел.
 *
 * Срок не задан (строки настроек ещё нет) → не истёк: закрывать программу за то,
 * что сервер не успел записать дату, нельзя.
 */
function evaluateTrial(startedAt, now = new Date(), days = trialDays()) {
  const start = startedAt instanceof Date ? startedAt : startedAt ? new Date(startedAt) : null
  if (!start || Number.isNaN(start.getTime())) {
    return { startedAt: null, endsAt: null, lastDay: null, daysLeft: null, expired: false, days }
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const endMs = start.getTime() + days * DAY_MS
  const msLeft = endMs - nowMs
  const expired = msLeft <= 0
  return {
    startedAt: start.toISOString(),
    endsAt: new Date(endMs).toISOString(),
    lastDay: localDateISO(new Date(endMs - 1)),
    daysLeft: expired ? 0 : Math.ceil(msLeft / DAY_MS),
    expired,
    days,
  }
}

// ————————————————————————————————————————————————————————————————
// Чтение из базы, с кэшем
// ————————————————————————————————————————————————————————————————

const { prisma: defaultPrisma } = require('./prisma')

/** Дата не меняется после записи, но копия старого образца может её обнулить —
 *  поэтому кэш с TTL, а не «раз за жизнь процесса». */
const CACHE_TTL_MS = 60 * 1000
let cached          // Date | null
let cachedAt = 0

function resetTrialCache() {
  cached = undefined
  cachedAt = 0
}

/**
 * Проставляет начало срока, если строка настроек есть, а даты в ней нет.
 * Условная запись (`trialStartedAt: null` в `where`): два процесса на старте
 * (надзор Electron поднимает сервер, старый ещё жив) не должны перезаписать
 * друг друга более поздней датой.
 *
 * Возвращает дату из базы или null, если строки настроек ещё нет (свежая
 * установка до мастера — строку создаст `ensureIdentity` или сам мастер).
 */
async function ensureTrialStart(prisma = defaultPrisma) {
  const row = await prisma.hotelSettings.findUnique({ where: { id: 1 }, select: { trialStartedAt: true } })
  if (!row) return null
  if (row.trialStartedAt) return remember(row.trialStartedAt)
  await prisma.hotelSettings.updateMany({ where: { id: 1, trialStartedAt: null }, data: { trialStartedAt: new Date() } })
  const fresh = await prisma.hotelSettings.findUnique({ where: { id: 1 }, select: { trialStartedAt: true } })
  return remember(fresh ? fresh.trialStartedAt : null)
}

function remember(value) {
  cached = value || null
  cachedAt = Date.now()
  return cached
}

/** Начало срока из кэша или из базы. Ошибку базы НЕ глотает — решает вызывающий. */
async function loadTrialStart(prisma = defaultPrisma) {
  if (cached !== undefined && Date.now() - cachedAt < CACHE_TTL_MS) return cached
  return ensureTrialStart(prisma)
}

/** Состояние пробного периода по данным базы. */
async function getTrialState(prisma = defaultPrisma, now = new Date()) {
  return evaluateTrial(await loadTrialStart(prisma), now)
}

function expiredMessage(trial) {
  const when = trial && trial.lastDay ? ` ${trial.lastDay.split('-').reverse().join('.')}` : ''
  return `Пробный период закончился${when}. Чтобы продолжить работу, введите ключ лицензии. Данные не тронуты.`
}

module.exports = {
  DEFAULT_TRIAL_DAYS,
  trialDays,
  evaluateTrial,
  ensureTrialStart,
  loadTrialStart,
  getTrialState,
  resetTrialCache,
  expiredMessage,
}
