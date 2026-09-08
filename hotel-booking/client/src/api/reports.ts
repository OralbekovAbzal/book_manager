import api from './client'

/**
 * Отчёты. Клиент НЕ знает, что такое «загрузка» или «реестр»: он получает с
 * сервера определение отчёта (параметры + колонки) и рисует по нему форму и
 * таблицу. Поэтому новый отчёт появляется в интерфейсе сам, без правок здесь —
 * и на этом же механизме потом заработает конструктор.
 */

export type ReportParamType = 'dateRange' | 'select' | 'multiselect' | 'text' | 'number' | 'boolean'

export interface ReportOption {
  value: string | number
  label: string
}

export interface ReportParamDef {
  key: string
  type: ReportParamType
  label: string
  required?: boolean
  hint?: string
  placeholder?: string
  default?: any
  options?: ReportOption[]
  /** Имя серверного справочника: корпуса, категории, партнёры… */
  optionsFrom?: string
  presets?: string[]
}

export type ReportColumnType =
  | 'text' | 'int' | 'number' | 'money' | 'percent'
  | 'date' | 'datetime' | 'month' | 'bool' | 'list'

export interface ReportColumn {
  key: string
  title: string
  type: ReportColumnType
  align: 'left' | 'right' | 'center'
  width?: number
}

export interface ReportChartDef {
  type: 'bar'
  x: string
  y: string
}

export interface ReportDefinition {
  id: string
  title: string
  description?: string
  icon?: string
  dataset: string
  source?: 'builtin' | 'custom'
  editable?: boolean
  params?: ReportParamDef[]
  columns?: any[]
  chart?: ReportChartDef
  totalsLabel?: string
}

export interface ReportSummary {
  id: string
  title: string
  description?: string
  icon?: string
  dataset: string
  source?: 'builtin' | 'custom'
  editable?: boolean
}

export type ReportRow = Record<string, string | number | boolean | null>

export interface ReportResult {
  report: { id: string; title: string; dataset: string }
  params: Record<string, any>
  groupBy: string[]
  columns: ReportColumn[]
  rows: ReportRow[]
  totals: Record<string, number | null>
  meta: {
    rowCount: number
    sourceRowCount: number
    truncated: boolean
    limit: number
    generatedAt: string
    hotelName?: string
    businessDate?: string
    requestedBy?: string | null
  }
}

export interface DatasetField {
  key: string
  label: string
  type: string
  groupable?: boolean
  /** Служебный счётчик (0/1) — нужен формулам, но не «данные» для показа. */
  synthetic?: boolean
  /** Конечный список значений поля — для фильтра «спросить у пользователя». */
  options?: DefParamOption[]
  /** Справочник сервера с тем же смыслом (корпуса, категории…). */
  optionsFrom?: string
}

/** Готовый показатель источника: именованная формула с подписью и типом. */
export interface DatasetMetric {
  key: string
  label: string
  expr: string
  type: ReportColumnType
  decimals?: number
  description?: string
}

export interface DatasetInfo {
  id: string
  label: string
  description?: string
  /** Источник не работает без параметра «period» — конструктор не даст его удалить. */
  requiresPeriod?: boolean
  fields: DatasetField[]
  metrics?: DatasetMetric[]
}

export interface FunctionInfo {
  name: string
  sig: string
  label: string
  agg?: boolean
}

// --- Определение отчёта в том виде, в каком его правит конструктор ---------

export interface DefParamOption { value: string | number; label: string }

export interface DefParam {
  key: string
  type: ReportParamType
  label: string
  required?: boolean
  hint?: string
  placeholder?: string
  default?: any
  options?: DefParamOption[]
  optionsFrom?: string
  presets?: string[]
}

export interface DefFilter {
  field?: string
  op?: string
  value?: any
  param?: string
  /** Формула-условие вместо поля и операции: `totalAmount - paidAmount > 0`. */
  expr?: string
  negate?: boolean
  when?: { param: string; eq: any }
}

export interface DefAgg {
  fn: string
  field?: string
  of?: string
  scale?: number
  decimals?: number
}

export interface DefColumn {
  key: string
  title?: string
  titleFrom?: string
  field?: string
  agg?: DefAgg
  /** Формула: `sum(isSold) / sum(isAvailable) * 100`, `totalAmount - paidAmount`. */
  expr?: string
  /** Готовый показатель источника данных (см. DatasetMetric). */
  metric?: string
  decimals?: number
  type?: ReportColumnType
  width?: number
  align?: 'left' | 'right' | 'center'
  total?: boolean
}

export interface DefSort { key: string; dir?: 'asc' | 'desc' }

/** Полное определение — то, что хранится в файле/БД и исполняется движком. */
export interface ReportSpec {
  id?: string
  version?: number
  title: string
  description?: string
  icon?: string
  dataset: string
  params?: DefParam[]
  filters?: DefFilter[]
  groupBy?: string[] | { param: string }
  columns: DefColumn[]
  sort?: DefSort[]
  limit?: number
  totalsLabel?: string
  chart?: ReportChartDef
}

export interface VocabItem {
  value: string
  label: string
  needsValue?: boolean
  list?: boolean
  needsField?: boolean
  needsOf?: boolean
}

/** Словарь конструктора: датасеты с полями + все допустимые операции с подписями. */
export interface ReportMeta {
  datasets: DatasetInfo[]
  OPS: VocabItem[]
  AGGS: VocabItem[]
  PARAM_TYPES: VocabItem[]
  COLUMN_TYPES: VocabItem[]
  OPTION_SOURCES: VocabItem[]
  PRESETS: VocabItem[]
  ICONS: VocabItem[]
  FUNCTIONS: FunctionInfo[]
}

/** Ошибка API отчётов: кроме текста несёт список проблем определения. */
export class ReportApiError extends Error {
  problems: string[]
  status?: number
  constructor(message: string, problems: string[] = [], status?: number) {
    super(message)
    this.problems = problems
    this.status = status
  }
}

function wrap(err: any, fallback: string): ReportApiError {
  const data = err?.response?.data
  return new ReportApiError(
    data?.error || data?.message || err?.message || fallback,
    Array.isArray(data?.problems) ? data.problems : [],
    err?.response?.status,
  )
}

export async function fetchReports(): Promise<ReportSummary[]> {
  const { data } = await api.get('/reports')
  return data.data
}

export async function fetchReportDefinition(id: string): Promise<ReportDefinition> {
  const { data } = await api.get(`/reports/${id}`)
  return data.data
}

export async function runReport(id: string, params: Record<string, any>): Promise<ReportResult> {
  const { data } = await api.post(`/reports/${id}/run`, { params })
  return data.data
}

// `GET /reports/datasets` (основа будущего конструктора отчётов) с клиента пока
// не зовётся: список датасетов приходит в `fetchReportMeta`. Обёртка убрана как
// мёртвая (D9-013), роут на сервере остался.

export async function fetchReportMeta(): Promise<ReportMeta> {
  const { data } = await api.get('/reports/meta')
  return data.data
}

/** «Чистое» определение — для редактора, копирования и выгрузки в JSON. */
export async function fetchReportSpec(id: string): Promise<{ spec: ReportSpec; source: 'builtin' | 'custom'; editable: boolean }> {
  const { data } = await api.get(`/reports/${id}/definition`)
  return { spec: data.data, source: data.source, editable: data.editable }
}

export async function validateSpec(spec: ReportSpec): Promise<{ ok: boolean; problems: string[]; definition: ReportDefinition | null }> {
  try {
    const { data } = await api.post('/reports/validate', { definition: spec })
    return data.data
  } catch (err) {
    throw wrap(err, 'Не удалось проверить определение')
  }
}

/** Выполнить определение, не сохраняя, — живой предпросмотр в конструкторе. */
export async function previewReport(spec: ReportSpec, params: Record<string, any>): Promise<ReportResult> {
  try {
    const { data } = await api.post('/reports/preview', { definition: spec, params })
    return data.data
  } catch (err) {
    throw wrap(err, 'Не удалось построить предпросмотр')
  }
}

export async function createReport(spec: ReportSpec): Promise<ReportDefinition> {
  try {
    const { data } = await api.post('/reports', { definition: spec })
    return data.data
  } catch (err) {
    throw wrap(err, 'Не удалось сохранить отчёт')
  }
}

export async function updateReport(id: string, spec: ReportSpec): Promise<ReportDefinition> {
  try {
    const { data } = await api.put(`/reports/${id}`, { definition: spec })
    return data.data
  } catch (err) {
    throw wrap(err, 'Не удалось сохранить отчёт')
  }
}

export async function deleteReport(id: string): Promise<void> {
  try {
    await api.delete(`/reports/${id}`)
  } catch (err) {
    throw wrap(err, 'Не удалось удалить отчёт')
  }
}

export async function importReport(spec: ReportSpec): Promise<{ definition: ReportDefinition; renamed: boolean; requestedId: string | null }> {
  try {
    const { data } = await api.post('/reports/import', { definition: spec })
    return { definition: data.data, renamed: !!data.renamed, requestedId: data.requestedId ?? null }
  } catch (err) {
    throw wrap(err, 'Не удалось импортировать отчёт')
  }
}

export type ExportFormat = 'xlsx' | 'docx' | 'csv'

/** Имя файла из Content-Disposition: кириллица приезжает в filename* (RFC 5987). */
function filenameFromHeader(header: string | undefined, fallback: string): string {
  if (!header) return fallback
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (utf8) { try { return decodeURIComponent(utf8[1]) } catch { /* ниже обычный filename */ } }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : fallback
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.readAsDataURL(blob)
  })
}

/** Ошибку сервера при responseType:'blob' приходится доставать из самого блоба. */
async function messageFromBlobError(err: any): Promise<string> {
  const blob = err?.response?.data
  if (blob instanceof Blob) {
    try {
      const parsed = JSON.parse(await blob.text())
      if (parsed?.error || parsed?.message) return parsed.error || parsed.message
    } catch { /* не JSON — ниже общий текст */ }
  }
  return 'Не удалось выгрузить отчёт'
}

/**
 * Выгрузка отчёта файлом. В Electron сохраняем через диалог main-процесса
 * (на file:// ссылка-загрузка не работает), в браузере — обычной ссылкой.
 * @returns имя сохранённого файла или null, если пользователь отменил диалог
 */
export async function downloadReport(
  id: string,
  params: Record<string, any>,
  format: ExportFormat,
): Promise<string | null> {
  let response
  try {
    response = await api.post(`/reports/${id}/export`, { params, format }, { responseType: 'blob' })
  } catch (err) {
    throw new Error(await messageFromBlobError(err))
  }

  const blob: Blob = response.data
  const fileName = filenameFromHeader(response.headers['content-disposition'], `report.${format}`)

  const bridge = window.appConfig?.saveReportFile
  if (bridge) {
    const result = await bridge({ fileName, base64: await blobToBase64(blob) })
    if (result.canceled) return null
    if (!result.ok) throw new Error(result.error || 'Не удалось сохранить файл')
    return fileName
  }

  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Освобождаем сразу после клика: браузер уже забрал данные себе.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return fileName
}
