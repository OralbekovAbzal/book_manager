/**
 * Что из готового НЕ входит в эту версию программы.
 *
 * Решение владельца (2026-09-12): оптимизатор размещения и откат к снимкам
 * клиентам в 1.0 не показываем — оба меняют много броней одним действием, и до
 * доработки это опаснее, чем полезно. Код остаётся (тесты, бэктест, автоснимки
 * пишутся по-прежнему), закрыт только вход: роуты отвечают 404, кнопки в
 * клиенте спрятаны (`client/src/config.ts`, `FEATURES`).
 *
 * Для разработки включается переменной `FEATURE_PREVIEW=1` (сервер) и
 * `VITE_FEATURE_PREVIEW=1` (клиент). В упакованной программе
 * (`NODE_ENV=production`) переменная не читается вообще: сервер наследует
 * окружение Windows, и один `setx FEATURE_PREVIEW 1` оживлял откат всей базы
 * к снимку — то самое, что владелец спрятал как «опаснее, чем полезно» (S13-011).
 */

const { devEnv } = require('./devOverride')

const PREVIEW = devEnv('FEATURE_PREVIEW') === '1'

const FEATURES = Object.freeze({
  /** Оптимизатор размещения: POST /occupancy/optimize и /optimize/apply. */
  optimizer: PREVIEW,
  /** Точки отката: весь /api/snapshots (автоснимки при этом пишутся как раньше). */
  snapshotRestore: PREVIEW,
})

/**
 * Middleware: раздел закрыт → 404 с кодом `FEATURE_OFF`. Именно 404, а не 403:
 * для этой версии раздела не существует, и клиенту нечего «выпрашивать».
 */
function requireFeature(name) {
  return function featureGate(_req, res, next) {
    if (FEATURES[name]) return next()
    res.status(404).json({ error: 'Раздел не входит в эту версию программы', code: 'FEATURE_OFF' })
  }
}

module.exports = { FEATURES, requireFeature }
