import React, { useEffect, useState } from 'react'
import { fetchPartners, createPartner, updatePartner, deletePartner } from '../../../api/partners'
import type { Partner } from '../../../types'

const PRESET_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
  '#f97316', '#06b6d4', '#84cc16', '#a855f7',
]

const DAYS = ['Любой', 'Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

interface FormState {
  name: string
  color: string
  defaultCheckInDay: number | null
  defaultNights: number
  commissionPercent: string
  contactPerson: string
  contactPhone: string
  notes: string
}

const emptyForm = (): FormState => ({
  name: '',
  color: PRESET_COLORS[0],
  defaultCheckInDay: null,
  defaultNights: 7,
  commissionPercent: '',
  contactPerson: '',
  contactPhone: '',
  notes: '',
})

export const PartnersSection: React.FC = () => {
  const [partners, setPartners] = useState<Partner[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    fetchPartners().then(p => { setPartners(p); setLoading(false) }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const startEdit = (p?: Partner) => {
    if (p) {
      setEditId(p.id)
      setForm({
        name: p.name,
        color: p.color,
        defaultCheckInDay: p.defaultCheckInDay,
        defaultNights: p.defaultNights,
        commissionPercent: p.commissionPercent != null ? String(p.commissionPercent) : '',
        contactPerson: p.contactPerson ?? '',
        contactPhone: p.contactPhone ?? '',
        notes: p.notes ?? '',
      })
    } else {
      setEditId('new')
      setForm(emptyForm())
    }
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    try {
      const payload = {
        name: form.name,
        color: form.color,
        defaultCheckInDay: form.defaultCheckInDay,
        defaultNights: form.defaultNights,
        commissionPercent: form.commissionPercent.trim() ? Number(form.commissionPercent) : null,
        contactPerson: form.contactPerson,
        contactPhone: form.contactPhone,
        notes: form.notes,
      }
      if (editId === 'new') await createPartner(payload)
      else if (typeof editId === 'number') await updatePartner(editId, payload)
      setEditId(null)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить партнёра? Все его квоты также будут удалены.')) return
    try {
      await deletePartner(id)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }}>
      <header>
        <div style={{ fontSize: '1.38rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          Партнёры (бюро путешествий)
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          Бюро путешествий и онлайн-агрегаторы, с которыми работаете по квотам.
          После добавления партнёра — закрепите за ним номера в разделе «Квоты».
        </div>
      </header>

      <button
        onClick={() => startEdit()}
        disabled={editId !== null}
        style={addBtnStyle(editId !== null)}
      >
        + Добавить партнёра
      </button>

      {editId !== null && (
        <div style={cardStyle}>
          <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 14 }}>
            {editId === 'new' ? 'Новый партнёр' : 'Редактирование'}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Название">
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Anytur"
                style={inputStyle}
              />
            </Field>

            <Field label="Цвет">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm({ ...form, color: c })}
                    style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: c, cursor: 'pointer',
                      border: form.color === c ? '3px solid var(--text)' : '1px solid var(--border)',
                    }}
                  />
                ))}
              </div>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="День заезда (по умолч.)">
                <select
                  value={form.defaultCheckInDay ?? -1}
                  onChange={e => {
                    const v = Number(e.target.value)
                    setForm({ ...form, defaultCheckInDay: v < 0 ? null : v })
                  }}
                  style={inputStyle}
                >
                  {DAYS.map((d, idx) => (
                    <option key={d} value={idx === 0 ? -1 : idx - 1}>{d}</option>
                  ))}
                </select>
              </Field>
              <Field label="Длительность (ночей)">
                <input
                  type="number"
                  min={1} max={60}
                  value={form.defaultNights}
                  onChange={e => setForm({ ...form, defaultNights: Math.max(1, Number(e.target.value) || 7) })}
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field label="Комиссия (%) — опционально">
              <input
                type="number"
                min={0} max={100} step={0.1}
                value={form.commissionPercent}
                onChange={e => setForm({ ...form, commissionPercent: e.target.value })}
                placeholder="15"
                style={inputStyle}
              />
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="Контактное лицо">
                <input
                  value={form.contactPerson}
                  onChange={e => setForm({ ...form, contactPerson: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="Телефон">
                <input
                  value={form.contactPhone}
                  onChange={e => setForm({ ...form, contactPhone: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field label="Примечания">
              <textarea
                rows={2}
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </Field>

            {error && (
              <div style={{ color: '#dc2626', fontSize: '0.92rem' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditId(null)} style={secondaryBtnStyle}>Отмена</button>
              <button onClick={save} style={primaryBtnStyle}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : partners.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: 30 }}>
          Партнёров пока нет
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {partners.map(p => (
            <div key={p.id} style={{
              display: 'flex', alignItems: 'center', gap: 12,
              padding: '10px 14px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
            }}>
              <div style={{
                width: 14, height: 14, borderRadius: 4,
                background: p.color, flexShrink: 0,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '1rem', fontWeight: 700 }}>{p.name}</div>
                <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>
                  {p.defaultCheckInDay != null ? `${DAYS[p.defaultCheckInDay + 1]} — ` : 'Любой день — '}
                  {p.defaultNights} {p.defaultNights === 1 ? 'ночь' : p.defaultNights < 5 ? 'ночи' : 'ночей'}
                  {p.commissionPercent != null && <> · комиссия {p.commissionPercent}%</>}
                  {p._count && <> · квот: {p._count.allotments} · броней: {p._count.bookings}</>}
                </div>
              </div>
              <button onClick={() => startEdit(p)} style={ghostBtnStyle}>Изм.</button>
              <button onClick={() => remove(p.id)} style={dangerBtnStyle}>Удалить</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Sub ──────────────────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-faint)' }}>{label}</label>
    {children}
  </div>
)

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', outline: 'none',
  background: 'var(--bg)', color: 'var(--text)',
  fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}

const cardStyle: React.CSSProperties = {
  padding: 16,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
}

const addBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 14px',
  background: disabled ? 'var(--surface-3)' : 'var(--accent)',
  color: disabled ? 'var(--text-faint)' : '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
  alignSelf: 'flex-start',
})

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}

const ghostBtnStyle: React.CSSProperties = {
  padding: '5px 10px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 6,
  fontSize: '0.88rem', cursor: 'pointer', color: 'var(--text-muted)',
}

const dangerBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle, color: '#dc2626', borderColor: '#fecaca',
}
