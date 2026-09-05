import React, { useEffect, useState } from 'react'
import { useRoomFundStore } from '../../../store/useRoomFundStore'
import { fetchCategories, CategoryWithCount } from '../../../api/categories'
import { fetchAllRooms, createRoom, updateRoom, deactivateRoom } from '../../../api/roomsAdmin'
import type { FeatureRow, CapacityRow } from '../../../api/roomFund'
import { compareRooms, naturalCompare } from '../../../utils/sortRooms'
import type { Room } from '../../../types'

type Segment = 'all' | 'active' | 'hidden'

const GRID_COLS = '80px 1fr 90px 1.5fr 120px 36px'

/** Форма ответа сервера об отказе — общая для 400/403 у номеров. */
interface RoomApiError {
  response?: { data?: { error?: string; code?: string; limit?: number; used?: number } }
}

/**
 * Текст отказа для человека за стойкой.
 *
 * Отдельно разбирается только лимит лицензии (403 `LICENSE_ROOM_LIMIT`): у него
 * есть цифры, которых нет в тексте сервера, и без них «обратитесь к поставщику»
 * выглядит произволом. Остальные ошибки сервер уже формулирует по-русски.
 */
function describeRoomError(e: unknown, fallback: string): string {
  const data = (e as RoomApiError)?.response?.data
  const message = data?.error ?? fallback
  if (data?.code !== 'LICENSE_ROOM_LIMIT') return message
  return `${message}. Номеров по лицензии: ${data.limit ?? '—'}, сейчас активно: ${data.used ?? '—'}.`
}

/** Полоса отказа над списком — для действий, у которых нет открытой формы. */
const actionErrorStyle: React.CSSProperties = {
  margin: '14px 0 0', padding: '10px 13px', borderRadius: 8,
  fontSize: '0.86rem', lineHeight: 1.5,
  border: '1px solid var(--s-overdue)', background: 'var(--surface-2)', color: 'var(--s-overdue)',
}

export const RoomsSection: React.FC = () => {
  // Справочник — общий, с сервера. Скрытые записи в сторе тоже есть: они нужны,
  // чтобы расшифровать вместимость номера, чью запись уже убрали из списков.
  const { buildings, features, capacities, ensureLoaded } = useRoomFundStore()
  useEffect(() => { ensureLoaded() }, [ensureLoaded])

  const activeFeatures = features.filter(f => f.isActive)
  const activeCapacities = capacities.filter(c => c.isActive)

  const [rooms, setRooms] = useState<Room[]>([])
  const [cats, setCats] = useState<CategoryWithCount[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [seg, setSeg] = useState<Segment>('all')
  const [search, setSearch] = useState('')
  const [form, setForm] = useState({
    number: '', categoryId: 0, building: '', floor: 1, features: [] as string[], capacity: '',
  })
  const [error, setError] = useState('')
  // Отказ у действия без формы (вернуть скрытый номер в работу). Раньше здесь
  // был alert; лимит лицензии — это текст, который надо прочитать, а не «ОК».
  const [actionError, setActionError] = useState('')

  const load = () => {
    setLoading(true)
    Promise.all([fetchAllRooms({}), fetchCategories()])
      .then(([r, c]) => { setRooms(r); setCats(c); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const startNew = () => {
    setEditId('new')
    setForm({
      // В номер идут НАЗВАНИЕ корпуса и КОД вместимости — так номера связаны
      // со справочником (внешних ключей между ними нет).
      number: '', categoryId: cats[0]?.id ?? 0, building: buildings.find(b => b.isActive)?.name ?? '',
      floor: 1, features: [], capacity: activeCapacities[0]?.code ?? '',
    })
    setError('')
  }

  const startEdit = (room: Room) => {
    if (editId === room.id) { setEditId(null); return }
    setEditId(room.id)
    setForm({
      number: room.number, categoryId: room.category.id, building: room.building,
      floor: room.floor, features: [...room.features], capacity: room.capacity ?? '',
    })
    setError('')
  }

  const save = async () => {
    if (!form.number.trim()) { setError('Введите номер комнаты'); return }
    if (!form.building.trim()) { setError('Введите корпус'); return }
    if (!form.categoryId) { setError('Выберите категорию'); return }
    try {
      const payload = {
        number: form.number, categoryId: form.categoryId, building: form.building,
        floor: form.floor, features: form.features, capacity: form.capacity,
      }
      if (editId === 'new') await createRoom(payload)
      else if (editId) await updateRoom(editId as number, payload)
      setEditId(null)
      setActionError('')
      load()
    } catch (e: unknown) {
      // Сюда же приходит 403 LICENSE_ROOM_LIMIT при добавлении сверх лицензии.
      setError(describeRoomError(e, 'Ошибка сохранения'))
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
      if (room.isActive) await deactivateRoom(room.id)
      else await updateRoom(room.id, { isActive: true })
      setActionError('')
      load()
    } catch (e: unknown) {
      // Возврат скрытого номера в работу — это +1 к активным, поэтому сюда
      // приходит тот же лимит лицензии, что и при добавлении нового.
      setActionError(describeRoomError(e, 'Не удалось изменить номер'))
    }
  }

  // К справочнику добавляем корпуса, которые встречаются у номеров, но которых
  // в справочнике нет (или их скрыли): иначе форма не покажет текущее значение.
  const buildingKeys = [...new Set(rooms.map(r => r.building))].sort(naturalCompare)
  const buildingOptions = [
    ...buildings.filter(b => b.isActive).map(b => b.name),
    ...buildingKeys.filter(k => !buildings.find(b => b.isActive && b.name === k)),
  ]

  // Номер хранит КОД вместимости; если запись справочника скрыли или её нет —
  // показываем сам код, а не пустоту (именно так и выглядела «1781675520618»).
  const getCapacityLabel = (code: string) => capacities.find(c => c.code === code)?.label ?? code

  // Скрытая запись, которая уже стоит у редактируемого номера, всё равно должна
  // быть в списке — иначе форма молча заменит её на «не указано» при сохранении.
  const capacityOptions = [
    ...activeCapacities,
    ...capacities.filter(c => !c.isActive && c.code === form.capacity),
  ]
  const featureOptions = [
    ...activeFeatures,
    ...features.filter(f => !f.isActive && form.features.includes(f.name)),
  ]

  // Фильтрация по сегменту + поиску
  const q = search.trim().toLowerCase()
  const visibleRooms = rooms.filter(r => {
    if (seg === 'active' && !r.isActive) return false
    if (seg === 'hidden' && r.isActive) return false
    if (q && !(`${r.number} ${r.category.name}`.toLowerCase().includes(q))) return false
    return true
  })

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600, letterSpacing: '-0.02em', color: 'var(--text)' }}>Номера</h1>
          <p style={{ margin: '5px 0 0', fontSize: '0.86rem', color: 'var(--text-faint)' }}>
            Номерной фонд отеля · {rooms.length} номеров в {cats.length} категориях
          </p>
        </div>
        <button onClick={startNew} style={{
          display: 'flex', alignItems: 'center', gap: 7, height: 36, padding: '0 15px',
          background: 'var(--accent)', border: 'none', borderRadius: 8, color: '#fff',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600,
          whiteSpace: 'nowrap', boxShadow: 'var(--shadow-sm)',
        }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M12 5v14" /></svg>
          Добавить номер
        </button>
      </div>

      {actionError && <div style={actionErrorStyle}>{actionError}</div>}

      {/* Toolbar: search + segment */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '18px 0 12px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по номеру или категории…"
            style={{
              width: '100%', height: 34, padding: '0 12px 0 32px', background: 'var(--surface)',
              border: '1px solid var(--border-subtle)', borderRadius: 8, fontFamily: 'inherit',
              fontSize: '0.85rem', color: 'var(--text)', outline: 'none',
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: 2, padding: 3, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
          {([['all', 'Все'], ['active', 'Активные'], ['hidden', 'Скрытые']] as [Segment, string][]).map(([key, label]) => (
            <button key={key} onClick={() => setSeg(key)} style={{
              padding: '5px 11px', border: 'none', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
              fontSize: '0.78rem', whiteSpace: 'nowrap',
              background: seg === key ? 'var(--bg)' : 'transparent',
              color: seg === key ? 'var(--text)' : 'var(--text-faint)',
              fontWeight: seg === key ? 600 : 500,
              boxShadow: seg === key ? 'var(--shadow-sm)' : 'none',
            }}>{label}</button>
          ))}
        </div>
      </div>

      {/* New-room form (вверху) */}
      {editId === 'new' && <RoomForm {...{ form, setForm, cats, capacityOptions, featureOptions, buildingOptions, error, save, toggleFeature, onCancel: () => setEditId(null), title: 'Новый номер' }} />}

      {/* Table */}
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: GRID_COLS, gap: 12, alignItems: 'center',
          padding: '9px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)',
          fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)',
        }}>
          <span>Номер</span><span>Категория</span><span>Вмест.</span><span>Особенности</span><span>Статус</span><span />
        </div>

        {cats.map(cat => {
          const catRooms = visibleRooms.filter(r => r.category.id === cat.id).sort(compareRooms)
          if (catRooms.length === 0) return null
          return (
            <div key={cat.id}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 9, padding: '8px 16px',
                background: 'var(--surface-2)', borderBottom: '1px solid var(--border-subtle)',
              }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cat.color, flexShrink: 0 }} />
                <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text)' }}>{cat.name}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>{catRooms.length}</span>
              </div>

              {catRooms.map(room => (
                <div key={room.id}>
                  <div
                    onClick={() => startEdit(room)}
                    style={{
                      display: 'grid', gridTemplateColumns: GRID_COLS, gap: 12, alignItems: 'center',
                      padding: '11px 16px', borderBottom: '1px solid var(--border-subtle)',
                      cursor: 'pointer', opacity: room.isActive ? 1 : 0.55,
                      background: editId === room.id ? 'var(--surface)' : 'transparent',
                    }}
                  >
                    <span className="mono" style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }}>{room.number}</span>
                    <span style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>{room.category.name}</span>
                    <span style={{ fontSize: '0.86rem', color: 'var(--text-muted)' }}>{room.capacity ? getCapacityLabel(room.capacity) : '—'}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                      {room.features.length === 0 ? <span style={{ color: 'var(--text-faint)' }}>—</span> :
                        room.features.map(f => (
                          <span key={f} style={{
                            fontSize: '0.74rem', padding: '2px 8px', borderRadius: 5,
                            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
                          }}>{f}</span>
                        ))}
                    </span>
                    <span
                      onClick={e => { e.stopPropagation(); toggleActive(room) }}
                      title={room.isActive ? 'Скрыть номер' : 'Активировать'}
                      style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', cursor: 'pointer', color: room.isActive ? 'var(--s-in)' : 'var(--text-faint)' }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: room.isActive ? 'var(--s-in)' : 'var(--text-faint)' }} />
                      {room.isActive ? 'Активен' : 'Скрыт'}
                    </span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      style={{ transform: editId === room.id ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', justifySelf: 'center' }}>
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </div>
                  {editId === room.id && (
                    <div style={{ padding: '4px 16px 16px', borderBottom: '1px solid var(--border-subtle)' }}>
                      <RoomForm {...{ form, setForm, cats, capacityOptions, featureOptions, buildingOptions, error, save, toggleFeature, onCancel: () => setEditId(null), title: '' }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )
        })}

        {visibleRooms.length === 0 && (
          <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-faint)', fontSize: '0.9rem' }}>
            {rooms.length === 0 ? 'Номера не добавлены' : 'Ничего не найдено'}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Inline form ──────────────────────────────────────────────────────────────

interface FormProps {
  form: { number: string; categoryId: number; building: string; floor: number; features: string[]; capacity: string }
  setForm: React.Dispatch<React.SetStateAction<FormProps['form']>>
  cats: CategoryWithCount[]
  capacityOptions: CapacityRow[]
  featureOptions: FeatureRow[]
  buildingOptions: string[]
  error: string
  save: () => void
  toggleFeature: (name: string) => void
  onCancel: () => void
  title: string
}

const RoomForm: React.FC<FormProps> = ({ form, setForm, cats, capacityOptions, featureOptions, buildingOptions, error, save, toggleFeature, onCancel, title }) => (
  <div style={{
    padding: 16, background: 'var(--bg)', border: '1px solid var(--border)',
    borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: title ? 12 : 0,
  }}>
    {title && <div style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)' }}>{title}</div>}

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <Field label="Номер">
        <input value={form.number} onChange={e => setForm(f => ({ ...f, number: e.target.value }))} placeholder="А101" style={inputStyle} autoFocus />
      </Field>
      <Field label="Категория">
        <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: Number(e.target.value) }))} style={inputStyle}>
          <option value={0}>— выберите —</option>
          {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px', gap: 12 }}>
      <Field label="Корпус">
        {buildingOptions.length > 0 ? (
          <select value={form.building} onChange={e => setForm(f => ({ ...f, building: e.target.value }))} style={inputStyle}>
            <option value="">— выберите —</option>
            {buildingOptions.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        ) : (
          <input value={form.building} onChange={e => setForm(f => ({ ...f, building: e.target.value }))} placeholder="Корпус" style={inputStyle} />
        )}
      </Field>
      <Field label="Вместимость">
        <select value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} style={inputStyle}>
          <option value="">— не указано —</option>
          {/* value — КОД: именно он лежит в Room.capacity. */}
          {capacityOptions.map(c => (
            <option key={c.id} value={c.code}>
              {c.label}{c.value > 0 ? ` (${c.value} чел.)` : ''}{c.isActive ? '' : ' — скрыт'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Этаж">
        <input type="number" min={1} max={99} value={form.floor} onChange={e => setForm(f => ({ ...f, floor: Number(e.target.value) }))} style={inputStyle} />
      </Field>
    </div>

    {featureOptions.length > 0 && (
      <Field label="Особенности">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {featureOptions.map(f => {
            const on = form.features.includes(f.name)
            return (
              <button key={f.id} type="button" onClick={() => toggleFeature(f.name)} style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 7, cursor: 'pointer',
                fontFamily: 'inherit', fontSize: '0.82rem',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                background: on ? 'var(--accent-bg)' : 'var(--bg)',
                color: on ? 'var(--accent-text)' : 'var(--text-muted)',
                fontWeight: on ? 600 : 500,
              }}>
                <span>{f.emoji ?? '✦'}</span> {f.name}
              </button>
            )
          })}
        </div>
      </Field>
    )}

    {error && <div style={{ fontSize: '0.85rem', color: 'var(--s-overdue)' }}>{error}</div>}

    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <button onClick={onCancel} style={{
        height: 36, padding: '0 16px', background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 8, fontFamily: 'inherit', fontSize: '0.86rem', color: 'var(--text)', cursor: 'pointer',
      }}>Отмена</button>
      <button onClick={save} style={{
        height: 36, padding: '0 18px', background: 'var(--accent)', border: 'none',
        borderRadius: 8, fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600, color: '#fff', cursor: 'pointer',
      }}>Сохранить</button>
    </div>
  </div>
)

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={{ fontSize: '0.78rem', fontWeight: 500, color: 'var(--text-muted)' }}>{label}</label>
    {children}
  </div>
)

const inputStyle: React.CSSProperties = {
  width: '100%', height: 38, padding: '0 12px', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: '0.86rem', boxSizing: 'border-box', fontFamily: 'inherit',
  outline: 'none', background: 'var(--bg)', color: 'var(--text)',
}
