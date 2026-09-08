const logger = require('../utils/logger')
const { safeUrl, safeError } = require('../utils/logSafe')

function errorHandler(err, req, res, _next) {
  // URL без значений query и ошибка без тела запроса: в error.log ФИО, телефоны
  // и документы гостей попадать не должны ни из строки запроса (D1-004), ни из
  // текста ошибки Prisma, который повторяет весь объект `data`.
  const safe = safeError(err)
  logger.error(`${req.method} ${safeUrl(req.originalUrl || req.url)} — ${safe.message}`, { stack: safe.stack })

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message })
  }

  if (err.code === 'P2002') {
    return res.status(409).json({ error: 'Запись с такими данными уже существует' })
  }

  if (err.code === 'P2025') {
    return res.status(404).json({ error: 'Запись не найдена' })
  }

  // Exclusion-constraint двойного бронирования (race condition): два админа одновременно
  // забронировали один номер на пересекающиеся даты — БД отклонила второй INSERT/UPDATE.
  const m = String(err && err.message || '')
  if (err.code === 'P2004' || m.includes('booking_no_overlap') || m.includes('23P01') || m.includes('exclusion constraint')) {
    return res.status(409).json({ error: 'Номер уже занят на выбранные даты (одновременное бронирование). Обновите сетку и попробуйте снова.' })
  }

  // Нарушение внешнего ключа: несуществующий roomId / categoryId / partnerId / shiftId.
  // P2010 + 23503 — то же самое из $executeRaw (тарифы пишутся сырым SQL).
  const rawCode = String((err.meta && err.meta.code) || '')
  if (err.code === 'P2003' || (err.code === 'P2010' && (rawCode === '23503' || m.includes('23503')))) {
    return res.status(400).json({ error: 'Связанная запись не найдена (номер, категория, партнёр или смена)' })
  }

  // Значение длиннее колонки в БД
  if (err.code === 'P2000') {
    return res.status(400).json({ error: 'Слишком длинное значение' })
  }

  // Неверный тип/форма данных для Prisma (строка вместо числа, NaN в where и т.п.) — это ошибка клиента
  if (err.name === 'PrismaClientValidationError') {
    return res.status(400).json({ error: 'Некорректные данные в запросе' })
  }

  const status = err.status || 500
  const message = status < 500 ? err.message : 'Внутренняя ошибка сервера'
  // Список проблем (валидация определения отчёта): клиент показывает их все разом
  const body = { error: message }
  if (status < 500 && Array.isArray(err.problems)) body.problems = err.problems
  res.status(status).json(body)
}

function createError(message, status = 400) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { errorHandler, createError }
