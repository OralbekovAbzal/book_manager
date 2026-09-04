import React from 'react'
import type { ReportSpec, ReportMeta } from '../../../../api/reports'
import { Field, Row, TextInput, NumInput, Select, Hint } from '../ui'
import { GROUP_PARAM_KEY } from '../model'

interface Props {
  spec: ReportSpec
  meta: ReportMeta
  onChange: (next: ReportSpec) => void
}

export const BasicsSection: React.FC<Props> = ({ spec, meta, onChange }) => {
  const set = (patch: Partial<ReportSpec>) => onChange({ ...spec, ...patch })
  const dataset = meta.datasets.find((d) => d.id === spec.dataset)

  // Источник данных определяет всё остальное: поля, по которым строятся колонки,
  // фильтры и группировка, в другом источнике не существуют.
  const changeDataset = (id: string) => {
    if (!id || id === spec.dataset) return
    const hasContent = spec.columns.length > 0 || (spec.filters?.length ?? 0) > 0
    if (hasContent && !window.confirm('Смена источника данных очистит колонки, фильтры, группировку и сортировку. Продолжить?')) return
    onChange({
      ...spec,
      dataset: id,
      columns: [],
      filters: [],
      groupBy: [],
      sort: [],
      params: (spec.params ?? []).filter((p) => p.key !== GROUP_PARAM_KEY),
    })
  }

  return (
    <>
      <Field label="Название">
        <TextInput value={spec.title} onChange={(v) => set({ title: v })} placeholder="Например: Брони по партнёрам" />
      </Field>
      <Field label="Описание">
        <TextInput value={spec.description ?? ''} onChange={(v) => set({ description: v })} placeholder="Показывается в списке отчётов" />
      </Field>
      <Field label="Источник данных">
        <Select
          value={spec.dataset}
          onChange={changeDataset}
          options={meta.datasets.map((d) => ({ value: d.id, label: d.label }))}
        />
      </Field>
      {dataset?.description && <Hint>{dataset.description}</Hint>}
      <Row>
        <Field label="Иконка" width={130}>
          <Select value={spec.icon ?? ''} onChange={(v) => set({ icon: v || undefined })} options={meta.ICONS} placeholder="—" />
        </Field>
        <Field label="Подпись итогов" grow={1}>
          <TextInput value={spec.totalsLabel ?? ''} onChange={(v) => set({ totalsLabel: v || undefined })} placeholder="Итого" />
        </Field>
        <Field label="Лимит строк" width={110} hint="Пусто — 5000 на экране">
          <NumInput value={spec.limit} onChange={(v) => set({ limit: v })} placeholder="5000" min={1} />
        </Field>
      </Row>
    </>
  )
}
