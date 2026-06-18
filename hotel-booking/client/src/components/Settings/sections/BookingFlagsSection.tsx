import React, { useEffect, useState } from 'react'
import { useSettingsStore, BookingFlagItem, FlagEffects } from '../../../store/useSettingsStore'
import { fetchBookingFlags, createBookingFlag, updateBookingFlag, deleteBookingFlag } from '../../../api/bookingFlags'

const emptyEffects = (): FlagEffects => ({ bufferAfter: 0, bufferBefore: 0, pin: false })

/** Краткое описание эффектов метки для списка. */
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

  // Перезагрузка меток из БД в стор
  const reload = () => fetchBookingFlags().then(bookingFlags => setRoomFund({ bookingFlags })).catch(() => {})
  useEffect(() => { reload() }, [])

  const startNew = () => {
    setEditId('new')
    setLabel('')
    setEffects(emptyEffects())
    setError('')
  }

  const startEdit = (f: BookingFlagItem) => {
    setEditId(f.id)
    setLabel(f.label)
    setEffects({ ...emptyEffects(), ...(f.effects ?? {}) })
    setError('')
  }

  const save = async () => {
    if (!label.trim()) { setError('Введите название метки'); return }
    const eff: FlagEffects = {}
    if (effects.bufferAfter && effects.bufferAfter > 0) eff.bufferAfter = effects.bufferAfter
    if (effects.bufferBefore && effects.bufferBefore > 0) eff.bufferBefore = effects.bufferBefore
    if (effects.pin) eff.pin = true

    try {
      if (editId === 'new') {
        await createBookingFlag({ label: label.trim(), effects: eff })
      } else if (editId) {
        await updateBookingFlag(editId, { label: label.trim(), effects: eff })
      }
      setEditId(null)
      await reload()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Удалить метку?')) return
    try {
      await deleteBookingFlag(id)
      await reload()
    } catch {
      alert('Не удалось удалить метку')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
        Метки броней
      </div>
      <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: 24 }}>
        Особые пометки для броней — выезд до/после 17:00, долг и т.д.
        При наличии метки блок брони отображается со штриховкой.
        Последний вариант в списке всегда позволяет ввести текст от руки.
      </div>

      {/* List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {flags.map((f, idx) => (
          <div key={f.id} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--ui-radius)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{
                width: 22, height: 22, borderRadius: 4,
                background: 'var(--surface-3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.77rem', fontWeight: 700, color: 'var(--text-faint)',
                flexShrink: 0,
              }}>{idx + 1}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={{ fontSize: '1rem', fontWeight: 500, color: 'var(--text)' }}>
                  {f.label}
                </span>
                {effectsSummary(f.effects) && (
                  <span style={{ fontSize: '0.8rem', color: 'var(--accent-text)', fontWeight: 600 }}>
                    ⚙ {effectsSummary(f.effects)}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => startEdit(f)} style={iconBtn} title="Редактировать">✎</button>
              <button onClick={() => remove(f.id)} style={{ ...iconBtn, color: '#dc2626' }} title="Удалить">✕</button>
            </div>
          </div>
        ))}

        {/* Free-text slot — always last, not editable, just indicator */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 14px',
          background: 'var(--surface)',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--ui-radius)',
          color: 'var(--text-faint)',
          fontSize: '1rem',
        }}>
          <span style={{
            width: 22, height: 22, borderRadius: 4,
            background: 'var(--surface-3)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '0.77rem', fontWeight: 700, color: 'var(--text-faint)',
            flexShrink: 0,
          }}>✎</span>
          <span>Произвольный текст — вводится от руки в карточке брони</span>
        </div>
      </div>

      {flags.length === 0 && (
        <div style={{
          padding: 24, textAlign: 'center', color: 'var(--text-faint)',
          background: 'var(--surface)', borderRadius: 8,
          border: '1px dashed var(--border)', fontSize: '1rem',
        }}>
          Метки не добавлены
        </div>
      )}

      {/* Edit form */}
      {editId !== null && (
        <div style={{
          padding: 14, background: 'var(--bg)',
          border: '2px solid var(--accent)',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>
            {editId === 'new' ? 'Новая метка' : 'Редактировать метку'}
          </div>
          <div>
            <label style={labelStyle}>Название *</label>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && save()}
              placeholder="Например: Выезд до 17:00"
              style={inputStyle}
              autoFocus
            />
          </div>

          {/* Эффекты для алгоритма */}
          <div style={{
            borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 2,
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Что метка делает для алгоритма
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>Зазор ПОСЛЕ (дней)</label>
                <input
                  type="number" min={0} max={14}
                  value={effects.bufferAfter ?? 0}
                  onChange={e => setEffects({ ...effects, bufferAfter: Math.max(0, Number(e.target.value) || 0) })}
                  style={inputStyle}
                />
                <div style={hintStyle}>Напр. «поздний выезд» = 1 → нельзя бронь день-в-день после</div>
              </div>
              <div>
                <label style={labelStyle}>Зазор ДО (дней)</label>
                <input
                  type="number" min={0} max={14}
                  value={effects.bufferBefore ?? 0}
                  onChange={e => setEffects({ ...effects, bufferBefore: Math.max(0, Number(e.target.value) || 0) })}
                  style={inputStyle}
                />
                <div style={hintStyle}>Напр. «раннее заселение» = 1</div>
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: '0.95rem', color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={!!effects.pin}
                onChange={e => setEffects({ ...effects, pin: e.target.checked })}
                style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
              />
              Не перемещать оптимизатором (VIP / спец-условия)
            </label>
          </div>

          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={startNew} style={dashedBtn}>
        + Добавить метку
      </button>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.92rem',
  color: 'var(--text-faint)', padding: '3px 5px', borderRadius: 4, lineHeight: 1,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: '1rem', boxSizing: 'border-box',
  fontFamily: 'inherit', outline: 'none',
  background: 'var(--bg)', color: 'var(--text)',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.85rem', fontWeight: 600,
  color: 'var(--text-faint)', marginBottom: 4,
}

const hintStyle: React.CSSProperties = {
  fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.3,
}

const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '8px 16px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  padding: '8px 16px', background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: '1rem', cursor: 'pointer', color: 'var(--text-muted)',
}

const dashedBtn: React.CSSProperties = {
  padding: '9px 0', background: 'none',
  border: '1px dashed var(--accent)',
  borderRadius: 'var(--ui-radius)', fontSize: '1rem',
  color: 'var(--accent)', cursor: 'pointer', fontWeight: 600,
}
