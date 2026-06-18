import React, { useState } from 'react'
import { useSettingsStore, BuildingItem } from '../../../store/useSettingsStore'

export const BuildingsSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const buildings = roomFund.buildings

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ name: '', description: '' })
  const [error, setError] = useState('')

  const startNew = () => {
    setEditId('new')
    setForm({ name: '', description: '' })
    setError('')
  }

  const startEdit = (b: BuildingItem) => {
    setEditId(b.id)
    setForm({ name: b.name, description: b.description })
    setError('')
  }

  const save = () => {
    if (!form.name.trim()) { setError('Введите название корпуса'); return }
    if (editId === 'new') {
      const newItem: BuildingItem = {
        id: Date.now().toString(),
        name: form.name.trim(),
        description: form.description.trim(),
      }
      setRoomFund({ buildings: [...buildings, newItem] })
    } else if (editId) {
      setRoomFund({
        buildings: buildings.map(b =>
          b.id === editId ? { ...b, name: form.name.trim(), description: form.description.trim() } : b
        ),
      })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить корпус?')) return
    setRoomFund({ buildings: buildings.filter(b => b.id !== id) })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: '#111827', marginBottom: 4 }}>Корпуса</div>
      <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 24 }}>
        Список корпусов отеля. Используются при создании номеров.
      </div>

      {buildings.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '1rem', background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb' }}>
          Корпуса не добавлены
        </div>
      )}

      {buildings.map(b => (
        <div key={b.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: '#f9fafb',
          borderRadius: 8, border: '1px solid #e5e7eb',
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>{b.name}</div>
            {b.description && <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginTop: 2 }}>{b.description}</div>}
          </div>
          <button onClick={() => startEdit(b)} style={iconBtn} title="Редактировать">✎</button>
          <button onClick={() => remove(b.id)} style={{ ...iconBtn, color: '#dc2626' }} title="Удалить">✕</button>
        </div>
      ))}

      {editId !== null && (
        <div style={{
          padding: 14, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новый корпус' : 'Редактировать корпус'}
          </div>
          <div>
            <label style={labelStyle}>Название *</label>
            <input
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Например: Корпус А"
              style={inputStyle}
              autoFocus
            />
          </div>
          <div>
            <label style={labelStyle}>Описание</label>
            <input
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="Необязательно"
              style={inputStyle}
            />
          </div>
          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={startNew} style={dashedBtn}>
        + Добавить корпус
      </button>
    </div>
  )
}

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.08rem',
  color: '#6b7280', padding: '2px 4px', borderRadius: 4, lineHeight: 1,
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
