import React, { useState } from 'react'
import { useSettingsStore, FeatureItem } from '../../../store/useSettingsStore'
import {
  SectionHeader, AddButton, EmptyBox, formCard, formTitle,
  inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

export const FeaturesSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const features = roomFund.features

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ name: '', emoji: '' })
  const [error, setError] = useState('')

  const startNew = () => { setEditId('new'); setForm({ name: '', emoji: '' }); setError('') }
  const startEdit = (f: FeatureItem) => { setEditId(f.id); setForm({ name: f.name, emoji: f.emoji }); setError('') }

  const save = () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    const emoji = form.emoji.trim() || '✦'
    if (editId === 'new') {
      const newItem: FeatureItem = { id: Date.now().toString(), name: form.name.trim(), emoji }
      setRoomFund({ features: [...features, newItem] })
    } else if (editId) {
      setRoomFund({ features: features.map(f => f.id === editId ? { ...f, name: form.name.trim(), emoji } : f) })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить особенность?')) return
    setRoomFund({ features: features.filter(f => f.id !== id) })
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Особенности"
        subtitle="Удобства и особенности номеров. Отображаются при выборе характеристик комнаты."
        action={<AddButton onClick={startNew} label="Добавить особенность" />}
      />

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новая особенность</div>
          <FeatureFields form={form} setForm={setForm} />
          {error && <div style={errorStyle}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {features.length === 0 && <EmptyBox>Особенности не добавлены</EmptyBox>}
        {features.map(f => (
          <div key={f.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px',
            background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: '1.1rem' }}>{f.emoji}</span>
            <span style={{ fontSize: '0.88rem', color: 'var(--text)', fontWeight: 500 }}>{f.name}</span>
            <button onClick={() => startEdit(f)} style={chipIconBtn} title="Редактировать">✎</button>
            <button onClick={() => remove(f.id)} style={{ ...chipIconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
          </div>
        ))}
      </div>

      {editId !== null && editId !== 'new' && (
        <div style={{ ...formCard, marginTop: 12 }}>
          <div style={formTitle}>Редактировать особенность</div>
          <FeatureFields form={form} setForm={setForm} />
          {error && <div style={errorStyle}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
          </div>
        </div>
      )}
    </div>
  )
}

const FeatureFields: React.FC<{ form: { name: string; emoji: string }; setForm: React.Dispatch<React.SetStateAction<{ name: string; emoji: string }>> }> = ({ form, setForm }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 12 }}>
    <div>
      <label style={labelStyle}>Эмодзи</label>
      <input value={form.emoji} onChange={e => setForm(f => ({ ...f, emoji: e.target.value }))} placeholder="🪟" maxLength={4} style={{ ...inputStyle, textAlign: 'center', fontSize: '1.2rem' }} />
    </div>
    <div>
      <label style={labelStyle}>Название</label>
      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Например: Балкон" style={inputStyle} autoFocus />
    </div>
  </div>
)

const chipIconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem',
  color: 'var(--text-faint)', padding: '1px 2px', borderRadius: 3, lineHeight: 1,
}
