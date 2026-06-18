import React, { useEffect, useState, useMemo } from 'react'
import {
  fetchAllotments,
  createAllotment,
  updateAllotment,
  deleteAllotment,
} from '../../../api/allotments'
import { fetchPartners } from '../../../api/partners'
import { fetchRooms } from '../../../api/rooms'
import type { Partner, Allotment, Room } from '../../../types'

interface FormState {
  partnerId: number | 0
  roomId: number | 0
  dateFrom: string
  dateTo: string
  notes: string
}

const emptyForm = (): FormState => ({
  partnerId: 0,
  roomId: 0,
  dateFrom: '',
  dateTo: '',
  notes: '',
})

export const AllotmentsSection: React.FC = () => {
  const [partners, setPartners] = useState<Partner[]>([])
  const [rooms, setRooms] = useState<Room[]>([])
  const [allotments, setAllotments] = useState<Allotment[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState('')
  const [filterPartnerId, setFilterPartnerId] = useState<number | 0>(0)

  const load = async () => {
    setLoading(true)
    try {
      const [ps, rs, als] = await Promise.all([
        fetchPartners(),
        fetchRooms({ isActive: true }),
        fetchAllotments(),
      ])
      setPartners(ps)
      setRooms(rs)
      setAllotments(als)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const startEdit = (a?: Allotment) => {
    if (a) {
      setEditId(a.id)
      setForm({
        partnerId: a.partnerId,
        roomId: a.roomId,
        dateFrom: a.dateFrom.slice(0, 10),
        dateTo: a.dateTo.slice(0, 10),
        notes: a.notes ?? '',
      })
    } else {
      setEditId('new')
      setForm(emptyForm())
    }
    setError('')
  }

  const save = async () => {
    if (!form.partnerId) { setError('Выберите партнёра'); return }
    if (!form.roomId)    { setError('Выберите номер'); return }
    if (!form.dateFrom || !form.dateTo) { setError('Укажите период'); return }
    if (form.dateTo <= form.dateFrom) { setError('Дата окончания должна быть позже начала'); return }

    try {
      const payload = {
        partnerId: form.partnerId as number,
        roomId: form.roomId as number,
        dateFrom: form.dateFrom,
        dateTo: form.dateTo,
        notes: form.notes,
      }
      if (editId === 'new') await createAllotment(payload)
      else if (typeof editId === 'number') await updateAllotment(editId, payload)
      setEditId(null)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (id: number) => {
    if (!confirm('Удалить квоту?')) return
    try {
      await deleteAllotment(id)
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  const filtered = useMemo(() => {
    if (!filterPartnerId) return allotments
    return allotments.filter(a => a.partnerId === filterPartnerId)
  }, [allotments, filterPartnerId])

  // Группируем по партнёру
  const grouped = useMemo(() => {
    const map = new Map<number, Allotment[]>()
    for (const a of filtered) {
      if (!map.has(a.partnerId)) map.set(a.partnerId, [])
      map.get(a.partnerId)!.push(a)
    }
    return map
  }, [filtered])

  const noPartners = partners.length === 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 800 }}>
      <header>
        <div style={{ fontSize: '1.38rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          Квоты для партнёров
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          За каждым партнёром закрепляется конкретный номер на определённый период.
          В этот период номер недоступен для прямой продажи — только под заявки бюро.
          Один номер не может одновременно принадлежать двум партнёрам.
        </div>
      </header>

      {noPartners && (
        <div style={{
          padding: '12px 14px', borderRadius: 8,
          background: '#fef3c7', color: '#92400e',
          fontSize: '0.95rem',
        }}>
          Сначала добавьте партнёров в разделе «Партнёры»
        </div>
      )}

      {!noPartners && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => startEdit()}
            disabled={editId !== null}
            style={addBtnStyle(editId !== null)}
          >
            + Добавить квоту
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.88rem', color: 'var(--text-faint)' }}>Партнёр:</span>
            <select
              value={filterPartnerId}
              onChange={e => setFilterPartnerId(Number(e.target.value))}
              style={{ ...inputStyle, width: 200 }}
            >
              <option value={0}>Все партнёры</option>
              {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {editId !== null && (
        <div style={cardStyle}>
          <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 14 }}>
            {editId === 'new' ? 'Новая квота' : 'Редактирование квоты'}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="Партнёр">
              <select
                value={form.partnerId}
                onChange={e => setForm({ ...form, partnerId: Number(e.target.value) })}
                style={inputStyle}
              >
                <option value={0}>— выберите партнёра —</option>
                {partners.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>

            <Field label="Номер">
              <select
                value={form.roomId}
                onChange={e => setForm({ ...form, roomId: Number(e.target.value) })}
                style={inputStyle}
              >
                <option value={0}>— выберите номер —</option>
                {rooms.map(r => (
                  <option key={r.id} value={r.id}>
                    №{r.number} — {r.category.name} (корп. {r.building}, эт. {r.floor})
                  </option>
                ))}
              </select>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Field label="С даты">
                <input
                  type="date"
                  value={form.dateFrom}
                  onChange={e => setForm({ ...form, dateFrom: e.target.value })}
                  style={inputStyle}
                />
              </Field>
              <Field label="По дату">
                <input
                  type="date"
                  value={form.dateTo}
                  onChange={e => setForm({ ...form, dateTo: e.target.value })}
                  style={inputStyle}
                />
              </Field>
            </div>

            <Field label="Примечания">
              <input
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="Например: контракт №42 на сезон 2026"
                style={inputStyle}
              />
            </Field>

            {error && (
              <div style={{ color: '#dc2626', fontSize: '0.92rem', padding: '6px 10px',
                background: '#fef2f2', borderRadius: 6, border: '1px solid #fecaca' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditId(null)} style={secondaryBtnStyle}>Отмена</button>
              <button onClick={save} style={primaryBtnStyle}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: 30 }}>
          {noPartners ? '' : 'Квот пока нет'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {Array.from(grouped.entries()).map(([partnerId, list]) => {
            const partner = partners.find(p => p.id === partnerId)
            return (
              <div key={partnerId}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 6, paddingLeft: 4,
                }}>
                  <span style={{
                    width: 12, height: 12, borderRadius: 3,
                    background: partner?.color ?? 'var(--text-faint)',
                  }} />
                  <span style={{
                    fontSize: '0.85rem', fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: '0.06em',
                    color: 'var(--text-faint)',
                  }}>
                    {partner?.name ?? '?'} · {list.length} {list.length === 1 ? 'номер' : list.length < 5 ? 'номера' : 'номеров'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {list.map(a => (
                    <div key={a.id} style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '9px 13px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderLeft: `3px solid ${partner?.color ?? 'var(--accent)'}`,
                      borderRadius: 8,
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '1rem', fontWeight: 600 }}>
                          №{a.room.number}
                          <span style={{ marginLeft: 8, fontWeight: 400, color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                            корп. {a.room.building}, эт. {a.room.floor}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 2 }}>
                          {a.dateFrom.slice(0, 10)} → {a.dateTo.slice(0, 10)}
                          {a.notes && <span style={{ marginLeft: 8 }}>· {a.notes}</span>}
                          {a.releases.length > 0 && (
                            <span style={{ marginLeft: 8, color: '#d97706' }}>
                              · {a.releases.length} {a.releases.length === 1 ? 'релиз' : 'релизов'}
                            </span>
                          )}
                        </div>
                      </div>
                      <button onClick={() => startEdit(a)} style={ghostBtnStyle}>Изм.</button>
                      <button onClick={() => remove(a.id)} style={dangerBtnStyle}>Удалить</button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Sub ──────────────────────────────────────────────────────────────────────

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
    <label style={{ fontSize: '0.85em', fontWeight: 600, color: 'var(--text-faint)' }}>{label}</label>
    {children}
  </div>
)

const inputStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', outline: 'none',
  background: 'var(--bg)', color: 'var(--text)',
  fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}

const cardStyle: React.CSSProperties = {
  padding: 16,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 10,
}

const addBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 14px',
  background: disabled ? 'var(--surface-3)' : 'var(--accent)',
  color: disabled ? 'var(--text-faint)' : '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
})

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}

const ghostBtnStyle: React.CSSProperties = {
  padding: '5px 10px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 6,
  fontSize: '0.88rem', cursor: 'pointer', color: 'var(--text-muted)',
}

const dangerBtnStyle: React.CSSProperties = {
  ...ghostBtnStyle, color: '#dc2626', borderColor: '#fecaca',
}
