const router = require('express').Router()
const { body } = require('express-validator')
const ctrl = require('../controllers/hotelController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

/**
 * Формат реквизитов проверяем ЗДЕСЬ, а не констрейнтом в базе: жёсткое правило
 * в схеме означало бы, что опечатка в одном поле роняет сохранение всех
 * настроек объекта, а починить её из интерфейса уже нельзя.
 *
 * Сначала санитайзер (он же нормализация из контроллера), потом проверка —
 * тогда «123 456 789 012» и «kz86 8562 0000 0032 7523» проходят, а не отвергаются
 * из-за пробелов и регистра. Пустое значение допустимо всегда: пустое поле
 * означает «реквизит не заполнен», и печать просто не выведет эту строку.
 */
const empty = (v) => v === null || v === undefined

/** Общее правило для реквизита-строки: обрезать, пустое → null, ограничить длину. */
const text = (field, max, message) =>
  body(field).optional({ nullable: true })
    .customSanitizer(ctrl.cleanText)
    .custom((v) => empty(v) || v.length <= max)
    .withMessage(message || `Слишком длинное значение (до ${max} символов)`)

const hotelRules = [
  text('legalName', 200, 'Юридическое имя — до 200 символов'),

  // БИН (юрлицо) и ИИН (ИП) — оба ровно 12 цифр, поэтому одно правило на оба.
  body('bin').optional({ nullable: true })
    .customSanitizer(ctrl.cleanBin)
    .custom((v) => empty(v) || /^\d{12}$/.test(v))
    .withMessage('БИН/ИИН — ровно 12 цифр'),

  text('address', 300, 'Адрес — до 300 символов'),
  // Телефон формат НЕ проверяем: в шапку документа пишут «+7 (7212) 55-55-55,
  // доб. 12» и два номера через запятую — любая маска здесь только мешает.
  text('phone', 60, 'Телефон — до 60 символов'),
  body('email').optional({ nullable: true })
    .customSanitizer(ctrl.cleanText)
    .custom((v) => empty(v) || (v.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)))
    .withMessage('Похоже, в адресе почты опечатка'),

  text('bankName', 200, 'Название банка — до 200 символов'),

  /**
   * IBAN проверяем МЯГКО — только код страны и общую длину (ISO 13616: 15–34
   * знака). Казахстанский счёт это «KZ» и ещё 18, но зашивать «ровно KZ и ровно
   * 20» нельзя: у объекта может быть счёт в иностранном банке, и жёсткая маска
   * не дала бы его сохранить. Контрольную сумму не считаем сознательно —
   * ошибка в счёте всплывёт в банке, а несохранённый счёт ломает печать сразу.
   */
  body('iban').optional({ nullable: true })
    .customSanitizer(ctrl.cleanIban)
    .custom((v) => empty(v) || /^[A-Z]{2}[A-Z0-9]{13,32}$/.test(v))
    .withMessage('IBAN — две буквы кода страны и всего 15–34 знака (у Казахстана: KZ и ещё 18)'),

  text('signerName', 120, 'Имя подписанта — до 120 символов'),
  text('signerTitle', 80, 'Должность подписанта — до 80 символов'),
]

router.get('/', ctrl.get)
// Права на реквизиты — те же, что на остальные настройки объекта: администратор.
// Стойка счёт печатает, но реквизиты юрлица не правит.
router.put('/', requireRole('SUPER_ADMIN', 'ADMIN'), hotelRules, validate, ctrl.update)

module.exports = router
// Правила отдельно — их прогоняют тесты (`hotelRequisites.test.js`) без поднятия Express.
module.exports.hotelRules = hotelRules
