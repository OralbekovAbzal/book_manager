import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * Общий диалог подтверждения.
 *
 * Зачем он вообще: половина необратимых действий в программе спрашивала
 * нативным `confirm()` («Удалить «Завтрак»?»), а половина не спрашивала вовсе
 * («Очистить период» в тарифах стирал календарь цен одним кликом — D6-004,
 * D7-011). Нативный `confirm` при этом не умеет ни третьей кнопки («Выключить»
 * вместо «Удалить»), ни объяснения последствий, ни токенов темы, и в Electron
 * выглядит чужим системным окном.
 *
 * Вызывается как функция, а не рисуется как компонент:
 *
 *   if (await confirmDanger({ title: '…', text: '…' })) { … }
 *   const answer = await confirmDialog({ …, extraLabel: 'Выключить' })
 *
 * Хост монтируется САМ, лениво, при первом вызове — отдельным React-корнем в
 * `document.body`. Так диалог доступен из любого места, не требуя правки
 * `App.tsx` и не завися от того, какой раздел сейчас открыт.
 * `document.body` выбран ещё и потому, что `transform` у родителя сделал бы его
 * containing block для `position: fixed` и диалог уехал бы внутрь модалки.
 */

// ── Всё объявлено ДО компонента: константа, объявленная ниже, падает при
// горячей перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

export type ConfirmAnswer = 'confirm' | 'cancel' | 'extra'

export interface ConfirmOptions {
  title: string
  /** Что именно произойдёт и что нельзя будет вернуть. Строки — отдельными абзацами. */
  text?: string | string[]
  confirmLabel?: string
  cancelLabel?: string
  /** Действие необратимо: красная кнопка подтверждения и фокус на «Отмена». */
  danger?: boolean
  /** Третья кнопка — безопасная альтернатива («Выключить» вместо «Удалить»). */
  extraLabel?: string
}

interface Request extends ConfirmOptions {
  id: number
  resolve: (answer: ConfirmAnswer) => void
}

// Выше формы брони (100), окон разделов (600–800) и подсказок: диалог —
// последнее, что видит пользователь перед необратимым действием.
const Z_INDEX = 12000

const OVERLAY: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: Z_INDEX,
  background: 'rgba(0,0,0,0.5)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
}

const PANEL: React.CSSProperties = {
  width: '100%', maxWidth: 460,
  background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 14,
  boxShadow: 'var(--shadow-lg)',
  display: 'flex', flexDirection: 'column',
  maxHeight: 'calc(100vh - 96px)', overflow: 'hidden',
}

const TITLE: React.CSSProperties = {
  fontSize: '1.02rem', fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)',
}

const TEXT: React.CSSProperties = {
  fontSize: '0.88rem', lineHeight: 1.5, color: 'var(--text-muted)', margin: 0,
}

const BTN_BASE: React.CSSProperties = {
  height: 36, padding: '0 16px', borderRadius: 8, cursor: 'pointer',
  fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600, whiteSpace: 'nowrap',
}

const BTN_CANCEL: React.CSSProperties = {
  ...BTN_BASE, background: 'var(--bg)', border: '1px solid var(--border)',
  color: 'var(--text)', fontWeight: 500,
}

const BTN_EXTRA: React.CSSProperties = {
  ...BTN_BASE, background: 'var(--surface-2)', border: '1px solid var(--border)',
  color: 'var(--text)',
}

const BTN_OK: React.CSSProperties = {
  ...BTN_BASE, border: 'none', background: 'var(--accent)', color: 'var(--text-inverse)',
}

const BTN_DANGER: React.CSSProperties = {
  ...BTN_BASE, border: 'none', background: 'var(--s-overdue)', color: 'var(--text-inverse)',
}

// ── Очередь запросов ─────────────────────────────────────────────────────────
// Вызов может прийти откуда угодно и в любой момент, поэтому состояние живёт вне
// React: маленькое хранилище с подпиской, а хост — его единственный читатель.
// Очередь, а не одно окно: два подряд идущих вопроса не должны глотать друг друга.

let queue: Request[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Хост существует в единственном экземпляре — второй корень рисовал бы второй диалог. */
let hostMounted = false

/**
 * Спросить подтверждение. Промис разрешается тем, что нажал пользователь:
 * `'confirm'` | `'cancel'` | `'extra'`. Esc и клик мимо окна — это `'cancel'`.
 */
export function confirmDialog(options: ConfirmOptions): Promise<ConfirmAnswer> {
  ensureHost()
  return new Promise<ConfirmAnswer>((resolve) => {
    queue = [...queue, { ...options, id: nextId++, resolve }]
    emit()
  })
}

/** Короткая форма для «да/нет» с красной кнопкой: `if (!await confirmDanger(…)) return`. */
export async function confirmDanger(options: Omit<ConfirmOptions, 'extraLabel'>): Promise<boolean> {
  const answer = await confirmDialog({ danger: true, ...options })
  return answer === 'confirm'
}

// ── Хост ─────────────────────────────────────────────────────────────────────

const ConfirmHost: React.FC = () => {
  const [, force] = useState(0)
  useEffect(() => subscribe(() => force((n) => n + 1)), [])

  const current = queue[0]
  if (!current) return null
  // key — чтобы следующий вопрос в очереди получил свежее состояние фокуса,
  // а не унаследовал фокус и клавиатуру предыдущего.
  return <ConfirmPanel key={current.id} request={current} />
}

const ConfirmPanel: React.FC<{ request: Request }> = ({ request }) => {
  const okRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const answer = (value: ConfirmAnswer) => {
    queue = queue.filter((r) => r.id !== request.id)
    emit()
    request.resolve(value)
  }
  // Ссылка на текущий обработчик: слушатель клавиатуры вешаем один раз, а
  // `answer` пересоздаётся на каждый рендер.
  const answerRef = useRef(answer)
  answerRef.current = answer

  // Фокус: при необратимом действии — на «Отмена». Слепое Enter/пробел тогда
  // отменяет, а не стирает цены; именно на этом обжигались в тарифах.
  useEffect(() => {
    const target = request.danger ? cancelRef.current : okRef.current
    target?.focus()
  }, [request.danger])

  useEffect(() => {
    // Слушаем на window в фазе перехвата: разделы и модалки вешают свои
    // Escape-обработчики на document (тоже с перехватом), а window в фазе
    // перехвата идёт РАНЬШЕ document — иначе Esc в диалоге заодно снимал бы
    // выделение в тарифах и закрывал раздел под ним.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        answerRef.current('cancel')
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        // Фокус на кнопке диалога — срабатывает ОНА: при `danger` фокус стоит на
        // «Отмена», и слепое Enter обязано отменить, а не стереть цены.
        // Жмём кнопку явно, а не отдаём событию его обычный ход: `preventDefault`
        // выше уже отменил бы штатное срабатывание кнопки, да и полагаться на
        // него, перехватывая клавиши на window, всё равно нельзя.
        const active = document.activeElement
        if (active instanceof HTMLButtonElement && panelRef.current?.contains(active)) {
          active.click()
          return
        }
        answerRef.current('confirm')
        return
      }
      if (e.key === 'Tab') {
        // Простая ловушка фокуса: пока диалог открыт, Tab не должен уводить
        // в форму под ним — там можно случайно нажать что угодно.
        const buttons = panelRef.current
          ? Array.from(panelRef.current.querySelectorAll('button'))
          : []
        if (buttons.length === 0) return
        const idx = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const step = e.shiftKey ? -1 : 1
        const next = buttons[(idx + step + buttons.length) % buttons.length]
        e.preventDefault()
        e.stopPropagation()
        next?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const paragraphs = Array.isArray(request.text)
    ? request.text
    : request.text ? [request.text] : []

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) answer('cancel') }}
      style={OVERLAY}
    >
      <div ref={panelRef} role="alertdialog" aria-modal="true" style={PANEL}>
        <div style={{ padding: '18px 22px 0' }}>
          <div style={TITLE}>{request.title}</div>
        </div>

        {paragraphs.length > 0 && (
          <div style={{
            padding: '10px 22px 0', overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {paragraphs.map((p, i) => <p key={i} style={TEXT}>{p}</p>)}
          </div>
        )}

        {/* Кнопки в одну строку, но с переносом: на 800px «Выключить» +
            «Удалить всё равно» + «Отмена» в строку не помещаются. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          padding: '18px 22px 18px', justifyContent: 'flex-end',
        }}>
          <button ref={cancelRef} type="button" onClick={() => answer('cancel')} style={BTN_CANCEL}>
            {request.cancelLabel ?? 'Отмена'}
          </button>
          {request.extraLabel && (
            <button type="button" onClick={() => answer('extra')} style={BTN_EXTRA}>
              {request.extraLabel}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            onClick={() => answer('confirm')}
            style={request.danger ? BTN_DANGER : BTN_OK}
          >
            {request.confirmLabel ?? 'Подтвердить'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Ленивое монтирование хоста ───────────────────────────────────────────────
// Объявление `function` поднимается целиком, поэтому вызов из `confirmDialog`
// выше законен, а сам хост стоит ПОСЛЕ компонентов: к первому вызову `ConfirmHost`
// уже определён, и временная мёртвая зона нас здесь не ловит.

function ensureHost() {
  if (hostMounted || typeof document === 'undefined') return
  hostMounted = true
  const container = document.createElement('div')
  container.setAttribute('data-confirm-host', '')
  document.body.appendChild(container)
  // Без StrictMode намеренно: собственных эффектов, которые стоило бы проверять
  // двойным монтированием, у хоста нет, а лишний прогон дал бы двойные слушатели.
  createRoot(container).render(<ConfirmHost />)
}
