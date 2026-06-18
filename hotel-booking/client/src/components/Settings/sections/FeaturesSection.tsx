import React, { useState } from 'react'
import { useSettingsStore, FeatureItem } from '../../../store/useSettingsStore'

export const FeaturesSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const features = roomFund.features

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ name: '', emoji: '' })
  const [error, setError] = useState('')

  const startNew = () => {
    setEditId('new')
    setForm({ name: '', emoji: '' })
    setError('')
  }

  const startEdit = (f: FeatureItem) => {
    setEditId(f.id)
    setForm({ name: f.name, emoji: f.emoji })
    setError('')
  }

  const save = () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    if (editId === 'new') {
      const newItem: FeatureItem = {
        id: Date.now().toString(),
        name: form.name.trim(),
        emoji: form.emoji.trim() || '✦',
      }
      setRoomFund({ features: [...features, newItem] })
    } else if (editId) {
      setRoomFund({
        features: features.map(f =>
          f.id === editId ? { ...f, name: form.name.trim(), emoji: form.emoji.trim() || '✦' } : f
        ),
      })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить особенность?')) return
    setRoomFund({ features: features.filter(f => f.id !== id) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: '#111827', marginBottom: 4 }}>Особенности</div>
      <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 24 }}>
        Удобства и особенности номеров. Отображаются при выборе характеристик комнаты.
      </div>

      {/* Grid of feature chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {features.map(f => (
          <div key={f.id} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', background: '#f9fafb',
            borderRadius: 20, border: '1px solid #e5e7eb',
          }}>
            <span style={{ fontSize: '1.23rem' }}>{f.emoji}</span>
            <span style={{ fontSize: '1rem', color: '#111827', fontWeight: 500 }}>{f.name}</span>
            <button onClick={() => startEdit(f)} style={{ ...chipIconBtn }} title="Редактировать">✎</button>
            <button onClick={() => remove(f.id)} style={{ ...chipIconBtn, color: '#dc2626' }} title="Удалить">✕</button>
          </div>
        ))}

        {features.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '1rem', background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb', width: '100%' }}>
            Особенности не добавлены
          </div>
        )}
      </div>

      {editId !== null && (
        <div style={{
          padding: 14, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новая особенность' : 'Редактировать'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Эмодзи</label>
              <input
                value={form.emoji}
                onChange={e => setForm({ ...form, emoji: e.target.value })}
                placeholder="🪟"
                style={{ ...inputStyle, textAlign: 'center', fontSize: '1.38rem' }}
                maxLength={4}
              />
            </div>
            <div>
              <label style={labelStyle}>Название *</label>
              <input
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="Например: Балкон"
                style={inputStyle}
                autoFocus
              />
            </div>
          </div>
          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={startNew} style={dashedBtn}>
        + Добавить особенность
      </button>
    </div>
  )
}

const chipIconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.85rem',
  color: '#6b7280', padding: '1px 2px', borderRadius: 3, lineHeight: 1,
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb',
  borderRadius: 7, fontSize: '1rem', boxSizing: 'border-box', fontFamily: 'inherit', outline: 'none',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#6b7280', marginBottom: 4,
}

const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '8px 16px', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 7, fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  padding: '8px 16px', background: 'none', border: '1px solid #e5e7eb',
  borderRadius: 7, fontSize: '1rem', cursor: 'pointer', color: '#6b7280',
}

const dashedBtn: React.CSSProperties = {
  padding: '9px 0', background: 'none', border: '1px dashed #6366f1',
  borderRadius: 8, fontSize: '1rem', color: '#6366f1', cursor: 'pointer', fontWeight: 600,
}
