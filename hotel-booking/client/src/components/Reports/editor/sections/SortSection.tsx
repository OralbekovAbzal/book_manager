import React from 'react'
import type { ReportSpec, ReportMeta, DatasetField, DatasetMetric, DefSort } from '../../../../api/reports'
import { Field, Row, Select, IconBtn, AddBtn, Hint } from '../ui'
import { autoTitle } from '../model'

interface Props {
  spec: ReportSpec
  meta: ReportMeta
  fields: DatasetField[]
  metrics: DatasetMetric[]
  onChange: (next: ReportSpec) => void
}

export const SortSection: React.FC<Props> = ({ spec, meta, fields, metrics, onChange }) => {
  const sort = spec.sort ?? []
  const colOptions = spec.columns.map((c) => ({ value: c.key, label: c.title || autoTitle(c, fields, meta.AGGS, metrics) || c.key }))

  const setSort = (next: DefSort[]) => onChange({ ...spec, sort: next })
  const update = (i: number, patch: Partial<DefSort>) => setSort(sort.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const remove = (i: number) => setSort(sort.filter((_, j) => j !== i))
  const add = () => setSort([...sort, { key: spec.columns[0]?.key ?? '', dir: 'asc' }])

  return (
    <>
      {sort.length === 0 && <Hint>Без сортировки строки идут в порядке данных.</Hint>}
      {sort.map((s, i) => (
        <Row key={i} align="flex-end" wrap={false}>
          <Field label={i === 0 ? 'Сначала по' : 'затем по'} grow={1}>
            <Select value={s.key} onChange={(v) => update(i, { key: v })} options={colOptions} placeholder="колонка…" />
          </Field>
          <Field label="Направление" width={140}>
            <Select value={s.dir ?? 'asc'} onChange={(v) => update(i, { dir: v as 'asc' | 'desc' })} options={[{ value: 'asc', label: 'по возрастанию' }, { value: 'desc', label: 'по убыванию' }]} />
          </Field>
          <IconBtn title="Убрать" onClick={() => remove(i)} danger>×</IconBtn>
        </Row>
      ))}
      {spec.columns.length > 0 && <AddBtn label="Сортировка" onClick={add} />}
    </>
  )
}
