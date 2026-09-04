import React, { useEffect, useState } from 'react'
import { createUser, fetchUsers, resetUserPassword, updateUser } from '../../../api/users'
import { useAuthStore } from '../../../store/useAuthStore'
import type { AdminRole, User } from '../../../types'
import {
  ROLE_LABELS, formatApiError, sameUsername, validateName, validatePassword, validateUsername,
} from '../../Setup/accountRules'
import {
  SectionHeader, AddButton, EmptyBox, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
} from './sectionUi'

// Настройки → Пользователи: учётные записи сотрудников (роль, доступ, пароль).
// Только для главного администратора — остальным раздел показывает пояснение.
export const UsersSection: React.FC = () => {
  const { admin } = useAuthStore()
  if (!admin || admin.role !== 'SUPER_ADMIN') {
    return (
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        <SectionHeader title="Пользователи" />
        <EmptyBox>Управление пользователями доступно главному администратору</EmptyBox>
      </div>
    )
  }
  return <UsersManager currentId={admin.id} />
}

const ROLE_OPTIONS: AdminRole[] = ['SUPER_ADMIN', 'ADMIN', 'STAFF']

interface NewUserForm { name: string; username: string; password: string; role: AdminRole }
const emptyNewUser = (): NewUserForm => ({ name: '', username: '', password: '', role: 'STAFF' })

const UsersManager: React.FC<{ currentId: number }> = ({ currentId }) => {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Ошибка конкретной строки (смена роли / активности) и «занятая» строка
  const [rowError, setRowError] = useState<{ id: number; text: string } | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<NewUserForm>(emptyNewUser())
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // Мини-форма сброса пароля — открыта для одного пользователя за раз
  const [resetId, setResetId] = useState<number | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetDoneId, setResetDoneId] = useState<number | null>(null)

  const load = () => {
    setLoading(true)
    fetchUsers()
      .then(list => { setUsers(list); setError('') })
      .catch(e => setError(formatApiError(e, 'Не удалось загрузить пользователей')))
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    if (resetDoneId === null) return
    const t = setTimeout(() => setResetDoneId(null), 2500)
    return () => clearTimeout(t)
  }, [resetDoneId])

  const replaceUser = (u: User) => setUsers(list => list.map(x => (x.id === u.id ? u : x)))

  const patch = async (u: User, payload: { role?: AdminRole; isActive?: boolean }) => {
    setBusyId(u.id)
    setRowError(null)
    try {
      replaceUser(await updateUser(u.id, payload))
    } catch (e) {
      setRowError({ id: u.id, text: formatApiError(e, 'Не удалось сохранить') })
    } finally {
      setBusyId(null)
    }
  }

  const startReset = (id: number) => { setResetId(id); setResetPassword(''); setResetError('') }
  const doReset = async (u: User) => {
    const err = validatePassword(resetPassword)
    if (err) { setResetError(err); return }
    setBusyId(u.id)
    setResetError('')
    try {
      await resetUserPassword(u.id, resetPassword)
      setResetId(null)
      setResetPassword('')
      setResetDoneId(u.id)
    } catch (e) {
      setResetError(formatApiError(e, 'Не удалось сменить пароль'))
    } finally {
      setBusyId(null)
    }
  }

  const startAdd = () => { setAdding(true); setForm(emptyNewUser()); setFormError('') }
  const submitAdd = async () => {
    const err = validateName(form.name) || validateUsername(form.username) || validatePassword(form.password)
    if (err) { setFormError(err); return }
    if (users.some(u => sameUsername(u.username, form.username))) { setFormError('Такой логин уже занят'); return }
    setSaving(true)
    setFormError('')
    try {
      const created = await createUser({
        name: form.name.trim(), username: form.username.trim(), password: form.password, role: form.role,
      })
      setUsers(list => [...list, created])
      setAdding(false)
    } catch (e) {
      setFormError(formatApiError(e, 'Не удалось создать пользователя'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Пользователи"
        subtitle="Учётные записи сотрудников: роли, доступ и пароли."
        action={<AddButton onClick={startAdd} label="Добавить пользователя" />}
      />

      {adding && (
        <div style={formCard}>
          <div style={formTitle}>Новый пользователь</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Имя</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} maxLength={80} autoComplete="off" style={inputStyle} autoFocus />
            </div>
            <div>
              <label style={labelStyle}>Логин</label>
              <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="латиница, цифры, . _ -" maxLength={30} autoComplete="off" spellCheck={false} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Пароль</label>
              <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="не менее 8 символов" autoComplete="new-password" style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Роль</label>
              <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value as AdminRole }))} style={inputStyle}>
                {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
          </div>
          {formError && <div style={errorStyle}>{formError}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setAdding(false)} style={secondaryBtn}>Отмена</button>
            <button onClick={submitAdd} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
              {saving ? 'Сохраняем…' : 'Создать'}
            </button>
          </div>
        </div>
      )}

      {error && <div style={{ ...errorStyle, marginTop: 12 }}>{error}</div>}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
          {users.length === 0 && !error && <EmptyBox>Пользователей пока нет</EmptyBox>}

          {users.map(u => {
            const isMe = u.id === currentId
            const busy = busyId === u.id
            return (
              <div key={u.id}>
                <div style={{ ...listRow, opacity: u.isActive ? 1 : 0.6 }}>
                  <div style={avatar}>{initials(u.name)}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={itemTitle}>
                      {u.name}
                      {isMe && <span style={tag}>это вы</span>}
                      {!u.isActive && <span style={tag}>неактивен</span>}
                    </div>
                    <div style={itemSub}>
                      <span className="mono">{u.username}</span> · с {formatDate(u.createdAt)}
                    </div>
                  </div>

                  <select
                    value={u.role}
                    disabled={isMe || busy}
                    onChange={e => patch(u, { role: e.target.value as AdminRole })}
                    title={isMe ? 'Свою роль изменить нельзя' : 'Роль'}
                    style={{ ...inputStyle, width: 200, height: 34, flexShrink: 0 }}
                  >
                    {ROLE_OPTIONS.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>

                  <Switch
                    checked={u.isActive}
                    disabled={isMe || busy}
                    onChange={() => patch(u, { isActive: !u.isActive })}
                    title={isMe ? 'Нельзя деактивировать себя' : u.isActive ? 'Активен — нажмите, чтобы закрыть доступ' : 'Неактивен — нажмите, чтобы открыть доступ'}
                  />

                  <button
                    onClick={() => (resetId === u.id ? setResetId(null) : startReset(u.id))}
                    disabled={busy}
                    style={{ ...secondaryBtn, height: 32, padding: '0 12px', fontSize: '0.8rem', whiteSpace: 'nowrap' }}
                  >
                    Сбросить пароль
                  </button>
                </div>

                {rowError?.id === u.id && <div style={{ ...errorStyle, padding: '4px 14px 0' }}>{rowError.text}</div>}
                {resetDoneId === u.id && <div style={{ fontSize: '0.82rem', color: 'var(--s-in)', padding: '4px 14px 0' }}>Пароль обновлён</div>}

                {resetId === u.id && (
                  <div style={{ ...formCard, marginTop: 6 }}>
                    <div style={formTitle}>Новый пароль — {u.name}</div>
                    <div style={{ maxWidth: 320 }}>
                      <label style={labelStyle}>Пароль</label>
                      <input
                        type="password"
                        value={resetPassword}
                        onChange={e => setResetPassword(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') doReset(u) }}
                        placeholder="не менее 8 символов"
                        autoComplete="new-password"
                        style={inputStyle}
                        autoFocus
                      />
                    </div>
                    {resetError && <div style={errorStyle}>{resetError}</div>}
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                      <button onClick={() => setResetId(null)} style={secondaryBtn}>Отмена</button>
                      <button onClick={() => doReset(u)} disabled={busy} style={primaryBtn}>Сохранить пароль</button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Переключатель «активен» в стиле приложения. */
const Switch: React.FC<{ checked: boolean; disabled?: boolean; onChange: () => void; title?: string }> = ({ checked, disabled, onChange, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    title={title}
    onClick={onChange}
    style={{
      width: 36, height: 20, borderRadius: 10, border: 'none', padding: 2, flexShrink: 0,
      background: checked ? 'var(--accent)' : 'var(--surface-3)',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      transition: 'background 0.15s',
    }}
  >
    <span style={{
      display: 'block', width: 16, height: 16, borderRadius: '50%', background: '#fff',
      transform: checked ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 0.15s',
      boxShadow: 'var(--shadow-sm)',
    }} />
  </button>
)

const initials = (name: string) => name.split(' ').filter(Boolean).map(p => p[0]).slice(0, 2).join('').toUpperCase()
const formatDate = (iso: string) => {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ru-RU')
}

const avatar: React.CSSProperties = {
  width: 30, height: 30, borderRadius: '50%', background: 'var(--surface-3)', flexShrink: 0,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)',
}
const tag: React.CSSProperties = {
  marginLeft: 8, padding: '1px 7px', borderRadius: 5, fontSize: '0.72rem', fontWeight: 500,
  color: 'var(--text-faint)', border: '1px solid var(--border-subtle)', verticalAlign: 'middle',
}
