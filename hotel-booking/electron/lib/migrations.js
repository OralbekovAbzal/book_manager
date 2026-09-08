/**
 * Обновление схемы у клиента: что ещё не применено, что упало, и копия папки
 * данных перед обновлением.
 *
 * ПОЧЕМУ ЭТО ЕСТЬ (D8-005). `migrate deploy` идёт на КАЖДОМ старте хоста. Если
 * миграция не прошла на живых данных (дубликаты под новый UNIQUE, NULL под новый
 * NOT NULL), в `_prisma_migrations` остаётся строка с `finished_at IS NULL`, и
 * каждый следующий запуск отвечает P3009 «failed migrations… new migrations will
 * not be applied» — программа не поднимается больше никогда, и откат на старый
 * установщик не помогает: запись в таблице та же.
 *
 * Проверено на клоне 08.09.2026: на PostgreSQL упавшая миграция откатывается
 * ЦЕЛИКОМ (DDL транзакционен), то есть схема остаётся прежней, мешает только
 * запись в журнале. Значит `migrate resolve --rolled-back <name>` + повторный
 * deploy — безопасное автоматическое лечение, а не риск оставить полусхему.
 *
 * Копия pgdata перед обновлением — страховка от случая, который так не лечится:
 * миграция прошла, а новая версия программы клиенту не подошла. Копию можно
 * вернуть на место при установленной прежней версии.
 *
 * Как и config.js — без `require('electron')`: модуль читают тесты сервера.
 */
const fs = require('fs')
const path = require('path')

/** Имена папок миграций (те, где есть migration.sql), по возрастанию. */
function listMigrationFolders(migrationsDir) {
  let entries
  try { entries = fs.readdirSync(migrationsDir, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(migrationsDir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort()
}

/**
 * Каких миграций из сборки ещё нет в базе.
 * `appliedNames` не массив (старый маркер без списка) → считаем неприменёнными
 * все: лучше лишний раз снять копию, чем не снять нужную.
 */
function pendingMigrations(folderNames, appliedNames) {
  const list = Array.isArray(folderNames) ? folderNames : []
  if (!Array.isArray(appliedNames)) return [...list]
  const applied = new Set(appliedNames)
  return list.filter((name) => !applied.has(name))
}

/**
 * Строки `_prisma_migrations`, которые начались и не закончились, — те самые,
 * из-за которых deploy отвечает P3009.
 * @returns {{name: string, logs: string}[]}
 */
function failedMigrations(rows) {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => r && r.finished_at == null && r.rolled_back_at == null)
    .map((r) => ({ name: String(r.migration_name || ''), logs: r.logs == null ? '' : String(r.logs) }))
}

/**
 * Куда кладём копию папки данных. Рядом с самой папкой, а не в temp: копия
 * кластера — это гигабайты, и она обязана остаться на том же диске, откуда её
 * можно просто переименовать обратно.
 */
function preUpdateCopyPaths(dataDir) {
  return { final: `${dataDir}-before-update`, tmp: `${dataDir}-before-update.tmp` }
}

/** Размер папки рекурсивно. Нет папки — 0 (не ошибка: считаем «нечего копировать»). */
function dirSizeBytes(dir) {
  let total = 0
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return 0 }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      if (e.isDirectory()) total += dirSizeBytes(p)
      else if (e.isFile()) total += fs.statSync(p).size
    } catch { /* файл исчез между чтением списка и stat — не беда */ }
  }
  return total
}

/**
 * Копия папки данных перед применением миграций.
 *
 * Требуем ДВОЙНОЙ запас места: копия займёт столько же, сколько кластер, и ещё
 * столько же нужно оставить самой базе на работу (WAL, временные файлы) — иначе
 * страховка сама уронит Postgres по ENOSPC.
 *
 * @param {string} dataDir
 * @param {{ freeBytes?: (p: string) => number|null, log?: (...a: any[]) => void }} opts
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
function copyDataDirBeforeUpdate(dataDir, { freeBytes, log } = {}) {
  const hlog = typeof log === 'function' ? log : () => {}
  const { final, tmp } = preUpdateCopyPaths(dataDir)

  try {
    // Обрывок прошлой попытки бесполезен всегда — убираем сразу.
    fs.rmSync(tmp, { recursive: true, force: true })

    // Место проверяем ДО удаления прошлой копии: если новую снять негде, старая
    // остаётся единственной страховкой — уносить её нельзя (находка тестов
    // волны 7). Место под старой копией в расчёт не берём: проще и надёжнее
    // отказаться от новой копии, чем остаться без обеих.
    const free = typeof freeBytes === 'function' ? freeBytes(dataDir) : null
    if (typeof free === 'number') {
      const need = 2 * dirSizeBytes(dataDir)
      if (free < need) {
        hlog('копия папки данных пропущена: свободно', free, 'нужно', need)
        return { ok: false, reason: 'space' }
      }
    }

    // Копия одна: прошлая относится к прошлому обновлению и уже неактуальна.
    fs.rmSync(final, { recursive: true, force: true })
    fs.cpSync(dataDir, tmp, { recursive: true })
    // postmaster.pid из копии убираем: с ним Postgres откажется стартовать на
    // возвращённой папке («lock file already exists»).
    try { fs.rmSync(path.join(tmp, 'postmaster.pid'), { force: true }) } catch { /* его может и не быть */ }
    // Переименование в конце: папка `-before-update` появляется только целиком.
    fs.renameSync(tmp, final)
    hlog('копия папки данных готова:', final)
    return { ok: true, path: final }
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* уже нет */ }
    const reason = String((err && err.message) || err)
    hlog('копия папки данных не удалась:', reason)
    return { ok: false, reason }
  }
}

/**
 * Текст диалога «Обновление базы не удалось». Пишем администратору отеля, а не
 * разработчику: что случилось, что делать и что данные целы.
 */
function describeMigrationFailure({ name, logs, copyPath, logPath } = {}) {
  const head = name
    ? `Не удалось применить обновление базы данных «${name}».`
    : 'Не удалось применить обновление базы данных.'

  const lines = String(logs == null ? '' : logs)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6)

  const parts = [head]
  if (lines.length) parts.push('Что сообщила база:\n' + lines.join('\n'))
  if (copyPath) {
    parts.push(
      `Копия данных до обновления сохранена здесь:\n${copyPath}\n` +
      'Папку можно вернуть на место, переименовав её в pgdata, при установленной прежней версии программы.',
    )
  }
  if (logPath) parts.push(`Подробности: ${logPath}`)
  parts.push('Данные не изменены.')

  return parts.join('\n\n')
}

module.exports = {
  listMigrationFolders,
  pendingMigrations,
  failedMigrations,
  preUpdateCopyPaths,
  dirSizeBytes,
  copyDataDirBeforeUpdate,
  describeMigrationFailure,
}
