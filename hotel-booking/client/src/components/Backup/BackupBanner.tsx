import React from 'react'
import { useBackupStatusStore } from '../../store/useBackupStatusStore'

/**
 * Полоса под шапкой: с резервными копиями что-то не так.
 *
 * Именно полоса, а не окно: копии — про завтрашнюю беду, а не про сегодняшнюю
 * работу стойки, и перекрывать шахматку из-за них нельзя. Устроена как полоса
 * лицензии, но кнопок здесь две (перейти в раздел и скрыть), поэтому обёртка —
 * не `<button>`: вложенные кнопки недопустимы.
 *
 * Тексты объясняют, ЧТО СДЕЛАТЬ, а не только что случилось: «вставьте флешку»
 * полезнее, чем «fallback».
 */

// ── Константы объявлены ДО компонента: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

const barStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%',
  padding: '0 8px 0 20px', minHeight: 28, flexShrink: 0,
  // Жёлтый — из токена статуса, а не хардкодом: #fff и #fde68a уже ломали тёмную тему
  background: 'color-mix(in srgb, var(--s-out) 14%, var(--surface))',
  borderBottom: '1px solid color-mix(in srgb, var(--s-out) 40%, var(--border-subtle))',
  color: 'var(--text)', fontSize: '0.8rem',
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
  const dismissed = useBackupStatusStore(s => s.dismissed)
  const dismiss = useBackupStatusStore(s => s.dismiss)

  if (warning === 'none' || dismissed) return null

  const text =
    warning === 'never'
      ? 'Резервных копий ещё нет — проверьте папку копий в настройках.'
    : warning === 'stale'
      // Дата в скобках — только если сервер её прислал: пустые скобки выглядят поломкой
      ? `Последняя копия старше двух суток${lastOkAt ? ` (${whenText(lastOkAt)})` : ''}.`
      : 'Копия записана на этот компьютер: папка копий (флешка) недоступна. '
        + 'Вставьте флешку — при выходе из программы копия запишется на неё.'

  return (
    <div style={barStyle}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--s-out)',
      }} />
      {/* На узком окне обрезаем текст, а не кнопки: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {text}
      </span>
      <button type="button" onClick={onOpen} style={linkStyle}>
        Открыть раздел →
      </button>
      <button type="button" onClick={dismiss} title="Скрыть до следующего входа" style={closeStyle}>
        ✕
      </button>
    </div>
  )
}
