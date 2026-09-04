import React, { useState } from 'react'
import type { AdminForm, FieldErrors, StaffDraft, StaffInput, StaffRole } from './setupModel'
import { emptyStaff, newStaffKey, validateStaff } from './setupModel'
import { PASSWORD_HINT, ROLE_LABELS } from './accountRules'
import { Field, StepHeading, hintStyle, linkBtn, wizardInput, wizardSecondary } from './setupUi'

interface Props {
  staff: StaffDraft[]
  admin: AdminForm
  onAdd: (item: StaffDraft) => void
  onRemove: (key: string) => void
}

// Шаг 3 — сотрудники (необязательно). Собственная форма добавления + таблица
// добавленных. Пароли в таблице скрыты, но их можно показать — их ещё нужно
// передать сотрудникам.
export const StepUsers: React.FC<Props> = ({ staff, admin, onAdd, onRemove }) => {
  const [draft, setDraft] = useState<StaffInput>(emptyStaff())
  const [errors, setErrors] = useState<FieldErrors<StaffInput>>({})
  const [showPasswords, setShowPasswords] = useState(false)

  const patch = (p: Partial<StaffInput>) => { setDraft(d => ({ ...d, ...p })); setErrors({}) }

  const add = (e: React.FormEvent) => {
    e.preventDefault()
    const errs = validateStaff(draft, admin, staff)
    if (Object.keys(errs).length) { setErrors(errs); return }
    onAdd({ ...draft, key: newStaffKey(), name: draft.name.trim(), username: draft.username.trim() })
    setDraft(emptyStaff())
    setErrors({})
  }

  return (
    <>
      <StepHeading
        title="Сотрудники"
        text="Учётные записи администраторов и сотрудников стойки. Шаг можно пропустить — пользователей легко добавить позже в Настройки → Пользователи."
      />

      <form onSubmit={add} noValidate style={{
        padding: 16, background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 10,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Имя" error={errors.name}>
            <input value={draft.name} onChange={e => patch({ name: e.target.value })} placeholder="Имя сотрудника" style={wizardInput} maxLength={80} autoComplete="off" autoFocus />
          </Field>
          <Field label="Логин" error={errors.username}>
            <input value={draft.username} onChange={e => patch({ username: e.target.value })} placeholder="латиница, цифры, . _ -" style={wizardInput} maxLength={30} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label="Пароль" error={errors.password} hint={PASSWORD_HINT}>
            <input type={showPasswords ? 'text' : 'password'} value={draft.password} onChange={e => patch({ password: e.target.value })} style={wizardInput} autoComplete="new-password" />
          </Field>
          <Field label="Роль">
            <select value={draft.role} onChange={e => patch({ role: e.target.value as StaffRole })} style={wizardInput}>
              <option value="STAFF">{ROLE_LABELS.STAFF}</option>
              <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
            </select>
          </Field>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="submit" style={wizardSecondary}>Добавить</button>
        </div>
      </form>

      {staff.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)' }}>Добавлено: {staff.length}</span>
            <button type="button" onClick={() => setShowPasswords(s => !s)} style={linkBtn}>
              {showPasswords ? 'Скрыть пароли' : 'Показать пароли'}
            </button>
          </div>
          <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.86rem' }}>
              <thead>
                <tr style={{ background: 'var(--surface)' }}>
                  <th style={th}>Имя</th>
                  <th style={th}>Логин</th>
                  <th style={th}>Пароль</th>
                  <th style={th}>Роль</th>
                  <th style={{ ...th, width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {staff.map(s => (
                  <tr key={s.key} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <td style={td}>{s.name}</td>
                    <td style={td} className="mono">{s.username}</td>
                    <td style={td} className="mono">{showPasswords ? s.password : '••••••••'}</td>
                    <td style={td}>{ROLE_LABELS[s.role]}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button type="button" onClick={() => onRemove(s.key)} title="Убрать" style={removeBtn}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div style={{ ...hintStyle, marginTop: 14, textAlign: 'center' }}>
          Пока никого не добавлено — нажмите «Пропустить», если сотрудники появятся позже.
        </div>
      )}
    </>
  )
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: '0.74rem', fontWeight: 600,
  color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em',
}
const td: React.CSSProperties = { padding: '8px 12px', color: 'var(--text)', verticalAlign: 'middle' }
const removeBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '0.95rem',
  color: 'var(--s-overdue)', padding: '2px 6px', borderRadius: 6, lineHeight: 1,
}
