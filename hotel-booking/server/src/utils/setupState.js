const bcrypt = require('bcryptjs')
const logger = require('./logger')

/**
 * Гейт мастера первого запуска (D1-001).
 *
 * Мастер публичен — на свежей установке входить некому. Раньше единственной
 * преградой была отметка `HotelSettings.setupCompletedAt`, и любой сценарий, где
 * она пропадала (восстановление копии без строки HotelSettings, база, заведённая
 * до появления мастера), открывал всей сети возможность одним POST без пароля
 * переименовать существующего SUPER_ADMIN и забрать программу себе.
 *
 * Решение владельца: мастер работает ТОЛЬКО на нетронутой базе. «Нетронутая» —
 * это состав учётных записей ровно такой, каким его оставил сид: пусто или одна
 * `admin` с сидовым паролем. Отметка перестала быть единственной защитой:
 * пропала она — но учётки уже настоящие — значит настройка давно пройдена, и
 * отметку надо восстановить, а не открывать мастер.
 */

const SEED_USERNAME = 'admin'
// Сид до 07.09 ставил admin123, после — admin. На машине клиента может быть
// любой из двух, и оба одинаково «никто ещё не настраивал».
const SEED_PASSWORDS = ['admin', 'admin123']

/**
 * Состав учёток — сидовый (значит мастер ещё уместен)?
 * @param {Array<{ username: string, password: string }>} admins — как есть из базы
 */
async function isSeedOnly(admins) {
  const list = Array.isArray(admins) ? admins : []
  if (list.length === 0) return true
  if (list.length > 1) return false

  const [only] = list
  if (!only || only.username !== SEED_USERNAME) return false

  for (const p of SEED_PASSWORDS) {
    try {
      // Пароль сидовый — значит учётку никто не присвоил. Если админ сменил
      // пароль сидовому `admin`, дальше это уже его учётка, а не сид.
      if (await bcrypt.compare(p, only.password)) return true
    } catch {
      // Мусор вместо bcrypt-хеша — точно не сид.
      return false
    }
  }
  return false
}

/**
 * @returns {Promise<{ needsSetup: boolean, hotelName: string|null, healed: boolean }>}
 * `healed` — отметку пришлось восстановить (наружу, в GET /status, не уходит).
 */
async function getSetupState(prisma, { heal = true } = {}) {
  const s = await prisma.hotelSettings.findUnique({
    where: { id: 1 },
    select: { name: true, setupCompletedAt: true },
  })
  const admins = await prisma.admin.findMany({ select: { username: true, password: true } })

  const marked = Boolean(s && s.setupCompletedAt)
  // bcrypt только когда его результат что-то решает: при стоящей отметке и
  // непустой таблице мастер закрыт без сверок. Иначе публичный /setup/status
  // стоил бы по полсекунды CPU на запрос — любой в сети занял бы сервер счётом
  // хешей (находка тестов волны 8).
  const seedOnly = marked && admins.length > 0 ? false : await isSeedOnly(admins)
  // Учёток нет вовсе (частично восстановленная копия) — войти некому, и отметка
  // ничего не защищает: мастер уместен независимо от неё.
  const needsSetup = admins.length === 0 || (!marked && seedOnly)

  let healed = false
  // Отметки нет, а учётки уже настоящие — это не «новая установка», а потерянная
  // отметка. Ставим её сами, чтобы мастер не всплыл на рабочем месте после
  // восстановления копии и не переписал живого администратора.
  if (!marked && !seedOnly && heal) {
    const now = new Date()
    await prisma.hotelSettings.upsert({
      where: { id: 1 },
      create: { id: 1, name: 'Отель', setupCompletedAt: now },
      update: { setupCompletedAt: now },
    })
    healed = true
    logger.warn('setup: отметка настройки восстановлена — в базе уже есть учётные записи')
  }

  return { needsSetup, hotelName: s ? s.name : null, healed }
}

module.exports = { SEED_USERNAME, SEED_PASSWORDS, isSeedOnly, getSetupState }
