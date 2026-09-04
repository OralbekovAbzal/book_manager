const path = require('path')
const fs = require('fs')
const cron = require('node-cron')
const { Prisma } = require('@prisma/client')
const { prisma } = require('./prisma')
const logger = require('./logger')
const { createError } = require('../middleware/errorHandler')

/**
 * Резервная копия — полный JSON-дамп всех таблиц средствами Prisma.
 *
 * pg_dump не используется: его нет ни на dev-машине, ни в упакованном приложении
 * (embedded-postgres поставляется без утилит), из-за чего ночной бэкап месяцами
 * молча падал.
 *
 * ВАЖНО ПРО ДЕНЬГИ. Восстановление физически УДАЛЯЕТ содержимое таблиц и
 * вставляет его заново из файла. Значит любая таблица, которой в файле нет,
 * после восстановления оказывается пустой. До версии формата 2 состав дампа
 * вёлся руками, и в списке не было `Payment` (журнал принятой кассы) и
 * `BookingService` (питание и услуги броней) — то есть «восстановление из
 * резервной копии» само стирало кассу. Теперь состав берётся из схемы
 * (Prisma DMMF), а файлы старого формата без явного подтверждения не
 * восстанавливаются (см. assessRestore).
 *
 * Из этого правила ровно два исключения — `BackupLog` и `Snapshot`. Их не
 * только не пишут в файл, но и НЕ ОЧИЩАЮТ при восстановлении: иначе «таблицы
 * нет в файле» означало бы «после восстановления она пуста». Почему именно
 * эти две — у EXCLUDED_MODELS, причины у них разные.
 *
 * Формат файла:
 *   { version: 2, createdAt, tables: { Admin: [...], Booking: [...], ... } }
 * Date → ISO-строки (JSON.stringify), при восстановлении — обратно по DMMF.
 */

const BACKUP_PATH = process.env.BACKUP_PATH || path.join(process.cwd(), 'backups')
// Сколько последних файлов хранить — старые удаляются после каждой новой копии
const BACKUP_KEEP = Math.max(1, parseInt(process.env.BACKUP_KEEP || '14', 10) || 14)
// Часовой пояс для метки в имени файла и расписания: сервер живёт в TZ=UTC,
// поэтому без него «03:00» срабатывало в 08:00 по Алматы.
const BACKUP_TZ = validTimeZone(process.env.BACKUP_TZ || 'Asia/Almaty')
const FILE_RE = /^backup_[0-9A-Za-z_-]+\.json$/

/**
 * Версия формата:
 *   1 — состав таблиц вёлся руками; нет `Payment`, `BookingService`,
 *       `ReportDefinition` и справочников номерного фонда.
 *   2 — состав собран из схемы: все таблицы, кроме явных исключений.
 *
 * Версия НЕ поднята из-за исключения `Snapshot`: у копий, снятых до него,
 * таблица `Snapshot` в файле есть, и её просто игнорируют — восстановление
 * из вчерашней копии работает как работало и подтверждения не требует
 * (лишняя таблица не попадает ни в unknownTables, ни в emptiedTables).
 * Поднимать версию значило бы объявить все вчерашние копии «старым форматом»
 * на ровном месте.
 */
const BACKUP_VERSION = 2
const SUPPORTED_VERSIONS = new Set([1, 2])

// Одна INSERT-строка не должна упираться в лимит параметров Postgres (32767),
// поэтому размер пачки считается от числа колонок модели, а не берётся наугад.
const MAX_INSERT_PARAMS = 30000
const MAX_CHUNK = 500

// ─── Состав дампа: берётся из схемы, а не из списка руками ────────────────────
//
// Раньше здесь стоял массив TABLES, который вели вручную, и на этом дважды
// потеряли данные: `Payment` и `BookingService` завели в сентябре, а в список
// не добавили. Теперь состав собирается из `Prisma.dmmf` — новая таблица
// попадает в копию сама, без правки этого файла.
//
// Исключения — короткий список, и причина у каждого своя.
//
//   BackupLog — журнал самих копий. Он описывает файлы на диске (включая
//   защитную копию, которую делает сам откат), и подмена этой истории
//   состоянием месячной давности врала бы о том, что реально лежит в папке.
//
//   Snapshot — оперативные точки отката ЭТОЙ установки, а не данные отеля.
//   Причина в размере: на живой базе 20 снимков занимали 1.29 МБ из 1.45 МБ
//   файла (87 %), а штатная ротация допускает до 60 (15 auto + 15 shift +
//   20 manual + 10 safety). Ночная копия выросла бы примерно до 5 МБ, при
//   BACKUP_KEEP=14 — до ~70 МБ папки, почти целиком из копий точек отката.
//   Восстанавливать снимки из ночной копии незачем: снимок описывает
//   состояние базы на свой момент, а не то, что нужно вернуть.
//   ПОБОЧНАЯ ПОЛЬЗА: снимки переживают восстановление из копии и остаются
//   страховкой от ошибочного восстановления — откатом можно вернуться к тому,
//   что было до него.
//   ЧЕГО ДЕЛАТЬ НЕЛЬЗЯ (вариант рассматривали и отвергли): хранить снимки в
//   копии без тяжёлого поля `data`. Восстановленный снимок с пустым `data`
//   выглядит в списке обычной точкой отката, а откат к нему ОЧИСТИТ брони —
//   ловушка страшнее лишних мегабайт.
//
// ПРАВИЛО для будущих исключений — про внешние ключи в обе стороны:
//  1. На исключённую модель никто не должен ссылаться: иначе строки
//     восстановленных таблиц получат NULL в ссылке на неё. Ловится проверкой
//     в buildSchemaPlan (пишет в лог).
//  2. Если исключённая модель сама ссылается на восстанавливаемую — её строки
//     переживут `deleteMany` родителя, и база применит к ним объявленное в
//     схеме действие: SET NULL для необязательной ссылки, отказ для Restrict.
//     Ровно этот случай у `Snapshot.createdById → Admin` (ON DELETE SET NULL),
//     поэтому авторство снимков восстановление запоминает и возвращает само —
//     см. restoreBackup. Новое исключение с внешними ключами требует такой же
//     пары шагов, иначе связь пропадёт молча.
const EXCLUDED_MODELS = new Set(['BackupLog', 'Snapshot'])

// Таблицы, потеря строк которых — это потеря денег. Ими меряется «честный отказ».
const MONEY_MODELS = ['Payment', 'BookingCharge', 'BookingService']

const modelKey = (name) => name[0].toLowerCase() + name.slice(1)

function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz } catch {
    logger.error(`Backup: unknown BACKUP_TZ "${tz}", falling back to UTC`)
    return 'UTC'
  }
}

// Метка «ГГГГ-ММ-ДД_ЧЧ-мм» по местному времени BACKUP_TZ
function localStamp(date) {
  const s = date.toLocaleString('sv-SE', { timeZone: BACKUP_TZ, hour12: false })
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{2}):(\d{2})/)
  if (!m) return date.toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  return `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}`
}

// ─── План по схеме ────────────────────────────────────────────────────────────

/**
 * Разбор схемы: какие модели входят в копию, в каком порядке их вставлять,
 * какие колонки — даты/JSON/списки, у каких моделей id на последовательности.
 *
 * Считается один раз: DMMF внутри процесса не меняется.
 */
let planCache = null
function schemaPlan() {
  if (!planCache) planCache = buildSchemaPlan()
  return planCache
}

function buildSchemaPlan() {
  const all = Prisma.dmmf.datamodel.models
  const included = all.filter((m) => !EXCLUDED_MODELS.has(m.name))
  const names = new Set(included.map((m) => m.name))

  const models = new Map()
  const edges = new Map() // модель → множество моделей, на которые она ссылается FK

  for (const m of included) {
    const known = new Set(), dates = new Set(), jsons = new Set(), lists = new Set()
    const required = []
    let idField = null, autoIncrementId = false, updatedAtField = null
    let columns = 0

    for (const f of m.fields) {
      if (f.kind !== 'scalar' && f.kind !== 'enum') continue
      known.add(f.name)
      columns++
      if (f.type === 'DateTime') dates.add(f.name)
      if (f.type === 'Json') jsons.add(f.name)
      if (f.isList) lists.add(f.name)
      if (f.isId) { idField = f.name; autoIncrementId = f.default?.name === 'autoincrement' }
      if (f.isUpdatedAt) updatedAtField = f.name
      // Колонка, которую файл обязан содержать: без неё вставка просто упадёт.
      // Поля со значением по умолчанию и @updatedAt подставит сама база.
      if (f.isRequired && !f.hasDefaultValue && !f.isUpdatedAt && !f.isList) required.push(f.name)
    }

    // Внешние ключи. `deferred` — те, что нельзя проставить сразу при вставке:
    // самоссылка (Payment.refundOfId → Payment) и рёбра, разорванные ради цикла.
    const deferred = new Set()
    const refs = new Set()
    for (const f of m.fields) {
      if (f.kind !== 'object' || !f.relationFromFields || f.relationFromFields.length === 0) continue
      if (f.type === m.name) {
        // Самоссылка: порядок таблиц её не решает, а порядок СТРОК внутри
        // createMany зависит от разбиения на пачки. Вставляем с null и
        // проставляем вторым проходом.
        for (const col of f.relationFromFields) deferred.add(col)
        continue
      }
      if (!names.has(f.type)) {
        // Исключённая модель, на которую кто-то ссылается — см. правило выше
        logger.error(
          `Backup: модель ${m.name} ссылается на исключённую из копии ${f.type} — `
          + 'исключение нужно снять, иначе восстановление обнулит эту связь',
        )
        continue
      }
      refs.add(f.type)
    }

    edges.set(m.name, refs)
    models.set(m.name, {
      name: m.name,
      key: modelKey(m.name),
      known, dates, jsons, lists, required,
      idField, autoIncrementId, updatedAtField,
      deferred,
      optionalRelations: new Map(
        m.fields
          .filter((f) => f.kind === 'object' && f.relationFromFields?.length > 0 && !f.isRequired)
          .map((f) => [f.type, f.relationFromFields]),
      ),
      chunk: Math.max(1, Math.min(MAX_CHUNK, Math.floor(MAX_INSERT_PARAMS / Math.max(1, columns)))),
    })
  }

  const order = topoSort(edges, models)
  return { order, models }
}

/**
 * Порядок вставки: сначала те, на кого ссылаются. Раньше этот порядок был
 * записан руками тем же массивом TABLES — при автосоставе его нужно вычислять.
 *
 * Циклы (A → B → A) в текущей схеме отсутствуют, но если появятся —
 * разрываем по необязательному внешнему ключу: его можно вставить как NULL
 * и проставить вторым проходом, ровно как самоссылку возврата.
 */
function topoSort(edges, models) {
  const pending = new Map([...edges].map(([name, deps]) => [name, new Set(deps)]))
  const order = []

  while (pending.size > 0) {
    // Сортировка по имени — чтобы порядок был воспроизводимым от запуска к запуску
    const ready = [...pending].filter(([, deps]) => deps.size === 0).map(([name]) => name).sort()

    if (ready.length === 0) {
      const broken = breakCycle(pending, models)
      if (!broken) {
        // Цикл из обязательных ссылок вставить нельзя в принципе — падаем громко
        // на старте, а не в середине восстановления.
        throw new Error(
          `Backup: в схеме цикл обязательных внешних ключей между ${[...pending.keys()].join(', ')}`,
        )
      }
      continue
    }

    for (const name of ready) { order.push(name); pending.delete(name) }
    for (const [, deps] of pending) for (const name of ready) deps.delete(name)
  }

  return order
}

/** Ищет в остатке ребро с необязательным FK и откладывает его на второй проход. */
function breakCycle(pending, models) {
  for (const [name, deps] of pending) {
    const info = models.get(name)
    for (const dep of deps) {
      const cols = info.optionalRelations.get(dep)
      if (!cols) continue
      for (const col of cols) info.deferred.add(col)
      deps.delete(dep)
      logger.warn(`Backup: цикл ${name} → ${dep} разорван по необязательной ссылке ${cols.join(', ')}`)
      return true
    }
  }
  return false
}

/**
 * Модели из плана, которые есть в сгенерированном Prisma Client
 * (после добавления таблицы в схему клиент могли ещё не перегенерировать).
 */
function presentTables() {
  return schemaPlan().order.filter((t) => {
    if (prisma[modelKey(t)]) return true
    logger.warn(`Backup: model ${t} is missing in Prisma Client, skipped`)
    return false
  })
}

// ─── Создание копии ───────────────────────────────────────────────────────────

async function createBackup() {
  fs.mkdirSync(BACKUP_PATH, { recursive: true })
  const now = new Date()
  const stamp = localStamp(now)
  let filename = `backup_${stamp}.json`
  // Две копии в одну минуту (ручная + перед восстановлением) — добавляем секунды,
  // а при совпадении и секунд — порядковый номер, чтобы не перезаписать файл
  const sec = String(now.getUTCSeconds()).padStart(2, '0')
  for (let n = 1; fs.existsSync(path.join(BACKUP_PATH, filename)); n++) {
    filename = `backup_${stamp}-${sec}${n > 1 ? `-${n}` : ''}.json`
  }
  const filePath = path.join(BACKUP_PATH, filename)
  const tmpPath = filePath + '.tmp'

  try {
    const { models } = schemaPlan()
    const tables = {}
    for (const name of presentTables()) {
      const info = models.get(name)
      tables[name] = await prisma[info.key].findMany(
        info.idField ? { orderBy: { [info.idField]: 'asc' } } : {},
      )
    }
    // Пишем во временный файл и переименовываем: обрыв на записи не оставит битую копию
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ version: BACKUP_VERSION, createdAt: now.toISOString(), tables }),
      'utf8',
    )
    fs.renameSync(tmpPath, filePath)
    const size = fs.statSync(filePath).size

    await prisma.backupLog.create({ data: { path: filePath, size, success: true } })
    logger.info(`Backup created: ${filename} (${size} bytes)`)
    pruneOldBackups()
    return { filename, path: filePath, size, createdAt: now.toISOString() }
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* временного файла может не быть */ }
    const message = String((err && err.message) || err).slice(0, 1000)
    try {
      await prisma.backupLog.create({ data: { path: filePath, size: 0, success: false, error: message } })
    } catch (logErr) {
      logger.error(`Backup log write failed: ${logErr.message}`)
    }
    logger.error(`Backup failed: ${message}`)
    throw err
  }
}

// Файлы копий в BACKUP_PATH, новые сверху
function listBackupFiles() {
  if (!fs.existsSync(BACKUP_PATH)) return []
  return fs.readdirSync(BACKUP_PATH)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_PATH, f))
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

function pruneOldBackups() {
  try {
    for (const f of listBackupFiles().slice(BACKUP_KEEP)) {
      fs.unlinkSync(path.join(BACKUP_PATH, f.name))
      logger.info(`Old backup deleted: ${f.name}`)
    }
  } catch (err) {
    logger.warn(`Backup prune failed: ${err.message}`)
  }
}

// Последняя запись журнала копий (удачная или нет) — для строки статуса в настройках
function lastBackupLog() {
  return prisma.backupLog.findFirst({ orderBy: { createdAt: 'desc' } })
}

// ─── Разбор файла ─────────────────────────────────────────────────────────────

/**
 * Строки из файла → данные для createMany: ISO → Date, null в Json → DbNull,
 * неизвестные колонки (файл из более новой версии) отбрасываются.
 * Отложенные внешние ключи (самоссылка возврата) обнуляются, а их значения
 * возвращаются отдельно — их проставит второй проход.
 */
function prepareRows(info, list) {
  if (!Array.isArray(list)) return { rows: [], links: [], unknown: [] }
  const rows = []
  const links = []
  const unknown = new Set()

  for (const src of list) {
    const row = {}
    const deferredValues = {}
    for (const [k, v] of Object.entries(src || {})) {
      if (!info.known.has(k)) { unknown.add(k); continue }
      if (info.deferred.has(k)) {
        // Ссылка на строку той же таблицы: сначала все строки, потом связи
        if (v != null) deferredValues[k] = v
        row[k] = null
        continue
      }
      if (v == null) {
        // Списку (String[]) null подсунуть нельзя — пусть сработает default схемы
        if (info.lists.has(k)) continue
        row[k] = info.jsons.has(k) ? Prisma.DbNull : null
        continue
      }
      row[k] = info.dates.has(k) ? new Date(v) : v
    }
    rows.push(row)
    if (Object.keys(deferredValues).length > 0 && info.idField && row[info.idField] != null) {
      links.push({ id: row[info.idField], values: deferredValues, row })
    }
  }

  return { rows, links, unknown: [...unknown] }
}

/**
 * План восстановления: строки по таблицам, отложенные связи и то, чего в файле
 * не хватает. Отдельная функция, чтобы «показать последствия» и сам откат
 * считали ОДНО И ТО ЖЕ — предупреждение, расходящееся с фактом, хуже отсутствия
 * предупреждения (тот же приём, что в utils/snapshot.js).
 */
function buildRestorePlan(dump) {
  const { models } = schemaPlan()
  const present = presentTables()
  const rowsByTable = {}
  const linksByTable = {}
  const missingTables = []   // таблицы, которых в файле нет вовсе
  const incomplete = []      // таблицы, где в файле не хватает обязательных колонок

  for (const name of present) {
    const info = models.get(name)
    const raw = dump.tables[name]
    if (raw === undefined) { missingTables.push(name); rowsByTable[name] = []; linksByTable[name] = []; continue }

    const { rows, links, unknown } = prepareRows(info, raw)
    if (unknown.length > 0) {
      // Колонки, которых нет в нынешней схеме: файл сделан более новой версией
      logger.warn(`Backup restore: в файле есть колонки ${name}, которых нет в схеме: ${unknown.join(', ')}`)
    }
    if (rows.length > 0) {
      const lacking = info.required.filter((f) => rows[0][f] === undefined)
      if (lacking.length > 0) incomplete.push({ table: name, fields: lacking })
    }
    rowsByTable[name] = rows
    linksByTable[name] = links
  }

  // Таблицы из файла, которых нет в схеме — их данные восстановить некуда.
  // Исключённые (`BackupLog`, `Snapshot`) сюда не попадают намеренно: в старых
  // копиях они есть, но их отсутствие в плане — наше решение, а не поломка
  // файла. Иначе каждая копия, снятая до исключения снимков, начала бы
  // требовать allowDataLoss и пугать пользователя.
  const unknownTables = Object.keys(dump.tables || {})
    .filter((t) => !EXCLUDED_MODELS.has(t) && !models.has(t))
    .filter((t) => Array.isArray(dump.tables[t]) && dump.tables[t].length > 0)

  return { present, rowsByTable, linksByTable, missingTables, unknownTables, incomplete }
}

// ─── Оценка последствий ───────────────────────────────────────────────────────

/** Деньги — с двумя знаками, как в paymentController: копить ошибку double нельзя. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Вклад платежа в кассу: возврат вычитается, отменённый не считается вовсе. */
function signedPayment(p) {
  if (p.voidedAt) return 0
  return p.kind === 'refund' ? -(p.amount || 0) : (p.amount || 0)
}

function formatMoney(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(round2(n))
}

/**
 * Что нынешнее состояние потеряет от восстановления.
 *
 * Гейт — то, чего файл вернуть НЕ МОЖЕТ:
 *  1. платежи, которых в файле нет (принятые наличные и карты — единственное,
 *     что не пересчитывается);
 *  2. таблицы, отсутствующие в файле целиком, при непустой таблице в базе —
 *     ровно случай старого формата: восстановление обнулит кассу, услуги,
 *     пользовательские отчёты и справочники номерного фонда молча;
 *  3. таблицы из файла, которых нет в схеме (файл от более новой версии).
 *
 * Начисления и услуги показываем в сводке, но восстановление из-за них не
 * блокируем: замена состояния файлом — это и есть смысл операции, а защитная
 * копия перед ней вернёт всё обратно.
 */
async function assessRestore(dump, plan) {
  const { models } = schemaPlan()
  const version = Number(dump.version) || 1

  const tables = {}
  for (const name of MONEY_MODELS) {
    if (!plan.present.includes(name)) continue
    const info = models.get(name)
    const current = await prisma[info.key].findMany(
      name === 'Payment'
        ? { select: { id: true, kind: true, amount: true, voidedAt: true } }
        : name === 'BookingCharge'
          ? { select: { id: true, amount: true } }
          : { select: { id: true } },
    )
    const willRestore = new Set(plan.rowsByTable[name].map((r) => r[info.idField]))
    const lost = current.filter((r) => !willRestore.has(r.id))
    tables[name] = {
      current: current.length,
      restored: plan.rowsByTable[name].length,
      lost: lost.length,
      lostAmount: name === 'Payment'
        ? round2(lost.reduce((s, p) => s + signedPayment(p), 0))
        : round2(lost.reduce((s, r) => s + (r.amount || 0), 0)),
    }
  }

  // Из отсутствующих в файле таблиц опасны только непустые: пустую обнулять нечем
  const emptied = []
  for (const name of plan.missingTables) {
    const info = models.get(name)
    const count = await prisma[info.key].count()
    if (count > 0) emptied.push({ table: name, rows: count })
  }

  const lostPayments = tables.Payment?.lost || 0
  return {
    version,
    legacyFormat: version < BACKUP_VERSION,
    payments: tables.Payment || null,
    charges: tables.BookingCharge || null,
    services: tables.BookingService || null,
    // Таблицы, которые файл обнулит, потому что не содержит их вовсе
    emptiedTables: emptied,
    // Таблицы из файла, которых нет в схеме — их строки восстановить некуда
    unknownTables: plan.unknownTables,
    requiresConfirmation: lostPayments > 0 || emptied.length > 0 || plan.unknownTables.length > 0,
  }
}

/** Текст отказа: что именно исчезнет и что с этим делать. */
function dataLossMessage(impact) {
  const parts = ['Восстановление отменено: файл копии не содержит части нынешних данных.']

  if (impact.payments?.lost > 0) {
    parts.push(
      `Будет стёрто платежей — ${impact.payments.lost} `
      + `(на ${formatMoney(impact.payments.lostAmount)} ₸).`,
    )
  }
  if (impact.emptiedTables.length > 0) {
    parts.push(
      'Этих таблиц в файле нет вовсе, они будут очищены: '
      + impact.emptiedTables.map((t) => `${t.table} (${t.rows})`).join(', ') + '.',
    )
  }
  if (impact.unknownTables.length > 0) {
    parts.push(
      'А эти таблицы есть в файле, но их нет в нынешней схеме — их данные пропадут: '
      + impact.unknownTables.join(', ') + '. Похоже, файл сделан более новой версией программы.',
    )
  }
  if (impact.legacyFormat) {
    parts.push(
      `Файл в старом формате (версия ${impact.version}): состав таблиц в нём вёлся вручную, `
      + 'кассы и услуг броней он не хранит.',
    )
  }
  parts.push(
    'Перед восстановлением делается копия текущего состояния, но потерю нужно '
    + 'подтвердить явно: повторите запрос с "allowDataLoss": true.',
  )
  return parts.join(' ')
}

// ─── Восстановление ───────────────────────────────────────────────────────────

let restoreInProgress = false

/** Читает и проверяет файл копии. Ничего не меняет. */
function readDump(fileName) {
  const name = String(fileName || '')
  if (!FILE_RE.test(name) || path.basename(name) !== name) {
    throw createError('Некорректное имя файла копии', 400)
  }
  const filePath = path.join(BACKUP_PATH, name)
  if (!fs.existsSync(filePath)) throw createError('Файл копии не найден', 404)

  let dump
  try { dump = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch {
    throw createError('Файл копии повреждён или не является JSON', 400)
  }
  if (!dump || !dump.tables || typeof dump.tables !== 'object') {
    throw createError('Неподдерживаемый формат копии', 400)
  }
  if (!SUPPORTED_VERSIONS.has(Number(dump.version))) {
    throw createError(
      `Формат копии версии ${dump.version} не поддерживается (эта программа читает `
      + `${[...SUPPORTED_VERSIONS].join(' и ')})`,
      400,
    )
  }
  return { name, dump }
}

/**
 * Сводка последствий восстановления — для окна подтверждения. Ничего не меняет.
 */
async function describeRestore(fileName) {
  const { name, dump } = readDump(fileName)
  const plan = buildRestorePlan(dump)
  const impact = await assessRestore(dump, plan)

  return {
    file: name,
    version: impact.version,
    createdAt: dump.createdAt || null,
    legacyFormat: impact.legacyFormat,
    // Сколько строк вернётся по каждой таблице
    rows: Object.fromEntries(plan.present.map((t) => [t, plan.rowsByTable[t].length])),
    payments: impact.payments,
    charges: impact.charges,
    services: impact.services,
    emptiedTables: impact.emptiedTables,
    unknownTables: impact.unknownTables,
    incomplete: plan.incomplete,
    requiresConfirmation: impact.requiresConfirmation,
    warning: impact.requiresConfirmation ? dataLossMessage(impact) : null,
  }
}

/**
 * @param {string} fileName  имя файла в BACKUP_PATH
 * @param {number|null} adminId  кто запустил (для журнала)
 * @param {{ allowDataLoss?: boolean }} options
 */
async function restoreBackup(fileName, adminId = null, options = {}) {
  const allowDataLoss = options.allowDataLoss === true
  const { name, dump } = readDump(fileName)
  if (restoreInProgress) throw createError('Восстановление уже выполняется', 409)

  const { models } = schemaPlan()
  const plan = buildRestorePlan(dump)

  // Не хватает обязательных колонок — вставка всё равно упадёт, но лучше сказать
  // это до создания защитной копии и до транзакции.
  if (plan.incomplete.length > 0) {
    throw createError(
      'Файл копии неполный: не хватает обязательных колонок — '
      + plan.incomplete.map((i) => `${i.table}: ${i.fields.join(', ')}`).join('; '),
      400,
    )
  }

  const impact = await assessRestore(dump, plan)
  // Проверяем ДО защитной копии: отказ не должен создавать файл и ротацией
  // вытеснять самую старую настоящую копию.
  if (impact.requiresConfirmation && !allowDataLoss) {
    logger.warn(
      `Backup ${name} restore refused: ${impact.payments?.lost || 0} payments would be lost, `
      + `emptied tables: ${impact.emptiedTables.map((t) => t.table).join(',') || 'none'}, `
      + `format v${impact.version}`,
    )
    const err = createError(dataLossMessage(impact), 409)
    err.impact = impact
    throw err
  }

  restoreInProgress = true
  try {
    // Точка отката: обычная копия текущего состояния. Она уже в новом формате,
    // поэтому «откат восстановления» вернёт и кассу тоже.
    const safety = await createBackup()
    logger.info(`Restore from ${name} by admin ${adminId}: safety backup ${safety.filename}`)

    const restored = {}
    let deferredLinks = 0
    let keptSnapshotAuthors = 0
    let orphanedSnapshotAuthors = 0
    await prisma.$transaction(async (tx) => {
      // Пересчёт последствий уже внутри транзакции: между показом предупреждения
      // и восстановлением второй администратор мог принять оплату, и её удаление
      // было бы ровно тем «молча», от которого защищаемся.
      if (!allowDataLoss && plan.present.includes('Payment')) {
        const fresh = await tx.payment.findMany({ select: { id: true } })
        const willRestore = new Set(plan.rowsByTable.Payment.map((r) => r.id))
        const lost = fresh.filter((p) => !willRestore.has(p.id)).length
        if (lost > 0) {
          throw createError(
            `Восстановление отменено: пока подтверждали, в кассе появились новые платежи (${lost}). `
            + 'Проверьте последствия заново.',
            409,
          )
        }
      }

      // Снимки восстановление не трогает (см. EXCLUDED_MODELS), но их автор —
      // ссылка на Admin, а Admin мы сейчас удалим и создадим заново. Внешний
      // ключ объявлен ON DELETE SET NULL, поэтому без пары «запомнили до /
      // вернули после» у всех уцелевших снимков молча пропал бы автор.
      // Читаем ДО удаления и без колонки `data` — она тяжёлая (мегабайты).
      const snapshotAuthors = EXCLUDED_MODELS.has('Snapshot') && tx.snapshot
        ? await tx.snapshot.findMany({
          where: { createdById: { not: null } },
          select: { id: true, createdById: true },
        })
        : []

      // Удаляем в обратном порядке зависимостей, вставляем в прямом; id сохраняются
      for (const t of [...plan.present].reverse()) await tx[models.get(t).key].deleteMany({})

      for (const t of plan.present) {
        const info = models.get(t)
        const rows = plan.rowsByTable[t]
        for (let i = 0; i < rows.length; i += info.chunk) {
          await tx[info.key].createMany({ data: rows.slice(i, i + info.chunk) })
        }
        restored[t] = rows.length
      }

      // Второй проход: отложенные ссылки внутри таблицы (возврат → исходный
      // платёж). Ставим их, когда все строки уже на месте.
      for (const t of plan.present) {
        const info = models.get(t)
        const restoredIds = new Set(plan.rowsByTable[t].map((r) => r[info.idField]))
        for (const link of plan.linksByTable[t]) {
          // Цель могла не восстановиться (её нет в файле) — связь теряем,
          // саму строку сохраняем: строка кассы важнее связи.
          const data = {}
          for (const [col, value] of Object.entries(link.values)) {
            if (restoredIds.has(value)) data[col] = value
          }
          if (Object.keys(data).length === 0) continue
          // `updatedAt` передаём явно: у поля @updatedAt Prisma иначе проставит
          // «сейчас», и восстановленная строка отличалась бы от снятой
          if (info.updatedAtField && link.row[info.updatedAtField] != null) {
            data[info.updatedAtField] = link.row[info.updatedAtField]
          }
          await tx[info.key].update({ where: { [info.idField]: link.id }, data })
          deferredLinks++
        }
      }

      // Возвращаем авторство снимков. Администраторы вставлены со своими id,
      // поэтому ссылка ведёт к тому же человеку. Снимок, чей автор заведён
      // ПОСЛЕ снятия копии, в файле не найдётся — такой остаётся без автора,
      // и это честно: приписать его некому.
      if (snapshotAuthors.length > 0) {
        const restoredAdmins = new Set((plan.rowsByTable.Admin || []).map((r) => r.id))
        const byAdmin = new Map()
        for (const s of snapshotAuthors) {
          if (!restoredAdmins.has(s.createdById)) { orphanedSnapshotAuthors++; continue }
          if (!byAdmin.has(s.createdById)) byAdmin.set(s.createdById, [])
          byAdmin.get(s.createdById).push(s.id)
        }
        // Одним запросом на администратора, а не на снимок: их единицы
        for (const [adminId, ids] of byAdmin) {
          await tx.snapshot.updateMany({ where: { id: { in: ids } }, data: { createdById: adminId } })
          keptSnapshotAuthors += ids.length
        }
      }

      // Последовательности — у КАЖДОЙ восстановленной таблицы с автоинкрементом:
      // id вставлены явные, и без сброса следующая же новая строка упрётся
      // в занятый id. (Раньше список вёлся руками — в снимках на этом уже
      // наступили.) Имена таблиц — из схемы, не из запроса.
      for (const t of plan.present) {
        const info = models.get(t)
        if (!info.autoIncrementId) continue
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${t}"', '${info.idField}'), `
          + `COALESCE((SELECT MAX("${info.idField}") FROM "${t}"), 0) + 1, false)`,
        )
      }

    }, { timeout: 300_000, maxWait: 20_000 })

    // Сбрасываем кэш сетки и говорим клиентам перезагрузить её
    try {
      const { invalidateGridCache } = require('../controllers/occupancyController')
      invalidateGridCache()
      const { getIO } = require('../socket/socketManager')
      getIO().to('bookings').emit('snapshot:restored', { backup: name })
    } catch { /* сокет/кэш недоступны — не критично */ }

    logger.info(
      `Backup ${name} (v${impact.version}) restored: ${JSON.stringify(restored)}, links ${deferredLinks}, `
      + `snapshot authors kept ${keptSnapshotAuthors}, orphaned ${orphanedSnapshotAuthors}`,
    )
    return {
      restored,
      safetyBackup: safety.filename,
      version: impact.version,
      // Что снесли осознанно — чтобы это было видно и в журнале действий, и в ответе
      lostPayments: impact.payments?.lost || 0,
      lostPaymentsAmount: impact.payments?.lostAmount || 0,
      emptiedTables: impact.emptiedTables.map((t) => t.table),
    }
  } finally {
    restoreInProgress = false
  }
}

// ─── Расписание ───────────────────────────────────────────────────────────────

function startBackupScheduler() {
  cron.schedule('0 3 * * *', async () => {
    logger.info('Starting scheduled backup...')
    try {
      await createBackup()
    } catch (err) {
      logger.error(`Scheduled backup error: ${err.message}`)
    }
  }, { timezone: BACKUP_TZ })
  logger.info(`Backup scheduler started (daily at 03:00 ${BACKUP_TZ}, keep last ${BACKUP_KEEP})`)
}

module.exports = {
  createBackup,
  restoreBackup,
  describeRestore,
  listBackupFiles,
  lastBackupLog,
  startBackupScheduler,
  BACKUP_VERSION,
  // для тестов и диагностики: какой состав и порядок собрался из схемы
  _schemaPlan: schemaPlan,
}
