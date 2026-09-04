import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchReportMeta, validateSpec, previewReport, createReport, updateReport,
  type ReportSpec, type ReportMeta, type ReportDefinition, type ReportResult,
} from '../../../api/reports'
import { ReportParams } from '../ReportParams'
import { ReportTable } from '../ReportTable'
import { Section } from './ui'
import { fieldsOf, metricsOf, groupMode, specToJson } from './model'
import { BasicsSection } from './sections/BasicsSection'
import { ColumnsSection } from './sections/ColumnsSection'
import { GroupSection } from './sections/GroupSection'
import { ParamsSection } from './sections/ParamsSection'
import { FiltersSection } from './sections/FiltersSection'
import { SortSection } from './sections/SortSection'
import { JsonSection } from './sections/JsonSection'

/**
 * Конструктор / редактор отчёта.
 *
 * Слева — форма над определением (или его JSON), справа — живой предпросмотр:
 * определение отправляется на сервер как есть, без сохранения, и сервер же
 * возвращает список проблем. Поэтому правила «что можно» живут в одном месте —
 * в валидации на сервере — и конструктор не может собрать то, что движок не примет.
 */

interface Props {
  mode: 'create' | 'edit'
  id?: string
  initial: ReportSpec
  onSaved: (def: ReportDefinition) => void
  onCancel: () => void
}

const GROUP_LABEL: Record<string, string> = { none: 'нет', fixed: 'фиксированная', param: 'выбирает пользователь' }

const headBtn = (primary: boolean): React.CSSProperties => ({
  height: 34, padding: '0 16px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.84rem', fontWeight: 600, whiteSpace: 'nowrap',
  border: primary ? 'none' : '1px solid var(--border)',
  background: primary ? 'var(--accent)' : 'var(--bg)',
  color: primary ? '#fff' : 'var(--text-muted)',
})

export const ReportEditor: React.FC<Props> = ({ mode, id, initial, onSaved, onCancel }) => {
  const [meta, setMeta] = useState<ReportMeta | null>(null)
  const [metaError, setMetaError] = useState('')
  const [spec, setSpec] = useState<ReportSpec>(initial)
  const [tab, setTab] = useState<'build' | 'json'>('build')
  // Все секции раскрыты: свёрнутые «Параметры» и «Фильтры» в первой версии
  // просто не находили — казалось, что настроить ввод пользователя нельзя.
  const [open, setOpen] = useState<Record<string, boolean>>({ basics: true, columns: true, group: true, params: true, filters: true, sort: true })

  const [problems, setProblems] = useState<string[]>([])
  const [resolved, setResolved] = useState<ReportDefinition | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [preview, setPreview] = useState<ReportResult | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState('')

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveProblems, setSaveProblems] = useState<string[]>([])

  const valuesRef = useRef(values)
  valuesRef.current = values
  const specRef = useRef(spec)
  specRef.current = spec
  const timer = useRef<number | undefined>(undefined)
  const seq = useRef(0)

  const dirty = useMemo(() => specToJson(spec) !== specToJson(initial), [spec, initial])
  const fields = useMemo(() => fieldsOf(meta, spec.dataset), [meta, spec.dataset])
  const metrics = useMemo(() => metricsOf(meta, spec.dataset), [meta, spec.dataset])
  const requiresPeriod = !!meta?.datasets.find((d) => d.id === spec.dataset)?.requiresPeriod

  useEffect(() => {
    fetchReportMeta().then(setMeta).catch(() => setMetaError('Не удалось загрузить словарь конструктора'))
  }, [])

  const cancel = () => {
    if (dirty && !window.confirm('Есть несохранённые изменения. Закрыть без сохранения?')) return
    onCancel()
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [dirty])

  /** Значения формы предпросмотра для новых параметров — из умолчаний определения. */
  const mergeDefaults = (def: ReportDefinition, prev: Record<string, any>) => {
    const next: Record<string, any> = {}
    for (const p of def.params || []) {
      if (prev[p.key] !== undefined) next[p.key] = prev[p.key]
      else if (p.type === 'dateRange') next[p.key] = { preset: p.default?.preset || 'currentMonth' }
      else if (p.default !== undefined) next[p.key] = p.default
    }
    return next
  }

  const runPreview = (def: ReportDefinition, params: Record<string, any>) => {
    const my = ++seq.current
    setPreviewBusy(true)
    setPreviewError('')
    previewReport(specRef.current, params)
      .then((res) => {
        if (my !== seq.current) return
        setPreview(res)
        if (res.params?.period) {
          setValues((prev) => ({ ...prev, period: { from: res.params.period.from, to: res.params.period.to } }))
        }
      })
      .catch((err) => {
        if (my !== seq.current) return
        setPreview(null)
        setPreviewError(err?.message || 'Не удалось построить предпросмотр')
        if (err?.problems?.length) setProblems(err.problems)
      })
      .finally(() => { if (my === seq.current) setPreviewBusy(false) })
    void def
  }

  // Любая правка определения → проверка на сервере → предпросмотр. С задержкой:
  // конструктор меняет определение на каждую букву в заголовке колонки.
  useEffect(() => {
    if (!meta) return
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      validateSpec(specRef.current)
        .then((v) => {
          setProblems(v.problems)
          if (!v.ok || !v.definition) {
            setResolved(null)
            setPreview(null)
            return
          }
          setResolved(v.definition)
          const merged = mergeDefaults(v.definition, valuesRef.current)
          setValues(merged)
          runPreview(v.definition, merged)
        })
        .catch((err) => setPreviewError(err?.message || 'Не удалось проверить определение'))
    }, 600)
    return () => window.clearTimeout(timer.current)
  }, [spec, meta])

  const handleValue = (key: string, value: any) => {
    const next = { ...valuesRef.current, [key]: value }
    setValues(next)
    if (resolved) {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => runPreview(resolved, next), 350)
    }
  }

  const handlePreset = (key: string, preset: string) => {
    const next = { ...valuesRef.current, [key]: { preset } }
    setValues(next)
    if (resolved) runPreview(resolved, next)
  }

  const save = async () => {
    if (!spec.title.trim()) { setSaveError('Дайте отчёту название'); return }
    setSaving(true)
    setSaveError('')
    setSaveProblems([])
    try {
      const def = mode === 'edit' && id ? await updateReport(id, spec) : await createReport(spec)
      onSaved(def)
    } catch (err: any) {
      setSaveError(err?.message || 'Не удалось сохранить')
      setSaveProblems(err?.problems ?? [])
    } finally {
      setSaving(false)
    }
  }

  const toggle = (key: string) => setOpen((o) => ({ ...o, [key]: !o[key] }))
  const allProblems = saveProblems.length ? saveProblems : problems

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden' }}>
      {/* Шапка */}
      <div style={{ height: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, padding: '0 22px', borderBottom: '1px solid var(--border)' }}>
        <button onClick={cancel} style={headBtn(false)}>← Отмена</button>
        <span style={{ fontSize: '1.02rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mode === 'edit' ? 'Изменение отчёта' : 'Новый отчёт'}
          {spec.title.trim() ? ` · ${spec.title.trim()}` : ''}
        </span>
        {mode === 'edit' && id && <span className="mono" style={{ fontSize: '0.74rem', color: 'var(--text-faint)' }}>{id}</span>}
        <span style={{ flex: 1 }} />
        {saveError && <span style={{ fontSize: '0.8rem', color: 'var(--s-overdue)' }}>{saveError}</span>}
        <button onClick={save} disabled={saving || !meta} style={{ ...headBtn(true), opacity: saving || !meta ? 0.6 : 1 }}>
          {saving ? 'Сохраняем…' : 'Сохранить'}
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Форма */}
        <div style={{ width: 'clamp(480px, 42%, 640px)', flexShrink: 0, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 2, padding: '10px 16px 0', borderBottom: '1px solid var(--border-subtle)' }}>
            {(['build', 'json'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  height: 32, padding: '0 14px', border: 'none', borderBottom: `2px solid ${tab === t ? 'var(--accent)' : 'transparent'}`,
                  background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.84rem',
                  fontWeight: tab === t ? 600 : 500, color: tab === t ? 'var(--text)' : 'var(--text-faint)',
                }}
              >{t === 'build' ? 'Конструктор' : 'JSON'}</button>
            ))}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {metaError && <div style={{ padding: 16, color: 'var(--s-overdue)', fontSize: '0.85rem' }}>{metaError}</div>}
            {!meta && !metaError && <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: '0.85rem' }}>Загрузка…</div>}

            {meta && tab === 'build' && (
              <>
                <Section title="Основное" open={!!open.basics} onToggle={() => toggle('basics')} hint={meta.datasets.find((d) => d.id === spec.dataset)?.label}>
                  <BasicsSection spec={spec} meta={meta} onChange={setSpec} />
                </Section>
                <Section title="Колонки" count={spec.columns.length} open={!!open.columns} onToggle={() => toggle('columns')}>
                  <ColumnsSection spec={spec} meta={meta} fields={fields} metrics={metrics} onChange={setSpec} />
                </Section>
                <Section title="Группировка" open={!!open.group} onToggle={() => toggle('group')} hint={GROUP_LABEL[groupMode(spec)]}>
                  <GroupSection spec={spec} fields={fields} onChange={setSpec} />
                </Section>
                <Section title="Параметры" count={spec.params?.length ?? 0} open={!!open.params} onToggle={() => toggle('params')}>
                  <ParamsSection spec={spec} meta={meta} requiresPeriod={requiresPeriod} onChange={setSpec} />
                </Section>
                <Section title="Фильтры" count={spec.filters?.length ?? 0} open={!!open.filters} onToggle={() => toggle('filters')}>
                  <FiltersSection spec={spec} meta={meta} fields={fields} onChange={setSpec} />
                </Section>
                <Section title="Сортировка" count={spec.sort?.length ?? 0} open={!!open.sort} onToggle={() => toggle('sort')}>
                  <SortSection spec={spec} meta={meta} fields={fields} metrics={metrics} onChange={setSpec} />
                </Section>
              </>
            )}
            {meta && tab === 'json' && <JsonSection spec={spec} onApply={setSpec} />}
          </div>
        </div>

        {/* Предпросмотр */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, height: 42, padding: '0 22px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
            <span style={{ fontSize: '0.86rem', fontWeight: 600 }}>Предпросмотр</span>
            {previewBusy && <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>считаем…</span>}
            {preview && !previewBusy && (
              <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>строк: {preview.meta.rowCount}</span>
            )}
          </div>

          {allProblems.length > 0 && (
            <div style={{ margin: '12px 22px 0', padding: '10px 14px', borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: '0.82rem' }}>
              <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--s-overdue)' }}>Определение пока некорректно:</div>
              <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {allProblems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}
          {previewError && allProblems.length === 0 && (
            <div style={{ margin: '12px 22px 0', padding: '10px 14px', borderRadius: 9, background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--s-overdue)', fontSize: '0.82rem' }}>{previewError}</div>
          )}

          {resolved && (
            <div style={{ padding: '12px 22px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0 }}>
              <ReportParams params={resolved.params || []} values={values} onChange={handleValue} onPreset={handlePreset} disabled={previewBusy} />
            </div>
          )}

          {preview ? (
            <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '12px 22px 18px' }}>
              <div style={{ flex: 1, minHeight: 0, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', display: 'flex', background: 'var(--bg)' }}>
                <ReportTable result={preview} totalsLabel={spec.totalsLabel} />
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: '0.86rem', padding: 22, textAlign: 'center' }}>
              {allProblems.length ? 'Исправьте замечания слева — предпросмотр появится сам' : previewBusy ? 'Считаем…' : 'Добавьте колонки — предпросмотр появится сам'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
