import React, { useEffect, useState } from 'react'
import type { ReportSpec, DatasetField, DefParam } from '../../../../api/reports'
import { Row, Seg, Chip, Hint } from '../ui'
import { groupMode, groupFields, GROUP_PARAM_KEY, type GroupMode } from '../model'

interface Props {
  spec: ReportSpec
  fields: DatasetField[]
  onChange: (next: ReportSpec) => void
}

const MODES: { value: GroupMode; label: string }[] = [
  { value: 'none', label: 'Без группировки' },
  { value: 'fixed', label: 'Фиксированная' },
  { value: 'param', label: 'Выбирает пользователь' },
]

/**
 * Группировка. «Выбирает пользователь» — это параметр `groupBy` (выпадающий
 * список) плюс `groupBy: { param }` в определении; секция сама держит этот
 * параметр в актуальном состоянии, чтобы не заставлять собирать его руками.
 */
export const GroupSection: React.FC<Props> = ({ spec, fields, onChange }) => {
  // Режим держим локально: «Фиксированная» без единого выбранного поля по данным
  // неотличима от «Без группировки», а форма должна помнить выбор пользователя.
  const [mode, setMode] = useState<GroupMode>(groupMode(spec))
  useEffect(() => {
    const derived = groupMode(spec)
    if (derived !== 'none' && derived !== mode) setMode(derived)
  }, [spec.groupBy])

  const groupable = fields.filter((f) => f.groupable)
  const selected = groupFields(spec)

  const withoutGroupParam = (params: DefParam[] | undefined) => (params ?? []).filter((p) => p.key !== GROUP_PARAM_KEY)

  const groupParam = (keys: string[]): DefParam => {
    const existing = spec.params?.find((p) => p.key === GROUP_PARAM_KEY)
    return {
      key: GROUP_PARAM_KEY,
      type: 'select',
      label: existing?.label || 'Группировка',
      required: true,
      hint: existing?.hint,
      default: keys.includes(String(existing?.default)) ? existing?.default : keys[0],
      options: keys.map((k) => ({ value: k, label: fields.find((f) => f.key === k)?.label ?? k })),
    }
  }

  const apply = (nextMode: GroupMode, keys: string[]) => {
    if (nextMode === 'none') {
      onChange({ ...spec, groupBy: [], params: withoutGroupParam(spec.params) })
    } else if (nextMode === 'fixed') {
      onChange({ ...spec, groupBy: keys, params: withoutGroupParam(spec.params) })
    } else {
      onChange({ ...spec, groupBy: { param: GROUP_PARAM_KEY }, params: [...withoutGroupParam(spec.params), groupParam(keys)] })
    }
  }

  const changeMode = (m: GroupMode) => {
    setMode(m)
    apply(m, selected)
  }

  const toggle = (key: string) => {
    const next = selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]
    apply(mode, next)
  }

  return (
    <>
      <Seg value={mode} onChange={(m) => changeMode(m as GroupMode)} options={MODES} />
      {mode !== 'none' && (
        <>
          <Hint>
            {mode === 'fixed'
              ? 'Поля группировки — в порядке выбора. Несколько полей дают вложенную группировку.'
              : 'Пользователь выберет одно из этих полей в параметрах отчёта. Первое — по умолчанию.'}
          </Hint>
          <Row gap={5} align="center">
            {groupable.map((f) => (
              <Chip key={f.key} active={selected.includes(f.key)} onClick={() => toggle(f.key)}>
                {f.label}
                {mode === 'fixed' && selected.includes(f.key) && selected.length > 1 && (
                  <span style={{ marginLeft: 5, opacity: 0.6 }}>{selected.indexOf(f.key) + 1}</span>
                )}
              </Chip>
            ))}
          </Row>
          <Hint>В колонках добавьте «Группу» (значение группировки) и расчёты — сумму, количество, долю.</Hint>
        </>
      )}
    </>
  )
}
