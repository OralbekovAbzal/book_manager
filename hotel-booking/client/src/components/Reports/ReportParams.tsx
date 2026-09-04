import React from 'react'
import type { ReportParamDef } from '../../api/reports'

/**
 * Панель параметров отчёта — рисуется ПО ОПРЕДЕЛЕНИЮ, а не по конкретному отчёту.
 * Тот же компонент покажет параметры отчёта, собранного в конструкторе или
 * загруженного импортом, поэтому здесь нет ни одного упоминания «загрузки»
 * или «реестра».
 */

const PRESET_LABELS: Record<string, string> = {
  today: 'Сегодня',
  last7: '7 дней',
  last30: '30 дней',
  currentMonth: 'Этот месяц',
  prevMonth: 'Прошлый месяц',
  currentYear: 'Этот год',
  prevYear: 'Прошлый год',
}

interface Props {
  params: ReportParamDef[]
  values: Record<string, any>
  onChange: (key: string, value: any) => void
  /** Клик по пресету периода: даты считает сервер, от даты смены. */
  onPreset: (key: string, preset: string) => void
  disabled?: boolean
}

const fieldWrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 5 }

const labelSt: React.CSSProperties = {
  fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.04em',
  textTransform: 'uppercase', color: 'var(--text-faint)',
}

const controlSt: React.CSSProperties = {
  height: 34, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 8,
  fontSize: '0.85rem', fontFamily: 'inherit', background: 'var(--bg)', color: 'var(--text)',
  outline: 'none', boxSizing: 'border-box',
}

const Chip: React.FC<{
  active: boolean; onClick: () => void; children: React.ReactNode; disabled?: boolean
}> = ({ active, onClick, children, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    style={{
      height: 28, padding: '0 11px', borderRadius: 7, cursor: disabled ? 'default' : 'pointer',
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      background: active ? 'var(--accent-bg)' : 'var(--bg)',
      color: active ? 'var(--accent-text)' : 'var(--text-muted)',
      fontSize: '0.79rem', fontWeight: active ? 600 : 500, fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    }}
  >{children}</button>
)

export const ReportParams: React.FC<Props> = ({ params, values, onChange, onPreset, disabled }) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 14 }}>
    {params.map((p) => {
      const value = values[p.key]

      if (p.type === 'dateRange') {
        const range = value || {}
        return (
          <div key={p.key} style={{ ...fieldWrap, gap: 6 }}>
            <span style={labelSt}>{p.label}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input
                type="date"
                value={range.from || ''}
                disabled={disabled}
                onChange={(e) => onChange(p.key, { ...range, from: e.target.value })}
                style={{ ...controlSt, width: 148 }}
              />
              <span style={{ color: 'var(--text-faint)' }}>—</span>
              <input
                type="date"
                value={range.to || ''}
                disabled={disabled}
                onChange={(e) => onChange(p.key, { ...range, to: e.target.value })}
                style={{ ...controlSt, width: 148 }}
              />
              {(p.presets || []).map((preset) => (
                <Chip key={preset} active={false} disabled={disabled} onClick={() => onPreset(p.key, preset)}>
                  {PRESET_LABELS[preset] || preset}
                </Chip>
              ))}
            </div>
          </div>
        )
      }

      if (p.type === 'multiselect') {
        const list: any[] = Array.isArray(value) ? value : []
        const toggle = (v: any) => onChange(
          p.key,
          list.includes(v) ? list.filter((x) => x !== v) : [...list, v],
        )
        return (
          <div key={p.key} style={{ ...fieldWrap, gap: 6 }}>
            <span style={labelSt}>{p.label}</span>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {(p.options || []).map((o) => (
                <Chip key={String(o.value)} active={list.includes(o.value)} disabled={disabled} onClick={() => toggle(o.value)}>
                  {o.label}
                </Chip>
              ))}
            </div>
          </div>
        )
      }

      if (p.type === 'select') {
        return (
          <div key={p.key} style={fieldWrap} title={p.hint}>
            <span style={labelSt}>{p.label}</span>
            <select
              value={value ?? ''}
              disabled={disabled}
              onChange={(e) => onChange(p.key, e.target.value === '' ? null : e.target.value)}
              style={{ ...controlSt, minWidth: 150, cursor: 'pointer' }}
            >
              {/* Пустой пункт («Все») — только у фильтров без умолчания. У режимов
                  вроде «Период считать» он был бы третьим, бессмысленным состоянием. */}
              {!p.required && p.default === undefined && <option value="">{p.placeholder || 'Все'}</option>}
              {(p.options || []).map((o) => (
                <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          </div>
        )
      }

      if (p.type === 'boolean') {
        return (
          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 7, height: 34, fontSize: '0.85rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!value}
              disabled={disabled}
              onChange={(e) => onChange(p.key, e.target.checked)}
            />
            {p.label}
          </label>
        )
      }

      return (
        <div key={p.key} style={fieldWrap}>
          <span style={labelSt}>{p.label}</span>
          <input
            type={p.type === 'number' ? 'number' : 'text'}
            value={value ?? ''}
            placeholder={p.placeholder}
            disabled={disabled}
            onChange={(e) => onChange(p.key, e.target.value)}
            style={{ ...controlSt, width: 170 }}
          />
        </div>
      )
    })}
  </div>
)
