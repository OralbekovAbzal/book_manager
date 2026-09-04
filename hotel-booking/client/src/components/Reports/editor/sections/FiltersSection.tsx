import React from 'react'
import type { ReportSpec, ReportMeta, DefFilter, DatasetField } from '../../../../api/reports'
import { Field, Row, Select, Seg, Check, IconBtn, Card, AddBtn, Hint } from '../ui'
import { DeferredText } from '../deferred'
import { ExprEditor } from '../ExprEditor'
import { coerceFilterValue, filterValueText, autoParam, isExprFilter } from '../model'

interface Props {
  spec: ReportSpec
  meta: ReportMeta
  fields: DatasetField[]
  onChange: (next: ReportSpec) => void
}

/**
 * Фильтры. Два вида: по полю (операция + значение) и формула-условие.
 *
 * Значение фильтра по полю берётся из константы, из параметра, или — главное —
 * «спросить у пользователя»: параметр создаётся сам, с типом и справочником
 * поля (корпуса → список корпусов, статус → список статусов). Пустой параметр
 * = фильтр не применяется, так один отчёт работает и «по всем», и «по одному».
 */
export const FiltersSection: React.FC<Props> = ({ spec, meta, fields, onChange }) => {
  const filters = spec.filters ?? []
  const params = spec.params ?? []
  const paramOptions = params.map((p) => ({ value: p.key, label: `${p.label} (${p.key})` }))
  const paramList = params.map((p) => ({ key: p.key, label: p.label }))
  const fieldOptions = fields.filter((f) => !f.synthetic).map((f) => ({ value: f.key, label: f.label }))

  const setFilters = (next: DefFilter[]) => onChange({ ...spec, filters: next })
  const update = (i: number, patch: Partial<DefFilter>) => setFilters(filters.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  const replace = (i: number, f: DefFilter) => setFilters(filters.map((x, j) => (j === i ? f : x)))
  const remove = (i: number) => setFilters(filters.filter((_, j) => j !== i))
  const addField = () => setFilters([...filters, { field: fieldOptions[0]?.value ?? '', op: 'eq', value: '' }])
  const addExpr = () => setFilters([...filters, { expr: '' }])

  /** «Спросить у пользователя»: новый параметр + ссылка на него из фильтра. */
  const askUser = (i: number) => {
    const f = filters[i]
    const field = fields.find((x) => x.key === f.field)
    if (!field) return
    const { param, op } = autoParam(field, f.op ?? 'eq', params.map((p) => p.key))
    const { value: _v, ...rest } = f
    onChange({
      ...spec,
      params: [...params, param],
      filters: filters.map((x, j) => (j === i ? { ...rest, op, param: param.key } : x)),
    })
  }

  const switchKind = (i: number, kind: 'field' | 'expr') => {
    const f = filters[i]
    if (kind === 'expr' && !isExprFilter(f)) replace(i, { expr: '', negate: f.negate, when: f.when })
    if (kind === 'field' && isExprFilter(f)) replace(i, { field: fieldOptions[0]?.value ?? '', op: 'eq', value: '', negate: f.negate, when: f.when })
  }

  return (
    <>
      {filters.length === 0 && <Hint>Фильтров нет — в отчёт попадает всё за период.</Hint>}
      {filters.map((f, i) => {
        const expr = isExprFilter(f)
        const op = meta.OPS.find((o) => o.value === f.op)
        const needsValue = op?.needsValue !== false
        const byParam = f.param !== undefined
        const field = fields.find((x) => x.key === f.field)
        const linked = byParam ? params.find((p) => p.key === f.param) : undefined
        return (
          <Card key={i}>
            <Row align="flex-end" wrap={false}>
              <Seg value={expr ? 'expr' : 'field'} onChange={(k) => switchKind(i, k as 'field' | 'expr')} options={[{ value: 'field', label: 'Поле' }, { value: 'expr', label: 'Формула' }]} />
              {!expr && (
                <>
                  <Field label="Поле" grow={1}>
                    <Select value={f.field ?? ''} onChange={(v) => update(i, { field: v })} options={fieldOptions} />
                  </Field>
                  <Field label="Операция" grow={1}>
                    <Select value={f.op ?? 'eq'} onChange={(v) => update(i, { op: v })} options={meta.OPS} />
                  </Field>
                </>
              )}
              {expr && <span style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-faint)', alignSelf: 'center' }}>строка попадает в отчёт, если условие верно</span>}
              <Check checked={!!f.negate} onChange={(v) => update(i, { negate: v || undefined })} label="НЕ" title="Инвертировать условие" />
              <IconBtn title="Удалить фильтр" onClick={() => remove(i)} danger>×</IconBtn>
            </Row>

            {expr && (
              <ExprEditor
                value={f.expr ?? ''}
                onCommit={(v) => update(i, { expr: v })}
                fields={fields}
                params={paramList}
                functions={meta.FUNCTIONS}
                aggAllowed={false}
                placeholder="totalAmount - paidAmount > 0"
              />
            )}

            {!expr && needsValue && (
              <Row align="flex-end">
                <Seg
                  value={byParam ? 'param' : 'value'}
                  onChange={(v) => {
                    if (v === 'ask') { askUser(i); return }
                    const { param: _p, value: _v, ...rest } = f
                    replace(i, v === 'param' ? { ...rest, param: params[0]?.key ?? '' } : { ...rest, value: '' })
                  }}
                  options={[{ value: 'ask', label: 'Спросить у пользователя' }, { value: 'param', label: 'Параметр' }, { value: 'value', label: 'Значение' }]}
                />
                {byParam ? (
                  <Field label="Параметр" grow={1}>
                    <Select value={f.param ?? ''} onChange={(v) => update(i, { param: v })} options={paramOptions} placeholder="выберите…" />
                  </Field>
                ) : (
                  <Field label={op?.list ? 'Значения через запятую' : 'Значение'} grow={1}>
                    <DeferredText value={filterValueText(f.value)} onCommit={(t) => update(i, { value: coerceFilterValue(t, field, !!op?.list) })} />
                  </Field>
                )}
              </Row>
            )}
            {!expr && byParam && (
              <Hint>
                {linked
                  ? <>Пользователь задаст «{linked.label}» перед построением; пусто — фильтр не применяется. Подпись и значения — в секции «Параметры».</>
                  : <>Параметр «{f.param}» не найден — выберите другой или создайте.</>}
              </Hint>
            )}

            <Row align="flex-end">
              <Check
                checked={!!f.when}
                onChange={(v) => update(i, { when: v ? { param: params[0]?.key ?? '', eq: '' } : undefined })}
                label="только при условии"
                title="Применять фильтр, только когда параметр равен значению"
              />
              {f.when && (
                <>
                  <Field label="Параметр" grow={1}>
                    <Select value={f.when.param} onChange={(v) => update(i, { when: { ...f.when!, param: v } })} options={paramOptions} placeholder="…" />
                  </Field>
                  <Field label="равен" grow={1}>
                    <DeferredText value={String(f.when.eq ?? '')} onCommit={(t) => update(i, { when: { ...f.when!, eq: t } })} />
                  </Field>
                </>
              )}
            </Row>
          </Card>
        )
      })}
      <Row align="center">
        <AddBtn label="Фильтр по полю" onClick={addField} />
        <AddBtn label="Условие-формула" onClick={addExpr} />
      </Row>
    </>
  )
}
