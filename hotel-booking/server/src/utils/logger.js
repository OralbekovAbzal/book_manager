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
      // colorize только в живом терминале (D8-008). В упаковке сервер запущен
      // дочерним процессом Electron, и его stdout построчно уходит в
      // host-debug.log: раскраска превращалась там в тысячи строк с escape-
      // последовательностями поверх того, что и так лежит в combined.log.
      format: format.combine(
        ...(process.stdout.isTTY ? [format.colorize()] : []),
        format.printf(({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`)
      ),
      // В упаковке каждый запрос дублировался в host-debug.log через stdout —
      // тот же поток, только без ротации и в папке пользователя. Поэтому в
      // production в консоль идут только предупреждения и ошибки; полный поток
      // остаётся в файлах, у которых есть ротация.
      level: process.env.NODE_ENV === 'production' ? 'warn' : undefined,
    }),
    // Ротация: 5 файлов по 5 МБ на каждый лог (D8-008). Без неё оценка стойки
    // ~2000 запросов в день давала сотни мегабайт за год — и ПД в них жили
    // вечно. `tailable: true` — свежие записи всегда в error.log/combined.log,
    // старое уезжает в combined1.log, combined2.log… (winston нумерует перед
    // расширением): так путь в диалогах и подсказках остаётся верным.
    new transports.File({
      filename: path.join(process.env.LOG_PATH || 'logs', 'error.log'),
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new transports.File({
      filename: path.join(process.env.LOG_PATH || 'logs', 'combined.log'),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
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
