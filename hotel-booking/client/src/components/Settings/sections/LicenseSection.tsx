import React, { useEffect } from 'react'
import { useLicenseStore } from '../../../store/useLicenseStore'
import { useAuthStore } from '../../../store/useAuthStore'
import {
  LicenseKeyForm, LicenseWarningNote,
  LICENSE_STATE_TITLE, licenseStateNote, licenseStateColor, formatIsoRu, pluralDays,
} from '../../License/licenseUi'
import { SectionHeader, formCard, errorStyle } from './sectionUi'

// Настройки → Лицензия. Рядом с «О программе» и по её образцу: состояние
// человеческими словами + одно действие. Разница в том, что обновления живут
// в Electron, а лицензия — на сервере, поэтому состояние берётся из стора.

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  gap: 16, padding: '7px 0', borderBottom: '1px solid var(--border-subtle)',
}

const rowLabel: React.CSSProperties = { fontSize: '0.84rem', color: 'var(--text-faint)', whiteSpace: 'nowrap' }
const rowValue: React.CSSProperties = { fontSize: '0.9rem', color: 'var(--text)', textAlign: 'right' }

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={rowStyle}>
    <span style={rowLabel}>{label}</span>
    <span style={rowValue}>{children}</span>
  </div>
)

export const LicenseSection: React.FC = () => {
  const { info, loading, error, load } = useLicenseStore()
  const admin = useAuthStore(s => s.admin)
  const canEdit = admin?.role === 'SUPER_ADMIN'

  // Перечитываем при открытии: `roomsUsed` меняется от правок в «Номерах»,
  // а состояние в сторе могло быть загружено при старте программы.
  useEffect(() => { void load() }, [load])

  if (!info && loading) {
    return <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
  }

  // Мягкое предупреждение: обслуживание кончилось по сегодняшнему числу, но
  // установленная версия старше — программа работает, ограничений нет.
  const softExpired = info?.state === 'ok' && info.maintenanceActive === false

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionHeader title="Лицензия" subtitle="Ключ вводится один раз и работает без интернета." />

      {error && <div style={errorStyle}>{error}</div>}

      {info && (
        <>
          <div style={formCard}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <span style={{
                width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                background: licenseStateColor(info.state),
              }} />
              <span style={{ fontSize: '1.08rem', fontWeight: 700 }}>{LICENSE_STATE_TITLE[info.state]}</span>
            </div>
            <div style={{ fontSize: '0.86rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              {licenseStateNote(info)}
            </div>
          </div>

          {/* Ключ выписан другому объекту (S13-008). Плашка висит постоянно, а не
              один раз после активации: чужой ключ обычно вводят и забывают. */}
          {info.hotelMismatch && (
            <LicenseWarningNote
              text={info.warning
                ?? `Ключ выписан на «${info.hotel ?? '—'}», а объект в настройках называется иначе. `
                 + 'Программа работает — сверьте название объекта или ключ.'}
            />
          )}

          {softExpired && (
            <div style={{
              padding: '10px 13px', borderRadius: 8, fontSize: '0.86rem', lineHeight: 1.5,
              border: '1px solid var(--s-out)', background: 'var(--surface-2)', color: 'var(--text)',
            }}>
              Обслуживание закончилось {formatIsoRu(info.maintenanceUntil)} — эта версия работает,
              но новые версии установить нельзя.
            </div>
          )}

          {info.trial && (
            <div style={formCard}>
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Пробный период</div>
              <div>
                <Row label="Длительность">{pluralDays(info.trial.days)} с первого запуска</Row>
                <Row label="Работает до">{formatIsoRu(info.trial.lastDay)}</Row>
                <div style={{ ...rowStyle, borderBottom: 'none' }}>
                  <span style={rowLabel}>Осталось</span>
                  <span style={{
                    ...rowValue,
                    color: info.trial.expired || (info.trial.daysLeft ?? 99) <= 3 ? 'var(--s-overdue)' : 'var(--text)',
                  }}>
                    {info.trial.expired ? 'срок вышел' : info.trial.daysLeft != null ? pluralDays(info.trial.daysLeft) : '—'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Без ключа карточка «Что в ключе» — одни прочерки; вместо неё выше стоит пробный период */}
          {info.state !== 'none' && <div style={formCard}>
            <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Что в ключе</div>
            <div>
              <Row label="Объект">{info.hotel ?? '—'}</Row>
              <Row label="Номеров по лицензии">{info.rooms ?? 'без ограничения'}</Row>
              {/*
                «Используется» может быть больше, чем «по лицензии», и это не ошибка:
                существующие номера не трогаются, отказ приходит только на добавление.
              */}
              <Row label="Используется сейчас">
                <span style={{
                  color: info.rooms !== null && info.roomsUsed >= info.rooms ? 'var(--s-out)' : 'var(--text)',
                }}>
                  {info.roomsUsed}
                </span>
              </Row>
              <Row label="Обслуживание до">{formatIsoRu(info.maintenanceUntil)}</Row>
              <Row label="Ключ выдан">{formatIsoRu(info.issuedAt)}</Row>
              <div style={{ ...rowStyle, borderBottom: 'none' }}>
                <span style={rowLabel}>Дата выпуска этой версии</span>
                <span style={rowValue}>{formatIsoRu(info.buildDate)}</span>
              </div>
            </div>
            {info.rooms !== null && info.roomsUsed > info.rooms && (
              <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
                Номеров больше, чем в лицензии. Существующие продолжают работать — ограничение
                действует только на добавление новых.
              </div>
            )}
          </div>}
        </>
      )}

      <div style={formCard}>
        <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>
          {info?.state === 'ok' ? 'Заменить ключ' : 'Ввести ключ'}
        </div>
        <LicenseKeyForm canEdit={canEdit} />
      </div>
    </div>
  )
}
