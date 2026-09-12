import React from 'react'
import { useLicenseStore } from '../../store/useLicenseStore'

/**
 * Полоса под шапкой: «Ключ лицензии не читается».
 *
 * Показывается ТОЛЬКО при `invalid`: ключ есть, но не проходит проверку —
 * молчать об этом хуже, чем сказать, а больше нигде это не всплывёт.
 *
 * При `none` не показывается ничего (решение владельца 12.09.2026): без ключа
 * идёт пробный период 14 дней, и полоса «лицензия не введена» всё это время
 * только мешала бы стойке. Сколько осталось — видно в «Настройки → Лицензия»;
 * когда срок выйдет, сервер ответит 402 и вместо приложения поднимется экран
 * блокировки (`MaintenanceGateScreen`). `expired` сюда тоже не доходит — там
 * тот же экран.
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
  if (!info || info.state !== 'invalid') return null

  const text = `Ключ лицензии не читается${info.message ? `: ${info.message}` : ''}.`

  return (
    <button type="button" onClick={onOpen} title="Открыть раздел «Лицензия»" style={barStyle}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--s-overdue)' }} />
      {/* На узком окне обрезаем текст, а не ссылку: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
      <span style={{ flexShrink: 0, marginLeft: 'auto', color: 'var(--accent-text)', fontWeight: 600 }}>
        Ввести ключ →
      </span>
    </button>
  )
}
