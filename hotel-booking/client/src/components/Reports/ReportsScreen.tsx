import React, { useEffect, useRef, useState } from 'react'
import {
  fetchReports, fetchReportDefinition, runReport, downloadReport,
  fetchReportSpec, deleteReport, importReport,
  type ReportSummary, type ReportDefinition, type ReportResult, type ReportSpec, type ExportFormat,
} from '../../api/reports'
import { useAuthStore } from '../../store/useAuthStore'
import { getSocket } from '../../hooks/useSocket'
import { ReportParams } from './ReportParams'
import { ReportTable } from './ReportTable'
import { ReportEditor } from './editor/ReportEditor'
import { blankSpec, readJsonFile, downloadSpec } from './editor/model'
import { formatPeriod } from './format'

/**
 * Раздел «Отчёты».
 *
 * Экран построен вокруг того, что отчёт — это ДАННЫЕ: слева список определений,
 * справа форма, собранная по параметрам выбранного определения, и таблица по его
 * колонкам. Здесь нет кода ни одного конкретного отчёта — конструктор, редактор
 * и импорт правят то же определение, которое этот экран уже умеет показывать.
 */

interface Props {
  onBack: () => void
}

const ICONS: Record<string, string> = {
  chart: 'M3 3v18h18M7 15l3-4 3 3 5-7',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
}

const DEFAULT_ICON = 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5'
const EDITOR_ROLES = new Set(['ADMIN', 'SUPER_ADMIN'])

const ToolBtn: React.FC<{
  label: string; onClick: () => void; disabled?: boolean; title?: string; danger?: boolean; accent?: boolean
}> = ({ label, onClick, disabled, title, danger, accent }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className="tb-btn"
    style={{
      height: 32, minWidth: 56, padding: '0 12px', borderRadius: 8,
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
      border: `1px solid ${danger ? 'var(--s-overdue)' : accent ? 'var(--accent)' : 'var(--border)'}`,
      background: 'var(--bg)', color: danger ? 'var(--s-overdue)' : accent ? 'var(--accent-text)' : 'var(--text-muted)',
      fontSize: '0.82rem', fontWeight: accent || danger ? 600 : 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
    }}
  >{label}</button>
)

interface EditorState {
  mode: 'create' | 'edit'
  id?: string
  initial: ReportSpec
}

export const ReportsScreen: React.FC<Props> = ({ onBack }) => {
  const admin = useAuthStore((s) => s.admin)
  const canEdit = EDITOR_ROLES.has(admin?.role ?? '')

  const [reports, setReports] = useState<ReportSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [definition, setDefinition] = useState<ReportDefinition | null>(null)
  const [values, setValues] = useState<Record<string, any>>({})
  const [result, setResult] = useState<ReportResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string>('')
  const [toast, setToast] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const fileRef = useRef<HTMLInputElement>(null)

  // Значения параметров нужны обработчику, который живёт в таймере, — держим их
  // в ref, иначе автозапуск сработает с предыдущим состоянием.
  const valuesRef = useRef(values)
  valuesRef.current = values
  const runTimer = useRef<number | undefined>(undefined)

  const flash = (text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  /** Список отчётов; selectId — какой выбрать после обновления (новый/изменённый). */
  const loadList = (selectId?: string) => fetchReports()
    .then((list) => {
      setReports(list)
      setActiveId((current) => {
        if (selectId && list.some((r) => r.id === selectId)) return selectId
        if (current && list.some((r) => r.id === current)) return current
        return list[0]?.id ?? null
      })
    })
    .catch(() => setError('Не удалось загрузить список отчётов'))

  useEffect(() => { loadList() }, [])

  // Отчёт создали/изменили/удалили на другом рабочем месте — перечитываем список
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const handler = () => { loadList() }
    socket.on('reports:changed', handler)
    return () => { socket.off('reports:changed', handler) }
  }, [])

  useEffect(() => {
    if (editor) return // внутри редактора Esc закрывает редактор, а не раздел
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onBack, editor])

  useEffect(() => () => {
    window.clearTimeout(runTimer.current)
    window.clearTimeout(toastTimer.current)
  }, [])

  // Смена отчёта: берём определение и запускаем со значениями по умолчанию.
  // Период не заполняем — его посчитает сервер от даты смены и вернёт обратно.
  useEffect(() => {
    if (!activeId) return
    setResult(null)
    setError('')
    setDefinition(null)
    setConfirmDelete(false)
    fetchReportDefinition(activeId)
      .then((def) => {
        setDefinition(def)
        const initial: Record<string, any> = {}
        for (const p of def.params || []) {
          if (p.type === 'dateRange') initial[p.key] = { preset: p.default?.preset || 'currentMonth' }
          else if (p.default !== undefined) initial[p.key] = p.default
        }
        setValues(initial)
        execute(def.id, initial)
      })
      .catch(() => setError('Не удалось загрузить отчёт'))
  }, [activeId])

  const execute = (id: string, params: Record<string, any>) => {
    setLoading(true)
    setError('')
    runReport(id, params)
      .then((res) => {
        setResult(res)
        // Сервер вернул фактические даты (в том числе развернув пресет) —
        // показываем в полях именно их, чтобы период на экране не расходился
        // с периодом в цифрах.
        if (res.params?.period) {
          setValues((prev) => ({ ...prev, period: { from: res.params.period.from, to: res.params.period.to } }))
        }
      })
      .catch((err) => {
        setResult(null)
        setError(err?.response?.data?.error || err?.response?.data?.message || 'Не удалось построить отчёт')
      })
      .finally(() => setLoading(false))
  }

  const scheduleRun = (params: Record<string, any>) => {
    window.clearTimeout(runTimer.current)
    runTimer.current = window.setTimeout(() => {
      if (activeId) execute(activeId, params)
    }, 350)
  }

  const handleChange = (key: string, value: any) => {
    const next = { ...valuesRef.current, [key]: value }
    setValues(next)
    scheduleRun(next)
  }

  const handlePreset = (key: string, preset: string) => {
    const next = { ...valuesRef.current, [key]: { preset } }
    setValues(next)
    if (activeId) execute(activeId, next)
  }

  const active = reports.find((r) => r.id === activeId)
  const hasRows = !!result && result.rows.length > 0

  /** Имя файла считаем из заголовка и периода — как это делает и сервер. */
  const fileBase = () => {
    const period = result?.params?.period
    const suffix = period?.from ? `-${period.from}_${period.to}` : ''
    return `${active?.title || 'Отчёт'}${suffix}`
  }

  const handleExport = async (format: ExportFormat) => {
    if (!activeId || !hasRows) return
    setBusy(format)
    try {
      const name = await downloadReport(activeId, valuesRef.current, format)
      if (name) flash(`Сохранено: ${name}`)
    } catch (err: any) {
      flash(err?.message || 'Не удалось выгрузить отчёт')
    } finally {
      setBusy('')
    }
  }

  /**
   * PDF в Electron печатает то же окно через printToPDF — макет совпадает
   * с бумажным до пикселя. В браузере такого API нет, поэтому открываем
   * обычную печать: там PDF выбирается принтером.
   */
  const handlePdf = async () => {
    if (!hasRows) return
    const bridge = window.appConfig?.saveReportPdf
    if (!bridge) {
      flash('Выберите «Сохранить как PDF» в окне печати')
      window.setTimeout(() => window.print(), 400)
      return
    }
    setBusy('pdf')
    try {
      const res = await bridge({ fileName: `${fileBase()}.pdf`, landscape: true })
      if (res.ok) flash('PDF сохранён')
      else if (!res.canceled) flash(res.error || 'Не удалось сохранить PDF')
    } finally {
      setBusy('')
    }
  }

  // --- Конструктор / редактор -------------------------------------------------

  const openNew = () => setEditor({ mode: 'create', initial: blankSpec('bookings') })

  /** Встроенный отчёт не правится — открываем его копию как новый. */
  const openCopy = async () => {
    if (!activeId) return
    try {
      const { spec } = await fetchReportSpec(activeId)
      const { id: _id, ...rest } = spec
      setEditor({ mode: 'create', initial: { ...rest, title: `${spec.title} (копия)` } })
    } catch (err: any) {
      flash(err?.message || 'Не удалось открыть отчёт')
    }
  }

  const openEdit = async () => {
    if (!activeId) return
    try {
      const { spec, editable } = await fetchReportSpec(activeId)
      if (!editable) return openCopy()
      setEditor({ mode: 'edit', id: activeId, initial: spec })
    } catch (err: any) {
      flash(err?.message || 'Не удалось открыть отчёт')
    }
  }

  const handleDelete = async () => {
    if (!activeId) return
    try {
      await deleteReport(activeId)
      setConfirmDelete(false)
      flash('Отчёт удалён')
      loadList()
    } catch (err: any) {
      flash(err?.message || 'Не удалось удалить')
    }
  }

  const handleSaved = (def: ReportDefinition) => {
    setEditor(null)
    flash('Отчёт сохранён')
    loadList(def.id)
  }

  const handleImport = async (file: File | undefined) => {
    if (!file) return
    try {
      const spec = await readJsonFile(file)
      const { definition: def, renamed, requestedId } = await importReport(spec)
      flash(renamed ? `Импортировано как «${def.id}» — ключ «${requestedId}» был занят` : `Импортировано: ${def.title}`)
      loadList(def.id)
    } catch (err: any) {
      const problems: string[] = err?.problems ?? []
      flash(problems.length ? `${err.message}: ${problems.slice(0, 2).join('; ')}${problems.length > 2 ? '…' : ''}` : (err?.message || 'Не удалось импортировать'))
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  const handleDownloadSpec = async () => {
    if (!activeId) return
    try {
      const { spec } = await fetchReportSpec(activeId)
      await downloadSpec({ ...spec, id: activeId })
    } catch (err: any) {
      flash(err?.message || 'Не удалось выгрузить определение')
    }
  }

  if (editor) {
    return <ReportEditor mode={editor.mode} id={editor.id} initial={editor.initial} onSaved={handleSaved} onCancel={() => setEditor(null)} />
  }

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex',
      background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden',
    }}>
      {/* Список отчётов */}
      <aside className="report-sidebar" style={{
        width: 244, flexShrink: 0, borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', background: 'var(--surface)',
      }}>
        <div style={{
          height: 60, flexShrink: 0, display: 'flex', alignItems: 'center',
          padding: '0 18px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: '1.02rem', fontWeight: 700, letterSpacing: '-0.01em' }}>Отчёты</span>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10 }}>
          {reports.map((r) => {
            const isActive = r.id === activeId
            return (
              <button
                key={r.id}
                onClick={() => setActiveId(r.id)}
                className="nav-item-btn"
                data-active={isActive}
                style={{
                  width: '100%', display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '10px 11px', marginBottom: 3, border: 'none', borderRadius: 9,
                  background: isActive ? 'var(--accent-bg)' : 'transparent',
                  color: isActive ? 'var(--accent-text)' : 'var(--text-muted)',
                  cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
                  style={{ flexShrink: 0, marginTop: 1 }}>
                  <path d={ICONS[r.icon || ''] || DEFAULT_ICON} />
                </svg>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: '0.87rem', fontWeight: isActive ? 600 : 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {r.title}
                    {r.source === 'custom' && (
                      <span className="mono" title="Пользовательский отчёт" style={{ fontSize: '0.62rem', fontWeight: 600, color: 'var(--text-faint)', background: 'var(--surface-2)', padding: '1px 5px', borderRadius: 4 }}>свой</span>
                    )}
                  </span>
                  {r.description && (
                    <span style={{ fontSize: '0.73rem', color: 'var(--text-faint)', lineHeight: 1.35, whiteSpace: 'normal' }}>
                      {r.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
          {!reports.length && !error && (
            <div style={{ padding: 14, fontSize: '0.82rem', color: 'var(--text-faint)' }}>Загрузка…</div>
          )}
        </div>
        {canEdit && (
          <div style={{ padding: 10, borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={openNew} style={{
              height: 34, borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff',
              cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.84rem', fontWeight: 600,
            }}>+ Новый отчёт</button>
            <button onClick={() => fileRef.current?.click()} style={{
              height: 30, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg)',
              color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem', fontWeight: 500,
            }}>Импорт из JSON</button>
            <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => handleImport(e.target.files?.[0])} />
          </div>
        )}
      </aside>

      {/* Отчёт */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {/* Кнопок много (правка + пять выгрузок): в узком окне они переносятся
            на вторую строку, а не отжимают заголовок в многоточие. */}
        <div className="report-toolbar" style={{
          minHeight: 60, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          padding: '10px 22px', borderBottom: '1px solid var(--border)',
        }}>
          <span style={{ fontSize: '1.02rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 140, maxWidth: '100%' }}>{active?.title || 'Отчёт'}</span>
          {loading && <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>считаем…</span>}
          <span style={{ flex: 1 }} />
          {toast && (
            <span style={{
              fontSize: '0.79rem', color: 'var(--text-muted)', background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)', borderRadius: 7, padding: '4px 10px',
              maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{toast}</span>
          )}
          {canEdit && active && (
            <div style={{ display: 'flex', gap: 6 }}>
              {active.source === 'custom' ? (
                <>
                  <ToolBtn label="Изменить" onClick={openEdit} accent />
                  {confirmDelete ? (
                    <>
                      <ToolBtn label="Точно удалить" onClick={handleDelete} danger />
                      <ToolBtn label="Нет" onClick={() => setConfirmDelete(false)} />
                    </>
                  ) : (
                    <ToolBtn label="Удалить" onClick={() => setConfirmDelete(true)} />
                  )}
                </>
              ) : (
                <ToolBtn label="Копия" onClick={openCopy} title="Встроенный отчёт не правится — создаётся копия" />
              )}
              <ToolBtn label="JSON" onClick={handleDownloadSpec} title="Скачать определение отчёта" />
            </div>
          )}
          <span style={{ width: 1, height: 22, background: 'var(--border-subtle)' }} />
          <div style={{ display: 'flex', gap: 6 }}>
            <ToolBtn label="Печать" title="Печать (Ctrl+P)" disabled={!hasRows} onClick={() => window.print()} />
            <ToolBtn label={busy === 'pdf' ? '…' : 'PDF'} disabled={!hasRows || !!busy} onClick={handlePdf} />
            <ToolBtn label={busy === 'xlsx' ? '…' : 'Excel'} disabled={!hasRows || !!busy} onClick={() => handleExport('xlsx')} />
            <ToolBtn label={busy === 'docx' ? '…' : 'Word'} disabled={!hasRows || !!busy} onClick={() => handleExport('docx')} />
            <ToolBtn label={busy === 'csv' ? '…' : 'CSV'} disabled={!hasRows || !!busy} onClick={() => handleExport('csv')} />
          </div>
          <button onClick={onBack} title="К шахматке (Esc)" style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.5rem',
            color: 'var(--text-faint)', padding: '0 4px', lineHeight: 1, fontWeight: 300,
          }}>×</button>
        </div>

        {definition && (
          <div className="report-toolbar" style={{
            padding: '14px 22px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
          }}>
            <ReportParams
              params={definition.params || []}
              values={values}
              onChange={handleChange}
              onPreset={handlePreset}
              disabled={loading}
            />
          </div>
        )}

        {error && (
          <div style={{
            margin: '14px 22px', padding: '10px 14px', borderRadius: 9,
            background: 'var(--surface-2)', border: '1px solid var(--border)',
            color: 'var(--s-overdue)', fontSize: '0.85rem',
          }}>{error}</div>
        )}

        {result && (
          <>
            <div className="report-toolbar" style={{
              display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
              padding: '8px 22px', fontSize: '0.78rem', color: 'var(--text-faint)', flexShrink: 0,
            }}>
              <span>{formatPeriod(result.params?.period)}</span>
              <span>строк: {result.meta.rowCount}</span>
              {result.meta.truncated && (
                <span style={{ color: 'var(--s-overdue)' }}>
                  показаны первые {result.meta.limit} — сузьте период или фильтры
                </span>
              )}
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '0 22px 18px' }}>
              <div style={{
                flex: 1, minHeight: 0, border: '1px solid var(--border)', borderRadius: 10,
                overflow: 'hidden', display: 'flex', background: 'var(--bg)',
              }}>
                <ReportTable result={result} totalsLabel={definition?.totalsLabel} />
              </div>
            </div>
          </>
        )}

        {!result && !error && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: '0.88rem' }}>
            {loading ? 'Считаем отчёт…' : reports.length ? 'Выберите отчёт' : canEdit ? 'Отчётов нет — создайте первый' : 'Отчётов нет'}
          </div>
        )}
      </div>
    </div>
  )
}
