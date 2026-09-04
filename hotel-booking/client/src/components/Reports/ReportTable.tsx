import React from 'react'
import type { ReportColumn, ReportResult } from '../../api/reports'
import { formatValue, formatPeriod } from './format'

/**
 * Таблица результата. Ничего не знает про конкретный отчёт: колонки, типы и
 * выравнивание приходят с сервера вместе с данными.
 *
 * Печатный макет — тот же DOM: блок #report-print целиком уходит на лист,
 * остальное приложение скрывается стилями @media print. Отдельной «версии для
 * печати» нет намеренно — она бы разъехалась с экранной при первой же правке.
 */

interface Props {
  result: ReportResult
  totalsLabel?: string
}

const th: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 1,
  background: 'var(--surface-2)', borderBottom: '1px solid var(--border)',
  padding: '8px 10px', fontSize: '0.76rem', fontWeight: 600,
  letterSpacing: '0.02em', color: 'var(--text-muted)', whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '7px 10px', fontSize: '0.84rem', borderBottom: '1px solid var(--border-subtle)',
  whiteSpace: 'nowrap', color: 'var(--text)',
}

const isNumeric = (c: ReportColumn) => ['int', 'number', 'money', 'percent'].includes(c.type)

export const ReportTable: React.FC<Props> = ({ result, totalsLabel = 'Итого' }) => {
  const { columns, rows, totals, meta, report, params } = result
  const hasTotals = totals && Object.values(totals).some((v) => v !== null && v !== undefined)
  const period = formatPeriod(params?.period)

  return (
    <div id="report-print" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      {/* Шапка — видна только на печати и в PDF */}
      <div className="report-print-head" style={{ display: 'none' }}>
        <h1>{report.title}</h1>
        <p>
          {meta.hotelName}
          {period ? ` · ${period}` : ''}
          {` · сформирован ${new Date(meta.generatedAt).toLocaleString('ru-RU')}`}
          {meta.requestedBy ? ` · ${meta.requestedBy}` : ''}
        </p>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', tableLayout: 'auto' }}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} style={{ ...th, textAlign: c.align === 'right' ? 'right' : 'left', width: c.width }}>
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="report-row">
                {columns.map((c) => {
                  // Процент рисуем полоской прямо в ячейке: глазами видно провалы
                  // и пики, а на печати полоска остаётся серой заливкой.
                  const bar = c.type === 'percent' && typeof row[c.key] === 'number'
                    ? Math.max(0, Math.min(100, row[c.key] as number))
                    : null
                  return (
                    <td
                      key={c.key}
                      style={{
                        ...td,
                        textAlign: c.align === 'right' ? 'right' : 'left',
                        fontVariantNumeric: isNumeric(c) ? 'tabular-nums' : undefined,
                        color: row[c.key] === null || row[c.key] === '' ? 'var(--text-faint)' : undefined,
                        background: bar !== null
                          ? `linear-gradient(to right, var(--accent-bg) ${bar}%, transparent ${bar}%)`
                          : undefined,
                      }}
                    >
                      {formatValue(row[c.key], c.type)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} style={{ ...td, textAlign: 'center', padding: 34, color: 'var(--text-faint)' }}>
                  За выбранный период данных нет
                </td>
              </tr>
            )}
          </tbody>
          {hasTotals && rows.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((c, i) => {
                  const v = totals[c.key]
                  const empty = v === null || v === undefined
                  return (
                    <td
                      key={c.key}
                      style={{
                        ...td, borderBottom: 'none', borderTop: '2px solid var(--border)',
                        position: 'sticky', bottom: 0, background: 'var(--surface-2)',
                        fontWeight: 600,
                        textAlign: c.align === 'right' ? 'right' : 'left',
                        fontVariantNumeric: isNumeric(c) ? 'tabular-nums' : undefined,
                      }}
                    >
                      {empty ? (i === 0 ? totalsLabel : '') : formatValue(v, c.type)}
                    </td>
                  )
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  )
}
