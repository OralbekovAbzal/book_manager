import React, { useEffect, useState } from 'react'
import { fetchHotel, updateHotel } from '../../../api/hotel'
import { useAuthStore } from '../../../store/useAuthStore'
import { formatApiError } from '../../Setup/accountRules'
import { SectionHeader, formCard, inputStyle, labelStyle, errorStyle, primaryBtn } from './sectionUi'

// Настройки → Отель: название и город. Видят все роли, изменяют SUPER_ADMIN и ADMIN
// (сервер проверяет роль тоже). После сохранения название обновляется в шапке.
export const HotelSection: React.FC = () => {
  const { admin, setHotelName } = useAuthStore()
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [form, setForm] = useState({ name: '', city: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchHotel()
      .then(h => setForm({ name: h.name ?? '', city: h.city ?? '' }))
      .catch(e => setError(formatApiError(e, 'Не удалось загрузить данные отеля')))
      .finally(() => setLoading(false))
  }, [])

  // Короткое «Сохранено», само исчезает
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название отеля'); return }
    setSaving(true)
    setError('')
    try {
      const h = await updateHotel({ name: form.name.trim(), city: form.city.trim() || null })
      setForm({ name: h.name ?? '', city: h.city ?? '' })
      setHotelName(h.name || null)
      setSaved(true)
    } catch (e) {
      setError(formatApiError(e, 'Ошибка сохранения'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Отель"
        subtitle="Название показывается в шапке программы и в меню разделов."
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : (
        <div style={formCard}>
          <div>
            <label style={labelStyle}>Название отеля</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              disabled={!canEdit}
              maxLength={120}
              placeholder="Например: Гранд Алатау"
              style={{ ...inputStyle, opacity: canEdit ? 1 : 0.7 }}
            />
          </div>
          <div>
            <label style={labelStyle}>Город</label>
            <input
              value={form.city}
              onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
              disabled={!canEdit}
              maxLength={80}
              placeholder="Необязательно"
              style={{ ...inputStyle, opacity: canEdit ? 1 : 0.7 }}
            />
          </div>

          {error && <div style={errorStyle}>{error}</div>}

          {canEdit ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
              {saved && <span style={{ fontSize: '0.85rem', color: 'var(--s-in)' }}>Сохранено</span>}
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>
              Только просмотр: изменять данные отеля может администратор или главный администратор.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
