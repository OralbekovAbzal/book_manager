import React from 'react'
import type { AdminForm, FieldErrors } from './setupModel'
import { Field, StepHeading, wizardInput } from './setupUi'

interface Props {
  value: AdminForm
  errors: FieldErrors<AdminForm>
  onChange: (patch: Partial<AdminForm>) => void
}

// Шаг 2 — главный администратор (владелец/управляющий): первая учётная запись, роль SUPER_ADMIN.
export const StepAdmin: React.FC<Props> = ({ value, errors, onChange }) => (
  <>
    <StepHeading
      title="Главный администратор"
      text="Владелец или управляющий отеля. Эта учётная запись управляет пользователями и всеми настройками — запомните пароль."
    />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Имя" error={errors.name}>
        <input
          value={value.name}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="Как к вам обращаться"
          style={wizardInput}
          maxLength={80}
          autoComplete="off"
          autoFocus
        />
      </Field>
      <Field label="Логин" error={errors.username} hint="Латинские буквы, цифры и символы . _ - (от 3 до 30 символов)">
        <input
          value={value.username}
          onChange={e => onChange({ username: e.target.value })}
          placeholder="admin"
          style={wizardInput}
          maxLength={30}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Пароль" error={errors.password} hint="Не менее 8 символов">
          <input
            type="password"
            value={value.password}
            onChange={e => onChange({ password: e.target.value })}
            style={wizardInput}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Подтверждение пароля" error={errors.passwordConfirm}>
          <input
            type="password"
            value={value.passwordConfirm}
            onChange={e => onChange({ passwordConfirm: e.target.value })}
            style={wizardInput}
            autoComplete="new-password"
          />
        </Field>
      </div>
    </div>
  </>
)
