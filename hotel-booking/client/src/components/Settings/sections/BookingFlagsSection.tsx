import React, { useEffect, useState } from 'react'
import { useSettingsStore, BookingFlagItem, FlagEffects } from '../../../store/useSettingsStore'
import { fetchBookingFlags, createBookingFlag, updateBookingFlag, deleteBookingFlag } from '../../../api/bookingFlags'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

const emptyEffects = (): FlagEffects => ({ bufferAfter: 0, bufferBefore: 0, pin: false })

function effectsSummary(e?: FlagEffects): string {
  if (!e) return ''
  const parts: string[] = []
  if (e.bufferAfter) parts.push(`буфер после ${e.bufferAfter} дн.`)
  if (e.bufferBefore) parts.push(`буфер до ${e.bufferBefore} дн.`)
  if (e.pin) parts.push('не перемещать')
  return parts.join(' · ')
}

export const BookingFlagsSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const flags = roomFund.bookingFlags ?? []

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [label, setLabel] = useState('')
  const [effects, setEffects] = useState<FlagEffects>(emptyEffects())
  const [error, setError] = useState('')

  const reload = () => fetchBookingFlags().then(bookingFlags => setRoomFund({ bookingFlags })).catch(() => {})
  useEffect(() => { reload() }, [])

  const startNew = () => { setEditId('new'); setLabel(''); setEffects(emptyEffects()); setError('') }
  const startEdit = (f: BookingFlagItem) => { setEditId(f.id); setLabel(f.label); setEffects({ ...emptyEffects(), ...(f.effects ?? {}) }); setError('') }

  const save = async () => {
    if (!label.trim()) { setError('Введите название метки'); return }
    const eff: FlagEffects = {}
    if (effects.bufferAfter && effects.bufferAfter > 0) eff.bufferAfter = effects.bufferAfter
    if (effects.bufferBefore && effects.bufferBefore > 0) eff.bufferBefore = effects.bufferBefore
    if (effects.pin) eff.pin = true
    try {
      if (editId === 'new') await createBookingFlag({ label: label.trim(), effects: eff })
      else if (editId) await updateBookingFlag(editId, { label: label.trim(), effects: eff })
      setEditId(null)
      await reload()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить метку?')) return
    try { await deleteBookingFlag(id); await reload() } catch { alert('Не удалось удалить метку') }
  }

  const Form = (
    <>
      <div>
        <label style={labelStyle}>Название</label>
        <input value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} placeholder="Например: Выезд до 17:00" style={inputStyle} autoFocus />
      </div>

      <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Эффект для алгоритма
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>Зазор после, дн.</label>
            <input type="number" min={0} max={14} value={effects.bufferAfter ?? 0} onChange={e => setEffects({ ...effects, bufferAfter: Math.max(0, Number(e.target.value) || 0) })} style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Зазор до, дн.</label>
            <input type="number" min={0} max={14} value={effects.bufferBefore ?? 0} onChange={e => setEffects({ ...effects, bufferBefore: Math.max(0, Number(e.target.value) || 0) })} style={inputStyle} />
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.88rem', color: 'var(--text)' }}>
          <input type="checkbox" checked={!!effects.pin} onChange={e => setEffects({ ...effects, pin: e.target.checked })} style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }} />
          Не перемещать оптимизатором (VIP / спец-условия)
        </label>
      </div>

      {error && <div style={errorStyle}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
        <button onClick={save} style={primaryBtn}>Сохранить</button>
      </div>
    </>
  )

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Метки броней"
        subtitle="Пометки для броней (поздний выезд, долг…). При наличии метки блок отображается со штриховкой."
        action={<AddButton onClick={startNew} label="Добавить метку" />}
      />

      {editId === 'new' && <div style={formCard}><div style={formTitle}>Новая метка</div>{Form}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {flags.length === 0 && <EmptyBox>Метки не добавлены</EmptyBox>}

        {flags.map((f, idx) => (
          <div key={f.id}>
            <div style={listRow}>
              <span className="mono" style={{
                width: 22, height: 22, borderRadius: 6, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-faint)', flexShrink: 0,
              }}>{idx + 1}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={itemTitle}>{f.label}</div>
                {effectsSummary(f.effects) && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--accent-text)', fontWeight: 500, marginTop: 2 }}>⚙ {effectsSummary(f.effects)}</div>
                )}
              </div>
              <button onClick={() => startEdit(f)} style={iconBtn} title="Редактировать">✎</button>
              <button onClick={() => remove(f.id)} style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
            </div>
            {editId === f.id && <div style={{ ...formCard, marginTop: 6 }}>{Form}</div>}
          </div>
        ))}

        {/* Свободный текст — всегда последний слот */}
        <div style={{ ...listRow, border: '1px dashed var(--border-subtle)', background: 'transparent', color: 'var(--text-faint)' }}>
          <span style={{ width: 22, textAlign: 'center', flexShrink: 0 }}>✎</span>
          <span style={{ fontSize: '0.84rem' }}>Произвольный текст — вводится от руки в карточке брони</span>
        </div>
      </div>
    </div>
  )
}
