import React, { useState, useEffect, useMemo } from 'react'
import { format, parseISO, addDays, differenceInCalendarDays } from 'date-fns'
import { useGridStore } from '../../store/useGridStore'
import { moveBooking } from '../../api/bookings'
import { fetchRooms } from '../../api/rooms'
import { AllotmentConfirm } from './AllotmentConfirm'
import type { Room } from '../../types'

export const MoveBookingModal: React.FC = () => {
  const { modal, closeModal, fetchGrid } = useGridStore()
  const isOpen = modal.open && modal.mode === 'move'
  const booking = modal.booking
  const initialTargetRoomId = modal.moveTargetRoomId
  const initialMoveDate     = modal.moveDate

  const [rooms, setRooms]             = useState<Room[]>([])
  const [targetRoomId, setTargetRoomId] = useState<number | null>(initialTargetRoomId ?? null)
  const [moveDate, setMoveDate]         = useState<string>(initialMoveDate ?? '')
  const [submitting, setSubmitting]     = useState(false)
  const [error, setError]               = useState<string | null>(null)
  // Целевой номер выделен партнёру: сервер вернул 409 ALLOTMENT_CONFLICT.
  // Это не отказ, а вопрос — переезд повторяется с `allowAllotmentOverride`.
  const [allotmentWarning, setAllotmentWarning] = useState<string | null>(null)

  useEffect(() => {
    if (isOpen) {
      setTargetRoomId(initialTargetRoomId ?? null)
      setMoveDate(initialMoveDate ?? '')
      setError(null)
      setAllotmentWarning(null)
      fetchRooms({ isActive: true }).then(setRooms)
    }
  }, [isOpen, initialTargetRoomId, initialMoveDate])

  // Escape закрывает СНАЧАЛА подтверждение по квоте и только потом само окно —
  // иначе одно нажатие выбрасывало бы из наполовину заполненного переезда.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (allotmentWarning) { setAllotmentWarning(null); return }
      closeModal()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, closeModal, allotmentWarning])

  const sourceRoom = useMemo(() =>
    rooms.find(r => r.id === booking?.roomId),
    [rooms, booking?.roomId]
  )
  const targetRoom = useMemo(() =>
    rooms.find(r => r.id === targetRoomId),
    [rooms, targetRoomId]
  )

  if (!isOpen || !booking) return null

  const origCheckIn  = booking.checkIn.slice(0, 10)
  const origCheckOut = booking.checkOut.slice(0, 10)

  // Валидация даты переезда: checkIn ≤ moveDate < checkOut
  const moveDateValid = moveDate >= origCheckIn && moveDate < origCheckOut
  const sameDay       = moveDate === origCheckIn
  const remainingNights = moveDate && moveDateValid
    ? differenceInCalendarDays(parseISO(origCheckOut), parseISO(moveDate))
    : 0
  const elapsedNights = moveDate && moveDateValid
    ? differenceInCalendarDays(parseISO(moveDate), parseISO(origCheckIn))
    : 0

  const canSubmitFinal = targetRoomId !== null && moveDateValid && targetRoomId !== booking.roomId

  const onSubmit = async (allowAllotmentOverride = false) => {
    if (!targetRoomId || !moveDateValid) return
    setSubmitting(true)
    setError(null)
    try {
      await moveBooking(booking.id, targetRoomId, moveDate, allowAllotmentOverride)
      closeModal()
      fetchGrid()
    } catch (err: unknown) {
      const e = err as {
        response?: { status?: number; data?: { error?: string; code?: string } }
        message?: string
      }
      const res = e.response
      // Квота партнёра — не запрет: отель вправе продать выделенный номер, но
      // осознанно. Спрашиваем тем же окном, что и форма брони, а не показываем
      // красную ошибку, из которой нет выхода.
      if (res?.status === 409 && res.data?.code === 'ALLOTMENT_CONFLICT') {
        setAllotmentWarning(res.data.error ?? 'Номер выделен партнёру по квоте')
        return
      }
      setError(res?.data?.error || e.message || 'Не удалось выполнить переезд')
    } finally {
      setSubmitting(false)
    }
  }

  const confirmAllotmentOverride = () => {
    setAllotmentWarning(null)
    void onSubmit(true)
  }

  // Список доступных номеров — все кроме текущего
  const availableRooms = rooms.filter(r => r.id !== booking.roomId)

  return (
    <>
      <div
        onClick={closeModal}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.5)',
          zIndex: 600,
          backdropFilter: 'blur(2px)',
        }}
      />
      <div style={{
        position: 'fixed',
        top: '50%', left: '50%',
        transform: 'translate(-50%, -50%)',
        width: 'min(520px, 95vw)',
        background: 'var(--bg)',
        borderRadius: 12,
        border: '1px solid var(--border)',
        zIndex: 601,
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text)',
        overflow: 'hidden',
      }}>
        <header style={{
          padding: '16px 20px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: '1.15rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
              Переезд гостя
            </div>
            <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {booking.guestName} · {origCheckIn} → {origCheckOut}
            </div>
          </div>
          <button
            onClick={closeModal}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: '1.54rem', color: 'var(--text-faint)',
              padding: '0 4px', lineHeight: 1, fontWeight: 300,
            }}
          >×</button>
        </header>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* From / To rooms */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'end', gap: 12 }}>
            <Field label="Из номера">
              <div style={{
                padding: '8px 10px',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                fontSize: '1.08rem', fontWeight: 600,
              }}>
                {sourceRoom ? `№${sourceRoom.number}` : `№${booking.roomId}`}
                {sourceRoom?.category?.name && (
                  <span style={{ marginLeft: 8, color: 'var(--text-faint)', fontWeight: 400, fontSize: '0.92rem' }}>
                    {sourceRoom.category.name}
                  </span>
                )}
              </div>
            </Field>
            <span style={{
              alignSelf: 'center', marginBottom: 8,
              color: 'var(--text-faint)', fontSize: '1.38rem', fontWeight: 400,
            }}>→</span>
            <Field label="В номер">
              <select
                value={targetRoomId ?? ''}
                onChange={(e) => setTargetRoomId(e.target.value ? parseInt(e.target.value) : null)}
                style={selectStyle}
              >
                <option value="">— Выберите номер —</option>
                {availableRooms.map(r => (
                  <option key={r.id} value={r.id}>
                    №{r.number} {r.category?.name ? `· ${r.category.name}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Move date */}
          <Field
            label="Дата переезда"
            hint={`Допустимо: ${origCheckIn} … ${format(addDays(parseISO(origCheckOut), -1), 'yyyy-MM-dd')}`}
          >
            <input
              type="date"
              value={moveDate}
              min={origCheckIn}
              max={format(addDays(parseISO(origCheckOut), -1), 'yyyy-MM-dd')}
              onChange={e => setMoveDate(e.target.value)}
              style={selectStyle}
            />
          </Field>

          {/* Preview */}
          {moveDateValid && targetRoom && (
            <div style={{
              padding: 14,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: '1rem',
              lineHeight: 1.6,
            }}>
              <div style={{
                fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-faint)',
                letterSpacing: '0.06em', textTransform: 'uppercase',
                marginBottom: 10,
              }}>
                Что произойдёт
              </div>

              {sameDay ? (
                <div style={{ color: 'var(--text)' }}>
                  Гость заехал сегодня — бронь просто переместится в номер{' '}
                  <strong>№{targetRoom.number}</strong> на даты {origCheckIn} → {origCheckOut}.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>
                    <span style={{
                      display: 'inline-block', width: 8, height: 8,
                      borderRadius: '50%', background: 'var(--status-checked-out)',
                      marginRight: 8, verticalAlign: 'middle',
                    }} />
                    <strong>№{sourceRoom?.number ?? booking.roomId}</strong>
                    {' '}— закроется датой <strong>{moveDate}</strong>{' '}
                    ({elapsedNights} {pluralNights(elapsedNights)})
                  </div>
                  <div>
                    <span style={{
                      display: 'inline-block', width: 8, height: 8,
                      borderRadius: '50%', background: 'var(--status-checked-in)',
                      marginRight: 8, verticalAlign: 'middle',
                    }} />
                    <strong>№{targetRoom.number}</strong>
                    {' '}— продолжение брони с <strong>{moveDate}</strong> по <strong>{origCheckOut}</strong>{' '}
                    ({remainingNights} {pluralNights(remainingNights)})
                  </div>
                  {/* Главный вопрос стойки при переезде — «а деньги?». Раньше
                      сервер делил `paidAmount` пропорцией и платежи оставались
                      на первой части (D3-001/002, D7-013); теперь счёт один. */}
                  <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    Деньги остаются на одном счёте: новая часть — продолжение брони,
                    платежи и начисления не делятся.
                  </div>
                </div>
              )}
            </div>
          )}

          {error && (
            <div style={{
              padding: '10px 14px',
              background: 'rgba(220,38,38,0.08)',
              border: '1px solid var(--status-overdue)',
              borderRadius: 6,
              color: 'var(--status-overdue)',
              fontSize: '0.92rem',
              fontWeight: 500,
            }}>
              {error}
            </div>
          )}
        </div>

        <footer style={{
          padding: '14px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          background: 'var(--surface)',
        }}>
          <button
            onClick={closeModal}
            disabled={submitting}
            style={{
              padding: '8px 16px',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: '1rem', fontWeight: 500,
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
          >
            Отмена
          </button>
          <button
            // Стрелка обязательна: `onClick={onSubmit}` передал бы в первый
            // аргумент событие клика, а он теперь — «продать номер из квоты».
            onClick={() => onSubmit()}
            disabled={!canSubmitFinal || submitting}
            style={{
              padding: '8px 18px',
              background: canSubmitFinal ? 'var(--accent)' : 'var(--surface-3)',
              border: 'none',
              borderRadius: 6,
              fontSize: '1rem', fontWeight: 600,
              color: '#ffffff',
              cursor: canSubmitFinal && !submitting ? 'pointer' : 'not-allowed',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Сохранение…' : 'Переселить'}
          </button>
        </footer>

        {/* Подтверждение продажи номера из квоты партнёра. Тот же компонент, что
            в форме брони: окно должно узнаваться, откуда бы ни пришло.
            Лежит ВНУТРИ окна и позиционируется `absolute` (см. AllotmentConfirm):
            на контейнере стоит `transform`, а он делает родителя containing block
            для `position: fixed` детей — «fixed» здесь всё равно накрыл бы только
            это окно, но вёл бы себя неочевидно (грабли из NOTES.md). */}
        {allotmentWarning && (
          <AllotmentConfirm
            message={allotmentWarning}
            busy={submitting}
            confirmLabel="Всё равно переселить"
            busyLabel="Переселяем…"
            onCancel={() => setAllotmentWarning(null)}
            onConfirm={confirmAllotmentOverride}
          />
        )}
      </div>
    </>
  )
}

function pluralNights(n: number): string {
  const mod10  = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'ночь'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'ночи'
  return 'ночей'
}

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{
      fontSize: '0.77rem', fontWeight: 700, color: 'var(--text-faint)',
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>
      {label}
    </span>
    {children}
    {hint && <span style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>{hint}</span>}
  </div>
)

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: '1rem',
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
}
