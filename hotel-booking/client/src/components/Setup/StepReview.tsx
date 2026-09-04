import React from 'react'
import type { AdminForm, HotelForm, StaffDraft } from './setupModel'
import { describeField } from './setupModel'
import { ROLE_LABELS, type ParsedApiError } from './accountRules'
import { ErrorBox, StepHeading, linkBtn } from './setupUi'

interface Props {
  hotel: HotelForm
  admin: AdminForm
  staff: StaffDraft[]
  /** Ошибка последней попытки завершить настройку (ответ сервера). */
  error: ParsedApiError | null
}

// Шаг 4 — сводка перед отправкой. Здесь же показываем ошибки сервера, в т.ч. по полям.
export const StepReview: React.FC<Props> = ({ hotel, admin, staff, error }) => (
  <>
    <StepHeading
      title="Проверка"
      text="Убедитесь, что всё верно. После завершения вы войдёте в систему как главный администратор."
    />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Block title="Отель">
        <Row label="Название" value={hotel.name.trim()} />
        <Row label="Город" value={hotel.city.trim() || '—'} />
      </Block>
      <Block title="Главный администратор">
        <Row label="Имя" value={admin.name.trim()} />
        <Row label="Логин" value={admin.username.trim()} mono />
        <Row label="Пароль" value="задан" />
      </Block>
      <Block title={`Сотрудники${staff.length ? ` · ${staff.length}` : ''}`}>
        {staff.length === 0
          ? <div style={{ fontSize: '0.86rem', color: 'var(--text-faint)' }}>Не добавлены — это можно сделать позже</div>
          : staff.map(s => <Row key={s.key} label={s.name} value={`${s.username} · ${ROLE_LABELS[s.role]}`} mono />)}
      </Block>
    </div>

    {error && (
      <div style={{ marginTop: 16 }}>
        <ErrorBox>
          <div style={{ fontWeight: 600 }}>{error.message}</div>
          {error.details.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {error.details.map((d, i) => (
                <li key={i}>{describeField(d.field, staff)}: {d.message}</li>
              ))}
            </ul>
          )}
          {error.status === 403 && (
            <div style={{ marginTop: 8 }}>
              Похоже, настройка уже выполнена (например, с другого компьютера).{' '}
              <button type="button" onClick={() => window.location.reload()} style={{ ...linkBtn, fontSize: '0.86rem' }}>
                Перейти ко входу
              </button>
            </div>
          )}
        </ErrorBox>
      </div>
    )}
  </>
)

const Block: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
    <div style={{
      fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-faint)',
      textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8,
    }}>{title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
  </div>
)

const Row: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div style={{ display: 'flex', gap: 12, fontSize: '0.88rem' }}>
    <span style={{ color: 'var(--text-faint)', minWidth: 130, flexShrink: 0 }}>{label}</span>
    <span className={mono ? 'mono' : undefined} style={{ color: 'var(--text)', fontWeight: 500, wordBreak: 'break-word' }}>{value}</span>
  </div>
)
