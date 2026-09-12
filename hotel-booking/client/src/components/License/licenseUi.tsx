import React, { useState } from 'react'
import { useLicenseStore } from '../../store/useLicenseStore'
import type { LicenseInfo, LicenseState } from '../../api/license'
import { formatApiError } from '../Setup/accountRules'
import { inputStyle, labelStyle, primaryBtn } from '../Settings/sections/sectionUi'

// Общее для раздела «Настройки → Лицензия» и для экрана блокировки 402:
// формат дат, человеческие названия состояний и сама форма ввода ключа.
// Форма одна на оба места намеренно — вводят ключ в двух разных ситуациях,
// но действие и его тексты одинаковые.

// ─── Константы объявлены ДО компонентов: объявленная ниже константа падает
// при горячей перезагрузке с «is not defined» (временная мёртвая зона). ────────

/**
 * 'ГГГГ-ММ-ДД' → 'ДД.ММ.ГГГГ'.
 *
 * Разбираем СТРОКУ, а не `new Date(iso)`: в ключе лежит календарный день, а не
 * момент времени. `new Date('2027-09-06')` — UTC-полночь, и при рендере в
 * местном времени она уехала бы на день назад (те же грабли, что с `@db.Date`).
 */
export function formatIsoRu(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—'
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** Короткое название состояния — то, что читает администратор отеля. */
export const LICENSE_STATE_TITLE: Record<LicenseState, string> = {
  none: 'Пробный период',
  ok: 'Лицензия действует',
  expired: 'Обслуживание закончилось',
  invalid: 'Ключ лицензии не читается',
}

/** «14 дней», «1 день», «3 дня». */
export function pluralDays(n: number): string {
  const abs = Math.abs(n) % 100
  const last = abs % 10
  if (abs > 10 && abs < 20) return `${n} дней`
  if (last === 1) return `${n} день`
  if (last >= 2 && last <= 4) return `${n} дня`
  return `${n} дней`
}

/** Сколько осталось пробного периода — фраза для раздела «Лицензия». */
export function trialNote(info: LicenseInfo): string {
  const t = info.trial
  if (!t || !t.lastDay) {
    return `Без ключа программа работает ${pluralDays(t?.days ?? 14)} с первого запуска, потом потребует ключ. Ключ вводится один раз главным администратором.`
  }
  if (t.expired) {
    return `Пробный период закончился ${formatIsoRu(t.lastDay)}. Чтобы продолжить работу, введите ключ лицензии.`
  }
  return `Программа работает полностью до ${formatIsoRu(t.lastDay)} включительно (осталось ${pluralDays(t.daysLeft ?? 0)}). ` +
    'Потом потребуется ключ лицензии — его вводит главный администратор, данные при этом не теряются.'
}

/** Пояснение под названием состояния. */
export function licenseStateNote(info: LicenseInfo): string {
  switch (info.state) {
    case 'none':
      return trialNote(info)
    case 'ok':
      return info.maintenanceActive === false
        ? 'Программа работает. Обслуживание закончилось — эта версия останется рабочей, но новые версии установить нельзя.'
        : 'Ключ проверен, обслуживание оплачено.'
    case 'expired':
      return 'Обслуживание закончилось раньше, чем выпущена эта версия программы. Продлите обслуживание или установите прежнюю версию — данные не тронуты.'
    case 'invalid':
      return info.message ?? 'Ключ не проходит проверку подписи.'
    default:
      return ''
  }
}

/** Цвет плашки состояния: тревожный только там, где действительно есть проблема. */
export function licenseStateColor(state: LicenseState): string {
  if (state === 'ok') return 'var(--s-in)'
  if (state === 'none') return 'var(--s-out)'
  return 'var(--s-overdue)'
}

const keyAreaStyle: React.CSSProperties = {
  ...inputStyle,
  height: 76,
  padding: '9px 12px',
  resize: 'vertical',
  lineHeight: 1.45,
  fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: '0.8rem',
}

const noteStyle: React.CSSProperties = {
  padding: '9px 13px', borderRadius: 8, fontSize: '0.86rem', lineHeight: 1.45,
  border: '1px solid var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)',
}

// ─── Форма ввода ключа ────────────────────────────────────────────────────────

interface KeyFormProps {
  /** Ключ принимает только главный администратор (POST /api/license → SUPER_ADMIN). */
  canEdit: boolean
  autoFocus?: boolean
  /** Зовётся после удачного POST — экран блокировки по нему возвращает приложение. */
  onActivated?: (info: LicenseInfo) => void
}

export const LicenseKeyForm: React.FC<KeyFormProps> = ({ canEdit, autoFocus, onActivated }) => {
  const activate = useLicenseStore(s => s.activate)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')

  if (!canEdit) {
    return (
      <div style={noteStyle}>
        Ключ лицензии вводит главный администратор. Передайте ему ключ или войдите под его учётной записью.
      </div>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!key.trim() || busy) return
    setBusy(true)
    setError('')
    setOk('')
    try {
      const info = await activate(key)
      setKey('')
      if (info.state === 'expired') {
        // POST прошёл (ключ настоящий), но гейт он не снимает — сказать об этом
        // прямо, иначе человек будет вводить тот же ключ по кругу.
        setError(
          `Ключ принят, но обслуживание по нему закончилось ${formatIsoRu(info.maintenanceUntil)}, ` +
          `а эта версия выпущена ${formatIsoRu(info.buildDate)}. Нужен ключ с продлённым обслуживанием.`,
        )
      } else {
        setOk(
          `Ключ принят: ${info.hotel ?? '—'}, номеров: ${info.rooms ?? '—'}, ` +
          `обслуживание до ${formatIsoRu(info.maintenanceUntil)}.`,
        )
        onActivated?.(info)
      }
    } catch (e2) {
      // Сервер присылает готовый человеческий текст («Подпись не сходится» и т.п.)
      setError(formatApiError(e2, 'Не удалось применить ключ'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label style={labelStyle}>Ключ лицензии</label>
        <textarea
          value={key}
          onChange={e => setKey(e.target.value)}
          autoFocus={autoFocus}
          spellCheck={false}
          placeholder="ROOMLINE-…"
          style={keyAreaStyle}
        />
        <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: 5, lineHeight: 1.45 }}>
          Вставьте строку целиком. Переносы строк и пробелы можно не убирать.
        </div>
      </div>

      {error && (
        <div style={{ ...noteStyle, background: 'transparent', borderColor: 'var(--s-overdue)', color: 'var(--s-overdue)' }}>
          {error}
        </div>
      )}
      {ok && (
        <div style={{ ...noteStyle, background: 'var(--accent-bg)', borderColor: 'var(--accent)', color: 'var(--accent-text)' }}>
          {ok}
        </div>
      )}

      <div>
        <button
          type="submit"
          disabled={busy || !key.trim()}
          style={{ ...primaryBtn, opacity: busy || !key.trim() ? 0.55 : 1, cursor: busy || !key.trim() ? 'default' : 'pointer' }}
        >
          {busy ? 'Проверка…' : 'Применить ключ'}
        </button>
      </div>
    </form>
  )
}
