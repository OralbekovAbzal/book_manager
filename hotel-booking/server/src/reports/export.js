const ExcelJS = require('exceljs')
const {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, WidthType, AlignmentType, BorderStyle,
} = require('docx')
const { createError } = require('../middleware/errorHandler')
const { hotelTz } = require('../utils/hotelTz')

/**
 * Момент времени → «ДД.ММ.ГГГГ ЧЧ:ММ» по времени отеля (D4-012). Сервер живёт в
 * UTC (`server.js`), поэтому `getHours()` печатал бы Гринвич — на пять часов
 * раньше того, что видит стойка.
 */
function formatDateTimeLocal(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  let parts
  try {
    parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: hotelTz(), year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(d)
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || ''
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`
}

/**
 * Выгрузка результата отчёта в файлы.
 *
 * Работает с ЛЮБЫМ отчётом, потому что на входе только `{columns, rows, totals}`:
 * новый отчёт — хоть встроенный, хоть собранный в конструкторе — получает все
 * форматы сразу, без единой правки здесь.
 *
 * PDF в этом списке нет намеренно: его делает Electron через printToPDF из того
 * же макета, что уходит на принтер. Серверный рендер PDF означал бы второй
 * движок вёрстки и расхождение с печатью.
 */

const NUMERIC = new Set(['int', 'number', 'money', 'percent'])

const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

function formatDateISO(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(value)
}

/** Текстовое представление — для CSV, Word и подписей. */
function asText(value, type) {
  if (value === null || value === undefined) return ''
  switch (type) {
    case 'date': return formatDateISO(value)
    case 'month': {
      const m = /^(\d{4})-(\d{2})/.exec(String(value))
      return m ? `${MONTHS_NOM[Number(m[2]) - 1]} ${m[1]}` : String(value)
    }
    case 'datetime': return formatDateTimeLocal(value)
    case 'bool': return value ? 'да' : 'нет'
    case 'list': return Array.isArray(value) ? value.join(', ') : String(value)
    default: return String(value)
  }
}

/** Значение для ячейки Excel: числа остаются числами, чтобы по ним считали. */
function asCell(value, type) {
  if (value === null || value === undefined || value === '') return null
  if (NUMERIC.has(type) && typeof value === 'number') return value
  return asText(value, type)
}

function periodLabel(result) {
  const p = result.params && result.params.period
  if (!p || !p.from || !p.to) return ''
  return p.from === p.to ? formatDateISO(p.from) : `${formatDateISO(p.from)} — ${formatDateISO(p.to)}`
}

function subtitle(result) {
  const parts = [result.meta.hotelName, periodLabel(result)].filter(Boolean)
  parts.push(`сформирован ${formatDateTimeLocal(result.meta.generatedAt)}`)
  if (result.meta.requestedBy) parts.push(result.meta.requestedBy)
  return parts.join(' · ')
}

/** Строка итогов: подпись в первой колонке, значения — в своих. */
function totalsRow(result, totalsLabel) {
  const { columns, totals } = result
  if (!totals || !Object.keys(totals).length) return null
  const hasValues = Object.values(totals).some((v) => v !== null && v !== undefined)
  if (!hasValues) return null
  return columns.map((c, i) => {
    const v = totals[c.key]
    if (v === null || v === undefined) return i === 0 ? totalsLabel : null
    return v
  })
}

// --- CSV --------------------------------------------------------------------

// Телефон и обычное отрицательное число: `+7 701 123 45 67`, `-5`, `-1 200,50`,
// `+7 (701) 123-45-67`. Такие ячейки Excel формулой не считает, и портить их
// апострофом значит ломать выгрузку ради несуществующего риска.
const PLAIN_NUMBER = /^[+-]?\d[\d\s().,-]*$/

/**
 * Нейтрализация формул в CSV (D4-002).
 *
 * Excel считает формулой всё, что начинается с `=`, `+`, `-`, `@`, а также с
 * табуляции и возврата каретки — включая содержимое ячейки, которую он сам
 * распаковал из кавычек. Имя гостя и примечание пишет стойка, то есть текст
 * произвольный: `=HYPERLINK("http://…"&C2;"Иванов")` в имени утащит телефон из
 * соседней ячейки по одному клику администратора. Ведущий апостроф — то, что
 * Excel понимает как «это текст»: в ячейке он не виден, в строке формул виден.
 *
 * xlsx и docx этого не требуют: там строка записывается строкой, формулой в
 * exceljs становится только объект `{ formula }`.
 */
function csvSafe(s) {
  const str = String(s)
  if (!str) return str
  // Excel при импорте отбрасывает ведущие пробельные символы, поэтому смотрим на
  // первый непробельный знак (OWASP; находка тестов волны 9).
  // Табуляция и возврат каретки — триггеры сами по себе (по сырому первому знаку).
  if (str[0] === '\t' || str[0] === '\r') return `'${str}`
  const ch = str.replace(/^[\s\u00a0]+/, '')[0]
  if (ch === '=' || ch === '@') return `'${str}`
  if ((ch === '+' || ch === '-') && !PLAIN_NUMBER.test(str)) return `'${str}`
  return str
}

/**
 * Разделитель — точка с запятой, десятичный — запятая: так файл открывается
 * двойным кликом в русском Excel. BOM нужен, иначе кириллица превращается
 * в кракозябры.
 */
function buildCsv(result, totalsLabel) {
  const { columns, rows } = result
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const cell = (value, type) => {
    if (value === null || value === undefined || value === '') return ''
    // Числовая колонка — своя ветка: там значение уже число, а не текст стойки.
    if (NUMERIC.has(type) && typeof value === 'number') return String(value).replace('.', ',')
    return csvSafe(asText(value, type))
  }

  // Апостроф ставим ДО кавычек: `esc` обязан видеть ячейку такой, какой она
  // уйдёт в файл, иначе кавычки посчитались бы по старой длине.
  const lines = [columns.map((c) => esc(csvSafe(c.title))).join(';')]
  for (const row of rows) {
    lines.push(columns.map((c) => esc(cell(row[c.key], c.type))).join(';'))
  }
  const totals = totalsRow(result, totalsLabel)
  if (totals) lines.push(totals.map((v, i) => esc(cell(v, columns[i].type))).join(';'))

  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8')
}

// --- Excel ------------------------------------------------------------------

/**
 * Имя листа Excel по названию отчёта (D4-001).
 *
 * Excel запрещает в имени листа семь символов, апостроф по краям, длину больше
 * 31 и зарезервированное «History»; exceljs на любом из этих случаев бросает
 * обычный `Error`, который движок не переводит в 400, — кнопка «Excel» отвечала
 * «Внутренняя ошибка сервера» на отчёте с названием «Долги / переплаты». Имя
 * листа — это оформление, а не данные: название целиком стоит в заголовке
 * первой строки, поэтому здесь чистим молча, а не отказываем.
 */
function safeSheetName(title) {
  const name = String(title === null || title === undefined ? '' : title)
    .replace(/[*?:/\\[\]]/g, ' ')
    .replace(/^'+|'+$/g, '')   // апостроф по краям запрещён отдельным правилом
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 31)
    // Обрезка на 31 символе может заново оставить пробел или апостроф с краю —
    // повторяем чистку, иначе длинное название всё равно уронит exceljs.
    .replace(/^'+|'+$/g, '')
    .trim()
  if (!name || name.toLowerCase() === 'history') return 'Отчёт'
  return name
}

async function buildXlsx(result, totalsLabel) {
  const { columns, rows } = result
  const wb = new ExcelJS.Workbook()
  wb.creator = result.meta.hotelName || 'Roomline PMS'
  wb.created = new Date()

  const ws = wb.addWorksheet(safeSheetName(result.report.title), {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  })

  ws.mergeCells(1, 1, 1, Math.max(columns.length, 1))
  const title = ws.getCell(1, 1)
  title.value = result.report.title
  title.font = { size: 14, bold: true }

  ws.mergeCells(2, 1, 2, Math.max(columns.length, 1))
  const sub = ws.getCell(2, 1)
  sub.value = subtitle(result)
  sub.font = { size: 9, color: { argb: 'FF666666' } }

  const header = ws.getRow(3)
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1)
    cell.value = c.title
    cell.font = { bold: true }
    cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left' }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F1F1' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } }
    // Ширина колонки в символах: пиксели из определения делим примерно на 7.
    ws.getColumn(i + 1).width = Math.max(10, Math.round((c.width || 110) / 7))
  })

  for (const row of rows) {
    const r = ws.addRow(columns.map((c) => asCell(row[c.key], c.type)))
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1)
      cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left' }
      if (c.type === 'percent') cell.numFmt = '0.0"%"'
      else if (c.type === 'money') cell.numFmt = '# ##0'
      else if (c.type === 'int') cell.numFmt = '# ##0'
    })
  }

  const totals = totalsRow(result, totalsLabel)
  if (totals) {
    const r = ws.addRow(totals)
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1)
      cell.font = { bold: true }
      cell.alignment = { horizontal: c.align === 'right' ? 'right' : 'left' }
      cell.border = { top: { style: 'medium', color: { argb: 'FF666666' } } }
      if (c.type === 'percent') cell.numFmt = '0.0"%"'
      else if (c.type === 'money' || c.type === 'int') cell.numFmt = '# ##0'
    })
  }

  // Автофильтр по шапке — иначе выгрузку всё равно донастраивают руками
  if (rows.length) {
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } }
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

// --- Word -------------------------------------------------------------------

/**
 * Потолок строк для Word (O13-001).
 *
 * Word — единственный формат, который собирает документ в памяти целиком:
 * на каждую ячейку создаётся объект-параграф библиотеки `docx`. Замеры аудита
 * 13.09 на отчёте из 12 колонок: 20 000 строк — 27 с полной блокировки цикла
 * событий и 3,2 ГБ RSS, 50 000 строк — «JavaScript heap out of memory».
 * Сервер один на весь отель, поэтому это не «долгая выгрузка», а 27 секунд без
 * броней и сокета на всех рабочих местах либо падение сервера. Те же 50 000
 * строк CSV отдаёт за 0,2 с, а xlsx за 4,7 с — поэтому отказ предлагает их.
 *
 * Проверка стоит ДО сборки документа: смысл в том, чтобы тяжёлая работа не
 * делалась вовсе, а не в том, чтобы упасть аккуратно.
 */
const DOCX_MAX_ROWS = 5000

/**
 * Потолок можно сдвинуть переменной окружения — но только ВНЕ production:
 * в установленной у клиента программе `NODE_ENV=production`, и переменная
 * не должна становиться способом уронить сервер отеля.
 */
function docxMaxRows() {
  const raw = process.env.REPORT_DOCX_MAX_ROWS
  if (process.env.NODE_ENV === 'production' || raw === undefined || raw === '') return DOCX_MAX_ROWS
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DOCX_MAX_ROWS
}

/** 5001 → «5 001»: число строк в тексте отказа читает человек. */
function groupDigits(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

const THIN = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }

function docxCell(text, opts = {}) {
  return new TableCell({
    borders: { top: THIN, bottom: THIN, left: THIN, right: THIN },
    shading: opts.shaded ? { fill: 'F1F1F1' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [new Paragraph({
      alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text ?? ''), bold: !!opts.bold, size: 16 })],
    })],
  })
}

async function buildDocx(result, totalsLabel) {
  const { columns, rows } = result

  const head = new TableRow({
    tableHeader: true,
    children: columns.map((c) => docxCell(c.title, { bold: true, shaded: true, right: c.align === 'right' })),
  })

  const body = rows.map((row) => new TableRow({
    children: columns.map((c) => docxCell(asText(row[c.key], c.type), { right: c.align === 'right' })),
  }))
  // Шапку кладём в тот же массив: `[head, ...body]` копировал бы тысячи строк
  // ради одной строки заголовка.
  body.unshift(head)

  const totals = totalsRow(result, totalsLabel)
  if (totals) {
    body.push(new TableRow({
      children: columns.map((c, i) => docxCell(asText(totals[i], c.type), {
        bold: true, shaded: true, right: c.align === 'right',
      })),
    }))
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: 'landscape' } } },
      children: [
        new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: result.report.title })] }),
        new Paragraph({ children: [new TextRun({ text: subtitle(result), size: 18, color: '666666' })] }),
        new Paragraph({ children: [] }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: body }),
      ],
    }],
  })

  return Packer.toBuffer(doc)
}

// --- Точка входа ------------------------------------------------------------

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** ASCII-имя файла для старых клиентов; полное кириллическое уедет в filename*. */
function translit(text) {
  return String(text).toLowerCase().split('')
    .map((ch) => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'report'
}

const FORMATS = {
  csv:  { mime: 'text/csv; charset=utf-8', ext: 'csv' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
}

async function exportReport(result, format, totalsLabel = 'Итого') {
  const meta = FORMATS[format]
  if (!meta) throw createError(`Формат «${format}» не поддерживается`, 400)

  // O13-001: отказ ДО сборки документа. Считаем по строкам результата, которые
  // уже есть в памяти, — сам docx ещё не начат.
  if (format === 'docx') {
    const max = docxMaxRows()
    const count = (result.rows || []).length
    if (count > max) {
      const err = createError(
        `В Word можно выгрузить до ${groupDigits(max)} строк (в отчёте ${groupDigits(count)}). `
        + 'Сузьте период или выгрузите в Excel/CSV.',
        400,
      )
      err.code = 'DOCX_TOO_LARGE'
      throw err
    }
  }

  let buffer
  if (format === 'csv') buffer = buildCsv(result, totalsLabel)
  else if (format === 'xlsx') buffer = await buildXlsx(result, totalsLabel)
  else buffer = await buildDocx(result, totalsLabel)

  const period = result.params && result.params.period
  const suffix = period && period.from ? `-${period.from}_${period.to}` : ''
  const base = `${translit(result.report.title)}${suffix}`

  return {
    buffer,
    mime: meta.mime,
    filename: `${base}.${meta.ext}`,
    filenameUtf8: `${result.report.title}${suffix}.${meta.ext}`,
  }
}

module.exports = {
  exportReport, FORMATS, buildCsv, buildXlsx, buildDocx, translit, formatDateTimeLocal,
  csvSafe, safeSheetName, DOCX_MAX_ROWS, docxMaxRows,
}
