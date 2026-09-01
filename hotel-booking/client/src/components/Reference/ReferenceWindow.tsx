import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fetchContacts, createContact, updateContact, deleteContact } from '../../api/contacts'
import { useAuthStore } from '../../store/useAuthStore'
import type { Contact } from '../../types'
import {
  AddButton, EmptyBox, iconBtn,
  formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from '../Settings/sections/sectionUi'

/**
 * Справочник — контакты сотрудников и служб.
 *
 * Экран построен вокруг поиска: администратор чаще ищет («сантех»), чем листает.
 * Группы фиксированы (пресет, см. GROUPS на сервере) — клиент их не настраивает,
 * только заполняет записи.
 */

interface Props {
  open: boolean
  onClose: () => void
}

const GROUPS = ['Экстренные', 'Сотрудники', 'Службы отеля', 'Подрядчики', 'Прочее'] as const

const GROUP_COLORS: Record<string, string> = {
  'Экстренные':   'var(--s-overdue)',
  'Сотрудники':   'var(--accent)',
  'Службы отеля': 'var(--s-in)',
  'Подрядчики':   'var(--s-out)',
  'Прочее':       'var(--s-maint)',
}

// Ширина контента раздела. Раньше была колонка 720px по центру — на окне 1400px
// половина экрана пустовала, и раздел выглядел уже остального приложения.
// Объявлено ДО компонента: константы ниже него ломают горячую перезагрузку (TDZ).
const contentWrap: React.CSSProperties = { maxWidth: 1280, margin: '0 auto' }

// Иконки действий — SVG в том же стиле Lucide, что в шапке и меню
// (в разделах настроек до сих пор текстовые глифы ✎ и ✕, это заметно дешевит).
const ICON_EDIT = <path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
const ICON_TRASH = <><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>
const ICON_STAR = <path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01Z" />

const onlyDigits = (s: string) => s.replace(/\D/g, '')

/** Группа контакта, приведённая к пресету: значение не из списка считаем «Прочее». */
const groupOf = (c: Contact) => ((GROUPS as readonly string[]).includes(c.group) ? c.group : 'Прочее')

interface FormState {
  name: string; role: string; group: string
  phones: string[]; email: string; notes: string; isPinned: boolean
}

const emptyForm = (): FormState => ({
  name: '', role: '', group: 'Службы отеля',
  phones: [''], email: '', notes: '', isPinned: false,
})

export const ReferenceWindow: React.FC<Props> = ({ open, onClose }) => {
  const admin = useAuthStore(s => s.admin)
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('all')
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [error, setError] = useState('')
  const [toast, setToast] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  const load = () => {
    setLoading(true)
    fetchContacts()
      .then(c => { setContacts(c); setLoading(false) })
      .catch(() => setLoading(false))
  }

  useEffect(() => {
    if (!open) return
    load()
    setQuery('')
    setGroupFilter('all')
    setEditId(null)
    const t = window.setTimeout(() => searchRef.current?.focus(), 60)
    return () => window.clearTimeout(t)
  }, [open])

  // Escape закрывает сначала форму, и только потом весь раздел — иначе одно
  // нажатие выбрасывало бы из справочника вместе с недописанной записью.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (editId !== null) { setEditId(null); setError(''); return }
      onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, editId])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const flash = (text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 1800)
  }

  // Копирование номера: в Electron окно грузится из file://, поэтому держим
  // запасной путь через execCommand, если Clipboard API недоступен.
  const copyPhone = async (phone: string) => {
    try {
      await navigator.clipboard.writeText(phone)
      flash(`Скопировано: ${phone}`)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = phone
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      flash(ok ? `Скопировано: ${phone}` : 'Не удалось скопировать')
    }
  }

  // ─── Поиск ────────────────────────────────────────────────────────────────
  const searchFiltered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    const qDigits = onlyDigits(q)
    return contacts.filter(c => {
      if (c.name.toLowerCase().includes(q)) return true
      if (c.role?.toLowerCase().includes(q)) return true
      if (c.notes?.toLowerCase().includes(q)) return true
      if (c.group.toLowerCase().includes(q)) return true
      if (c.email?.toLowerCase().includes(q)) return true
      if (qDigits && c.phones.some(p => onlyDigits(p).includes(qDigits))) return true
      return false
    })
  }, [contacts, query])

  // Чипы строятся по ВСЕМ контактам (какие группы вообще заведены), а счётчики —
  // по результатам поиска. Так ряд чипов не прыгает, пока пользователь печатает.
  const chips = useMemo(() => {
    const present = GROUPS.filter(g => contacts.some(c => groupOf(c) === g))
    return present.map(g => ({
      key: g,
      label: g,
      color: GROUP_COLORS[g] ?? 'var(--s-maint)',
      count: searchFiltered.filter(c => groupOf(c) === g).length,
    }))
  }, [contacts, searchFiltered])

  const visible = useMemo(
    () => (groupFilter === 'all' ? searchFiltered : searchFiltered.filter(c => groupOf(c) === groupFilter)),
    [searchFiltered, groupFilter],
  )

  const sections = useMemo(() => {
    // Выбрана конкретная группа — заголовки групп не нужны, показываем один список
    // (закреплённые внутри него идут первыми, порядок приходит с сервера).
    if (groupFilter !== 'all') {
      return visible.length
        ? [{ title: groupFilter, color: GROUP_COLORS[groupFilter] ?? 'var(--s-maint)', items: visible }]
        : []
    }
    // «Все» — закреплённые отдельной группой сверху, остальные по порядку пресета.
    const pinned = visible.filter(c => c.isPinned)
    const rest = visible.filter(c => !c.isPinned)
    const out: { title: string; color: string; items: Contact[] }[] = []
    if (pinned.length) out.push({ title: '★ Закреплённые', color: 'var(--accent)', items: pinned })
    for (const g of GROUPS) {
      const items = rest.filter(c => groupOf(c) === g)
      if (items.length) out.push({ title: g, color: GROUP_COLORS[g] ?? 'var(--s-maint)', items })
    }
    return out
  }, [visible, groupFilter])

  // Для экрана — один сплошной поток карточек: заголовок группы на всю ширину
  // разрывал бы ряд, и хвост каждой группы оставался бы пустым. Порядок при этом
  // сохраняется (закреплённые → группы по пресету), а группу кодируют цвет кружка
  // и чипы над списком. Для печати `sections` остаются — на бумаге сетки нет.
  const ordered = useMemo(() => sections.flatMap(s => s.items), [sections])

  // ─── Форма ────────────────────────────────────────────────────────────────
  const startEdit = (c?: Contact) => {
    if (c) {
      setEditId(c.id)
      setForm({
        name: c.name, role: c.role ?? '', group: c.group,
        phones: c.phones.length ? [...c.phones] : [''],
        email: c.email ?? '', notes: c.notes ?? '', isPinned: c.isPinned,
      })
    } else {
      setEditId('new')
      setForm(emptyForm())
    }
    setError('')
  }

  const closeForm = () => { setEditId(null); setError('') }

  const save = async (keepOpen = false) => {
    if (!form.name.trim()) { setError('Введите имя или название'); return }
    const payload = {
      name: form.name,
      role: form.role,
      group: form.group,
      phones: form.phones.map(p => p.trim()).filter(Boolean),
      email: form.email,
      notes: form.notes,
      isPinned: form.isPinned,
    }
    try {
      if (editId === 'new') await createContact(payload)
      else if (typeof editId === 'number') await updateContact(editId, payload)

      if (keepOpen) {
        // Группу оставляем выбранной: при заполнении подряд идут записи одной группы.
        flash(`Сохранено: ${form.name.trim()}`)
        setForm({ ...emptyForm(), group: form.group })
        setError('')
        window.setTimeout(() => nameRef.current?.focus(), 0)
      } else {
        closeForm()
      }
      load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (c: Contact) => {
    if (!confirm(`Удалить контакт «${c.name}»?`)) return
    try { await deleteContact(c.id); load() }
    catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      alert(err?.response?.data?.error ?? 'Ошибка удаления')
    }
  }

  // ─── Печать ───────────────────────────────────────────────────────────────
  // Через скрытый iframe: window.open в Electron перехватывается и уводит
  // страницу во внешний браузер.
  const print = () => {
    const rows = sections.map(sec => `
      <h2>${escapeHtml(sec.title)}</h2>
      <table>
        ${sec.items.map(c => `
          <tr>
            <td class="n">${escapeHtml(c.name)}${c.role ? ` <span class="r">· ${escapeHtml(c.role)}</span>` : ''}</td>
            <td class="p">${c.phones.map(escapeHtml).join('<br>') || '—'}</td>
            <td class="c">${escapeHtml(c.notes ?? '')}</td>
          </tr>`).join('')}
      </table>`).join('')

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Справочник</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 11pt; color: #000; margin: 18mm 14mm; }
        h1 { font-size: 15pt; margin: 0 0 4mm; }
        h2 { font-size: 11pt; margin: 6mm 0 2mm; padding-bottom: 1mm; border-bottom: 1px solid #000; }
        table { width: 100%; border-collapse: collapse; }
        td { padding: 1.5mm 2mm 1.5mm 0; vertical-align: top; border-bottom: 1px solid #ddd; }
        td.n { width: 42%; } td.p { width: 30%; white-space: nowrap; } td.c { width: 28%; color: #444; font-size: 9.5pt; }
        .r { color: #555; font-weight: normal; }
        td.n { font-weight: bold; }
      </style></head>
      <body><h1>Справочник контактов</h1>${rows}</body></html>`

    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.right = '0'
    frame.style.bottom = '0'
    frame.style.width = '0'
    frame.style.height = '0'
    frame.style.border = '0'
    document.body.appendChild(frame)
    const doc = frame.contentWindow?.document
    if (!doc) { document.body.removeChild(frame); return }
    doc.open(); doc.write(html); doc.close()
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    window.setTimeout(() => document.body.removeChild(frame), 1000)
  }

  if (!open) return null

  const Form = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Имя или название">
          <input ref={nameRef} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="Ерлан / Прачечная «Астра»" style={inputStyle} autoFocus />
        </Field>
        <Field label="Кто это">
          <input value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
            placeholder="Сантехник" style={inputStyle} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Группа">
          <select value={form.group} onChange={e => setForm({ ...form, group: e.target.value })} style={inputStyle}>
            {GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
        </Field>
        <Field label="Почта">
          <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })}
            placeholder="—" style={inputStyle} />
        </Field>
      </div>

      <Field label="Телефоны">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {form.phones.map((p, i) => (
            <div key={i} style={{ display: 'flex', gap: 6 }}>
              <input
                value={p}
                onChange={e => {
                  const next = [...form.phones]; next[i] = e.target.value
                  setForm({ ...form, phones: next })
                }}
                placeholder="+7 701 234 56 78"
                style={inputStyle}
              />
              {form.phones.length > 1 && (
                <button type="button" onClick={() => setForm({ ...form, phones: form.phones.filter((_, j) => j !== i) })}
                  style={{ ...iconBtn, color: 'var(--s-overdue)' }} title="Убрать номер">✕</button>
              )}
            </div>
          ))}
          {form.phones.length < 5 && (
            <button type="button" onClick={() => setForm({ ...form, phones: [...form.phones, ''] })}
              style={{
                alignSelf: 'flex-start', background: 'transparent', border: '1px dashed var(--border)',
                borderRadius: 8, padding: '6px 12px', fontSize: '0.82rem', color: 'var(--text-muted)',
                cursor: 'pointer', fontFamily: 'inherit',
              }}>+ ещё номер</button>
          )}
        </div>
      </Field>

      <Field label="Заметка">
        <textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
          placeholder="Звонить после 9:00"
          style={{ ...inputStyle, height: 'auto', padding: '8px 12px', resize: 'vertical' }} />
      </Field>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.86rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={form.isPinned} onChange={e => setForm({ ...form, isPinned: e.target.checked })} />
        Закрепить наверху
      </label>

      {error && <div style={errorStyle}>{error}</div>}
    </>
  )

  return (
    // Обычный экран в потоке приложения, а не окно поверх сетки.
    <div style={{
      flex: 1, minHeight: 0, background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      color: 'var(--text)', overflow: 'hidden',
    }}>
      {/* Шапка */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 24px',
        height: 60, borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: '1.08rem', fontWeight: 700, letterSpacing: '-0.01em' }}>Справочник</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
          {contacts.length ? `${contacts.length} ${contactWord(contacts.length)}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={print} style={secondaryBtn} title="Распечатать список">Печать</button>
        {canEdit && <AddButton onClick={() => startEdit()} label="Добавить контакт" />}
        <button onClick={onClose} title="К шахматке (Esc)" style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.5rem',
          color: 'var(--text-faint)', padding: '0 4px', lineHeight: 1, fontWeight: 300,
        }}>×</button>
      </div>

      {/* Поиск и группы — по левому краю контента, а не по центру узкой колонки */}
      <div style={{ padding: '16px 24px 12px', flexShrink: 0 }}>
        <div style={contentWrap}>
          <div style={{ position: 'relative', maxWidth: 560 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
              strokeWidth="2" strokeLinecap="round"
              style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Поиск: имя, должность или номер…"
              style={{ ...inputStyle, height: 44, paddingLeft: 40, fontSize: '0.95rem' }}
            />
            {query && (
              <button onClick={() => { setQuery(''); searchRef.current?.focus() }} title="Очистить"
                style={{
                  position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
                  fontSize: '1.1rem', lineHeight: 1,
                }}>×</button>
            )}
          </div>

          {/* Чипы групп — тот же приём, что у фильтров статусов в шахматке */}
          {chips.length > 1 && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
              marginTop: 10, padding: 4, background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)', borderRadius: 10,
            }}>
              <GroupPill
                active={groupFilter === 'all'}
                label="Все"
                count={searchFiltered.length}
                onClick={() => setGroupFilter('all')}
              />
              {chips.map(ch => (
                <GroupPill
                  key={ch.key}
                  active={groupFilter === ch.key}
                  label={ch.label}
                  count={ch.count}
                  dotColor={ch.color}
                  onClick={() => setGroupFilter(groupFilter === ch.key ? 'all' : ch.key)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Список */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 24px 32px' }}>
        <div style={contentWrap}>


          {loading ? (
            <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-faint)' }}>Загрузка…</div>
          ) : contacts.length === 0 ? (
            <EmptyBox>
              Справочник пока пуст.<br />
              {canEdit
                ? 'Добавьте сантехника, электрика, прачечную, такси — всех, кому звонят со стойки.'
                : 'Контакты добавляет администратор.'}
            </EmptyBox>
          ) : sections.length === 0 ? (
            <EmptyBox>
              {query && groupFilter !== 'all'
                ? <>По запросу «{query}» в группе «{groupFilter}» ничего нет.{' '}
                    <LinkBtn onClick={() => setGroupFilter('all')}>Искать во всех группах</LinkBtn></>
                : query
                  ? <>По запросу «{query}» ничего не найдено</>
                  : <>В группе «{groupFilter}» пока пусто</>}
            </EmptyBox>
          ) : (
            <div style={{
              display: 'grid', gap: 10,
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            }}>
              {ordered.map(c => (
                <ContactCard
                  key={c.id}
                  contact={c}
                  color={GROUP_COLORS[groupOf(c)] ?? 'var(--s-maint)'}
                  editing={editId === c.id}
                  canEdit={canEdit}
                  onCopy={copyPhone}
                  onEdit={() => startEdit(c)}
                  onRemove={() => remove(c)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Форма — модальным окном, как бронь и перемещение. Раньше она открывалась
          сверху списка: нажимаешь карандаш на нижней карточке, а форма появляется
          за пределами экрана — визуально не происходило ничего. */}
      {editId !== null && (
        <div
          onClick={e => { if (e.target === e.currentTarget) closeForm() }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
          }}
        >
          <div style={{
            background: 'var(--bg)', borderRadius: 14, width: '100%', maxWidth: 620,
            maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column',
            boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)', overflow: 'hidden',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px',
              borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
            }}>
              <span style={{ ...formTitle, fontSize: '1rem' }}>
                {editId === 'new'
                  ? 'Новый контакт'
                  : `Правка: ${contacts.find(c => c.id === editId)?.name ?? ''}`}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={closeForm} title="Закрыть (Esc)" style={{
                background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.4rem',
                color: 'var(--text-faint)', padding: '0 2px', lineHeight: 1, fontWeight: 300,
              }}>×</button>
            </div>

            <div style={{
              flex: 1, overflowY: 'auto', padding: '18px 20px',
              display: 'flex', flexDirection: 'column', gap: 12,
            }}>
              {Form}
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px',
              borderTop: '1px solid var(--border-subtle)', flexShrink: 0,
            }}>
              <button onClick={closeForm} style={secondaryBtn}>Отмена</button>
              <span style={{ flex: 1 }} />
              {/* Первичное заполнение справочника — это десяток записей подряд,
                  поэтому даём сохранить и сразу продолжить, не закрывая окно. */}
              {editId === 'new' && (
                <button onClick={() => save(true)} style={secondaryBtn}>Сохранить и добавить ещё</button>
              )}
              <button onClick={() => save(false)} style={primaryBtn}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* Уведомление о копировании */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 26, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--text)', color: 'var(--text-inverse)', padding: '9px 16px',
          borderRadius: 8, fontSize: '0.85rem', fontWeight: 500, boxShadow: 'var(--shadow-md)',
          zIndex: 520, pointerEvents: 'none',
        }}>{toast}</div>
      )}
    </div>
  )
}

const CardIconBtn: React.FC<{
  onClick: () => void
  title: string
  icon: React.ReactNode
  danger?: boolean
}> = ({ onClick, title, icon, danger = false }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width: 26, height: 26, flexShrink: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'transparent', border: 'none', borderRadius: 6,
      color: danger ? 'var(--s-overdue)' : 'var(--text-faint)',
      cursor: 'pointer', transition: 'background 0.12s, color 0.12s',
    }}
    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface-2)' }}
    onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{icon}</svg>
  </button>
)

const ContactCard: React.FC<{
  contact: Contact
  color: string
  editing: boolean
  canEdit: boolean
  onCopy: (phone: string) => void
  onEdit: () => void
  onRemove: () => void
}> = ({ contact: c, color, editing, canEdit, onCopy, onEdit, onRemove }) => (
  <div style={{
    display: 'flex', flexDirection: 'column', gap: 9, padding: '13px 14px',
    background: 'var(--surface)', borderRadius: 10,
    border: `1px solid ${editing ? 'var(--accent)' : 'var(--border-subtle)'}`,
    boxShadow: editing ? 'var(--shadow-sm)' : 'none',
  }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      {/* Кружок с буквой в цвете группы — тот же приём, что у аватара админа в шапке */}
      <div style={{
        width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color, fontSize: '0.9rem', fontWeight: 700,
      }}>
        {c.name.trim().charAt(0).toUpperCase()}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          {c.isPinned && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="none"
              style={{ flexShrink: 0 }} aria-label="Закреплён">{ICON_STAR}</svg>
          )}
          <span style={{
            fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{c.name}</span>
        </div>
        {c.role && (
          <div style={{
            fontSize: '0.79rem', color: 'var(--text-faint)', marginTop: 1,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{c.role}</div>
        )}
      </div>

      {canEdit && (
        <div style={{ display: 'flex', gap: 1 }}>
          <CardIconBtn onClick={onEdit} title="Редактировать" icon={ICON_EDIT} />
          <CardIconBtn onClick={onRemove} title="Удалить" icon={ICON_TRASH} danger />
        </div>
      )}
    </div>

    {/* Телефоны — рядом с именем, а не у противоположного края строки */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {c.phones.length === 0 && (
        <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>номера нет</span>
      )}
      {c.phones.map(p => (
        <button
          key={p}
          onClick={() => onCopy(p)}
          title="Нажмите, чтобы скопировать"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
            borderRadius: 7, padding: '4px 9px', fontSize: '0.86rem', fontWeight: 600,
            color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            transition: 'background 0.12s, border-color 0.12s',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--accent-bg)'
            e.currentTarget.style.borderColor = 'var(--accent)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'var(--surface-2)'
            e.currentTarget.style.borderColor = 'var(--border-subtle)'
          }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
          </svg>
          {p}
        </button>
      ))}
    </div>

    {(c.notes || c.email) && (
      <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
        {c.notes}
        {c.notes && c.email && <br />}
        {c.email}
      </div>
    )}
  </div>
)

const LinkBtn: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button onClick={onClick} style={{
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: 'var(--accent)', fontFamily: 'inherit', fontSize: 'inherit',
    fontWeight: 600, textDecoration: 'underline',
  }}>{children}</button>
)

const GroupPill: React.FC<{
  active: boolean
  label: string
  count: number
  dotColor?: string
  onClick: () => void
}> = ({ active, label, count, dotColor, onClick }) => (
  <button
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 12px',
      borderRadius: 7, fontFamily: 'inherit', fontSize: '0.86rem',
      cursor: 'pointer', whiteSpace: 'nowrap', border: 'none',
      background: active ? 'var(--bg)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-muted)',
      fontWeight: active ? 600 : 500,
      boxShadow: active ? 'var(--shadow-sm)' : 'none',
      opacity: count === 0 && !active ? 0.45 : 1,
      transition: 'background 0.12s, opacity 0.12s',
    }}
  >
    {dotColor && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />}
    {label}
    <span style={{ color: 'var(--text-faint)', fontWeight: 500, fontSize: '0.8rem' }}>{count}</span>
  </button>
)

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={labelStyle}>{label}</label>
    {children}
  </div>
)

function contactWord(n: number) {
  const t = n % 100
  if (t >= 11 && t <= 14) return 'контактов'
  switch (n % 10) {
    case 1: return 'контакт'
    case 2: case 3: case 4: return 'контакта'
    default: return 'контактов'
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
  ))
}
