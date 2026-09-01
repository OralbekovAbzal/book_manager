// Единая CORS-политика для REST (app.js) и socket.io (socketManager.js).
// Граница безопасности — JWT в заголовке Authorization, а не Origin/cookie,
// поэтому политика рассчитана на desktop/LAN-клиентов:
//  • без Origin — упакованный Electron (file:// → Origin: null), нативные клиенты;
//  • явный список CLIENT_ORIGIN (через запятую);
//  • любой адрес локальной сети (localhost + приватные диапазоны IPv4).

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/

function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true)
  if (allowedOrigins.includes(origin)) return cb(null, true)
  if (LAN_ORIGIN.test(origin)) return cb(null, true)
  return cb(new Error('CORS: origin не разрешён'))
}

module.exports = { corsOrigin, allowedOrigins, LAN_ORIGIN }
