import { useEffect, useRef } from 'react'

/**
 * Escape во вложенном попапе (календарь, выпадающий список) закрывает ТОЛЬКО этот
 * попап, а не окно, внутри которого он живёт.
 *
 * Почему нужен отдельный хук, а не просто `onKeyDown`. Форма брони, окно переезда,
 * просмотр брони и раздел «Справочник» вешают свой обработчик Escape на `document`
 * в фазе всплытия — и делают это РАНЬШЕ попапа (окно смонтировано до того, как
 * человек открыл календарь). Слушатели на одном узле в одной фазе вызываются в
 * порядке подписки, поэтому обработчик окна срабатывал первым и закрывал форму
 * вместе с набранными именем, телефоном и паспортом (аудит 13.09: C13-003, C13-020).
 *
 * Лечится фазой ПЕРЕХВАТА: она проходит через `document` до всплытия, а
 * `stopPropagation()` там не даёт событию дойти до фазы всплытия вовсе. Тот же
 * приём уже используют `SettlementDialog`, `PrintPreview` и `ConfirmDialog`.
 *
 * Использовать в любом попапе внутри окна: `usePopupEscape(open, () => setOpen(false))`.
 */
export function usePopupEscape(open: boolean, onClose: () => void): void {
  // Колбэк держим в ref: иначе инлайновая стрелка у вызывающего пересоздавала бы
  // подписку на каждый рендер (лишние add/removeEventListener на каждое нажатие).
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [open])
}
