import React from 'react'

/**
 * Общая обвязка диалогов «восстановление сотрёт то, чего в файле нет»: сводка
 * последствий, галочка осознанного согласия, оформление опасного действия.
 *
 * Зачем отдельный файл. Таких диалогов в программе два — откат к снимку
 * (`Snapshots/SnapshotsModal.tsx`) и восстановление из резервной копии
 * (`Settings/sections/BackupSection.tsx`). Операции разные, а вопрос к
 * пользователю один и тот же: «столько-то денег исчезнет безвозвратно,
 * подтверди». Диалог должен УЗНАВАТЬСЯ, иначе второй раз его читают заново
 * и жмут «ок» не глядя.
 *
 * Оба диалога уже переведены на этот модуль. Заводя третий («восстановление
 * сотрёт то, чего в источнике нет» — сценарий повторяющийся), бери отсюда же,
 * а не копируй разметку: разошедшиеся предупреждения о потере денег хуже,
 * чем одно неидеальное.
 *
 * Всё на токенах темы: захардкоженный светлый фон уже ломал тёмную тему
 * в окне «Аудит».
 */

// ── Константы объявлены ДО компонентов: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/** Счётчики по одной таблице: сколько есть, сколько вернётся, сколько исчезнет. */
export interface RestoreTableImpact {
  current: number
  restored: number
  lost: number
  lostAmount: number
}

export function formatMoney(n: number): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)} ₸`
}

/**
 * Серверный `warning` написан как текст ОТКАЗА и заканчивается инструкцией
 * «повторите запрос с "allowDataLoss": true» — до клика эта фраза лишняя, её
 * роль играет галочка согласия. Отрезаем ровно предложение с именем поля API;
 * если текст на сервере изменится, правило просто не сработает и покажется всё
 * целиком. Сами цифры не пересчитываем: предупреждение, разошедшееся с фактом,
 * хуже, чем его отсутствие — числа всегда приходят с сервера.
 */
export function trimApiHint(text: string, apiField: string): string {
  return text
    .split(/(?<=\.)\s+/)
    .filter(s => !s.includes(apiField))
    .join(' ')
    .trim()
}

/** То немногое из сводки, что нужно тексту согласия: что именно пропадёт. */
export interface RestoreLossSummary {
  payments: RestoreTableImpact | null
  emptiedTables: { table: string; rows: number }[]
  unknownTables: string[]
}

/**
 * Текст галочки согласия — называет цену вопроса цифрами, а не «данные будут
 * потеряны». Общий на все диалоги восстановления (раздел копий, мастер первого
 * запуска): формулировка про потерю денег обязана быть одна.
 */
export function restoreConsentLabel(a: RestoreLossSummary): string {
  const parts: string[] = []
  if ((a.payments?.lost ?? 0) > 0) {
    parts.push(`платежей ${a.payments!.lost} на ${formatMoney(a.payments!.lostAmount)}`)
  }
  if (a.emptiedTables.length > 0) {
    const rows = a.emptiedTables.reduce((s, t) => s + t.rows, 0)
    parts.push(`${a.emptiedTables.length} таблиц целиком (записей ${rows})`)
  }
  if (a.unknownTables.length > 0) {
    parts.push(`данные таблиц, которых нет в этой версии программы (${a.unknownTables.join(', ')})`)
  }
  return `Понимаю: будет стёрто ${parts.join(' и ')} — восстановить их будет нечем`
}

export const impactBoxStyle: React.CSSProperties = {
  marginTop: 14, padding: '10px 12px', background: 'var(--surface)',
  border: '1px solid var(--border-subtle)', borderRadius: 8,
  display: 'flex', flexDirection: 'column', gap: 6, fontSize: '0.88rem',
}
export const impactRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
}
export const impactNameStyle: React.CSSProperties = { color: 'var(--text-muted)', flexShrink: 0 }
export const impactValueStyle: React.CSSProperties = { textAlign: 'right', color: 'var(--text)' }

/** Ошибка/предупреждение — на токенах, чтобы не слепить в тёмной теме. */
export const restoreErrorBoxStyle: React.CSSProperties = {
  padding: '10px 14px', background: 'var(--surface-2)', color: 'var(--s-overdue)',
  border: '1px solid var(--s-overdue)', borderRadius: 8,
  fontSize: '0.88rem', lineHeight: 1.45,
}

export const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: 'var(--s-overdue)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
/** Тот же размер, но обычное подтверждение — терять нечего. */
export const confirmBtnStyle: React.CSSProperties = { ...dangerBtnStyle, background: '#d97706' }

/** Строка сводки по таблице: сколько вернётся и сколько исчезнет. */
export const MoneyImpactRow: React.FC<{ name: string; data: RestoreTableImpact | null }> = ({ name, data }) => {
  // null — модели нет в схеме сервера: строку не рисуем вовсе, чтобы не показывать
  // «0», которое читается как «ничего не потеряется».
  if (!data) return null
  return (
    <div style={impactRowStyle}>
      <span style={impactNameStyle}>{name}</span>
      <span style={impactValueStyle}>
        вернётся <strong>{data.restored}</strong>
        <span style={{ color: 'var(--text-faint)' }}> · сейчас {data.current}</span>
        {data.lost > 0 && (
          <span style={{ color: 'var(--s-overdue)', fontWeight: 600 }}>
            {' '}· исчезнет {data.lost}
            {data.lostAmount !== 0 ? ` (${formatMoney(data.lostAmount)})` : ''}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Осознанное согласие. Именно галочка, а не второе «ОК»: второе подтверждение
 * жмут не читая, а галочку надо поставить руками — и текст рядом с ней называет
 * цену вопроса цифрами.
 */
export const ConsentCheckbox: React.FC<{
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}> = ({ checked, disabled, onChange, children }) => (
  <label style={{
    display: 'flex', alignItems: 'flex-start', gap: 9, marginTop: 12,
    padding: '10px 12px', borderRadius: 8,
    border: '1px solid var(--s-overdue)', background: 'var(--surface)',
    cursor: disabled ? 'default' : 'pointer', fontSize: '0.88rem', lineHeight: 1.45,
  }}>
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      style={{ marginTop: 2, flexShrink: 0, accentColor: 'var(--s-overdue)' }}
    />
    <span>{children}</span>
  </label>
)
