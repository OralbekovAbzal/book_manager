/**
 * Гейт лицензии — два рычага в лицензировании Roomline PMS.
 *
 * 1. Пробный период (с 12.09.2026). Без ключа программа работает 14 дней с
 *    первого старта (`utils/trial.js`), потом закрывается до ввода ключа.
 *    Ключ, который не читается, срок не продлевает.
 * 2. Обслуживание. Правило: «обслуживание = право на обновления», а не право
 *    пользоваться программой. Поэтому блокируется не работа отеля, а работа
 *    СЛИШКОМ НОВОЙ сборки: если обслуживание кончилось раньше, чем выпущена
 *    эта версия, значит клиент поставил обновление, за которое не платил.
 *
 * Что при этом важно и чего мы НЕ делаем:
 *  - база не трогается ни на байт, откатиться на прежний установщик можно всегда;
 *  - сервер поднимается нормально (иначе Electron решил бы, что хост умер,
 *    и полез бы перезапускать его по кругу);
 *  - вход и раздел лицензии открыты — иначе ввести ключ было бы нечем.
 */

const { getLicenseState, getBuildDate, formatRu } = require('../utils/license')
const trial = require('../utils/trial')
const logger = require('../utils/logger')

/**
 * Что остаётся доступным при закрытом гейте.
 * `/api/health` — Electron ждёт по нему старта хоста; `/api/license` — ввод нового
 * ключа; `/api/auth/login` — чтобы было кому его вводить.
 */
const ALLOWED = ['/api/health', '/api/license', '/api/auth/login']

/**
 * Точные пути (без подпутей), открытые под гейтом. `POST /api/system/backup` —
 * резервная копия: её снимает и Electron при выходе (внутренний токен), и человек
 * кнопкой. Закрывать копию гейтом значило бы «в тот день, когда кончился пробный
 * период и данные нужно переносить, последней копии нет» (O13-013). Подпути
 * `/backup/upload` и `/backup/restore` остаются закрытыми: восстановление под
 * гейтом не нужно, а загрузка файла — тем более.
 */
const ALLOWED_EXACT = ['/api/system/backup']

const MAINTENANCE_EXPIRED = 'MAINTENANCE_EXPIRED'
const TRIAL_EXPIRED = 'TRIAL_EXPIRED'

function isAllowed(pathname) {
  if (ALLOWED_EXACT.some((p) => pathname === p || pathname === `${p}/`)) return true
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

  if (lic.state === 'expired') {
    const message = expiredMessage(lic.payload.maintenanceUntil)
    return res.status(402).json({
      code: MAINTENANCE_EXPIRED,
      message,
      // Дубль в `error` — чтобы общий обработчик ошибок на клиенте (он читает
      // именно это поле у всех остальных ответов) показал текст, а не «неизвестная ошибка».
      error: message,
      maintenanceUntil: lic.payload.maintenanceUntil,
      buildDate: getBuildDate(),
    })
  }

  // Ключа нет (или он не читается) — смотрим пробный период. С действующим
  // ключом (`ok`) сюда не доходим: срок ему не указ.
  if (lic.state === 'none' || lic.state === 'invalid') {
    let t
    try {
      t = await trial.getTrialState()
    } catch (err) {
      // Та же логика, что выше: лежащая база — не «кончился пробный период».
      logger.error(`maintenanceGate: не удалось прочитать пробный период — ${err.message}`)
      return next()
    }
    if (t.expired) {
      const message = trial.expiredMessage(t)
      return res.status(402).json({
        code: TRIAL_EXPIRED,
        message,
        error: message,
        trialEndsAt: t.lastDay,
        buildDate: getBuildDate(),
      })
    }
  }

  return next()
}

module.exports = { maintenanceGate, MAINTENANCE_EXPIRED, TRIAL_EXPIRED, ALLOWED, expiredMessage }
