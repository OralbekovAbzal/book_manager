import React, { useEffect, useState } from 'react'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { fetchBooking } from '../../api/bookings'
import type { Booking } from '../../types'

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED:   'Подтверждена',
  CHECKED_IN:  'Заехал',
  CHECKED_OUT: 'Выехал',
  CANCELLED:   'Отменена',
  NO_SHOW:     'Не приехал',
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED:   '#2563eb',
  CHECKED_IN:  '#059669',
  CHECKED_OUT: '#6b7280',
  CANCELLED:   '#dc2626',
  NO_SHOW:     '#b45309',
}

const fmtMoney = (n?: number) => (n != null ? n.toLocaleString('ru-RU') + ' ₸' : '—')
const fmtDate = (iso?: string) => {
  if (!iso) return '—'
  return new Date(iso.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })
}

export const BookingViewModal: React.FC = () => {
  const { modal, closeModal } = useGridStore()
  const { roomFund } = useSettingsStore()

  const open = modal.open && modal.mode === 'view'
  const booking = modal.booking

  // Объект из сетки может прийти без гостей/сумм — тогда подгружаем полную бронь с сервера
  const [full, setFull] = useState<Booking | null>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, closeModal])

  useEffect(() => {
    setFull(null)
    if (!open || !booking || booking.totalAmount !== undefined) return
    let cancelled = false
    fetchBooking(booking.id)
      .then(b => { if (!cancelled) setFull(b) })
      .catch(() => { /* секции «Гость»/«Оплата» покажут то, что есть в объекте сетки */ })
    return () => { cancelled = true }
  }, [open, booking?.id])

  if (!open || !booking) return null

  // Гости и оплата — из полной версии, если она подгружена
  const info = full ?? booking

  const nights = differenceInCalendarDays(
    parseISO(booking.checkOut.slice(0, 10)),
    parseISO(booking.checkIn.slice(0, 10)),
  )

  const guestTotal =
    (info.adultsWithMeals ?? 0) + (info.childrenWithMeals ?? 0) +
    (info.adultsNoMeals ?? 0) + (info.childrenNoMeals ?? 0)

  const flagLabels = (() => {
    const flags = booking.flags ?? []
    if (flags.length === 0) return []
    const map = new Map((roomFund.bookingFlags ?? []).map(f => [f.id, f.label]))
    return flags.map(f => map.get(f) ?? f)
  })()

  const debt = (info.totalAmount ?? 0) - (info.paidAmount ?? 0)

  return (
    <Overlay onClose={closeModal}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '20px 24px 16px', borderBottom: '1px solid var(--border)',
      }}>
        <div>
          <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)' }}>
            {booking.guestName}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{
              fontSize: '0.82rem', fontWeight: 700, color: '#fff',
              background: STATUS_COLORS[booking.status] ?? '#6b7280',
              padding: '2px 9px', borderRadius: 20,
            }}>
              {STATUS_LABELS[booking.status] ?? booking.status}
            </span>
            {booking.partner && (
              <span style={{
                fontSize: '0.82rem', fontWeight: 700, color: '#fff',
                background: booking.partner.color, padding: '2px 9px', borderRadius: 20,
              }}>
                🅰 {booking.partner.name}
              </span>
            )}
          </div>
        </div>
        <button onClick={closeModal} style={closeBtnStyle}>×</button>
      </div>

      {/* Body */}
      <div style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto' }}>
        <Section title="Проживание">
          <Row label="Заезд" value={fmtDate(booking.checkIn)} />
          <Row label="Выезд" value={fmtDate(booking.checkOut)} />
          <Row label="Ночей" value={String(nights)} />
          {booking.source && <Row label="Источник" value={booking.source} />}
        </Section>

        {(booking.guestPhone || guestTotal > 0) && (
          <Section title="Гость">
            {booking.guestPhone && <Row label="Телефон" value={booking.guestPhone} />}
            {guestTotal > 0 && (
              <>
                {(info.adultsWithMeals ?? 0) > 0 && <Row label="Взрослые (с питанием)" value={String(info.adultsWithMeals)} />}
                {(info.childrenWithMeals ?? 0) > 0 && <Row label="Дети (с питанием)" value={String(info.childrenWithMeals)} />}
                {(info.adultsNoMeals ?? 0) > 0 && <Row label="Взрослые (без питания)" value={String(info.adultsNoMeals)} />}
                {(info.childrenNoMeals ?? 0) > 0 && <Row label="Дети (без питания)" value={String(info.childrenNoMeals)} />}
                {(info.extraBedsWithMeals ?? 0) > 0 && <Row label="Доп. места (с питанием)" value={String(info.extraBedsWithMeals)} />}
                {(info.extraBedsNoMeals ?? 0) > 0 && <Row label="Доп. места (без питания)" value={String(info.extraBedsNoMeals)} />}
              </>
            )}
          </Section>
        )}

        {(info.totalAmount != null || info.paidAmount != null) && (
          <Section title="Оплата">
            <Row label="Сумма" value={fmtMoney(info.totalAmount)} />
            <Row label="Оплачено" value={fmtMoney(info.paidAmount)} />
            {(info.discountPercent ?? 0) > 0 && <Row label="Скидка" value={`${info.discountPercent}%`} />}
            {debt > 0 && <Row label="Задолженность" value={fmtMoney(debt)} valueColor="#dc2626" />}
          </Section>
        )}

        {flagLabels.length > 0 && (
          <Section title="Метки">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {flagLabels.map((l, i) => (
                <span key={i} style={{
                  fontSize: '0.85rem', fontWeight: 600,
                  background: 'var(--surface-2)', color: 'var(--text-muted)',
                  padding: '3px 9px', borderRadius: 6,
                }}>{l}</span>
              ))}
            </div>
          </Section>
        )}

        {booking.notes && (
          <Section title="Примечания">
            <div style={{ fontSize: '0.95rem', color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {booking.notes}
            </div>
          </Section>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '14px 24px', borderTop: '1px solid var(--border)',
        display: 'flex', justifyContent: 'flex-end',
      }}>
        <button onClick={closeModal} style={primaryBtnStyle}>Закрыть</button>
      </div>
    </Overlay>
  )
}

// ─── Sub-components ─────────────────────────────────────────────────────────────

const Overlay: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div
    onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
  >
    <div style={{
      width: '90vw', maxWidth: 480, maxHeight: '88vh',
      background: 'var(--bg)', color: 'var(--text)',
      borderRadius: 12, border: '1px solid var(--border)',
      boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {children}
    </div>
  </div>
)

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div>
    <div style={{
      fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-faint)',
      letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8,
    }}>{title}</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
  </div>
)

const Row: React.FC<{ label: string; value: string; valueColor?: string }> = ({ label, value, valueColor }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: '0.95rem' }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontWeight: 600, color: valueColor ?? 'var(--text)', textAlign: 'right' }}>{value}</span>
  </div>
)

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '1.6rem', color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px', fontWeight: 300,
}

const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
