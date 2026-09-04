import type { ReportColumnType, ReportRow, ReportColumn } from '../../api/reports'

/**
 * Форматирование значений отчёта. Живёт отдельно от таблицы, потому что тем же
 * правилам должны подчиняться печать и выгрузки — иначе на экране «9,7 %»,
 * а в файле «9.7000000001».
 */

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]
const MONTHS_NOM = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

const nbsp = ' '

/** Разделитель разрядов — неразрывный пробел, чтобы число не рвалось по строкам. */
function groupDigits(n: number, decimals = 0): string {
  const fixed = Math.abs(n).toFixed(decimals)
  const [int, frac] = fixed.split('.')
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, nbsp)
  const sign = n < 0 ? '−' : ''
  return sign + withSep + (frac ? ',' + frac : '')
}

/** 'YYYY-MM-DD' → '03.09.2026'. Дата приходит строкой и часовой пояс не трогает. */
export function formatDateISO(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  return m ? `${m[3]}.${m[2]}.${m[1]}` : value
}

/** 'YYYY-MM-DD' → '3 сентября 2026' */
export function formatDateLong(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return value
  return `${Number(m[3])} ${MONTHS_GEN[Number(m[2]) - 1]} ${m[1]}`
}

export function formatValue(value: unknown, type: ReportColumnType): string {
  if (value === null || value === undefined || value === '') return ''

  switch (type) {
    case 'date':
      return formatDateISO(String(value))
    case 'month': {
      const m = /^(\d{4})-(\d{2})/.exec(String(value))
      return m ? `${MONTHS_NOM[Number(m[2]) - 1]} ${m[1]}` : String(value)
    }
    case 'datetime': {
      const d = new Date(String(value))
      if (Number.isNaN(d.getTime())) return String(value)
      const p = (n: number) => String(n).padStart(2, '0')
      return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    case 'percent':
      return typeof value === 'number' ? `${groupDigits(value, 1)}${nbsp}%` : String(value)
    case 'money':
      return typeof value === 'number' ? groupDigits(value, 0) : String(value)
    case 'int':
      return typeof value === 'number' ? groupDigits(value, 0) : String(value)
    case 'number':
      return typeof value === 'number'
        ? groupDigits(value, Number.isInteger(value) ? 0 : 1)
        : String(value)
    case 'bool':
      return value ? 'да' : 'нет'
    case 'list':
      return Array.isArray(value) ? value.join(', ') : String(value)
    default:
      return String(value)
  }
}

/** Значение как есть — для CSV/Excel, где форматирует уже сама программа. */
export function rawValue(value: unknown): string | number {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

/** Подпись периода для шапки отчёта и печати. */
export function formatPeriod(period?: { from?: string; to?: string } | null): string {
  if (!period?.from || !period?.to) return ''
  if (period.from === period.to) return formatDateLong(period.from)
  return `${formatDateISO(period.from)} — ${formatDateISO(period.to)}`
}

/** Матрица строк для выгрузок: заголовки, данные, итоги. */
export function toMatrix(
  columns: ReportColumn[],
  rows: ReportRow[],
  totals: Record<string, number | null> | undefined,
  totalsLabel = 'Итого',
): (string | number)[][] {
  const out: (string | number)[][] = [columns.map((c) => c.title)]
  for (const row of rows) out.push(columns.map((c) => rawValue(row[c.key])))
  if (totals && Object.keys(totals).length) {
    out.push(columns.map((c, i) => {
      const v = totals[c.key]
      if (v === null || v === undefined) return i === 0 ? totalsLabel : ''
      return v
    }))
  }
  return out
}
