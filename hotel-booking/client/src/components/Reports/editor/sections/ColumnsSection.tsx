import React from 'react'
import type { ReportSpec, ReportMeta, DefColumn, DatasetField, DatasetMetric, ReportColumnType } from '../../../../api/reports'
import { Field, Row, TextInput, NumInput, Select, Seg, Check, IconBtn, Card, AddBtn, Hint } from '../ui'
import { ExprEditor } from '../ExprEditor'
import { columnMode, autoTitle, uniqueKey, groupMode, aggToExpr, type ColumnMode } from '../model'

interface Props {
  spec: ReportSpec
  meta: ReportMeta
  fields: DatasetField[]
  metrics: DatasetMetric[]
  onChange: (next: ReportSpec) => void
}

const NUMERIC = new Set(['int', 'number', 'money', 'percent'])
const MODES: { value: ColumnMode; label: string }[] = [
  { value: 'field', label: 'Поле' },
  { value: 'metric', label: 'Показатель' },
  { value: 'expr', label: 'Формула' },
  { value: 'agg', label: 'Расчёт' },
  { value: 'group', label: 'Группа' },
]

/**
 * Колонки. Пять способов получить значение:
 *   Поле        — как есть из источника;
 *   Показатель  — готовая формула источника («Загрузка, %») одним кликом;
 *   Формула     — своя: sum(isSold) / sum(isAvailable) * 100, totalAmount - paidAmount;
 *   Расчёт      — простой агрегат по одному полю (сумма, среднее…);
 *   Группа      — значение группировки (только когда она есть).
 */
export const ColumnsSection: React.FC<Props> = ({ spec, meta, fields, metrics, onChange }) => {
  const cols = spec.columns
  const grouped = groupMode(spec) !== 'none'
  const taken = () => cols.map((c) => c.key)

  const setCols = (next: DefColumn[]) => {
    // Сортировка ссылается на ключи колонок — удалили колонку, забыли и сортировку по ней
    const keys = new Set(next.map((c) => c.key))
    onChange({ ...spec, columns: next, sort: (spec.sort ?? []).filter((s) => keys.has(s.key)) })
  }
  const update = (i: number, patch: Partial<DefColumn>) => setCols(cols.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const replace = (i: number, col: DefColumn) => setCols(cols.map((c, j) => (j === i ? col : c)))
  const remove = (i: number) => setCols(cols.filter((_, j) => j !== i))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= cols.length) return
    const next = [...cols]
    ;[next[i], next[j]] = [next[j], next[i]]
    setCols(next)
  }

  const addField = (fieldKey: string) => {
    if (!fieldKey) return
    setCols([...cols, { key: uniqueKey(fieldKey, taken()), field: fieldKey }])
  }
  const addMetric = (metricKey: string) => {
    if (!metricKey) return
    setCols([...cols, { key: uniqueKey(metricKey, taken()), metric: metricKey }])
  }
  const addExpr = () => setCols([...cols, { key: uniqueKey('calc', taken()), expr: '' }])
  const addAgg = () => setCols([...cols, { key: uniqueKey('count', taken()), title: 'Количество', agg: { fn: 'count' } }])
  const addGroup = () => setCols([...cols, { key: uniqueKey('group', taken()), field: '$group', titleFrom: '$group' }])

  const fieldType = (key: string) => fields.find((f) => f.key === key)?.type ?? 'text'

  // Смена режима сохраняет ключ и заголовок, а значение переводит, где это
  // возможно: «Сумма: ночей» становится формулой sum(nights), показатель — своей
  // формулой (можно доработать), формула — полем из первого имени.
  const switchMode = (i: number, mode: ColumnMode) => {
    const c = cols[i]
    if (mode === columnMode(c)) return
    const base: DefColumn = { key: c.key, title: c.title, width: c.width, align: c.align, total: c.total }
    switch (mode) {
      case 'field': {
        const guess = c.agg?.field || (c.expr ?? '').match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0]
        const field = guess && fields.some((f) => f.key === guess) ? guess : fields[0]?.key
        replace(i, { ...base, field })
        break
      }
      case 'metric':
        replace(i, { ...base, metric: metrics[0]?.key })
        break
      case 'expr': {
        const metric = c.metric ? metrics.find((m) => m.key === c.metric) : null
        const expr = metric ? metric.expr : aggToExpr(c)
        replace(i, { ...base, expr, type: c.type ?? metric?.type, decimals: c.decimals ?? metric?.decimals })
        break
      }
      case 'agg':
        replace(i, { ...base, agg: { fn: c.field && NUMERIC.has(fieldType(c.field)) ? 'sum' : 'count', field: c.field && !c.field.startsWith('$') ? c.field : undefined } })
        break
      case 'group':
        replace(i, { ...base, field: '$group', titleFrom: '$group' })
        break
    }
  }

  const allFields = fields.map((f) => ({ value: f.key, label: f.synthetic ? `${f.label} · ${f.key}` : f.label }))
  const numericFields = fields.filter((f) => NUMERIC.has(f.type)).map((f) => ({ value: f.key, label: f.label }))
  const metricOptions = metrics.map((m) => ({ value: m.key, label: m.label }))
  const paramList = (spec.params ?? []).map((p) => ({ key: p.key, label: p.label }))

  return (
    <>
      {cols.length === 0 && (
        <Hint>
          Колонок пока нет. Для сгруппированного отчёта — «Группа» + показатели;
          для списка — поля. Своя формула: «Формула».
        </Hint>
      )}

      {cols.map((col, i) => {
        const mode = columnMode(col)
        const agg = meta.AGGS.find((a) => a.value === col.agg?.fn)
        const metric = col.metric ? metrics.find((m) => m.key === col.metric) : null
        const aggFieldOptions = col.agg && ['sum', 'avg', 'ratio'].includes(col.agg.fn) ? numericFields : allFields
        const modes = MODES.filter((m) => (m.value !== 'group' || grouped) && (m.value !== 'metric' || metrics.length > 0))
        const columnsAbove = cols.slice(0, i).map((c) => ({ key: c.key, title: c.title || autoTitle(c, fields, meta.AGGS, metrics) }))

        return (
          <Card key={i}>
            <Row align="center">
              <Seg value={mode} onChange={(m) => switchMode(i, m as ColumnMode)} options={modes} />
              {mode === 'field' && (
                <Select value={col.field ?? ''} onChange={(v) => update(i, { field: v })} options={allFields} placeholder="поле…" style={{ flex: '1 1 160px' }} />
              )}
              {mode === 'metric' && (
                <Select value={col.metric ?? ''} onChange={(v) => update(i, { metric: v })} options={metricOptions} placeholder="показатель…" style={{ flex: '1 1 160px' }} />
              )}
              {mode === 'agg' && col.agg && (
                <>
                  <Select
                    value={col.agg.fn}
                    onChange={(fn) => update(i, { agg: { ...col.agg, fn, of: fn === 'ratio' ? col.agg?.of : undefined, scale: fn === 'ratio' ? (col.agg?.scale ?? 100) : undefined } })}
                    options={meta.AGGS}
                    style={{ flex: '1 1 140px' }}
                  />
                  {agg?.needsField !== false && (
                    <Select value={col.agg.field ?? ''} onChange={(v) => update(i, { agg: { ...col.agg!, field: v } })} options={aggFieldOptions} placeholder="поле…" style={{ flex: '1 1 140px' }} />
                  )}
                </>
              )}
              {mode === 'expr' && <span style={{ flex: 1 }} />}
              {mode === 'group' && (
                <span style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-faint)' }}>значение группировки</span>
              )}
              <span style={{ flex: '0 0 auto', display: 'flex', marginLeft: 'auto' }}>
                <IconBtn title="Выше" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
                <IconBtn title="Ниже" onClick={() => move(i, 1)} disabled={i === cols.length - 1}>↓</IconBtn>
                <IconBtn title="Удалить колонку" onClick={() => remove(i)} danger>×</IconBtn>
              </span>
            </Row>

            {mode === 'metric' && metric && (
              <Hint><span className="mono">{metric.expr}</span>{metric.description ? ` — ${metric.description}` : ''}</Hint>
            )}

            {mode === 'expr' && (
              <ExprEditor
                value={col.expr ?? ''}
                onCommit={(v) => update(i, { expr: v })}
                fields={fields}
                columns={columnsAbove}
                params={paramList}
                functions={meta.FUNCTIONS}
                aggAllowed
                placeholder={grouped ? 'sum(isSold) / sum(isAvailable) * 100' : 'totalAmount - paidAmount'}
              />
            )}

            {mode === 'agg' && col.agg?.fn === 'ratio' && (
              <Row>
                <Field label="Из чего (знаменатель)" grow={1}>
                  <Select value={col.agg.of ?? ''} onChange={(v) => update(i, { agg: { ...col.agg!, of: v } })} options={numericFields} placeholder="поле…" />
                </Field>
                <Field label="Масштаб" width={90} hint="100 — в процентах">
                  <NumInput value={col.agg.scale} onChange={(v) => update(i, { agg: { ...col.agg!, scale: v } })} placeholder="1" />
                </Field>
              </Row>
            )}

            <Row>
              <Field label="Заголовок" grow={2}>
                <TextInput value={col.title ?? ''} onChange={(v) => update(i, { title: v || undefined })} placeholder={autoTitle(col, fields, meta.AGGS, metrics) || 'авто'} />
              </Field>
              <Field label="Тип" width={120}>
                <Select value={col.type ?? ''} onChange={(v) => update(i, { type: (v || undefined) as ReportColumnType | undefined })} options={meta.COLUMN_TYPES} placeholder={metric ? `авто (${meta.COLUMN_TYPES.find((t) => t.value === metric.type)?.label ?? metric.type})` : 'авто'} />
              </Field>
              {(mode === 'agg' || mode === 'expr' || mode === 'metric') && (
                <Field label="Знаков" width={70} hint="Знаков после запятой">
                  <NumInput
                    value={mode === 'agg' ? col.agg?.decimals : col.decimals}
                    onChange={(v) => (mode === 'agg' ? update(i, { agg: { ...col.agg!, decimals: v } }) : update(i, { decimals: v }))}
                    placeholder={metric?.decimals !== undefined ? String(metric.decimals) : '—'}
                    min={0}
                  />
                </Field>
              )}
              <Field label="Ширина" width={80}>
                <NumInput value={col.width} onChange={(v) => update(i, { width: v })} placeholder="авто" min={30} />
              </Field>
              <Field label="Выравн." width={90}>
                <Select value={col.align ?? ''} onChange={(v) => update(i, { align: (v || undefined) as DefColumn['align'] })} options={[{ value: 'left', label: 'слева' }, { value: 'right', label: 'справа' }, { value: 'center', label: 'центр' }]} placeholder="авто" />
              </Field>
              <Check checked={col.total !== false} onChange={(v) => update(i, { total: v ? undefined : false })} label="итог" title="Считать эту колонку в строке «Итого»" />
            </Row>
          </Card>
        )
      })}

      <Row align="center">
        <Select value="" onChange={addField} options={allFields} placeholder="+ поле…" style={{ width: 170, borderStyle: 'dashed', color: 'var(--accent-text)', fontWeight: 600 }} />
        {metrics.length > 0 && (
          <Select value="" onChange={addMetric} options={metricOptions} placeholder="+ показатель…" style={{ width: 190, borderStyle: 'dashed', color: 'var(--accent-text)', fontWeight: 600 }} />
        )}
        <AddBtn label="Формула" onClick={addExpr} />
        <AddBtn label="Расчёт" onClick={addAgg} />
        {grouped && <AddBtn label="Группа" onClick={addGroup} />}
      </Row>
    </>
  )
}
