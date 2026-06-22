const logger = require('../utils/logger')

function errorHandler(err, req, res, _next) {
  logger.error(`${req.method} ${req.url} — ${err.message}`, { stack: err.stack })

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

  const status = err.status || 500
  const message = status < 500 ? err.message : 'Внутренняя ошибка сервера'
  res.status(status).json({ error: message })
}

function createError(message, status = 400) {
  const err = new Error(message)
  err.status = status
  return err
}

module.exports = { errorHandler, createError }
