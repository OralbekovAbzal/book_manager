import React, { useState } from 'react'
import { useSettingsStore, CapacityItem } from '../../../store/useSettingsStore'

export const CapacitiesSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const capacities = roomFund.capacities

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ label: '', value: 1 })
  const [error, setError] = useState('')

  const startNew = () => {
    setEditId('new')
    setForm({ label: '', value: 1 })
    setError('')
  }

  const startEdit = (c: CapacityItem) => {
    setEditId(c.id)
    setForm({ label: c.label, value: c.value })
    setError('')
  }

  const save = () => {
    if (!form.label.trim()) { setError('Введите название'); return }
    if (form.value < 1) { setError('Минимум 1 гость'); return }
    if (editId === 'new') {
      const newItem: CapacityItem = {
        id: Date.now().toString(),
        label: form.label.trim(),
        value: form.value,
      }
      setRoomFund({ capacities: [...capacities, newItem] })
    } else if (editId) {
      setRoomFund({
        capacities: capacities.map(c =>
          c.id === editId ? { ...c, label: form.label.trim(), value: form.value } : c
        ),
      })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить тип вместимости?')) return
    setRoomFund({ capacities: capacities.filter(c => c.id !== id) })
  }

  const guestWord = (n: number) => {
    if (n === 1) return 'гость'
    if (n >= 2 && n <= 4) return 'гостя'
    return 'гостей'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: '#111827', marginBottom: 4 }}>Вместимость</div>
      <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 24 }}>
        Типы вместимости номеров. Используются при создании и фильтрации комнат.
      </div>

      {capacities.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '1rem', background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb' }}>
          Типы вместимости не добавлены
        </div>
      )}

      {capacities.map(c => (
        <div key={c.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: '#f9fafb',
          borderRadius: 8, border: '1px solid #e5e7eb',
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: '#eef2ff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: '1.08rem', fontWeight: 700, color: '#6366f1', flexShrink: 0,
          }}>
            {c.value}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>{c.label}</div>
            <div style={{ fontSize: '0.85rem', color: '#9ca3af' }}>{c.value} {guestWord(c.value)}</div>
          </div>
          <button onClick={() => startEdit(c)} style={iconBtn} title="Редактировать">✎</button>
          <button onClick={() => remove(c.id)} style={{ ...iconBtn, color: '#dc2626' }} title="Удалить">✕</button>
        </div>
      ))}

      {editId !== null && (
        <div style={{
          padding: 14, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новый тип вместимости' : 'Редактировать'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8 }}>
            <div>
              <label style={labelStyle}>Название *</label>
              <input
                value={form.label}
                onChange={e => setForm({ ...form, label: e.target.value })}
                placeholder="Например: Одноместный"
                style={inputStyle}
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Кол-во гостей *</label>
              <input
                type="number"
                min={1}
                max={20}
                value={form.value}
                onChange={e => setForm({ ...form, value: Number(e.target.value) })}
                style={inputStyle}
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
        + Добавить тип вместимости
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
