const logger = require('../utils/logger')
const { safeUrl, safeError } = require('../utils/logSafe')

const ROOM_TAKEN = 'Номер уже занят на выбранные даты (одновременное бронирование). Обновите сетку и попробуйте снова.'

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
  // Этот отказ говорит о номере и датах сам по себе, на каком бы роуте ни случился.
  const m = String(err && err.message || '')
  if (err.code === 'P2004'
    || m.includes('booking_no_overlap') || m.includes('23P01') || m.includes('exclusion constraint')) {
    return res.status(409).json({ error: ROOM_TAKEN })
  }

  // Взаимоблокировка (S13-L1, найдено на живом стенде 13.09). Prisma заворачивает её
  // либо в `P2034`, либо в `PrismaClientUnknownRequestError` вообще без `code` —
  // поэтому смотрим и на код, и на текст. Общий смысл один: «повторите», а не
  // «внутренняя ошибка сервера».
  //
  // Текст про занятый номер — только там, где речь о размещении (R13-S-003).
  // Взаимоблокировка бывает и при возврате платежа, и при восстановлении копии:
  // две транзакции ждут друг друга на чём угодно, и «Номер уже занят на выбранные
  // даты» в ответ на возврат денег — это не подсказка, а дезинформация.
  const deadlock = err.code === 'P2034'
    || m.includes('40P01')
    || m.includes('deadlock detected')
    || m.includes('взаимоблокировка')
  if (deadlock) {
    // `originalUrl` первым: внутри роутера `req.url` обрезан до пути без префикса
    // монтирования, и `/api/bookings` в нём уже не видно.
    const path = String(req.originalUrl || req.url || req.path || '').split('?')[0]
    if (path.startsWith('/api/bookings') || path.startsWith('/api/occupancy')) {
      return res.status(409).json({ error: ROOM_TAKEN })
    }
    return res.status(409).json({
      error: 'Операция не удалась из-за одновременного изменения данных. Повторите ещё раз.',
      code: 'CONCURRENT_UPDATE',
    })
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
