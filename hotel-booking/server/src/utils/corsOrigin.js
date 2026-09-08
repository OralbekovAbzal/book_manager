// Единая CORS-политика для REST (app.js) и socket.io (socketManager.js).
// Граница безопасности — JWT в заголовке Authorization, а не Origin/cookie,
// поэтому политика рассчитана на desktop/LAN-клиентов:
//  • без Origin — упакованный Electron (file:// → Origin: null), нативные клиенты;
//  • явный список CLIENT_ORIGIN (через запятую);
//  • любой адрес локальной сети (localhost + приватные диапазоны IPv4).
// IPv6-петля [::1] — тот же localhost: на Windows браузер и Vite нередко
// резолвят localhost именно в неё, и Origin приходит как http://[::1]:5173.

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173,http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean)

// Хост закрыт границей `(:порт)?$`: без неё `http://localhost.evil.example` и
// `http://10.evil.example` проходили как «локальная сеть» (находка волны 10).
const LAN_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(:\d{1,5})?$/

function corsOrigin(origin, cb) {
  if (!origin) return cb(null, true)
  if (allowedOrigins.includes(origin)) return cb(null, true)
  if (LAN_ORIGIN.test(origin)) return cb(null, true)
  return cb(new Error('CORS: origin не разрешён'))
}

module.exports = { corsOrigin, allowedOrigins, LAN_ORIGIN }
