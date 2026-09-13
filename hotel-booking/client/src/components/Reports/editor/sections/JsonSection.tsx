import React, { useEffect, useRef, useState } from 'react'
import type { ReportSpec } from '../../../../api/reports'
import { Row, Hint } from '../ui'
import { specToJson, parseSpec, readJsonFile, downloadSpec } from '../model'

interface Props {
  spec: ReportSpec
  onApply: (next: ReportSpec) => void
}

const btn: React.CSSProperties = {
  height: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer',
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text-muted)',
  fontSize: '0.79rem', fontWeight: 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
}

/**
 * Определение как текст. Это тот же объект, что собирает конструктор, поэтому
 * сложный отчёт можно подготовить снаружи (в том числе попросить его у ИИ),
 * вставить сюда — и дальше править обычной формой.
 */
export const JsonSection: React.FC<Props> = ({ spec, onApply }) => {
  const [text, setText] = useState(() => specToJson(spec))
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const dirty = text !== specToJson(spec)

  // Конструктор изменил определение, а текст здесь не трогали — подтягиваем
  useEffect(() => { if (!dirty) setText(specToJson(spec)) }, [spec])

  const apply = () => {
    try {
      onApply(parseSpec(text))
      setError('')
      setNote('Применено')
    } catch (err: any) {
      setError(err?.message || 'Не удалось разобрать JSON')
    }
  }

  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setNote('Скопировано') } catch { setNote('Буфер обмена недоступен') }
  }

  const load = async (file: File | undefined) => {
    if (!file) return
    try {
      const parsed = await readJsonFile(file)
      setText(specToJson(parsed))
      onApply(parsed)
      setError('')
      setNote(`Загружено: ${file.name}`)
    } catch (err: any) {
      setError(err?.message || 'Не удалось прочитать файл')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', flex: 1, minHeight: 0 }}>
      <Hint>Правки применяются кнопкой «Применить». Сохранение отчёта — в шапке.</Hint>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setNote('') }}
        spellCheck={false}
        className="mono"
        style={{
          flex: 1, minHeight: 320, width: '100%', boxSizing: 'border-box', resize: 'vertical',
          padding: 10, border: `1px solid ${error ? 'var(--s-overdue)' : 'var(--border)'}`, borderRadius: 8,
          background: 'var(--bg)', color: 'var(--text)', fontSize: '0.76rem', lineHeight: 1.45, outline: 'none',
        }}
      />
      {error && <div style={{ fontSize: '0.8rem', color: 'var(--s-overdue)' }}>{error}</div>}
      <Row align="center">
        <button type="button" onClick={apply} disabled={!dirty} style={{ ...btn, opacity: dirty ? 1 : 0.5, borderColor: dirty ? 'var(--accent)' : undefined, color: dirty ? 'var(--accent-text)' : undefined, fontWeight: 600 }}>Применить</button>
        <button type="button" onClick={copy} style={btn}>Скопировать</button>
        <button
          type="button"
          // `downloadSpec` теперь бросает при отказе сохранения (диск полон, папка только
          // на чтение) — без ловца ошибка уходила в консоль, а человек не видел ничего (R13-C-002).
          onClick={() => { setError(''); setNote(''); downloadSpec(spec).then((r) => { if (r && !r.canceled) setNote('Файл сохранён') }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Не удалось сохранить файл')) }}
          style={btn}
        >Скачать файл</button>
        <button type="button" onClick={() => fileRef.current?.click()} style={btn}>Загрузить из файла</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => load(e.target.files?.[0])} />
        {note && <span style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>{note}</span>}
      </Row>
    </div>
  )
}
