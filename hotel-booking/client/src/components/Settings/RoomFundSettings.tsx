import React, { useEffect, useState } from 'react'
import { fetchCategories, createCategory, updateCategory, deleteCategory, CategoryWithCount } from '../../api/categories'
import { fetchAllRooms, createRoom, updateRoom, deactivateRoom } from '../../api/roomsAdmin'
import type { Room } from '../../types'

const PRESET_COLORS = [
  '#D4A8E1','#B5D4F4','#C0DD97','#FAC775',
  '#F5C4B3','#A8D8D8','#F7C5D5','#D4C5A9',
  '#B8C0CC','#FFD700','#98D8C8','#E8A0BF',
]

const FEATURE_OPTIONS = ['балкон','вид на море','двуспальная кровать','джакузи','холодильник','кондиционер','сейф']

export const RoomFundSettings: React.FC = () => {
  const [tab, setTab] = useState<'categories' | 'rooms'>('categories')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '4px', background: '#f3f4f6', borderRadius: 8 }}>
        {(['categories', 'rooms'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              flex: 1, padding: '7px 0', border: 'none', borderRadius: 6, cursor: 'pointer',
              fontSize: '1rem', fontWeight: 600,
              background: tab === t ? '#fff' : 'transparent',
              color: tab === t ? '#111827' : '#6b7280',
              boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
              transition: 'all 0.15s',
            }}
          >
            {t === 'categories' ? 'Категории' : 'Номера'}
          </button>
        ))}
      </div>

      {tab === 'categories' ? <CategoriesTab /> : <RoomsTab />}
    </div>
  )
}

// ─── Категории ────────────────────────────────────────────────────────────────

const CategoriesTab: React.FC = () => {
  const [cats, setCats] = useState<CategoryWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState({ name: '', color: PRESET_COLORS[0], description: '' })
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    fetchCategories().then(data => { setCats(data); setLoading(false) }).catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const startEdit = (cat?: CategoryWithCount) => {
    if (cat) {
      setEditId(cat.id)
      setForm({ name: cat.name, color: cat.color, description: cat.description ?? '' })
    } else {
      setEditId('new')
      setForm({ name: '', color: PRESET_COLORS[0], description: '' })
    }
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    try {
      if (editId === 'new') {
        await createCategory(form)
      } else if (editId) {
        await updateCategory(editId as number, form)
      }
      setEditId(null)
      load()
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить категорию?')) return
    try {
      await deleteCategory(id)
      load()
    } catch (e: any) {
      alert(e?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  if (loading) return <Loader />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {cats.map(cat => (
        <div key={cat.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px', background: '#f9fafb',
          borderRadius: 8, border: '1px solid #e5e7eb',
        }}>
          <div style={{ width: 14, height: 14, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827' }}>{cat.name}</div>
            {cat.description && <div style={{ fontSize: '0.85rem', color: '#9ca3af' }}>{cat.description}</div>}
          </div>
          <div style={{ fontSize: '0.85rem', color: '#9ca3af', background: '#e5e7eb', borderRadius: 10, padding: '2px 8px' }}>
            {cat._count?.rooms ?? 0} ном.
          </div>
          <button onClick={() => startEdit(cat)} style={iconBtn}>✎</button>
          <button onClick={() => remove(cat.id)} style={{ ...iconBtn, color: '#dc2626' }}>✕</button>
        </div>
      ))}

      {/* Форма редактирования */}
      {editId !== null && (
        <div style={{
          padding: 14, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новая категория' : 'Редактировать'}
          </div>

          <input
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Название (напр. Люкс)"
            style={inputStyle}
          />
          <input
            value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="Описание (необязательно)"
            style={inputStyle}
          />

          <div>
            <div style={{ fontSize: '0.85rem', color: '#9ca3af', marginBottom: 6 }}>Цвет</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {PRESET_COLORS.map(c => (
                <div
                  key={c}
                  onClick={() => setForm({ ...form, color: c })}
                  style={{
                    width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer',
                    outline: form.color === c ? '3px solid #6366f1' : 'none',
                    outlineOffset: 2,
                  }}
                />
              ))}
              <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })}
                style={{ width: 24, height: 24, border: 'none', borderRadius: '50%', cursor: 'pointer', padding: 0 }} />
            </div>
          </div>

          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={() => startEdit()} style={{
        padding: '9px 0', background: 'none', border: '1px dashed #6366f1',
        borderRadius: 8, fontSize: '1rem', color: '#6366f1', cursor: 'pointer', fontWeight: 600,
      }}>
        + Добавить категорию
      </button>
    </div>
  )
}

// ─── Номера ───────────────────────────────────────────────────────────────────

const RoomsTab: React.FC = () => {
  const [rooms, setRooms] = useState<Room[]>([])
  const [cats, setCats] = useState<CategoryWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [showInactive, setShowInactive] = useState(false)
  const [form, setForm] = useState({
    number: '', categoryId: 0, building: '', floor: 1, features: [] as string[],
  })
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    Promise.all([
      fetchAllRooms(showInactive ? {} : { isActive: true }),
      fetchCategories(),
    ]).then(([r, c]) => { setRooms(r); setCats(c); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [showInactive])

  const startNew = () => {
    setEditId('new')
    setForm({ number: '', categoryId: cats[0]?.id ?? 0, building: '', floor: 1, features: [] })
    setError('')
  }

  const startEdit = (room: Room) => {
    setEditId(room.id)
    setForm({
      number: room.number, categoryId: room.category.id,
      building: room.building, floor: room.floor, features: [...room.features],
    })
    setError('')
  }

  const save = async () => {
    if (!form.number.trim()) { setError('Введите номер комнаты'); return }
    if (!form.building.trim()) { setError('Введите корпус'); return }
    if (!form.categoryId) { setError('Выберите категорию'); return }
    try {
      if (editId === 'new') {
        await createRoom(form)
      } else if (editId) {
        await updateRoom(editId as number, form)
      }
      setEditId(null)
      load()
    } catch (e: any) {
      setError(e?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const toggleFeature = (f: string) => {
    setForm(prev => ({
      ...prev,
      features: prev.features.includes(f) ? prev.features.filter(x => x !== f) : [...prev.features, f],
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
    } catch (e: any) {
      alert(e?.response?.data?.error ?? 'Ошибка')
    }
  }

  if (loading) return <Loader />

  const buildings = [...new Set(rooms.map(r => r.building))].sort()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Контролы */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '0.92rem', color: '#6b7280' }}>Всего: {rooms.length} номеров</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.92rem', color: '#6b7280', cursor: 'pointer' }}>
          <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} />
          Показать неактивные
        </label>
      </div>

      {/* Список по корпусам */}
      {buildings.map(building => {
        const buildingRooms = rooms.filter(r => r.building === building)
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
                  <span style={{ fontSize: '0.85rem', color: '#9ca3af', flex: 1 }}>{room.category.name} · эт. {room.floor}</span>
                  {room.features.length > 0 && (
                    <span style={{ fontSize: '0.77rem', color: '#9ca3af' }} title={room.features.join(', ')}>
                      {room.features.map(f => {
                        if (f.includes('балкон')) return '🪟'
                        if (f.includes('море')) return '🌊'
                        if (f.includes('двуспальн')) return '🛏'
                        if (f.includes('джакузи')) return '🛁'
                        return '✦'
                      }).join('')}
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

      {/* Форма */}
      {editId !== null && (
        <div style={{
          padding: 14, background: '#fff', border: '2px solid #6366f1',
          borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4,
        }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#374151' }}>
            {editId === 'new' ? 'Новый номер' : 'Редактировать номер'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Номер</label>
              <input value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} placeholder="А101" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Корпус</label>
              <input value={form.building} onChange={e => setForm({ ...form, building: e.target.value })} placeholder="А" style={inputStyle} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <label style={labelStyle}>Категория</label>
              <select value={form.categoryId} onChange={e => setForm({ ...form, categoryId: Number(e.target.value) })} style={inputStyle}>
                <option value={0}>— выберите —</option>
                {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Этаж</label>
              <input type="number" min={1} max={99} value={form.floor} onChange={e => setForm({ ...form, floor: Number(e.target.value) })} style={inputStyle} />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Удобства</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {FEATURE_OPTIONS.map(f => (
                <button
                  key={f} type="button"
                  onClick={() => toggleFeature(f)}
                  style={{
                    padding: '4px 10px', borderRadius: 20, fontSize: '0.92rem', cursor: 'pointer',
                    border: '1px solid',
                    borderColor: form.features.includes(f) ? '#6366f1' : '#e5e7eb',
                    background: form.features.includes(f) ? '#eef2ff' : '#fff',
                    color: form.features.includes(f) ? '#6366f1' : '#6b7280',
                    fontWeight: form.features.includes(f) ? 600 : 400,
                  }}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {error && <div style={{ fontSize: '0.92rem', color: '#dc2626' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} style={primaryBtn}>Сохранить</button>
            <button onClick={() => setEditId(null)} style={secondaryBtn}>Отмена</button>
          </div>
        </div>
      )}

      <button onClick={startNew} style={{
        padding: '9px 0', background: 'none', border: '1px dashed #6366f1',
        borderRadius: 8, fontSize: '1rem', color: '#6366f1', cursor: 'pointer', fontWeight: 600,
      }}>
        + Добавить номер
      </button>
    </div>
  )
}

// ─── Стили ────────────────────────────────────────────────────────────────────

const Loader = () => (
  <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af', fontSize: '1rem' }}>Загрузка...</div>
)

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 7, fontSize: '1rem', boxSizing: 'border-box', fontFamily: 'inherit', outline: 'none',
}

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#6b7280', marginBottom: 4,
}

const primaryBtn: React.CSSProperties = {
  flex: 1, padding: '8px 0', background: '#6366f1', color: '#fff',
  border: 'none', borderRadius: 7, fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  padding: '8px 16px', background: 'none', border: '1px solid #e5e7eb',
  borderRadius: 7, fontSize: '1rem', cursor: 'pointer', color: '#6b7280',
}

const iconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.08rem',
  color: '#6b7280', padding: '2px 4px', borderRadius: 4, lineHeight: 1,
}
