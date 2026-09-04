import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { fetchBookingPayments, type BookingMoney } from '../../api/payments'
import { BookingPaymentPanel } from './BookingPaymentPanel'
import { money } from './paymentsUi'

/**
 * Деньги брони прямо в её форме: «начислено / принято / долг» рядом с итогом
 * и кнопка «Принять оплату».
 *
 * Зачем: гость платит у стойки в момент оформления. Раньше единственным входом
 * в кассу был раздел «Касса» — приходилось выйти из брони, открыть кассу и найти
 * там ту же бронь в списке долгов. Из-за этого деньги записывали «потом» и забывали.
 *
 * Сам приём денег живёт в `BookingPaymentPanel` — том же, что и в «Кассе».
 * Здесь только сводка и кнопка, открывающая его диалогом.
 */

const rowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
  gap: 10, fontSize: '0.88rem', padding: '2px 0',
}

interface Props {
  bookingId: number
  /** Гость и номер: в диалоге видно, на какую бронь принимаются деньги. */
  guestName: string
  subtitle?: string
  /** Заголовок рамки. Без него компонент рисуется «голым» — внутри чужой секции. */
  title?: string
  /**
   * Суммы брони изменились: сервер пересчитал `Booking.paidAmount`.
   * Открытая форма брони об этом не знает — обязана подхватить новое значение,
   * иначе сохранение вернёт старое число поверх пересчитанного кэша.
   */
  onChanged?: (summary: BookingMoney) => void
  /**
   * Есть ли в журнале хоть одна запись платежа. Форма брони по этому признаку
   * решает, можно ли ещё править «Оплачено» руками: как только у брони появился
   * платёж, число принадлежит журналу, а не полю формы.
   */
  onJournalPresence?: (hasPayments: boolean) => void
}

/** Чтобы «Оплачено» в форме брони могло открыть приём оплаты, не дублируя диалог. */
export interface BookingMoneyBarHandle {
  openPayment: () => void
}

export const BookingMoneyBar = forwardRef<BookingMoneyBarHandle, Props>(function BookingMoneyBar(
  { bookingId, guestName, subtitle, title, onChanged, onJournalPresence }, ref,
) {
  const [summary, setSummary] = useState<BookingMoney | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [dialog, setDialog] = useState(false)

  // Номер запроса: ответ отменённой загрузки не должен затирать свежий.
  const reqId = useRef(0)

  // Колбэк в ref: иначе он попадёт в зависимости эффекта и незапомненная стрелка
  // из родителя перезапустит загрузку журнала на каждый его рендер.
  const presenceRef = useRef(onJournalPresence)
  presenceRef.current = onJournalPresence

  useImperativeHandle(ref, () => ({ openPayment: () => setDialog(true) }), [])

  const load = () => {
    const my = ++reqId.current
    setLoading(true)
    fetchBookingPayments(bookingId)
      .then((d) => {
        if (my !== reqId.current) return
        setSummary(d.summary)
        setFailed(false)
        presenceRef.current?.(d.payments.length > 0)
      })
      .catch(() => { if (my === reqId.current) setFailed(true) })
      .finally(() => { if (my === reqId.current) setLoading(false) })
  }

  useEffect(() => {
    setSummary(null)
    setFailed(false)
    load()
  }, [bookingId])

  const handleChanged = (s: BookingMoney) => {
    setSummary(s)
    // Любое изменение из панели означает операцию по журналу, а записи в нём
    // не исчезают (платёж нельзя удалить, только отменить) — значит журнал
    // непуст. Отдельно перечитывать список ради счётчика незачем.
    presenceRef.current?.(true)
    onChanged?.(s)
  }

  const body = (
    <>
      {failed ? (
        <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>
          Не удалось загрузить платежи брони.{' '}
          <button
            type="button"
            onClick={load}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent-text)', fontFamily: 'inherit', fontSize: 'inherit' }}
          >Повторить</button>
        </div>
      ) : (
        <>
          <div style={rowStyle}>
            <span style={{ color: 'var(--text-muted)' }}>Начислено</span>
            <span className="mono" style={{ fontWeight: 600, color: 'var(--text)' }}>
              {loading ? '…' : `${money(summary?.charged ?? 0)} ₸`}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={{ color: 'var(--text-muted)' }}>Принято</span>
            <span className="mono" style={{ fontWeight: 600, color: 'var(--s-in)' }}>
              {loading ? '…' : `${money(summary?.paid ?? 0)} ₸`}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={{ color: 'var(--text-muted)' }}>{(summary?.due ?? 0) < 0 ? 'Переплата' : 'Долг'}</span>
            <span className="mono" style={{
              fontWeight: 700,
              color: (summary?.due ?? 0) > 0 ? 'var(--s-overdue)' : 'var(--text-faint)',
            }}>
              {loading ? '…' : `${money(Math.abs(summary?.due ?? 0))} ₸`}
            </span>
          </div>
          {summary && !summary.chargesFromRows && (
            <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginTop: 2 }}>
              Строк начислений нет — «начислено» взято из итога брони.
            </div>
          )}
        </>
      )}
      <button
        type="button"
        onClick={() => setDialog(true)}
        style={{
          marginTop: 8, width: '100%', height: 32, borderRadius: 8, cursor: 'pointer',
          background: 'var(--accent)', color: '#fff', border: 'none',
          fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600,
        }}
      >
        Принять оплату
      </button>
    </>
  )

  return (
    <>
      {title ? (
        <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', height: 40, padding: '0 12px',
            background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)',
          }}>
            <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
          </div>
          <div style={{ padding: '8px 12px' }}>{body}</div>
        </div>
      ) : (
        <div>{body}</div>
      )}

      {dialog && (
        <PaymentDialog
          bookingId={bookingId}
          guestName={guestName}
          subtitle={subtitle}
          onClose={() => setDialog(false)}
          onChanged={handleChanged}
        />
      )}
    </>
  )
})

/**
 * Приём оплаты поверх брони. Это действие над бронью, а не отдельное место —
 * поэтому модалка, а не раздел (см. `docs/decisions/interface.md`).
 */
const PaymentDialog: React.FC<{
  bookingId: number
  guestName: string
  subtitle?: string
  onClose: () => void
  onChanged: (s: BookingMoney) => void
}> = ({ bookingId, guestName, subtitle, onClose, onChanged }) => {
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  const flash = (text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  // Escape закрывает СНАЧАЛА диалог оплаты: форма брони и просмотр брони слушают
  // Escape на document в фазе всплытия, поэтому перехватываем на погружении и
  // гасим событие — иначе одно нажатие закрывало бы всю бронь вместе с кассой.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [onClose])

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 700,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '32px 16px', overflowY: 'auto',
      }}
    >
      <div
        style={{
          // 600 — не «красивое число»: при меньшей ширине три плитки
          // «начислено / принято / долг» перестают помещаться в один ряд.
          width: '100%', maxWidth: 600, background: 'var(--bg)', color: 'var(--text)',
          border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-lg)',
          display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 64px)', overflow: 'hidden',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '1rem', fontWeight: 600, letterSpacing: '-0.01em' }}>Оплата брони</div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {guestName}{subtitle ? ` · ${subtitle}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.5rem',
              color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px', fontWeight: 300,
            }}
          >×</button>
        </div>

        {toast && (
          <div style={{
            margin: '10px 18px 0', padding: '8px 12px', borderRadius: 8,
            background: 'var(--accent-bg)', color: 'var(--accent-text)', fontSize: '0.84rem',
          }}>{toast}</div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
          <BookingPaymentPanel
            bookingId={bookingId}
            onFlash={flash}
            onChanged={onChanged}
            autoFocusAmount
          />
        </div>
      </div>
    </div>
  )
}
