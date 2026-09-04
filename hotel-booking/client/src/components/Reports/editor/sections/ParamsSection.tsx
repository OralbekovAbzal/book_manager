import React from 'react'
import type { ReportSpec, ReportMeta, DefParam, ReportParamType } from '../../../../api/reports'
import { Field, Row, TextInput, Select, Seg, Chip, Check, IconBtn, Card, AddBtn, Hint } from '../ui'
import { DeferredText, DeferredArea } from '../deferred'
import { uniqueKey, groupMode, GROUP_PARAM_KEY, parseOptionsText, optionsToText, paramUsage } from '../model'

interface Props {
  spec: ReportSpec
  meta: ReportMeta
  requiresPeriod: boolean
  onChange: (next: ReportSpec) => void
}

export const ParamsSection: React.FC<Props> = ({ spec, meta, requiresPeriod, onChange }) => {
  const params = spec.params ?? []
  const managedGroup = groupMode(spec) === 'param'

  const setParams = (next: DefParam[]) => onChange({ ...spec, params: next })
  const update = (i: number, patch: Partial<DefParam>) => setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const remove = (i: number) => {
    const key = params[i].key
    // Фильтры, ссылающиеся на удалённый параметр, стали бы ошибкой валидации — снимаем ссылку сами
    const filters = (spec.filters ?? []).map((f) => {
      const next = { ...f }
      if (next.param === key) delete next.param
      if (next.when?.param === key) delete next.when
      return next
    })
    onChange({ ...spec, params: params.filter((_, j) => j !== i), filters })
  }
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= params.length) return
    const next = [...params]
    ;[next[i], next[j]] = [next[j], next[i]]
    setParams(next)
  }
  const add = () => setParams([...params, { key: uniqueKey('param', params.map((p) => p.key)), type: 'text', label: 'Новый параметр' }])

  const changeType = (i: number, type: ReportParamType) => {
    const p = params[i]
    const next: DefParam = { key: p.key, type, label: p.label, required: p.required, hint: p.hint }
    if (type === 'dateRange') { next.default = { preset: 'currentMonth' }; next.presets = ['currentMonth', 'prevMonth', 'last30'] }
    if (type === 'select' || type === 'multiselect') next.options = []
    setParams(params.map((x, j) => (j === i ? next : x)))
  }

  const usage = paramUsage(spec)

  return (
    <>
      <Hint>
        Параметры — это поля, которые пользователь заполняет перед построением отчёта.
        Сам по себе параметр ни на что не влияет: его подставляют в фильтр
        («Спросить у пользователя» в секции «Фильтры») или в формулу как <span className="mono">@ключ</span>.
      </Hint>
      {params.map((p, i) => {
        const isPeriod = requiresPeriod && p.key === 'period'
        const isGroup = managedGroup && p.key === GROUP_PARAM_KEY
        const locked = isPeriod || isGroup
        const useSource = !!p.optionsFrom
        const usedIn = usage[p.key] ?? []
        return (
          <Card key={i}>
            <Row align="center" wrap={false}>
              <Field label="Ключ" width={140}>
                <DeferredText value={p.key} onCommit={(v) => update(i, { key: v.replace(/[^a-zA-Z0-9_]/g, '') })} mono style={{ opacity: locked ? 0.6 : 1 }} />
              </Field>
              <Field label="Тип" grow={1}>
                <Select value={p.type} onChange={(v) => changeType(i, v as ReportParamType)} options={meta.PARAM_TYPES} disabled={locked} />
              </Field>
              <Field label="Подпись" grow={1}>
                <TextInput value={p.label} onChange={(v) => update(i, { label: v })} />
              </Field>
              <span style={{ flex: '0 0 auto', display: 'flex', alignSelf: 'flex-end' }}>
                <IconBtn title="Выше" onClick={() => move(i, -1)} disabled={i === 0}>↑</IconBtn>
                <IconBtn title="Ниже" onClick={() => move(i, 1)} disabled={i === params.length - 1}>↓</IconBtn>
                <IconBtn title={locked ? 'Этот параметр обязателен' : 'Удалить параметр'} onClick={() => remove(i)} disabled={locked} danger>×</IconBtn>
              </span>
            </Row>

            {isPeriod && <Hint>Источник данных требует период — параметр удалить нельзя.</Hint>}
            {isGroup && <Hint>Список значений управляется секцией «Группировка».</Hint>}
            {!locked && (
              usedIn.length
                ? <Hint>Используется: {usedIn.join(', ')}</Hint>
                : <Hint><span style={{ color: 'var(--s-overdue)' }}>Нигде не используется</span> — добавьте фильтр с этим параметром или упомяните <span className="mono">@{p.key}</span> в формуле.</Hint>
            )}

            {p.type === 'dateRange' && (
              <Row>
                <Field label="Пресеты" grow={1}>
                  <Row gap={4} align="center">
                    {meta.PRESETS.map((pr) => {
                      const on = (p.presets ?? []).includes(pr.value)
                      return (
                        <Chip key={pr.value} active={on} onClick={() => update(i, { presets: on ? (p.presets ?? []).filter((x) => x !== pr.value) : [...(p.presets ?? []), pr.value] })}>
                          {pr.label}
                        </Chip>
                      )
                    })}
                  </Row>
                </Field>
                <Field label="По умолчанию" width={150}>
                  <Select value={p.default?.preset ?? ''} onChange={(v) => update(i, { default: v ? { preset: v } : undefined })} options={meta.PRESETS} placeholder="этот месяц" />
                </Field>
              </Row>
            )}

            {(p.type === 'select' || p.type === 'multiselect') && !isGroup && (
              <>
                <Row align="center">
                  <Seg
                    value={useSource ? 'source' : 'list'}
                    onChange={(v) => update(i, v === 'source' ? { optionsFrom: meta.OPTION_SOURCES[0]?.value, options: undefined } : { optionsFrom: undefined, options: [] })}
                    options={[{ value: 'list', label: 'Свой список' }, { value: 'source', label: 'Справочник' }]}
                  />
                  {useSource && (
                    <Select value={p.optionsFrom ?? ''} onChange={(v) => update(i, { optionsFrom: v })} options={meta.OPTION_SOURCES} style={{ width: 200 }} />
                  )}
                </Row>
                {!useSource && (
                  <Field label="Значения (по одному в строке: значение | подпись)">
                    <DeferredArea value={optionsToText(p.options)} onCommit={(t) => update(i, { options: parseOptionsText(t) })} placeholder={'CONFIRMED | Подтверждена\nCANCELLED | Отменена'} />
                  </Field>
                )}
              </>
            )}

            {p.type !== 'dateRange' && (
              <Row>
                {p.type !== 'boolean' && (
                  <Field label="Плейсхолдер" grow={1}>
                    <TextInput value={p.placeholder ?? ''} onChange={(v) => update(i, { placeholder: v || undefined })} placeholder={p.type === 'select' ? 'Все' : ''} />
                  </Field>
                )}
                {!isGroup && (
                  <Field label={p.type === 'multiselect' ? 'По умолчанию (через запятую)' : 'По умолчанию'} grow={1}>
                    {p.type === 'boolean'
                      ? <Check checked={!!p.default} onChange={(v) => update(i, { default: v })} label="включено" />
                      : p.type === 'select' && !useSource && (p.options?.length ?? 0) > 0
                        ? <Select value={p.default ?? ''} onChange={(v) => update(i, { default: v || undefined })} options={p.options ?? []} placeholder="—" />
                        : <DeferredText
                            value={Array.isArray(p.default) ? p.default.join(', ') : (p.default ?? '')}
                            onCommit={(v) => update(i, { default: p.type === 'multiselect' ? v.split(',').map((s) => s.trim()).filter(Boolean) : (v || undefined) })}
                          />}
                  </Field>
                )}
                <Check checked={!!p.required} onChange={(v) => update(i, { required: v || undefined })} label="обязательный" />
              </Row>
            )}

            <Field label="Подсказка">
              <TextInput value={p.hint ?? ''} onChange={(v) => update(i, { hint: v || undefined })} placeholder="Показывается при наведении" />
            </Field>
          </Card>
        )
      })}
      <AddBtn label="Параметр" onClick={add} />
    </>
  )
}
