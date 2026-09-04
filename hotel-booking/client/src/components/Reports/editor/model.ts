import type {
  ReportSpec, DefColumn, DefParam, DefFilter, DatasetField, DatasetMetric, ReportMeta,
} from '../../../api/reports'

/**
 * Модель конструктора: чистые функции над определением отчёта.
 * Сам конструктор — только форма поверх этого; вся «умность» (ключи, режимы,
 * авто-параметры, разбор JSON) живёт здесь, чтобы её можно было проверить без React.
 */

/** Параметр «Период» — его требуют оба источника данных. */
export const PERIOD_PARAM: DefParam = {
  key: 'period',
  type: 'dateRange',
  label: 'Период',
  required: true,
  default: { preset: 'currentMonth' },
  presets: ['today', 'last7', 'last30', 'currentMonth', 'prevMonth', 'currentYear'],
}

/** Ключ параметра, которым управляет режим группировки «выбирает пользователь». */
export const GROUP_PARAM_KEY = 'groupBy'

export function blankSpec(dataset: string): ReportSpec {
  return {
    title: '',
    description: '',
    dataset,
    params: [{ ...PERIOD_PARAM }],
    filters: [],
    groupBy: [],
    columns: [],
    sort: [],
    totalsLabel: 'Итого',
  }
}

/** Ключ, которого ещё нет среди занятых: base, base2, base3… */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  const clean = base.replace(/[^a-zA-Z0-9_]/g, '') || 'col'
  if (!set.has(clean)) return clean
  for (let n = 2; n < 1000; n++) {
    if (!set.has(`${clean}${n}`)) return `${clean}${n}`
  }
  return `${clean}${Date.now()}`
}

export function fieldsOf(meta: ReportMeta | null, dataset: string): DatasetField[] {
  return meta?.datasets.find((d) => d.id === dataset)?.fields ?? []
}

export function metricsOf(meta: ReportMeta | null, dataset: string): DatasetMetric[] {
  return meta?.datasets.find((d) => d.id === dataset)?.metrics ?? []
}

export function fieldLabel(fields: DatasetField[], key: string | undefined): string {
  if (!key) return ''
  if (key.startsWith('$group')) return 'Группа'
  return fields.find((f) => f.key === key)?.label ?? key
}

export type GroupMode = 'none' | 'fixed' | 'param'

export function groupMode(spec: ReportSpec): GroupMode {
  const g = spec.groupBy
  if (!g) return 'none'
  if (Array.isArray(g)) return g.length ? 'fixed' : 'none'
  return g.param ? 'param' : 'none'
}

/** Поля, по которым сейчас группируем (фиксированные или разрешённые пользователю). */
export function groupFields(spec: ReportSpec): string[] {
  const g = spec.groupBy
  if (!g) return []
  if (Array.isArray(g)) return g
  const p = spec.params?.find((x) => x.key === g.param)
  return (p?.options ?? []).map((o) => String(o.value))
}

export type ColumnMode = 'field' | 'metric' | 'expr' | 'agg' | 'group'

export function columnMode(col: DefColumn): ColumnMode {
  if (col.metric) return 'metric'
  if (col.expr !== undefined) return 'expr'
  if (col.agg) return 'agg'
  if (col.field && col.field.startsWith('$group')) return 'group'
  return 'field'
}

/** Автозаголовок — что покажет сервер, если title пуст. Для плейсхолдера. */
export function autoTitle(
  col: DefColumn, fields: DatasetField[], aggs: { value: string; label: string }[], metrics: DatasetMetric[] = [],
): string {
  if (col.metric) return metrics.find((m) => m.key === col.metric)?.label ?? col.metric
  // Сервер подпишет колонку-формулу её ключом — показываем то же, а не саму формулу
  if (col.expr !== undefined) return col.key
  if (col.agg) {
    const fn = aggs.find((a) => a.value === col.agg?.fn)?.label ?? col.agg.fn
    return col.agg.field ? `${fn}: ${fieldLabel(fields, col.agg.field)}` : fn
  }
  return fieldLabel(fields, col.field)
}

/** Расчёт «Сумма по полю» как формула — при переключении режима колонки. */
export function aggToExpr(col: DefColumn): string {
  const a = col.agg
  if (!a) return col.field && !col.field.startsWith('$') ? col.field : ''
  const f = a.field ?? ''
  switch (a.fn) {
    case 'count': return 'count()'
    case 'sum': return `sum(${f})`
    case 'avg': return `avg(${f})`
    case 'countDistinct': return `countDistinct(${f})`
    case 'min': return `minOf(${f})`
    case 'max': return `maxOf(${f})`
    case 'first': return `first(${f})`
    case 'ratio': return `sum(${f}) / sum(${a.of ?? ''})${a.scale ? ` * ${a.scale}` : ''}`
    default: return f
  }
}

/**
 * Параметр «спросить у пользователя» для фильтра по полю: тип и справочник
 * берутся из описания поля, чтобы вместо голого текстового ввода получился
 * выпадающий список корпусов, статусов, партнёров.
 */
export function autoParam(field: DatasetField, op: string, taken: Iterable<string>): { param: DefParam; op: string } {
  const listOp = ['in', 'notIn', 'hasAny'].includes(op)
  const key = uniqueKey(field.key, taken)
  const base: DefParam = { key, label: field.label, type: 'text' }

  if (field.options?.length || field.optionsFrom) {
    return {
      param: {
        ...base,
        type: listOp ? 'multiselect' : 'select',
        placeholder: listOp ? undefined : 'Все',
        ...(field.options?.length ? { options: field.options } : { optionsFrom: field.optionsFrom }),
      },
      op,
    }
  }
  if (field.type === 'bool') return { param: { ...base, type: 'boolean' }, op: 'eq' }
  if (['int', 'number', 'money', 'percent'].includes(field.type)) {
    return { param: { ...base, type: 'number' }, op: listOp ? 'eq' : op }
  }
  // Свободный текст: «одно из» без списка значений не имеет смысла — ищем по вхождению
  return { param: { ...base, type: 'text', placeholder: 'Часть текста' }, op: listOp ? 'contains' : op }
}

/** Где используется каждый параметр — чтобы «ничейный» параметр был виден сразу. */
export function paramUsage(spec: ReportSpec): Record<string, string[]> {
  const usage: Record<string, string[]> = {}
  const add = (key: string, where: string) => { (usage[key] ||= []).push(where) }
  const fromExpr = (expr: string | undefined, where: string) => {
    for (const m of String(expr ?? '').matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)) add(m[1], where)
  }
  ;(spec.filters ?? []).forEach((f, i) => {
    const at = `фильтр №${i + 1}`
    if (f.param) add(f.param, at)
    if (f.when?.param) add(f.when.param, `условие ${at}`)
    fromExpr(f.expr, `условие ${at}`)
  })
  spec.columns.forEach((c) => fromExpr(c.expr, `колонка «${c.title || c.key}»`))
  const g = spec.groupBy
  if (g && !Array.isArray(g) && g.param) add(g.param, 'группировка')
  return usage
}

export function specToJson(spec: ReportSpec): string {
  return JSON.stringify(spec, null, 2)
}

/** Разбор JSON из редактора или файла. Бросает понятную ошибку. */
export function parseSpec(text: string): ReportSpec {
  let raw: any
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('Это не JSON: проверьте кавычки и запятые')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ожидается объект определения отчёта')
  if (!raw.dataset) throw new Error('В определении нет поля dataset')
  return {
    title: '',
    ...raw,
    params: Array.isArray(raw.params) ? raw.params : [],
    filters: Array.isArray(raw.filters) ? raw.filters : [],
    columns: Array.isArray(raw.columns) ? raw.columns : [],
    sort: Array.isArray(raw.sort) ? raw.sort : [],
  }
}

export function readJsonFile(file: File): Promise<ReportSpec> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.onload = () => {
      try { resolve(parseSpec(String(reader.result))) } catch (err) { reject(err) }
    }
    reader.readAsText(file)
  })
}

/** Скачать определение файлом. В Electron на file:// сработает через мост, иначе ссылкой. */
export async function downloadSpec(spec: ReportSpec): Promise<void> {
  const name = `${spec.id || 'report'}.report.json`
  const text = specToJson(spec)
  const bridge = window.appConfig?.saveReportFile
  if (bridge) {
    await bridge({ fileName: name, base64: btoa(unescape(encodeURIComponent(text))) })
    return
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Список «значение | подпись» построчно → options. Без «|» подпись = значение. */
export function parseOptionsText(text: string): { value: string; label: string }[] {
  return text.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf('|')
      if (i < 0) return { value: l, label: l }
      return { value: l.slice(0, i).trim(), label: l.slice(i + 1).trim() || l.slice(0, i).trim() }
    })
}

export function optionsToText(options: { value: string | number; label: string }[] | undefined): string {
  return (options ?? []).map((o) => (String(o.value) === o.label ? String(o.value) : `${o.value} | ${o.label}`)).join('\n')
}

/** Значение фильтра под тип поля: числа — числом, списки — массивом. */
export function coerceFilterValue(text: string, field: DatasetField | undefined, isList: boolean): any {
  const num = field && ['int', 'number', 'money', 'percent'].includes(field.type)
  const one = (s: string) => {
    const t = s.trim()
    if (num && t !== '' && !Number.isNaN(Number(t))) return Number(t)
    return t
  }
  if (isList) return text.split(',').map(one).filter((v) => v !== '')
  return one(text)
}

export function filterValueText(value: any): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

export function isExprFilter(f: DefFilter): boolean {
  return f.expr !== undefined
}
