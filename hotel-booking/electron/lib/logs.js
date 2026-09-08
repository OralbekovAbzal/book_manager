/**
 * Диагностический лог хоста: чистка от ANSI и ротация по размеру (D8-008).
 *
 * `host-debug.log` рос без предела и на 40 % состоял из escape-последовательностей
 * цвета: сервер запущен дочерним процессом, winston красил вывод в консоль, а
 * консоль здесь — файл. Читать такой лог у клиента по телефону невозможно, а
 * пересылать — значит пересылать ещё и его размер.
 *
 * Без `require('electron')` — модуль зовут и main-процесс, и тесты сервера
 * (`server/test/electron-logs.test.js`). Не забыть про `lib/**` в
 * package.json → build.files.
 */
const fs = require('fs')

// CSI-последовательности цвета: ESC [ параметры m. Только они и нужны —
// winston других не печатает, а трогать всё подряд рискованно: в логе бывают
// куски SQL и путей, где квадратные скобки — часть текста.
const ANSI_RE = /\x1b\[[0-9;]*m/g

/**
 * Текст без кодов цвета.
 * @param {unknown} text
 * @returns {string}
 */
function stripAnsi(text) {
  // Не строка — пустая строка. Буфер из stdout зовущий обязан привести к строке
  // сам (кодировка — его дело); тихое String(buffer) здесь пряталo бы ошибку и
  // писало бы в лог «[object Object]» вместо сообщения.
  if (typeof text !== 'string') return ''
  return text.replace(ANSI_RE, '')
}

/**
 * Ротация файла лога по размеру.
 *
 * Переименование, а не обрезка: файл в этот момент открыт на дозапись у
 * main-процесса, и усечение на месте дало бы дыры в середине. После rename
 * следующий `appendFileSync` создаёт файл заново — поэтому звать это надо
 * ДО первой записи, при старте.
 *
 * Ошибки не бросаются никогда: ротация лога — не повод не запустить программу.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @param {{keep?: number}} [opts] keep — сколько нумерованных копий держать
 * @returns {{rotated: boolean, size: number, error?: Error}}
 */
function rotateLogFile(filePath, maxBytes, { keep = 1 } = {}) {
  if (!filePath || typeof filePath !== 'string') return { rotated: false, size: 0 }
  let size = 0
  try {
    if (!fs.existsSync(filePath)) return { rotated: false, size: 0 }
    size = fs.statSync(filePath).size
    if (!(Number(maxBytes) > 0) || size <= Number(maxBytes)) return { rotated: false, size }

    // Сдвиг нумерации: самая старая копия (.keep) уходит совсем, остальные
    // сдвигаются на единицу, свежий лог становится .1. Всего файлов на диске
    // не больше keep + 1 — предел размера папки предсказуем.
    const n = Math.max(1, Math.floor(Number(keep)) || 1)
    try { fs.rmSync(`${filePath}.${n}`, { force: true }) } catch { /* нечего удалять */ }
    for (let i = n - 1; i >= 1; i -= 1) {
      try {
        if (fs.existsSync(`${filePath}.${i}`)) fs.renameSync(`${filePath}.${i}`, `${filePath}.${i + 1}`)
      } catch { /* копию потерять не жалко, лог важнее */ }
    }
    fs.renameSync(filePath, `${filePath}.1`)
    return { rotated: true, size }
  } catch (error) {
    return { rotated: false, size, error }
  }
}

module.exports = { stripAnsi, rotateLogFile }
