/**
 * Безопасный для логов вид URL (D1-004).
 *
 * Стойка ищет гостей по ФИО и телефону, и эти строки уезжают в query:
 * `/api/occupancy/grid?guestSearch=Асель`, `/api/guests/lookup?phone=+7701…`,
 * `/api/payments/debts?q=…`. Каждый такой запрос писался в `combined.log` и —
 * через stdout сервера — в `host-debug.log`, то есть персональные данные годами
 * копились в двух открытых текстовых файлах вне базы. Логи при этом пересылают
 * в поддержку целиком.
 *
 * Диагностическая ценность строки — в том, КАКОЙ путь и КАКИЕ фильтры звали, а
 * не в их значениях. Поэтому значения отбрасываем, имена параметров оставляем:
 * «искали по guestSearch» разбирать инцидент помогает, «искали Асель» — нет.
 */

/**
 * @param {unknown} url — `req.originalUrl` или `req.url`
 * @returns {string} путь; при наличии query — `путь?keys=имя1,имя2`
 */
function safeUrl(url) {
  if (typeof url !== 'string') return ''
  const i = url.indexOf('?')
  if (i === -1) return url
  const path = url.slice(0, i)
  const query = url.slice(i + 1)
  // Порядок появления сохраняем как есть: он показывает, как клиент собрал
  // запрос. Значения не трогаем вообще — даже не декодируем, чтобы ПД случайно
  // не проявились из процентного кодирования.
  const keys = query.split('&')
    .map((pair) => pair.split('=')[0])
    .filter((k) => k !== '')
  if (keys.length === 0) return path
  return `${path}?keys=${keys.join(',')}`
}

/**
 * Ошибка в виде, пригодном для лога (находка тестов волны 8).
 *
 * Prisma кладёт в `message` весь объект `data` — с ФИО, телефоном и номером
 * документа гостя — при любой ошибке валидации (пустая строка вместо даты и т.п.).
 * Пользователь видит 400 и ничего не замечает, а паспорт уезжает в error.log,
 * combined.log и host-debug.log. Диагностике хватает первой строки сообщения
 * (там имя вызова и вид ошибки) и кадров стека без текста.
 *
 * S13-L2 (живой стенд 13.09): у Prisma сообщение НАЧИНАЕТСЯ с пустой строки
 * (`\nInvalid \`prisma.booking.create()\` invocation:`), поэтому «первая строка»
 * давала в журнале голое `PrismaClientUnknownRequestError: ` без причины — из-за
 * этого взаимоблокировку (S13-L1) пришлось ловить отдельным прогоном. Берём первую
 * НЕПУСТУЮ строку, а у ошибок Postgres дополнительно достаём код и текст драйвера.
 */

/** Код ошибки Postgres и её текст из отладочного вывода коннектора Prisma. */
function pgDetails(raw) {
  // Только настоящий отчёт драйвера: у ошибки валидации Prisma в тексте лежит
  // объект `data`, где `code:` может оказаться кодом услуги или партнёра.
  if (!/PostgresError|severity:/.test(raw)) return ''
  const out = []
  const code = raw.match(/code:\s*"([0-9A-Za-z]{5})"/)
  if (code) out.push(`pg ${code[1]}`)
  // Берём ТОЛЬКО значение `message:` — это текст самого Postgres («deadlock detected»,
  // «conflicting key value violates exclusion constraint …»), данных гостя в нём нет.
  // Соседний `detail:` не трогаем: там лежат значения ключа (логин, ключ лицензии).
  const msg = raw.match(/message:\s*"((?:[^"\\]|\\.)*)"/)
  if (msg) out.push(msg[1].replace(/\\"/g, '"').slice(0, 200))
  return out.join(' ')
}

function safeError(err) {
  if (!err) return { message: 'unknown error' }
  const raw = String(err.message == null ? err : err.message)
  const firstLine = (raw.split(/\r?\n/).find((l) => l.trim() !== '') || '').trim().slice(0, 300)
  const code = err.code ? ` [${err.code}]` : ''
  const name = err.name && err.name !== 'Error' ? `${err.name}: ` : ''
  const details = /^PrismaClient\w*Error$/.test(String(err.name || '')) ? pgDetails(raw) : ''
  const message = `${name}${firstLine}${code}${details ? ` — ${details}` : ''}`
  const frames = typeof err.stack === 'string'
    ? err.stack.split(/\r?\n/).filter((l) => /^\s+at\s/.test(l)).slice(0, 12).join('\n')
    : undefined
  return frames ? { message, stack: frames } : { message }
}

module.exports = { safeUrl, safeError }
