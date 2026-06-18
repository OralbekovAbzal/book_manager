import React, { useEffect, useState } from 'react'
import { fetchCategories, createCategory, updateCategory, deleteCategory, CategoryWithCount } from '../../../api/categories'

const PRESET_COLORS = [
  '#D4A8E1','#B5D4F4','#C0DD97','#FAC775',
  '#F5C4B3','#A8D8D8','#F7C5D5','#D4C5A9',
  '#B8C0CC','#FFD700','#98D8C8','#E8A0BF',
]

export const CategoriesSection: React.FC = () => {
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
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить категорию?')) return
    try {
      await deleteCategory(id)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: '1.69rem', fontWeight: 700, color: '#111827', marginBottom: 4 }}>Категории</div>
      <div style={{ fontSize: '1rem', color: '#6b7280', marginBottom: 24 }}>
        Категории номеров хранятся в базе данных и используются во всей системе.
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af', fontSize: '1rem' }}>Загрузка...</div>
      ) : (
        <>
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

          <button onClick={() => startEdit()} style={dashedBtn}>
            + Добавить категорию
          </button>
        </>
      )}
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
