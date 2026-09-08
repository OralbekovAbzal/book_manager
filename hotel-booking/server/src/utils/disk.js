const fs = require('fs')
const path = require('path')

/**
 * Свободное место под данными, копиями и логами (D8-006).
 *
 * Тот же замер, что в `electron/lib/disk.js`, — намеренный дубль: сервер живёт
 * отдельным процессом и в клиентском режиме запускается вообще без Electron,
 * тянуть модуль из соседнего пакета неоткуда.
 *
 * Правило всего файла: НИКОГДА не бросать. Папка копий может лежать на вынутой
 * флешке (ENOENT), путь может быть не задан вовсе — статус системы обязан
 * ответить и в этом случае.
 */

const MB = 1048576

/**
 * Свободные байты на томе, где лежит путь. Путь может не существовать —
 * поднимаемся к ближайшему существующему предку (том тот же).
 * @returns {number|null} null — тома нет (флешка вынута) или замер недоступен
 */
function freeBytes(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return null
  let cur
  try { cur = path.resolve(dirPath) } catch { return null }

  for (;;) {
    try {
      if (fs.existsSync(cur)) {
        const st = fs.statfsSync(cur)
        const size = Number(st.bsize) * Number(st.bavail)
        return Number.isFinite(size) ? size : null
      }
    } catch { return null }
    const up = path.dirname(cur)
    if (!up || up === cur) return null
    cur = up
  }
}

/**
 * Сводка по нескольким путям.
 *
 * `freeMb` — МИНИМУМ по измеренным томам: предупреждать надо про самый тесный,
 * а не про средний. Пути, которые измерить не удалось, из ответа выпадают
 * целиком — «не знаем» и «мало» это разные вещи, и путать их в интерфейсе нельзя.
 *
 * @param {{ paths?: {role: string, path: string}[], thresholdMb?: number }} opts
 * @returns {{ freeMb: number|null, warning: boolean, thresholdMb: number, checked: {role: string, freeMb: number}[] }}
 */
function diskStatus({ paths = [], thresholdMb = 1024 } = {}) {
  const limit = Number.isFinite(Number(thresholdMb)) ? Number(thresholdMb) : 1024
  const checked = []

  for (const item of Array.isArray(paths) ? paths : []) {
    const p = item && typeof item.path === 'string' ? item.path.trim() : ''
    if (!p) continue
    const bytes = freeBytes(p)
    if (bytes === null) continue
    checked.push({ role: String((item && item.role) || ''), freeMb: Math.floor(bytes / MB) })
  }

  const freeMb = checked.length ? Math.min(...checked.map((c) => c.freeMb)) : null
  return {
    freeMb,
    warning: freeMb !== null && freeMb < limit,
    thresholdMb: limit,
    checked,
  }
}

module.exports = { MB, freeBytes, diskStatus }
