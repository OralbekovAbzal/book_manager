import React, { useState } from 'react'
import { useSettingsStore, BuildingItem } from '../../../store/useSettingsStore'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

export const BuildingsSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const buildings = roomFund.buildings

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ name: '', description: '' })
  const [error, setError] = useState('')

  const startNew = () => { setEditId('new'); setForm({ name: '', description: '' }); setError('') }
  const startEdit = (b: BuildingItem) => { setEditId(b.id); setForm({ name: b.name, description: b.description }); setError('') }

  const save = () => {
    if (!form.name.trim()) { setError('Введите название корпуса'); return }
    if (editId === 'new') {
      const newItem: BuildingItem = { id: Date.now().toString(), name: form.name.trim(), description: form.description.trim() }
      setRoomFund({ buildings: [...buildings, newItem] })
    } else if (editId) {
      setRoomFund({ buildings: buildings.map(b => b.id === editId ? { ...b, name: form.name.trim(), description: form.description.trim() } : b) })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить корпус?')) return
    setRoomFund({ buildings: buildings.filter(b => b.id !== id) })
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Корпуса"
        subtitle="Список корпусов отеля. Используются при создании номеров."
        action={<AddButton onClick={startNew} label="Добавить корпус" />}
      />

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новый корпус</div>
          <BuildingFields form={form} setForm={setForm} />
          {error && <div style={errorStyle}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {buildings.length === 0 && <EmptyBox>Корпуса не добавлены</EmptyBox>}

        {buildings.map(b => (
          <div key={b.id}>
            <div style={listRow}>
              <div style={{ flex: 1 }}>
                <div style={itemTitle}>{b.name}</div>
                {b.description && <div style={itemSub}>{b.description}</div>}
              </div>
              <button onClick={() => startEdit(b)} style={iconBtn} title="Редактировать">✎</button>
              <button onClick={() => remove(b.id)} style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
            </div>
            {editId === b.id && (
              <div style={{ ...formCard, marginTop: 6 }}>
                <BuildingFields form={form} setForm={setForm} />
                {error && <div style={errorStyle}>{error}</div>}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
                  <button onClick={save} style={primaryBtn}>Сохранить</button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const BuildingFields: React.FC<{ form: { name: string; description: string }; setForm: React.Dispatch<React.SetStateAction<{ name: string; description: string }>> }> = ({ form, setForm }) => (
  <>
    <div>
      <label style={labelStyle}>Название</label>
      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Например: Корпус А" style={inputStyle} autoFocus />
    </div>
    <div>
      <label style={labelStyle}>Описание</label>
      <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Необязательно" style={inputStyle} />
    </div>
  </>
)
