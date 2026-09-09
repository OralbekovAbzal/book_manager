/**
 * Гейт обслуживания — единственный рычаг в лицензировании Roomline PMS.
 *
 * Правило: «обслуживание = право на обновления», а не право пользоваться
 * программой. Поэтому блокируется не работа отеля, а работа СЛИШКОМ НОВОЙ сборки:
 * если обслуживание кончилось раньше, чем выпущена эта версия, значит клиент
 * поставил обновление, за которое не платил.
 *
 * Что при этом важно и чего мы НЕ делаем:
 *  - база не трогается ни на байт, откатиться на прежний установщик можно всегда;
 *  - сервер поднимается нормально (иначе Electron решил бы, что хост умер,
 *    и полез бы перезапускать его по кругу);
 *  - вход и раздел лицензии открыты — иначе ввести продлённый ключ было бы нечем.
 */

const { getLicenseState, getBuildDate, formatRu } = require('../utils/license')
const logger = require('../utils/logger')

/**
 * Что остаётся доступным при закрытом гейте.
 * `/api/health` — Electron ждёт по нему старта хоста; `/api/license` — ввод нового
 * ключа; `/api/auth/login` — чтобы было кому его вводить.
 */
const ALLOWED = ['/api/health', '/api/license', '/api/auth/login']

const MAINTENANCE_EXPIRED = 'MAINTENANCE_EXPIRED'

function isAllowed(pathname) {
  return ALLOWED.some((p) => pathname === p || pathname === `${p}/` || pathname.startsWith(`${p}/`))
}

function expiredMessage(maintenanceUntil) {
  return (
    `Обслуживание закончилось ${formatRu(maintenanceUntil)}, а эта версия выпущена позже. ` +
    'Продлите обслуживание или установите прежнюю версию. Данные не тронуты.'
  )
}

async function maintenanceGate(req, res, next) {
  if (!req.path.startsWith('/api')) return next()
  // Preflight пропускаем всегда: 402 на OPTIONS браузер показал бы как ошибку CORS,
  // и вместо внятного текста про обслуживание клиент увидел бы «сеть недоступна».
  if (req.method === 'OPTIONS') return next()
  if (isAllowed(req.path)) return next()

  let lic
  try {
    lic = await getLicenseState()
  } catch (err) {
    // База недоступна — это не «кончилась лицензия». Пропускаем: об отсутствии
    // базы честнее расскажет тот запрос, которому она реально нужна.
    logger.error(`maintenanceGate: не удалось прочитать лицензию — ${err.message}`)
    return next()
  }

  if (lic.state !== 'expired') return next()

  const message = expiredMessage(lic.payload.maintenanceUntil)
  res.status(402).json({
    code: MAINTENANCE_EXPIRED,
    message,
    // Дубль в `error` — чтобы общий обработчик ошибок на клиенте (он читает
    // именно это поле у всех остальных ответов) показал текст, а не «неизвестная ошибка».
    error: message,
    maintenanceUntil: lic.payload.maintenanceUntil,
    buildDate: getBuildDate(),
  })
}

module.exports = { maintenanceGate, MAINTENANCE_EXPIRED, ALLOWED, expiredMessage }
