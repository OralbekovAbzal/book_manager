const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { prisma } = require('../utils/prisma')
const { revokeSessions } = require('../utils/sessions')

// `tv` — версия сессии (Admin.tokenVersion): middleware/auth.js и handshake
// сокета сверяют её с базой, несовпадение — 401. Та же функция продублирована
// в setupController.signToken — claims менять в обоих местах.
function signToken(admin) {
  return jwt.sign(
    { id: admin.id, role: admin.role, tv: admin.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
  )
}

// Разрешённая форма логина — ровно та же, что при создании учётки
// (`routes/users.js`, `routes/setup.js`). Ничего другого в базе появиться не может,
// значит на входе всё остальное можно отвергать не глядя.
const USERNAME_RE = /^[a-z0-9._-]+$/

/**
 * Запасной поиск учётки БЕЗ учёта регистра — для старых баз, где логин мог
 * сохраниться как `Admin` или `Aigerim` (сегодня все источники учёток пишут
 * нижний регистр).
 *
 * Почему перебором, а не фильтром Prisma. Раньше здесь стоял
 * `findFirst({ username: { equals, mode: 'insensitive' } })`, а Prisma
 * компилирует такой фильтр в `ILIKE` — и `%`, введённый в поле «Логин»,
 * находил ПЕРВУЮ учётку отеля (R13-S-004, подтверждено на демо-базе). Проверка
 * по `USERNAME_RE` убирает `%`, но `_` в логине разрешён, а в `ILIKE` он значит
 * «любой один символ»: `admin_2` нашёл бы и `admin12`. Экранировать его через
 * Prisma нечем (у `equals` нет `ESCAPE`), поэтому регистр складываем сами.
 * Таблица учёток отеля — это единицы строк, и лишний SELECT здесь дешевле
 * любого шаблона в SQL.
 */
async function findAdminIgnoringCase(normalized) {
  const rows = await prisma.admin.findMany({
    select: { id: true, username: true },
    orderBy: { id: 'asc' },
  })
  const hit = rows.find((r) => String(r.username || '').toLowerCase() === normalized)
  return hit ? prisma.admin.findUnique({ where: { id: hit.id } }) : null
}

async function login(req, res, next) {
  try {
    const { username, password } = req.body

    // Регистр логина не должен решать, пустят человека или нет (S13-007).
    // Точное совпадение — обычный путь (учётки создаются в нижнем регистре);
    // поиск без учёта регистра нужен старым базам, где логин мог сохраниться
    // как `Admin` или `Aigerim`, — иначе починка входа сломала бы вход им.
    const normalized = (typeof username === 'string' ? username : '').trim().toLowerCase()
    // Вторая проверка формы логина (первая — в `loginRules`): в базу уходит
    // только то, что могло там оказаться. Отказ выглядит как обычный неверный
    // вход — по тому, чем именно не понравился логин, гадать не о чем.
    if (!USERNAME_RE.test(normalized)) {
      return res.status(401).json({ error: 'Неверный логин или пароль' })
    }
    const admin = await prisma.admin.findUnique({ where: { username: normalized } })
      || await findAdminIgnoringCase(normalized)
    if (!admin || !admin.isActive) {
      return res.status(401).json({ error: 'Неверный логин или пароль' })
    }

    const valid = await bcrypt.compare(password, admin.password)
    if (!valid) {
      return res.status(401).json({ error: 'Неверный логин или пароль' })
    }

    const token = signToken(admin)
    res.json({
      token,
      admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
    })
  } catch (err) {
    next(err)
  }
}

// Выход — это отзыв ВСЕХ сессий учётной записи, а не только этой вкладки:
// скопированный или оставленный на другом ноутбуке токен после выхода тоже
// перестаёт работать. Раньше ответ был stateless, а токен жил до 8 ч.
async function logout(req, res, next) {
  try {
    await revokeSessions(req.admin.id, { reason: 'session_revoked' })
    res.json({ message: 'Выход выполнен' })
  } catch (err) {
    next(err)
  }
}

async function me(req, res) {
  res.json({ admin: req.admin })
}

async function changePassword(req, res, next) {
  try {
    const { currentPassword, newPassword } = req.body

    const admin = await prisma.admin.findUnique({ where: { id: req.admin.id } })
    const valid = await bcrypt.compare(currentPassword, admin.password)
    if (!valid) {
      return res.status(400).json({ error: 'Неверный текущий пароль' })
    }

    const hash = await bcrypt.hash(newPassword, 12)
    // Смена пароля обязана убивать чужие сессии — иначе после утечки она
    // бессмысленна. Своя уходит вместе с ними: вызывающий входит заново
    // с новым паролем (клиент получает auth:revoked по сокету).
    await revokeSessions(req.admin.id, { reason: 'password_changed', data: { password: hash } })

    res.json({ message: 'Пароль изменён, войдите заново' })
  } catch (err) {
    next(err)
  }
}

module.exports = { login, logout, me, changePassword, USERNAME_RE }
