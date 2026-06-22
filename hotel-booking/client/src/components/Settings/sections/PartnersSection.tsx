import React, { useEffect, useState } from 'react'
import { fetchPartners, createPartner, updatePartner, deletePartner } from '../../../api/partners'
import type { Partner } from '../../../types'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

const PRESET_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
  '#f97316', '#06b6d4', '#84cc16', '#a855f7',
]

const DAYS = ['Любой', 'Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']
const nightsWord = (n: number) => (n === 1 ? 'ночь' : n < 5 ? 'ночи' : 'ночей')

interface FormState {
  name: string; color: string; defaultCheckInDay: number | null; defaultNights: number
  commissionPercent: string; contactPerson: string; contactPhone: string; notes: string
}

const emptyForm = (): FormState => ({
  name: '', color: PRESET_COLORS[0], defaultCheckInDay: null, defaultNights: 7,
  commissionPercent: '', contactPerson: '', contactPhone: '', notes: '',
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
        name: p.name, color: p.color, defaultCheckInDay: p.defaultCheckInDay, defaultNights: p.defaultNights,
        commissionPercent: p.commissionPercent != null ? String(p.commissionPercent) : '',
        contactPerson: p.contactPerson ?? '', contactPhone: p.contactPhone ?? '', notes: p.notes ?? '',
      })
    } else { setEditId('new'); setForm(emptyForm()) }
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    try {
      const payload = {
        name: form.name, color: form.color, defaultCheckInDay: form.defaultCheckInDay, defaultNights: form.defaultNights,
        commissionPercent: form.commissionPercent.trim() ? Number(form.commissionPercent) : null,
        contactPerson: form.contactPerson, contactPhone: form.contactPhone, notes: form.notes,
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
    try { await deletePartner(id); load() }
    catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  const Form = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Название"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Anytur" style={inputStyle} autoFocus /></Field>
        <Field label="Комиссия, %"><input type="number" min={0} max={100} step={0.1} value={form.commissionPercent} onChange={e => setForm({ ...form, commissionPercent: e.target.value })} placeholder="—" style={inputStyle} /></Field>
      </div>

      <Field label="Цвет">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {PRESET_COLORS.map(c => (
            <button key={c} type="button" onClick={() => setForm({ ...form, color: c })} style={{
              width: 26, height: 26, borderRadius: 7, background: c, cursor: 'pointer',
              border: form.color === c ? '2px solid var(--text)' : '1px solid var(--border-subtle)',
            }} />
          ))}
        </div>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="День заезда (по умолч.)">
          <select value={form.defaultCheckInDay ?? -1} onChange={e => { const v = Number(e.target.value); setForm({ ...form, defaultCheckInDay: v < 0 ? null : v }) }} style={inputStyle}>
            {DAYS.map((d, idx) => <option key={d} value={idx === 0 ? -1 : idx - 1}>{d}</option>)}
          </select>
        </Field>
        <Field label="Ночей (по умолч.)"><input type="number" min={1} max={60} value={form.defaultNights} onChange={e => setForm({ ...form, defaultNights: Math.max(1, Number(e.target.value) || 7) })} style={inputStyle} /></Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Контактное лицо"><input value={form.contactPerson} onChange={e => setForm({ ...form, contactPerson: e.target.value })} style={inputStyle} /></Field>
        <Field label="Телефон"><input value={form.contactPhone} onChange={e => setForm({ ...form, contactPhone: e.target.value })} style={inputStyle} /></Field>
      </div>

      <Field label="Примечания"><textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, height: 'auto', padding: '8px 12px', resize: 'vertical' }} /></Field>

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
        title="Партнёры"
        subtitle="Бюро и агрегаторы, с которыми работаете по квотам."
        action={<AddButton onClick={() => startEdit()} label="Добавить партнёра" />}
      />

      {editId === 'new' && <div style={formCard}><div style={formTitle}>Новый партнёр</div>{Form}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {partners.length === 0 && <EmptyBox>Партнёров пока нет</EmptyBox>}
          {partners.map(p => (
            <div key={p.id}>
              <div style={listRow}>
                <div style={{ width: 14, height: 14, borderRadius: 4, background: p.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={itemTitle}>{p.name}</div>
                  <div style={itemSub}>
                    {p.defaultCheckInDay != null ? `${DAYS[p.defaultCheckInDay + 1]} · ` : 'Любой день · '}
                    {p.defaultNights} {nightsWord(p.defaultNights)}
                    {p.commissionPercent != null && ` · ${p.commissionPercent}%`}
                    {p._count && ` · квот ${p._count.allotments} · броней ${p._count.bookings}`}
                  </div>
                </div>
                <button onClick={() => startEdit(p)} style={iconBtn} title="Редактировать">✎</button>
                <button onClick={() => remove(p.id)} style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
              </div>
              {editId === p.id && <div style={{ ...formCard, marginTop: 6 }}>{Form}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={labelStyle}>{label}</label>
    {children}
  </div>
)
