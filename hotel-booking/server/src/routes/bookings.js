const router = require('express').Router()
const { body, query, param } = require('express-validator')
const ctrl = require('../controllers/bookingController')
const settlement = require('../controllers/settlementController')
const payments = require('../controllers/paymentController')
const { authenticate, requireRole } = require('../middleware/auth')
const { validate } = require('../middleware/validate')

router.use(authenticate)

const SOURCES = ['телефон', 'стойка', 'онлайн', 'Каспи', 'ремонт', null]

// Виды строк начислений — общий список для предпросмотра и для правки строк ниже
const CHARGE_KINDS = ['stay', 'meal', 'extra', 'discount']

// Счётчики гостей, проценты, суммы, метки, смена, статус — общие для POST и PUT.
// express-validator 7 приводит значение к строке перед isInt/isFloat, поэтому числа из JSON
// проходят проверку; мусор ("abc", -3, 150%) отсекается здесь, а не падает в Prisma с 500.
const GUEST_COUNTERS = [
  'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals', 'childrenNoMeals',
  'extraBedsWithMeals', 'extraBedsNoMeals', 'disabledAdults', 'disabledChildren',
]
const bookingNumericRules = [
  body(GUEST_COUNTERS).optional({ nullable: true }).isInt({ min: 0, max: 99 })
    .withMessage('Количество гостей должно быть целым числом от 0 до 99'),
  body(['discountPercent', 'prepaymentPercent']).optional().isFloat({ min: 0, max: 100 })
    .withMessage('Процент должен быть числом от 0 до 100'),
  body(['totalAmount', 'prepaidAmount', 'paidAmount']).optional().isFloat({ min: 0 })
    .withMessage('Сумма должна быть неотрицательным числом'),
  body('flags').optional().isArray().withMessage('flags должен быть массивом строк'),
  body('flags.*').isString().isLength({ max: 60 }).withMessage('Метка — строка до 60 символов'),
  body('shiftId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('shiftId должен быть целым числом'),
  body('status').optional().isIn(['CONFIRMED', 'CHECKED_IN']).withMessage('Недопустимый статус'),
  // Осознанное подтверждение продажи номера из квоты партнёра (409 ALLOTMENT_CONFLICT)
  body('allowAllotmentOverride').optional().isBoolean().withMessage('allowAllotmentOverride — да/нет'),
  // Явное «Пересчитать по тарифу»: пересобрать автоматические строки начислений
  body('recalcCharges').optional().isBoolean().withMessage('recalcCharges — да/нет'),
  // Питание и услуги брони: какая услуга, скольким людям, сколько раз.
  // Отсутствие поля и пустой массив — РАЗНЫЕ вещи: первое «не трогай питание»,
  // второе «питания нет». Поэтому optional() без nullable: null не принимаем.
  body('services').optional().isArray({ max: 50 })
    .withMessage('services — массив услуг (до 50)'),
  body('services.*.serviceId').isInt({ min: 1 })
    .withMessage('serviceId услуги обязателен'),
  body('services.*.adults').optional().isInt({ min: 0, max: 99 })
    .withMessage('Число взрослых по услуге — от 0 до 99'),
  body('services.*.children').optional().isInt({ min: 0, max: 99 })
    .withMessage('Число детей по услуге — от 0 до 99'),
  body('services.*.quantity').optional().isFloat({ min: 0, max: 999 })
    .withMessage('Количество услуги — от 0 до 999'),
]

// ─── Документ гостя ──────────────────────────────────────────────────────────
// Набор полей — под уведомление о прибытии иностранца (МВД) и статистику по
// гражданству. Значения перечислений проверяем здесь, а не в контроллере:
// 'passport'/'id_card'/'other' и 'm'/'f' — это КОНТРАКТ с клиентом, и опечатка
// в нём должна отвечать 400 сразу, а не всплыть через полгода при выгрузке.
//
// `checkFalsy: true` во всех правилах — намеренно: очищенное поле формы приходит
// пустой строкой, и это «не заполнено», а не ошибка ввода. В базу её кладёт
// контроллер как null (guestDocValue), проверять тут нечего.
const DOC_TYPES = ['passport', 'id_card', 'other']
const SEXES = ['m', 'f']

const guestDocRules = [
  body('guestCitizenship').optional({ nullable: true, checkFalsy: true }).trim()
    .isLength({ max: 60 }).withMessage('Гражданство — до 60 символов'),
  body('guestDocType').optional({ nullable: true, checkFalsy: true }).isIn(DOC_TYPES)
    .withMessage('Тип документа: паспорт, удостоверение личности или иной'),
  body('guestDocNumber').optional({ nullable: true, checkFalsy: true }).trim()
    .isLength({ max: 40 }).withMessage('Номер документа — до 40 символов'),
  // strictMode: без него validator принимает и «2026/05/14», и «2026-5-14»,
  // а new Date() в контроллере разберёт их по-своему. Даты документа — ровно
  // ГГГГ-ММ-ДД, как checkIn/checkOut, и без времени (@db.Date).
  body(['guestDocExpiry', 'guestBirthDate']).optional({ nullable: true, checkFalsy: true })
    .isDate({ format: 'YYYY-MM-DD', strictMode: true })
    .withMessage('Дата документа — в формате ГГГГ-ММ-ДД'),
  body('guestSex').optional({ nullable: true, checkFalsy: true }).isIn(SEXES)
    .withMessage('Пол — «m» или «f»'),
]

const bookingBodyRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен').toInt(),
  body('guestName').trim().notEmpty().withMessage('Имя гостя обязательно').isLength({ max: 100 }),
  body('guestPhone').optional({ nullable: true }).trim().isLength({ max: 30 }),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('source').optional({ nullable: true }).isIn(SOURCES).withMessage('Недопустимый источник брони'),
  body('notes').optional({ nullable: true }).isLength({ max: 1000 }),
  ...guestDocRules,
  ...bookingNumericRules,
]

const actualTimesRules = [
  body(['actualCheckInAt', 'actualCheckOutAt']).optional({ nullable: true }).isISO8601()
    .withMessage('Фактическое время заезда/выезда — дата и время в формате ISO 8601'),
]

// PUT — все поля необязательные, но если пришли — проверяются так же, как при создании
const bookingUpdateRules = [
  body('roomId').optional().isInt({ min: 1 }).withMessage('roomId должен быть целым числом').toInt(),
  body('guestName').optional().trim().notEmpty().withMessage('Имя гостя не может быть пустым').isLength({ max: 100 }),
  body('guestPhone').optional({ nullable: true }).trim().isLength({ max: 30 }),
  body('checkIn').optional().isDate().withMessage('checkIn в формате YYYY-MM-DD'),
  body('checkOut').optional().isDate().withMessage('checkOut в формате YYYY-MM-DD'),
  // Фактические заезд/выезд — момент времени целиком (не YYYY-MM-DD, как checkIn),
  // поэтому isISO8601, а не isDate. null допустим: им администратор стирает
  // ошибочно проставленное время. Право на саму правку проверяет контроллер.
  ...actualTimesRules,
  body('source').optional({ nullable: true }).isIn(SOURCES).withMessage('Недопустимый источник брони'),
  body('notes').optional({ nullable: true }).isLength({ max: 1000 }),
  // Документ дозаполняют ИМЕННО через PUT: бронь завели по телефону, паспорт
  // принесли на стойку. Это основной сценарий, а не побочный.
  ...guestDocRules,
  ...bookingNumericRules,
  // Версия брони, которую видит форма (её же `updatedAt` из ответа сервера).
  // Необязательно намеренно: старый клиент и служебные вызовы замка не знают,
  // и отвечать им 400 значило бы сломать сохранение ради защиты от гонки.
  body('expectedUpdatedAt').optional({ nullable: true }).isISO8601()
    .withMessage('expectedUpdatedAt: ISO-дата'),
]

const availabilityRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен'),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('excludeBookingId').optional({ nullable: true }).isInt().withMessage('excludeBookingId должен быть целым числом'),
  // Проверка считает то же, что сохранение, а буфер метки и квота зависят от меток
  // и партнёра будущей брони. Поля необязательные: без них ответ просто грубее.
  body('flags').optional().isArray().withMessage('flags должен быть массивом строк'),
  body('flags.*').isString().isLength({ max: 60 }).withMessage('Метка — строка до 60 символов'),
  body('partnerId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('partnerId должен быть целым числом'),
]

const listRules = [
  query('dateFrom').optional().isDate(),
  query('dateTo').optional().isDate(),
  query('roomId').optional().isInt(),
  query('status').optional().isIn(['CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW']),
  query('categoryId').optional().isInt(),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 500 }),
]

// Предпросмотр счёта — те же поля, что у POST /, плюс необязательные bookingId
// (подтянуть сохранённые ручные строки) и manualCharges (ещё не сохранённые).
// Ничего не пишет, поэтому доступен любому вошедшему и без проверки прошедших дат:
// форма спрашивает «сколько выйдет» и на датах, которые сохранить не даст.
const previewRules = [
  body('roomId').isInt({ min: 1 }).withMessage('roomId обязателен').toInt(),
  body('checkIn').isDate().withMessage('checkIn обязателен (YYYY-MM-DD)'),
  body('checkOut').isDate().withMessage('checkOut обязателен (YYYY-MM-DD)'),
  body('bookingId').optional({ nullable: true }).isInt({ min: 1 }).withMessage('bookingId — целое число'),
  body('manualCharges').optional().isArray({ max: 100 }).withMessage('manualCharges — массив строк (до 100)'),
  body('manualCharges.*.kind').optional().isIn(CHARGE_KINDS).withMessage('Недопустимый вид начисления'),
  body('manualCharges.*.quantity').optional().isFloat({ min: 0 }).withMessage('Количество — неотрицательное число'),
  body('manualCharges.*.unitPrice').optional().isFloat({ min: -100000000, max: 100000000 })
    .withMessage('Цена должна быть числом'),
  body('manualCharges.*.amount').optional().isFloat({ min: -100000000, max: 100000000 })
    .withMessage('Сумма должна быть числом'),
  ...bookingNumericRules,
]

router.get('/', listRules, validate, ctrl.list)
router.post('/preview', previewRules, validate, ctrl.preview)
router.post('/check-availability', availabilityRules, validate, ctrl.checkAvailability)
router.post('/', bookingBodyRules, validate, ctrl.create)
router.get('/:id', param('id').isInt(), validate, ctrl.getOne)
router.put('/:id', param('id').isInt(), bookingUpdateRules, validate, ctrl.update)
router.delete('/:id', param('id').isInt(), validate, ctrl.cancel)
router.patch('/:id/checkin', param('id').isInt(), validate, ctrl.checkIn)
router.patch('/:id/checkout', param('id').isInt(), validate, ctrl.checkOut)
// Правка фактического времени заезда/выезда администратором — работает и на
// закрытой (CHECKED_OUT/CANCELLED) брони, в отличие от общего PUT /:id.
router.patch('/:id/actual-times', param('id').isInt(), actualTimesRules, validate, ctrl.updateActualTimes)
// ─── Расчёт с гостем (отмена / ранний выезд + штраф + возврат) ───────────────
// Одно окно вместо четырёх экранов: калькулятор показывает, сколько к возврату,
// администратор правит штраф и сумму возврата. Деньги по закрываемой сделке —
// только администратору, как и отмена заселённого гостя.
const settlementRules = [
  body('action').isIn(settlement.ACTIONS).withMessage('Действие: отмена, выезд или без изменения статуса'),
]
const settlementMoneyRules = [
  ...settlementRules,
  body('penalty.amount').optional({ nullable: true }).isFloat({ min: 0 })
    .withMessage('Штраф — неотрицательное число'),
  body('penalty.reason').optional({ nullable: true }).trim().isLength({ max: 300 })
    .withMessage('Причина штрафа — до 300 символов'),
  body('refund.amount').optional({ nullable: true }).isFloat({ min: 0 })
    .withMessage('Сумма возврата — неотрицательное число'),
  body('refund.method').optional({ nullable: true }).isIn(payments.METHODS)
    .withMessage('Неизвестный способ возврата'),
  body('refund.comment').optional({ nullable: true }).trim().isLength({ max: 500 })
    .withMessage('Комментарий — до 500 символов'),
]

router.post('/:id/settlement/preview',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  param('id').isInt(), settlementRules, validate, settlement.preview)
router.post('/:id/settlement',
  requireRole('SUPER_ADMIN', 'ADMIN'),
  param('id').isInt(), settlementMoneyRules, validate, settlement.settle)

router.post('/:id/move',
  param('id').isInt(),
  body('newRoomId').isInt({ min: 1 }),
  body('moveDate').isDate(),
  validate, ctrl.move)

// ─── Начисления брони ────────────────────────────────────────────────────────
// Итог брони = сумма строк. Ручная строка обязана нести причину: именно она
// превращает уступку «беру полсуток» из устной договорённости в запись.

const chargeMoneyRules = [
  body('quantity').optional().isFloat({ min: 0 }).withMessage('Количество — неотрицательное число'),
  body('unitPrice').optional().isFloat({ min: -100000000, max: 100000000 }).withMessage('Цена должна быть числом'),
  body('date').optional({ nullable: true }).isDate().withMessage('Дата начисления в формате YYYY-MM-DD'),
  body('reason').trim().notEmpty().withMessage('Укажите причину — без неё строка не сохраняется')
    .isLength({ max: 300 }).withMessage('Причина — до 300 символов'),
]

const chargeCreateRules = [
  body('kind').isIn(CHARGE_KINDS).withMessage('Недопустимый вид начисления'),
  body('label').trim().notEmpty().withMessage('Укажите название строки').isLength({ max: 200 }),
  ...chargeMoneyRules,
]

const chargeUpdateRules = [
  body('kind').optional().isIn(CHARGE_KINDS).withMessage('Недопустимый вид начисления'),
  body('label').optional().trim().notEmpty().withMessage('Название строки не может быть пустым').isLength({ max: 200 }),
  ...chargeMoneyRules,
]

router.get('/:id/charges', param('id').isInt(), validate, ctrl.listCharges)
router.post('/:id/charges/rebuild', param('id').isInt(), validate, ctrl.rebuildCharges)
router.post('/:id/charges', param('id').isInt(), chargeCreateRules, validate, ctrl.addCharge)
router.put('/:id/charges/:chargeId',
  param('id').isInt(), param('chargeId').isInt(), chargeUpdateRules, validate, ctrl.updateCharge)
router.delete('/:id/charges/:chargeId',
  param('id').isInt(), param('chargeId').isInt(), validate, ctrl.removeCharge)

module.exports = router
