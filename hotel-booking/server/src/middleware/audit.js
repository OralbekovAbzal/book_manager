const { prisma } = require('../utils/prisma')
const logger = require('../utils/logger')

// Журнал действий (модель AuditLog). Подключается в app.js ДО роутов:
//   app.use('/api', auditMiddleware)
// По событию 'finish' ответа пишет запись для успешных (статус < 400) POST/PUT/PATCH/DELETE
// на отслеживаемых путях. req.admin к этому моменту уже выставлен authenticate внутри
// роутера; если его нет (401, публичный /setup) — запись пропускается.
// Запись в БД асинхронная: сбой журнала не должен ломать сам запрос.

const METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
// Префиксы путей (без /api), которые попадают в журнал целиком
const TRACKED_PREFIXES = [
  '/bookings', '/users', '/rooms', '/categories', '/partners', '/allotments',
  '/rates', '/hotel', '/system/backup', '/reports',
]
// POST-запросы, которые ничего не меняют
const IGNORED = new Set(['/bookings/check-availability'])
// Отчёты: в журнал идут создание/правка/удаление/импорт определений, а не каждый
// запуск, выгрузка или предпросмотр — иначе журнал утонет в рабочих запросах.
const IGNORED_PATTERNS = [/^\/reports\/[^/]+\/(run|export)\/?$/, /^\/reports\/(preview|validate)\/?$/]

const SECRET_FIELDS = new Set(['password', 'currentPassword', 'newPassword'])
const MAX_DETAILS = 2048

function isTracked(method, routePath) {
  if (!METHODS.has(method)) return false
  if (IGNORED.has(routePath)) return false
  if (IGNORED_PATTERNS.some((re) => re.test(routePath))) return false
  if (routePath === '/occupancy/optimize/apply' || routePath === '/shifts/next-day') return true
  if (/^\/snapshots\/\d+\/restore\/?$/.test(routePath)) return true
  return TRACKED_PREFIXES.some((p) => routePath === p || routePath.startsWith(p + '/'))
}

// Тело запроса без паролей (на любой глубине), не длиннее 2 КБ в JSON
function stripSecrets(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return value
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_FIELDS.has(k)) continue
    out[k] = stripSecrets(v, depth + 1)
  }
  return out
}

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return undefined
  const clean = stripSecrets(body)
  let str
  try { str = JSON.stringify(clean) } catch { return undefined }
  if (!str || str === '{}' || str === '[]') return undefined
  if (str.length <= MAX_DETAILS) return clean
  return { _truncated: true, preview: str.slice(0, MAX_DETAILS - 64) }
}

// id объекта: из пути (/bookings/12/move, /allotments/releases/7), из req.params
// или из ответа (data.id у созданных сущностей)
function extractId(routePath, params, responseBody) {
  const m = routePath.match(/\/(\d+)(?:\/|$)/)
  if (m) return parseInt(m[1], 10)
  const fromParams = params && parseInt(params.id, 10)
  if (Number.isInteger(fromParams)) return fromParams
  const d = responseBody && typeof responseBody === 'object'
    ? (responseBody.data !== undefined ? responseBody.data : responseBody)
    : null
  if (d && typeof d === 'object' && Number.isInteger(d.id)) return d.id
  return null
}

function auditMiddleware(req, res, next) {
  // Путь фиксируем сейчас: внутри вложенного роутера Express подрезает req.url
  const routePath = req.originalUrl.split('?')[0].replace(/^\/api(?=\/|$)/, '')
  if (!isTracked(req.method, routePath)) return next()

  // Перехватываем res.json, чтобы забрать id созданной сущности из ответа
  let responseBody
  const originalJson = res.json.bind(res)
  res.json = (body) => { responseBody = body; return originalJson(body) }

  res.on('finish', () => {
    if (res.statusCode >= 400) return
    const admin = req.admin
    if (!admin) return
    // Синхронная ошибка здесь (например, Prisma Client не перегенерирован и
    // prisma.auditLog отсутствует) уронила бы процесс — поэтому try/catch
    try {
      const details = sanitizeBody(req.body)
      prisma.auditLog.create({
        data: {
          adminId: admin.id,
          adminName: admin.name || admin.username || String(admin.id),
          action: `${req.method} ${routePath}`,
          entity: routePath.split('/')[1] || '',
          entityId: extractId(routePath, req.params, responseBody),
          ...(details !== undefined && { details }),
          ip: req.ip || null,
        },
      }).catch((err) => logger.error(`Audit log write failed: ${err.message}`))
    } catch (err) {
      logger.error(`Audit log write failed: ${err.message}`)
    }
  })

  next()
}

module.exports = { auditMiddleware }
