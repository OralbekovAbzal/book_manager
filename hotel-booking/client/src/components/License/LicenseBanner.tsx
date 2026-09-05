import React from 'react'
import { useLicenseStore } from '../../store/useLicenseStore'

/**
 * Полоса под шапкой: «Лицензия не введена».
 *
 * Именно полоса, а не модалка: без ключа программа работает полностью (демо), и
 * перекрывать работу стойки из-за учётного вопроса нельзя. Одна строка, кликом
 * уводит в «Настройки → Лицензия».
 *
 * При `ok` не показывается ничего. `invalid` показываем тоже: ключ есть, но не
 * читается — молчать об этом хуже, чем сказать, а больше нигде это не всплывёт.
 * `expired` сюда не доходит: там поднимается экран блокировки вместо приложения.
 */

const barStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%',
  padding: '0 20px', height: 28, flexShrink: 0,
  background: 'var(--surface-2)', border: 'none',
  borderBottom: '1px solid var(--border-subtle)',
  color: 'var(--text-muted)', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '0.8rem', textAlign: 'left',
}

export const LicenseBanner: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const info = useLicenseStore(s => s.info)
  if (!info || info.state === 'ok' || info.state === 'expired') return null

  const text = info.state === 'none'
    ? 'Лицензия не введена — программа работает в демонстрационном режиме.'
    : `Ключ лицензии не читается${info.message ? `: ${info.message}` : ''}.`

  return (
    <button type="button" onClick={onOpen} title="Открыть раздел «Лицензия»" style={barStyle}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: info.state === 'none' ? 'var(--s-out)' : 'var(--s-overdue)',
      }} />
      {/* На узком окне обрезаем текст, а не ссылку: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      <span style={{ flexShrink: 0, marginLeft: 'auto', color: 'var(--accent-text)', fontWeight: 600 }}>
        Ввести ключ →
      </span>
    </button>
  )
}
