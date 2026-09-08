import React from 'react'
import { useBackupStatusStore, pickBannerWarning } from '../../store/useBackupStatusStore'

/**
 * Полоса под шапкой: с резервными копиями или со свободным местом что-то не так.
 *
 * Именно полоса, а не окно: копии — про завтрашнюю беду, а не про сегодняшнюю
 * работу стойки, и перекрывать шахматку из-за них нельзя. Устроена как полоса
 * лицензии, но кнопок здесь две (перейти в раздел и скрыть), поэтому обёртка —
 * не `<button>`: вложенные кнопки недопустимы.
 *
 * Полоса ОДНА, даже если бед несколько: приоритет считает `pickBannerWarning`
 * (диск → never → stale → fallback). Две полосы съедали бы высоту шахматки.
 *
 * Тексты объясняют, ЧТО СДЕЛАТЬ, а не только что случилось: «вставьте флешку»
 * полезнее, чем «fallback».
 */

// ── Константы объявлены ДО компонента: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/**
 * Цвет полосы — токеном, а не хардкодом: #fff и #fde68a уже ломали тёмную тему.
 * Кончившийся диск красим тревожнее (`--s-overdue`, тот же красный, что у долгов),
 * потому что это единственная из четырёх бед, которая останавливает работу
 * сегодня; про копии — жёлтый `--s-out`.
 */
function barStyle(tone: string): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: 9, width: '100%',
    padding: '0 8px 0 20px', minHeight: 28, flexShrink: 0,
    background: `color-mix(in srgb, ${tone} 14%, var(--surface))`,
    borderBottom: `1px solid color-mix(in srgb, ${tone} 40%, var(--border-subtle))`,
    color: 'var(--text)', fontSize: '0.8rem',
  }
}

const linkStyle: React.CSSProperties = {
  flexShrink: 0, marginLeft: 'auto', padding: '2px 8px',
  background: 'transparent', border: 'none', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600, color: 'var(--accent-text)',
}

const closeStyle: React.CSSProperties = {
  flexShrink: 0, width: 20, height: 20, padding: 0, lineHeight: 1,
  background: 'transparent', border: 'none', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '0.95rem', color: 'var(--text-faint)',
}

/** Дата последней копии словами. Копии — не `@db.Date`, время местное и осмысленное. */
function whenText(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

export const BackupBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const warning = useBackupStatusStore(s => s.warning)
  const lastOkAt = useBackupStatusStore(s => s.lastOkAt)
  const diskWarning = useBackupStatusStore(s => s.diskWarning)
  const diskFreeMb = useBackupStatusStore(s => s.diskFreeMb)
  const dismissedKind = useBackupStatusStore(s => s.dismissedKind)
  const dismiss = useBackupStatusStore(s => s.dismiss)

  const kind = pickBannerWarning({ diskWarning, warning })
  if (kind === 'none' || kind === dismissedKind) return null

  const text =
    kind === 'disk'
      // Скобки — только когда сервер сумел измерить: «(осталось null МБ)» хуже, чем без цифры
      ? `На диске мало места${diskFreeMb !== null ? ` (осталось ${diskFreeMb.toLocaleString('ru-RU')} МБ)` : ''}`
        + ' — освободите место, иначе база данных может остановиться.'
    : kind === 'never'
      ? 'Резервных копий ещё нет — проверьте папку копий в настройках.'
    : kind === 'stale'
      // Дата в скобках — только если сервер её прислал: пустые скобки выглядят поломкой
      ? `Последняя копия старше двух суток${lastOkAt ? ` (${whenText(lastOkAt)})` : ''}.`
      : 'Копия записана на этот компьютер: папка копий (флешка) недоступна. '
        + 'Вставьте флешку — при выходе из программы копия запишется на неё.'

  const tone = kind === 'disk' ? 'var(--s-overdue)' : 'var(--s-out)'

  return (
    <div style={barStyle(tone)}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: tone,
      }} />
      {/* На узком окне обрезаем текст, а не кнопки: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {text}
      </span>
      {/* Для диска ведём туда же, в «Резервную копию»: там видно пути, по которым
          считалось место, — отдельного раздела «диск» в программе нет. */}
      <button type="button" onClick={onOpen} style={linkStyle}>
        Открыть раздел →
      </button>
      <button type="button" onClick={() => dismiss(kind)} title="Скрыть до следующего входа" style={closeStyle}>
        ✕
      </button>
    </div>
  )
}
