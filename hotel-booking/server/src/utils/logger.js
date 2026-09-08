const { createLogger, format, transports } = require('winston')
const path = require('path')

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
      ),
    }),
    new transports.File({
      filename: path.join(process.env.LOG_PATH || 'logs', 'error.log'),
      level: 'error',
    }),
    new transports.File({
      filename: path.join(process.env.LOG_PATH || 'logs', 'combined.log'),
    }),
  ],
})

// Ошибка записи лога не должна ронять сервер (D8-006). У winston File-transport
// при ENOSPC (диск полон) эмитит 'error', logger переэмитит его на себя, и без
// слушателя это необработанное событие — то есть падение процесса ровно тогда,
// когда программа и так в беде. Пишем в консоль (её собирает host-debug.log) и
// продолжаем работать: без логов отель работать может, без сервера — нет.
logger.on('error', (e) => console.error('[logger]', e && e.message))

module.exports = logger
