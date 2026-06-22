import React, { useState } from 'react'
import { useSettingsStore, CapacityItem } from '../../../store/useSettingsStore'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

const guestWord = (n: number) => (n === 1 ? 'гость' : n >= 2 && n <= 4 ? 'гостя' : 'гостей')

export const CapacitiesSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const capacities = roomFund.capacities

  const [editId, setEditId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState({ label: '', value: 1 })
  const [error, setError] = useState('')

  const startNew = () => { setEditId('new'); setForm({ label: '', value: 1 }); setError('') }
  const startEdit = (c: CapacityItem) => { setEditId(c.id); setForm({ label: c.label, value: c.value }); setError('') }

  const save = () => {
    if (!form.label.trim()) { setError('Введите название'); return }
    if (form.value < 1) { setError('Минимум 1 гость'); return }
    if (editId === 'new') {
      const newItem: CapacityItem = { id: Date.now().toString(), label: form.label.trim(), value: form.value }
      setRoomFund({ capacities: [...capacities, newItem] })
    } else if (editId) {
      setRoomFund({ capacities: capacities.map(c => c.id === editId ? { ...c, label: form.label.trim(), value: form.value } : c) })
    }
    setEditId(null)
  }

  const remove = (id: string) => {
    if (!confirm('Удалить тип вместимости?')) return
    setRoomFund({ capacities: capacities.filter(c => c.id !== id) })
  }

  const Form = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 12 }}>
        <div>
          <label style={labelStyle}>Название</label>
          <input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} placeholder="Например: Одноместный" style={inputStyle} autoFocus />
        </div>
        <div>
          <label style={labelStyle}>Кол-во гостей</label>
          <input type="number" min={1} max={20} value={form.value} onChange={e => setForm(f => ({ ...f, value: Number(e.target.value) }))} style={inputStyle} />
        </div>
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
        title="Вместимость"
        subtitle="Типы вместимости номеров. Используются при создании и фильтрации комнат."
        action={<AddButton onClick={startNew} label="Добавить тип" />}
      />

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новый тип вместимости</div>
          {Form}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {capacities.length === 0 && <EmptyBox>Типы вместимости не добавлены</EmptyBox>}

        {capacities.map(c => (
          <div key={c.id}>
            <div style={listRow}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-bg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-text)',
              }} className="mono">{c.value}</div>
              <div style={{ flex: 1 }}>
                <div style={itemTitle}>{c.label}</div>
                <div style={itemSub}>{c.value} {guestWord(c.value)}</div>
              </div>
              <button onClick={() => startEdit(c)} style={iconBtn} title="Редактировать">✎</button>
              <button onClick={() => remove(c.id)} style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
            </div>
            {editId === c.id && <div style={{ ...formCard, marginTop: 6 }}>{Form}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
