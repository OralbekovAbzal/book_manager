import React, { useEffect, useState } from 'react'
import { useConnectionStore } from '../../store/useConnectionStore'

/**
 * Полоса «Нет связи с сервером».
 *
 * Раньше обрыв был невидим: socket.io тихо переподключался, а рабочее место
 * продолжало показывать картину получаса давности — на втором ноутбуке номер
 * выглядел свободным, хотя его уже продали (аудит D5-003).
 *
 * Полоса, а не окно: без связи программа не мертва — прошлое видно, а сервер
 * при возвращении сам скажет правду (сетка перечитывается на `connect`).
 * Кнопок нет намеренно: нажимать нечего, переподключение идёт само.
 */

// ── Константы объявлены ДО компонента: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/**
 * Сколько терпим до полосы. Обычное переподключение (сервер перезапустили,
 * Wi-Fi моргнул) укладывается в пару секунд, и полоса, мигающая на каждом
 * таком случае, приучает её не замечать.
 */
const OFFLINE_GRACE_MS = 5000

/** Тон — серый из токенов: это не авария, а «данные могут быть старше, чем кажется». */
const TONE = 'var(--text-faint)'

const barStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 9, width: '100%',
  padding: '0 20px', minHeight: 28, flexShrink: 0,
  background: `color-mix(in srgb, ${TONE} 14%, var(--surface))`,
  borderBottom: `1px solid color-mix(in srgb, ${TONE} 40%, var(--border-subtle))`,
  color: 'var(--text)', fontSize: '0.8rem',
}

const TEXT = 'Нет связи с сервером — данные могут быть устаревшими'

export const ConnectionBanner: React.FC = () => {
  const online = useConnectionStore((s) => s.online)
  const since = useConnectionStore((s) => s.since)
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (online) {
      setShow(false)
      return
    }
    // Отсчёт ведём от момента обрыва, а не от монтирования: раздел могли открыть
    // уже посреди обрыва, и тогда ждать ещё пять секунд незачем.
    const elapsed = since ? Date.now() - since : 0
    const wait = Math.max(0, OFFLINE_GRACE_MS - elapsed)
    const t = window.setTimeout(() => setShow(true), wait)
    return () => window.clearTimeout(t)
  }, [online, since])

  if (!show) return null

  return (
    <div style={barStyle}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: TONE }} />
      {/* На узком окне обрезаем текст: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={TEXT}>
        {TEXT}
      </span>
    </div>
  )
}
