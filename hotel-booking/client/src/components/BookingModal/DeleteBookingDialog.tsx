import React, { useEffect, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'
import { cancelBooking } from '../../api/bookings'
import { fetchBookingPayments } from '../../api/payments'
import { formatApiError } from '../Setup/accountRules'
import { SettlementDialog } from './SettlementDialog'

/**
 * Отмена брони.
 *
 * Окно называлось «Удалить бронь?» и обещало, что записи не станет. Сервер при
 * этом ставил `CANCELLED`: бронь оставалась в истории, в отчётах и в кассе
 * (аудит D7-007). Теперь текст совпадает с тем, что произойдёт на самом деле.
 *
 * Разговоров на самом деле два, и они разные:
 *   - по брони ничего не принято — короткое подтверждение (это окно);
 *   - деньги есть — окно расчёта с гостем (`SettlementDialog`): штраф за отмену
 *     и возврат сразу, чтобы переплата не висела до чьего-нибудь визита в «Кассу».
 * Какой из них показать, знает только журнал платежей, поэтому окно сначала
 * спрашивает его и лишь потом решает, что нарисовать.
 */

const fmtDate = (iso?: string) => {
  if (!iso) return ''
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })
}


export const DeleteBookingDialog: React.FC = () => {
  const { deleteTarget, closeDeleteConfirm, fetchGrid, fetchToday } = useGridStore()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Сколько по брони уже принято. Спрашиваем журнал платежей, а не поле брони:
  // `Booking.paidAmount` — лишь его кэш. null — ещё не знаем.
  const [paid, setPaid] = useState<number | null>(null)
  // Журнал не ответил. Отмену из-за этого не запрещаем — просто идём по
  // короткому пути, как по брони без денег.
  const [moneyFailed, setMoneyFailed] = useState(false)

  useEffect(() => {
    if (!deleteTarget) return
    setError('')
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) closeDeleteConfirm() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [deleteTarget, submitting, closeDeleteConfirm])

  // Деньги брони — отдельным запросом на КАЖДОЕ открытие: за время, пока список
  // висел на экране, соседнее рабочее место могло принять оплату.
  useEffect(() => {
    if (!deleteTarget) { setPaid(null); setMoneyFailed(false); return }
    let cancelled = false
    setPaid(null)
    setMoneyFailed(false)
    fetchBookingPayments(deleteTarget.id)
      .then(d => { if (!cancelled) setPaid(d.summary.paid) })
      // Не ответил — просто не называем сумму. Ради неё запрещать отмену незачем.
      .catch(() => { if (!cancelled) setMoneyFailed(true) })
    return () => { cancelled = true }
  }, [deleteTarget?.id])

  if (!deleteTarget) return null

  // Пока не знаем, есть ли по брони деньги, не показываем НИ ОДНО из двух окон:
  // короткое подтверждение и расчёт с гостем — разные разговоры, и подменять
  // одно другим на глазах у пользователя хуже, чем десятая доля секунды ожидания.
  if (paid === null && !moneyFailed) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          background: 'var(--bg)', color: 'var(--text-muted)',
          border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-lg)',
          padding: '18px 24px', fontSize: '0.92rem',
        }}>Считаем деньги брони…</div>
      </div>
    )
  }

  // По брони приняты деньги — отмена без разговора о них оставила бы переплату
  // висеть до тех пор, пока кто-нибудь не откроет «Кассу». Тот же расчёт, что
  // и в форме брони: штраф за отмену и возврат в одном окне.
  if ((paid ?? 0) > 0) {
    return (
      <SettlementDialog
        bookingId={deleteTarget.id}
        action="cancel"
        guestName={deleteTarget.guestName}
        subtitle={`${fmtDate(deleteTarget.checkIn)} → ${fmtDate(deleteTarget.checkOut)}`}
        onClose={closeDeleteConfirm}
        onDone={async () => {
          closeDeleteConfirm()
          await Promise.all([fetchGrid(), fetchToday()])
        }}
      />
    )
  }

  const handleCancelBooking = async () => {
    setSubmitting(true)
    setError('')
    try {
      await cancelBooking(deleteTarget.id)
      closeDeleteConfirm()
      await Promise.all([fetchGrid(), fetchToday()])
    } catch (e) {
      // Текст сервера, а не «Не удалось удалить бронь»: он объясняет причину
      // (нет прав, статус не тот) — аудит D5-005.
      setError(formatApiError(e, 'Не удалось отменить бронь'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !submitting) closeDeleteConfirm() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '90vw', maxWidth: 460,
        background: 'var(--bg)', color: 'var(--text)',
        borderRadius: 12, border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', padding: 24,
      }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
            background: '#fef2f2', color: '#dc2626',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem',
          }}>⚠</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: 6 }}>
              Отменить бронь?
            </div>
            <div style={{ fontSize: '0.95rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--text)' }}>{deleteTarget.guestName}</strong>
              {' '}({fmtDate(deleteTarget.checkIn)} → {fmtDate(deleteTarget.checkOut)}).
              {' '}Бронь останется в истории со статусом «Отменена». Начисления будут сняты.
              {/* Про деньги здесь не говорим намеренно: сюда доходят только брони,
                  по которым ничего не принято. Где деньги есть — открывается
                  окно расчёта с гостем (см. выше). */}
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', lineHeight: 1.5, marginTop: 8 }}>
              Штраф за отмену, если он есть, добавляется ручной строкой в начислениях брони.
            </div>
          </div>
        </div>

        {error && (
          <div style={{ color: '#dc2626', fontSize: '0.92rem', marginTop: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
          <button onClick={closeDeleteConfirm} disabled={submitting} style={secondaryBtnStyle}>
            Не отменять
          </button>
          <button onClick={handleCancelBooking} disabled={submitting} style={dangerBtnStyle}>
            {submitting ? 'Отменяем…' : 'Отменить бронь'}
          </button>
        </div>
      </div>
    </div>
  )
}

const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 16px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}

const dangerBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: '#dc2626', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
