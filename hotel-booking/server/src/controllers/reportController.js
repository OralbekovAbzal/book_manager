const {
  listDefinitions, getDefinition, validateDefinition, cleanDefinition,
  createDefinition, updateDefinition, removeDefinition, importDefinition,
} = require('../reports/registry')
const { describeDatasets } = require('../reports/datasets')
const { resolveOptions } = require('../reports/options')
const { runReport } = require('../reports/engine')
const { exportReport } = require('../reports/export')
const vocab = require('../reports/vocab')
const { getCurrentBusinessDate } = require('../utils/businessDate')
const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')
const { emitReportsChanged } = require('../socket/socketManager')

/**
 * Отчёты. Контроллер намеренно тонкий: он не знает, что такое «загрузка» или
 * «реестр» — только берёт определение и отдаёт его движку. Новый отчёт = новое
 * определение (файл, конструктор или импорт), без правок этого файла.
 */

function summary(d) {
  return {
    id: d.id,
    title: d.title,
    description: d.description,
    icon: d.icon,
    dataset: d.dataset,
    source: d.source,
    editable: d.editable,
    createdBy: d.createdBy || null,
    updatedAt: d.updatedAt || null,
  }
}

async function withMeta(result, req, today) {
  const hotel = await prisma.hotelSettings.findUnique({ where: { id: 1 } }).catch(() => null)
  result.meta.hotelName = hotel?.name || 'Отель'
  result.meta.businessDate = today.toISOString().slice(0, 10)
  result.meta.requestedBy = req.admin?.name || null
  return result
}

function notifyChanged() {
  try { emitReportsChanged() } catch { /* сокет не инициализирован — не критично */ }
}

// GET /api/reports — список доступных отчётов (без данных)
async function list(req, res, next) {
  try {
    res.json({ data: (await listDefinitions()).map(summary) })
  } catch (err) { next(err) }
}

// GET /api/reports/datasets — описание источников данных
async function datasets(req, res, next) {
  try {
    res.json({ data: describeDatasets() })
  } catch (err) { next(err) }
}

// GET /api/reports/meta — всё, из чего конструктор собирает определение
async function meta(req, res, next) {
  try {
    res.json({ data: Object.assign({ datasets: describeDatasets() }, vocab) })
  } catch (err) { next(err) }
}

// GET /api/reports/:id — определение с подставленными списками значений (для формы)
async function get(req, res, next) {
  try {
    res.json({ data: await resolveOptions(await getDefinition(req.params.id)) })
  } catch (err) { next(err) }
}

// GET /api/reports/:id/definition — «чистое» определение для редактора и экспорта в JSON
async function definition(req, res, next) {
  try {
    const def = await getDefinition(req.params.id)
    res.json({ data: cleanDefinition(def), source: def.source, editable: def.editable })
  } catch (err) { next(err) }
}

// POST /api/reports/:id/run — выполнить отчёт с параметрами
async function run(req, res, next) {
  try {
    const def = await getDefinition(req.params.id)
    const today = await getCurrentBusinessDate()
    const result = await runReport(def, req.body?.params || {}, { today })
    res.json({ data: await withMeta(result, req, today) })
  } catch (err) { next(err) }
}

// POST /api/reports/:id/export — тот же отчёт файлом (csv / xlsx / docx)
async function exportFile(req, res, next) {
  try {
    const def = await getDefinition(req.params.id)
    const format = String(req.body?.format || req.query.format || 'xlsx').toLowerCase()
    const today = await getCurrentBusinessDate()

    // forExport поднимает потолок строк: на экране лимит защищает браузер,
    // а в файл выгружают именно всё найденное.
    const result = await withMeta(
      await runReport(def, req.body?.params || {}, { today, forExport: true }), req, today,
    )
    const file = await exportReport(result, format, def.totalsLabel)

    // Кириллица в имени файла живёт только в filename* (RFC 5987);
    // в filename оставляем транслит для старых клиентов.
    res.setHeader('Content-Type', file.mime)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"; filename*=UTF-8''${encodeURIComponent(file.filenameUtf8)}`,
    )
    res.setHeader('Content-Length', file.buffer.length)
    res.send(file.buffer)
  } catch (err) { next(err) }
}

// --- Конструктор / редактор ---------------------------------------------------

function bodyDefinition(req) {
  const def = req.body?.definition
  if (!def || typeof def !== 'object' || Array.isArray(def)) {
    throw createError('Ожидается поле definition с определением отчёта', 400)
  }
  return def
}

// POST /api/reports/validate — проверить определение, не сохраняя.
// При успехе возвращает его же с подставленными списками значений: конструктору
// это нужно для формы предпросмотра, а второй запрос ради этого — лишний.
async function validate(req, res, next) {
  try {
    const def = bodyDefinition(req)
    const problems = validateDefinition(def)
    res.json({
      data: {
        ok: problems.length === 0,
        problems,
        definition: problems.length ? null : await resolveOptions(cleanDefinition(def)),
      },
    })
  } catch (err) { next(err) }
}

// POST /api/reports/preview — выполнить определение, не сохраняя (живой предпросмотр)
async function preview(req, res, next) {
  try {
    const def = bodyDefinition(req)
    const problems = validateDefinition(def)
    if (problems.length) {
      return res.status(400).json({ error: 'Определение отчёта некорректно', problems })
    }
    const today = await getCurrentBusinessDate()
    const clean = cleanDefinition(def)
    if (!clean.id) clean.id = 'preview'
    const result = await runReport(clean, req.body?.params || {}, { today })
    res.json({ data: await withMeta(result, req, today) })
  } catch (err) { next(err) }
}

// POST /api/reports — сохранить новый отчёт
async function create(req, res, next) {
  try {
    const def = await createDefinition(bodyDefinition(req), req.admin?.id)
    notifyChanged()
    res.status(201).json({ data: def })
  } catch (err) { next(err) }
}

// PUT /api/reports/:id — изменить пользовательский отчёт
async function update(req, res, next) {
  try {
    const def = await updateDefinition(req.params.id, bodyDefinition(req))
    notifyChanged()
    res.json({ data: def })
  } catch (err) { next(err) }
}

// DELETE /api/reports/:id — удалить пользовательский отчёт
async function remove(req, res, next) {
  try {
    await removeDefinition(req.params.id)
    notifyChanged()
    res.json({ data: { id: req.params.id } })
  } catch (err) { next(err) }
}

// POST /api/reports/import — загрузить определение из JSON
async function importJson(req, res, next) {
  try {
    const { definition: def, renamed, requestedId } = await importDefinition(bodyDefinition(req), req.admin?.id)
    notifyChanged()
    res.status(201).json({ data: def, renamed, requestedId })
  } catch (err) { next(err) }
}

module.exports = {
  list, datasets, meta, get, definition, run, exportFile,
  validate, preview, create, update, remove, importJson,
}
