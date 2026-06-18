import React, { useEffect, useState } from 'react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { fetchCategories, CategoryWithCount } from '../../../api/categories'
import { fetchAllRooms, createRoom, updateRoom, deactivateRoom } from '../../../api/roomsAdmin'
import { compareRooms, naturalCompare } from '../../../utils/sortRooms'
import type { Room } from '../../../types'

export const RoomsSection: React.FC = () => {
  const { roomFund } = useSettingsStore()
  const { buildings, features, capacities } = roomFund

  const [rooms, setRooms] = useState<Room[]>([])
  const [cats, setCats] = useState<CategoryWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [form, setForm] = useState({
    number: '',
    categoryId: 0,
    building: '',
    floor: 1,
    features: [] as string[],
    capacity: '',
  })
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    Promise.all([
      fetchAllRooms(showInactive ? {} : { isActive: true }),
      fetchCategories(),
    ])
      .then(([r, c]) => { setRooms(r); setCats(c); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [showInactive])

  const startNew = () => {
    setEditId('new')
    setForm({
      number: '',
      categoryId: cats[0]?.id ?? 0,
      building: buildings[0]?.name ?? '',
      floor: 1,
      features: [],
      capacity: capacities[0]?.id ?? '',
    })
    setError('')
  }

  const startEdit = (room: Room) => {
    setEditId(room.id)
    setForm({
      number: room.number,
      categoryId: room.category.id,
      building: room.building,
      floor: room.floor,
      features: [...room.features],
      capacity: room.capacity ?? '',
    })
    setError('')
  }

  const save = async () => {
    if (!form.number.trim()) { setError('Введите номер комнаты'); return }
    if (!form.building.trim()) { setError('Введите корпус'); return }
    if (!form.categoryId) { setError('Выберите категорию'); return }
    try {
      if (editId === 'new') {
        await createRoom({
          number: form.number,
          categoryId: form.categoryId,
          building: form.building,
          floor: form.floor,
          features: form.features,
          capacity: form.capacity,
        })
      } else if (editId) {
        await updateRoom(editId as number, {
          number: form.number,
          categoryId: form.categoryId,
          building: form.building,
          floor: form.floor,
          features: form.features,
          capacity: form.capacity,
        })
      }
      setEditId(null)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const toggleFeature = (featureName: string) => {
    setForm(prev => ({
      ...prev,
      features: prev.features.includes(featureName)
        ? prev.features.filter(x => x !== featureName)
        : [...prev.features, featureName],
    }))
  }

  const toggleActive = async (room: Room) => {
    try {
      if (room.isActive) {
        await deactivateRoom(room.id)
      } else {
        await updateRoom(room.id, { isActive: true })
      }
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка')
    }
  }

  // Group rooms by building (натуральная сортировка корпусов)
  const buildingKeys = [...new Set(rooms.map(r => r.building))].sort(naturalCompare)

  // Building options: from store + any existing in DB (to avoid data loss)
  const buildingOptions = [
    ...buildings.map(b => b.name),
    ...buildingKeys.filter(k => !buildings.find(b => b.name === k)),
  ]

  const getFeatureEmoji = (featureName: string) => {
    const found = features.find(f => f.name === featureName)
    return found ? found.emoji : '✦'
  }

  const getCapacityLabel = (capacityId: string) => {
    const found = capacities.find(c => c.id === capacityId)
    return found ? found.label : capacityId
  }

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af', fontSize: '1rem' }}>
        Загрузка...
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: '#111827', marginBottom: 4 }}>Номера</div>
      <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 16 }}>
        Управление номерным фондом. Номера привязаны к корпусам, категориям, вместимости и особенностям.
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.92rem', color: '#6b7280' }}>Всего: {rooms.length} номеров</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.92rem', color: '#6b7280', cursor: 'pointer' }}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Показать неактивные
        </label>
      </div>

      {/* Room list grouped by building */}
      {buildingKeys.map(building => {
        const buildingRooms = rooms.filter(r => r.building === building).sort(compareRooms)
        return (
          <div key={building}>
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Корпус {building}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {buildingRooms.map(room => (
                <div key={room.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', background: room.isActive ? '#f9fafb' : '#fafafa',
                  borderRadius: 7, border: '1px solid #e5e7eb',
                  opacity: room.isActive ? 1 : 0.5,
                }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: room.category.color, flexShrink: 0 }} />
                  <span style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', width: 60 }}>{room.number}</span>
                  <span style={{ fontSize: '0.85rem', color: '#9ca3af', flex: 1 }}>
                    {room.category.name} · эт. {room.floor}
                    {room.capacity ? ` · ${getCapacityLabel(room.capacity)}` : ''}
                  </span>
                  {room.features.length > 0 && (
                    <span style={{ fontSize: '0.92rem', color: '#9ca3af' }} title={room.features.join(', ')}>
                      {room.features.map(f => getFeatureEmoji(f)).join('')}
                    </span>
                  )}
                  <button onClick={() => startEdit(room)} style={iconBtn}>✎</button>
                  <button onClick={() => toggleActive(room)} style={{ ...iconBtn, color: room.isActive ? '#dc2626' : '#059669' }}>
                    {room.isActive ? '⊗' : '✓'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {rooms.length === 0 && (
        <div style={{ padding: '24px', textAlign: 'center', color: '#9ca3af', fontSize: '1rem', background: '#f9fafb', borderRadius: 8, border: '1px dashed #e5e7eb' }}>
          Номера не добавлены
        </div>
      )}

      {/* Form */}
      {editId !== null && (
        <div style={{
          padding: 16, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 12, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новый номер' : 'Редактировать номер'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Номер *</label>
              <input
                value={form.number}
                onChange={e => setForm({ ...form, number: e.target.value })}
                placeholder="А101"
                style={inputStyle}
                autoFocus
              />
            </div>
            <div>
              <label style={labelStyle}>Корпус *</label>
              {buildingOptions.length > 0 ? (
                <select
                  value={form.building}
                  onChange={e => setForm({ ...form, building: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">— выберите —</option>
                  {buildingOptions.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={form.building}
                  onChange={e => setForm({ ...form, building: e.target.value })}
                  placeholder="Введите корпус"
                  style={inputStyle}
                />
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px', gap: 8 }}>
            <div>
              <label style={labelStyle}>Категория *</label>
              <select
                value={form.categoryId}
                onChange={e => setForm({ ...form, categoryId: Number(e.target.value) })}
                style={inputStyle}
              >
                <option value={0}>— выберите —</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Вместимость</label>
              <select
                value={form.capacity}
                onChange={e => setForm({ ...form, capacity: e.target.value })}
                style={inputStyle}
              >
                <option value="">— не указано —</option>
                {capacities.map(c => (
                  <option key={c.id} value={c.id}>{c.label} ({c.value} чел.)</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Этаж</label>
              <input
                type="number"
                min={1}
                max={99}
                value={form.floor}
                onChange={e => setForm({ ...form, floor: Number(e.target.value) })}
                style={inputStyle}
              />
            </div>
          </div>

          {features.length > 0 && (
            <div>
              <label style={labelStyle}>Особенности</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {features.map(f => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => toggleFeature(f.name)}
                    style={{
                      padding: '4px 10px', borderRadius: 20, fontSize: '0.92rem', cursor: 'pointer',
                      border: '1px solid',
                      borderColor: form.features.includes(f.name) ? '#6366f1' : '#e5e7eb',
                      background: form.features.includes(f.name) ? '#eef2ff' : '#fff',
                      color: form.features.includes(f.name) ? '#6366f1' : '#6b7280',
                      fontWeight: form.features.includes(f.name) ? 600 : 400,
                      display: 'flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    <span>{f.emoji}</span> {f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={startNew} style={dashedBtn}>
        + Добавить номер
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
