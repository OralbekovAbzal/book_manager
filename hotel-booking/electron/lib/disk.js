/**
 * Свободное место на диске (D8-006).
 *
 * Место нигде не проверялось: при заполнении диска Postgres завершается PANIC,
 * winston роняет процесс на ошибке записи лога, копия ложится на тот же диск,
 * что и база, — и всё это без единого слова пользователю. Здесь только замер;
 * что с ним делать, решают вызывающие (диалог в Electron, поле `disk` в статусе).
 *
 * Без `require('electron')` — модуль зовут и main-процесс, и тесты сервера.
 */
const fs = require('fs')
const path = require('path')

const MB = 1048576

/**
 * Свободные байты на томе, где лежит путь.
 *
 * Путь может ещё не существовать (папка копий на вынутой флешке, папка данных
 * до первого запуска), поэтому поднимаемся к ближайшему существующему предку —
 * том у них один. Ничего не нашлось или statfs недоступен → null; исключений
 * этот модуль не бросает никогда: замер места не повод не запуститься.
 *
 * @returns {number|null}
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

/** Предупреждать ли о месте. Неизвестное место (null) предупреждением НЕ считаем. */
function diskWarning(freeBytesValue, thresholdBytes) {
  if (typeof freeBytesValue !== 'number' || !Number.isFinite(freeBytesValue)) return false
  return freeBytesValue < thresholdBytes
}

/** Байты → целые мегабайты (вниз). null остаётся null. */
function toMb(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null
  return Math.floor(bytes / MB)
}

module.exports = { MB, freeBytes, diskWarning, toMb }
