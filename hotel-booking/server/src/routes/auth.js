const router = require('express').Router()
const { body, validationResult } = require('express-validator')
const { login, logout, me, changePassword, USERNAME_RE } = require('../controllers/authController')
const { authenticate } = require('../middleware/auth')
const { validate } = require('../middleware/validate')
const { passwordRule } = require('../utils/passwordPolicy')

// `USERNAME_RE` — та же формула логина, что в `routes/users.js` и `routes/setup.js`
// (других источников учёток нет). Живёт в контроллере: там же стоит вторая, главная
// проверка — роут можно обойти или вызвать контроллер напрямую, запрос в базу нельзя.

// На ВХОДЕ парольная политика не проверяется — только «поле не пустое».
// Иначе учётные записи со старыми короткими паролями перестанут входить.
// Логин приводится к нижнему регистру (S13-007): учётки создаются именно так
// (`routes/users.js`, `routes/setup.js`), а вход раньше только обрезал пробелы —
// `Aigerim` с Caps Lock получал «Неверный логин или пароль» при живой учётке
// `aigerim`, и каждая такая попытка жгла лимит входа.
//
// Форма логина проверяется здесь так же строго, как при создании учётки
// (R13-S-004): непроверенная строка уходила в поиск без учёта регистра, а его
// Prisma компилирует в `ILIKE` — и `%` из поля «Логин» находил ПЕРВУЮ учётку
// отеля. Знать логин для входа переставало быть нужно.
const loginRules = [
  body('username').trim().toLowerCase()
    .notEmpty().bail()
    .matches(USERNAME_RE),
  body('password').notEmpty(),
]

/**
 * Ответ на непрошедшую проверку ЛОГИНА — всегда один и тот же 401.
 *
 * Общий `validate` отдаёт 400 «Ошибка валидации» со списком полей и текстов,
 * и здесь это было бы подсказкой: по разнице ответов видно, какие символы
 * в логинах отеля вообще бывают, а по названию поля — что не так. Снаружи
 * «логин не того формата», «логина нет» и «пароль не тот» обязаны выглядеть
 * одинаково.
 */
function validateLogin(req, res, next) {
  if (!validationResult(req).isEmpty()) {
    return res.status(401).json({ error: 'Неверный логин или пароль' })
  }
  next()
}

const changePasswordRules = [
  body('currentPassword').notEmpty().withMessage('Текущий пароль обязателен'),
  passwordRule(body, 'newPassword'),
]

router.post('/login', loginRules, validateLogin, login)
router.post('/logout', authenticate, logout)
router.get('/me', authenticate, me)
router.post('/change-password', authenticate, changePasswordRules, validate, changePassword)

module.exports = router
