import React, { useEffect, useState } from 'react'
import { useConnectionStore } from '../../store/useConnectionStore'
import { IS_ELECTRON } from '../../config'

/**
 * Полоса «Нет связи с сервером».
 *
 * Раньше обрыв был невидим: socket.io тихо переподключался, а рабочее место
 * продолжало показывать картину получаса давности — на втором ноутбуке номер
 * выглядел свободным, хотя его уже продали (аудит D5-003).
 *
 * Полоса, а не окно: без связи программа не мертва — прошлое видно, а сервер
 * при возвращении сам скажет правду (сетка перечитывается на `connect`).
 *
 * Единственная кнопка — «Найти хост в сети» и только в Electron (13.09.2026).
 * Обычно нажимать действительно нечего: переподключение идёт само, а сторож
 * адреса сам ищет хост после смены сети. Но если автоматика не справилась
 * (гостевой Wi-Fi изолирует устройства, хост переустановили), раньше выход был
 * один — звать человека с паролем сисадмина. Кнопка ничего не настраивает: она
 * запускает тот же поиск, что сторож ведёт сам, и переехать может только на
 * подтверждённый подписью хост. В браузере её нет: там нет и моста в Electron.
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

const btnStyle: React.CSSProperties = {
  flexShrink: 0, marginLeft: 'auto', padding: '2px 10px',
  fontSize: '0.78rem', lineHeight: 1.4, cursor: 'pointer',
  color: 'var(--text)', background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 4,
}

export const ConnectionBanner: React.FC = () => {
  const online = useConnectionStore((s) => s.online)
  const since = useConnectionStore((s) => s.since)
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')

  // Мост есть только в упакованном Electron; сборка прежней версии его не знает,
  // поэтому проверяем саму функцию, а не только «мы в Electron».
  const canRebind = IS_ELECTRON && typeof window.appConfig?.rebindHost === 'function'

  const rebind = async () => {
    if (busy) return
    setBusy(true)
    setResult('')
    try {
      const r = await window.appConfig!.rebindHost!()
      // Текст приходит готовым из main-процесса: он один и в логе, и на экране.
      setResult(r?.message || 'Хост не найден')
      // Удача — программа сама перезапустится через пару секунд. Если по какой-то
      // причине не перезапустилась, «перезапускаю» на экране висеть не должно:
      // через три секунды возвращаем честное «нет связи». Неудачный ответ,
      // наоборот, остаётся — его читают и по нему звонят.
      if (r?.ok) window.setTimeout(() => setResult(''), 3000)
    } catch {
      setResult('Не удалось выполнить поиск — перезапустите программу')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (online) {
      setShow(false)
      // Связь вернулась — прошлый ответ поиска больше не о чём: в следующий раз
      // человек должен видеть результат СВОЕЙ попытки, а не позавчерашней.
      setResult('')
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

  // Пока идёт поиск и пока не сменили попытку — вместо общего текста показываем
  // то, что происходит именно сейчас: человек нажал кнопку и ждёт ответа.
  const text = busy ? 'Ищу хост в сети…' : (result || TEXT)

  return (
    <div style={barStyle}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: TONE }} />
      {/* На узком окне обрезаем текст: полоса обязана остаться в одну строку */}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={text}>
        {text}
      </span>
      {canRebind && (
        <button type="button" style={btnStyle} onClick={rebind} disabled={busy}>
          {busy ? 'Ищу…' : 'Найти хост в сети'}
        </button>
      )}
    </div>
  )
}
