import React, { useEffect, useState } from 'react'
import { fetchCategories, createCategory, updateCategory, deleteCategory, CategoryWithCount } from '../../../api/categories'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

const PRESET_COLORS = [
  '#D4A8E1', '#B5D4F4', '#C0DD97', '#FAC775',
  '#F5C4B3', '#A8D8D8', '#F7C5D5', '#D4C5A9',
  '#B8C0CC', '#FFD700', '#98D8C8', '#E8A0BF',
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
    if (cat) { setEditId(cat.id); setForm({ name: cat.name, color: cat.color, description: cat.description ?? '' }) }
    else { setEditId('new'); setForm({ name: '', color: PRESET_COLORS[0], description: '' }) }
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    try {
      if (editId === 'new') await createCategory(form)
      else if (editId) await updateCategory(editId as number, form)
      setEditId(null)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить категорию?')) return
    try { await deleteCategory(id); load() }
    catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  const Form = (
    <>
      <div>
        <label style={labelStyle}>Название</label>
        <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Например: Люкс" style={inputStyle} autoFocus />
      </div>
      <div>
        <label style={labelStyle}>Описание</label>
        <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Необязательно" style={inputStyle} />
      </div>
      <div>
        <label style={labelStyle}>Цвет</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PRESET_COLORS.map(c => (
            <div key={c} onClick={() => setForm({ ...form, color: c })} style={{
              width: 24, height: 24, borderRadius: '50%', background: c, cursor: 'pointer',
              outline: form.color === c ? '3px solid var(--accent)' : 'none', outlineOffset: 2,
            }} />
          ))}
          <input type="color" value={form.color} onChange={e => setForm({ ...form, color: e.target.value })}
            style={{ width: 24, height: 24, border: 'none', borderRadius: '50%', cursor: 'pointer', padding: 0, background: 'none' }} />
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
        title="Категории"
        subtitle="Категории номеров хранятся в базе и используются во всей системе."
        action={<AddButton onClick={() => startEdit()} label="Добавить категорию" />}
      />

      {editId === 'new' && <div style={formCard}><div style={formTitle}>Новая категория</div>{Form}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {cats.length === 0 && <EmptyBox>Категории не добавлены</EmptyBox>}

          {cats.map(cat => (
            <div key={cat.id}>
              <div style={listRow}>
                <div style={{ width: 14, height: 14, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={itemTitle}>{cat.name}</div>
                  {cat.description && <div style={itemSub}>{cat.description}</div>}
                </div>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: '2px 8px' }}>
                  {cat._count?.rooms ?? 0} ном.
                </span>
                <button onClick={() => startEdit(cat)} style={iconBtn} title="Редактировать">✎</button>
                <button onClick={() => remove(cat.id)} style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Удалить">✕</button>
              </div>
              {editId === cat.id && <div style={{ ...formCard, marginTop: 6 }}>{Form}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
