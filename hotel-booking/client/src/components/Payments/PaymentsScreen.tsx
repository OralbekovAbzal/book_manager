import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchDebts, fetchCurrentShiftSummary, voidPayment,
  METHOD_LABELS,
  type DebtRow, type Payment, type ShiftSummary,
} from '../../api/payments'
import { useAuthStore } from '../../store/useAuthStore'
import { inputStyle, secondaryBtn, formTitle, EmptyBox } from '../Settings/sections/sectionUi'
import { apiErrorText, card, fmtDate, fmtTime, InlinePrompt, money, Stat, td, th } from './paymentsUi'
import { BookingPaymentPanel } from './BookingPaymentPanel'

/**
 * Раздел «Касса».
 *
 * Две половины одной задачи «деньги в программе сходятся с деньгами на руках»:
 *   • «Приём оплаты» — по каждой брони видно начислено / принято / долг,
 *     и деньги принимаются здесь же, а не считаются в уме;
 *   • «Смена» — отчёт по кассе: сколько принято чем, кем, сколько возвращено.
 *
 * Смену и рабочую дату проставляет СЕРВЕР (дата смены, а не дата устройства) —
 * экран их только показывает.
 *
 * Сам приём денег живёт в `BookingPaymentPanel` — тот же компонент открывается
 * из формы брони. Здесь остаётся только список «кто сколько должен» и отчёт смены.
 */

interface Props {
  onBack: () => void
}

/** Бейдж отменённой брони в списке долгов. */
const cancelledBadge: React.CSSProperties = {
  fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap',
  padding: '1px 7px', borderRadius: 20,
  background: 'var(--surface-2)', color: 'var(--s-out)',
  border: '1px solid var(--border-subtle)',
}

export const PaymentsScreen: React.FC<Props> = ({ onBack }) => {
  const admin = useAuthStore((s) => s.admin)
  const canVoid = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [tab, setTab] = useState<'take' | 'shift'>('take')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])
  const flash = (text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2600)
  }

  // ─── Приём оплаты ──────────────────────────────────────────────────────────
  const [query, setQuery] = useState('')
  const [debts, setDebts] = useState<DebtRow[]>([])
  const [businessDate, setBusinessDate] = useState<string | null>(null)
  const [loadingDebts, setLoadingDebts] = useState(true)
  const [onlyDebt, setOnlyDebt] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const loadDebts = (q: string) => {
    setLoadingDebts(true)
    fetchDebts(q)
      .then((d) => { setDebts(d.bookings); setBusinessDate(d.businessDate) })
      .catch(() => {})
      .finally(() => setLoadingDebts(false))
  }

  // Поиск с дебаунсом: список приходит с сервера, дёргать его на каждую букву незачем.
  useEffect(() => {
    const t = window.setTimeout(() => loadDebts(query.trim()), query ? 350 : 0)
    return () => window.clearTimeout(t)
  }, [query])

  const selected = useMemo(() => debts.find((d) => d.id === selectedId) || null, [debts, selectedId])

  const visibleDebts = useMemo(
    () => (onlyDebt ? debts.filter((d) => d.due > 0) : debts),
    [debts, onlyDebt],
  )

  const totalDue = useMemo(
    () => debts.reduce((s, d) => s + (d.due > 0 ? d.due : 0), 0),
    [debts],
  )

  // ─── Смена ─────────────────────────────────────────────────────────────────
  const [shift, setShift] = useState<ShiftSummary | null>(null)
  const [shiftError, setShiftError] = useState('')
  const [loadingShift, setLoadingShift] = useState(false)
  // Какую запись смены отменяем: причина спрашивается формой, а не window.prompt
  // (в Electron prompt() не работает вовсе).
  const [voidingShift, setVoidingShift] = useState<Payment | null>(null)

  const loadShift = () => {
    setLoadingShift(true); setShiftError('')
    fetchCurrentShiftSummary()
      .then(setShift)
      .catch((e) => setShiftError(apiErrorText(e, 'Не удалось загрузить кассу смены')))
      .finally(() => setLoadingShift(false))
  }
  useEffect(() => { if (tab === 'shift') loadShift() }, [tab])

  const doVoidInShift = async (p: Payment, reason: string) => {
    if (!reason.trim()) { flash('Причина отмены обязательна'); return }
    setVoidingShift(null)
    try {
      await voidPayment(p.id, reason.trim())
      flash('Запись отменена')
      loadShift()
      loadDebts(query.trim())
    } catch (e) {
      flash(apiErrorText(e, 'Не удалось отменить запись'))
    }
  }

  // ─── Разметка ──────────────────────────────────────────────────────────────
  const tabBtn = (id: 'take' | 'shift'): React.CSSProperties => ({
    height: 32, padding: '0 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
    fontSize: '0.85rem', fontWeight: 600,
    background: tab === id ? 'var(--accent-bg)' : 'transparent',
    color: tab === id ? 'var(--accent-text)' : 'var(--text-muted)',
    border: `1px solid ${tab === id ? 'var(--accent)' : 'var(--border-subtle)'}`,
  })

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      {/* Шапка раздела */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 18px',
        borderBottom: '1px solid var(--border-subtle)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <button onClick={onBack} style={{ ...secondaryBtn, height: 32 }}>← Шахматка</button>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.25 }}>
          <span style={{ fontSize: '1.02rem', fontWeight: 600, letterSpacing: '-0.02em' }}>Касса</span>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>
            Рабочий день {fmtDate(businessDate || shift?.shift?.date)}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <button onClick={() => setTab('take')} style={tabBtn('take')}>Приём оплаты</button>
        <button onClick={() => setTab('shift')} style={tabBtn('shift')}>Смена</button>
      </div>

      {toast && (
        <div style={{
          margin: '10px 18px 0', padding: '8px 12px', borderRadius: 8,
          background: 'var(--accent-bg)', color: 'var(--accent-text)', fontSize: '0.84rem',
        }}>{toast}</div>
      )}

      {tab === 'take' ? (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 14, padding: 18, overflow: 'hidden' }}>
          {/* Слева — кто сколько должен */}
          <div style={{ flex: '1 1 420px', minWidth: 320, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Гость, телефон или номер комнаты…"
                style={{ ...inputStyle, flex: 1, minWidth: 180 }}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.8rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={onlyDebt} onChange={(e) => setOnlyDebt(e.target.checked)} />
                только с долгом
              </label>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginBottom: 8 }}>
              {loadingDebts ? 'Загрузка…' : `Броней: ${visibleDebts.length} · Долг всего: ${money(totalDue)}`}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 12 }}>
              {visibleDebts.length === 0 && !loadingDebts ? (
                <div style={{ padding: 18 }}><EmptyBox>Ничего не найдено</EmptyBox></div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
                    <tr>
                      <th style={th}>Гость</th>
                      <th style={th}>Даты</th>
                      <th style={{ ...th, textAlign: 'right' }}>Начислено</th>
                      <th style={{ ...th, textAlign: 'right' }}>Принято</th>
                      <th style={{ ...th, textAlign: 'right' }}>Долг</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleDebts.map((b) => (
                      <tr
                        key={b.id}
                        onClick={() => setSelectedId(b.id)}
                        style={{
                          cursor: 'pointer',
                          background: b.id === selectedId ? 'var(--accent-bg)' : 'transparent',
                        }}
                      >
                        <td style={td}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600 }}>{b.guestName}</span>
                            {/* Отменённая бронь в списке долгов — не ошибка: отмена сняла
                                начисления, и принятые деньги стали отрицательным долгом,
                                то есть обязательством вернуть. Без бейджа строка выглядела
                                бы обычной бронью с переплатой (решение в data-and-money.md). */}
                            {b.status === 'CANCELLED' && (
                              <span style={cancelledBadge}>
                                отменена
                                {b.due < 0 ? ` · к возврату ${money(-b.due)} ₸` : ''}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>
                            №{b.room?.number ?? '—'}{b.guestPhone ? ` · ${b.guestPhone}` : ''}
                          </div>
                        </td>
                        <td style={{ ...td, whiteSpace: 'nowrap', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          {fmtDate(b.checkIn)}<br />{fmtDate(b.checkOut)}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>
                          {money(b.charged)}
                          {!b.chargesFromRows && b.charged > 0 && (
                            <div style={{ fontSize: '0.68rem', color: 'var(--text-faint)' }}>итог брони</div>
                          )}
                        </td>
                        <td style={{ ...td, textAlign: 'right' }}>{money(b.paid)}</td>
                        <td style={{
                          ...td, textAlign: 'right', fontWeight: 600,
                          color: b.due > 0 ? 'var(--s-overdue)' : b.due < 0 ? 'var(--s-out)' : 'var(--text-faint)',
                        }}>{money(b.due)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Справа — приём денег по выбранной брони */}
          <div style={{ flex: '1 1 380px', minWidth: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!selected ? (
              <EmptyBox>Выберите бронь слева, чтобы принять оплату</EmptyBox>
            ) : (
              <BookingPaymentPanel
                key={selected.id}
                bookingId={selected.id}
                fallback={{ charged: selected.charged, paid: selected.paid, due: selected.due }}
                header={
                  <>
                    <div style={{ ...formTitle, marginBottom: 2 }}>{selected.guestName}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
                      Номер {selected.room?.number ?? '—'} · {fmtDate(selected.checkIn)} — {fmtDate(selected.checkOut)}
                    </div>
                  </>
                }
                onFlash={flash}
                onChanged={() => loadDebts(query.trim())}
              />
            )}
          </div>
        </div>
      ) : (
        /* ─── Отчёт по кассе за смену ─────────────────────────────────────── */
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 18 }}>
          {shiftError ? (
            <EmptyBox>{shiftError}</EmptyBox>
          ) : !shift ? (
            <EmptyBox>{loadingShift ? 'Загрузка…' : 'Нет данных'}</EmptyBox>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 1100 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Stat label="Принято за смену" value={money(shift.totals.received)} tone="plus" hint={`операций: ${shift.totals.count}`} />
                <Stat label="Возвращено" value={money(shift.totals.refunded)} tone="minus" />
                <Stat label="Итого в кассе" value={money(shift.totals.net)} />
                <Stat label="Отменённые записи" value={String(shift.totals.voidedCount)}
                  hint={shift.totals.voidedCount ? `на ${money(shift.totals.voidedAmount)} — в кассу не входят` : 'нет'} />
              </div>

              <div style={card}>
                <div style={{ ...formTitle, marginBottom: 8 }}>По способам оплаты</div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={th}>Способ</th>
                      <th style={{ ...th, textAlign: 'right' }}>Принято</th>
                      <th style={{ ...th, textAlign: 'right' }}>Возвращено</th>
                      <th style={{ ...th, textAlign: 'right' }}>Итого</th>
                      <th style={{ ...th, textAlign: 'right' }}>Операций</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shift.byMethod.map((m) => (
                      <tr key={m.method}>
                        <td style={td}>{m.label}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{money(m.received)}</td>
                        <td style={{ ...td, textAlign: 'right' }}>{money(m.refunded)}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(m.net)}</td>
                        <td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>{m.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={card}>
                <div style={{ ...formTitle, marginBottom: 8 }}>Кто принял</div>
                {shift.byAdmin.length === 0 ? (
                  <div style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>За смену денег ещё не принимали</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>Сотрудник</th>
                        <th style={{ ...th, textAlign: 'right' }}>Принято</th>
                        <th style={{ ...th, textAlign: 'right' }}>Возвращено</th>
                        <th style={{ ...th, textAlign: 'right' }}>Итого</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shift.byAdmin.map((a) => (
                        <tr key={`${a.adminId ?? a.adminName}`}>
                          <td style={td}>{a.adminName}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{money(a.received)}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{money(a.refunded)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{money(a.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={card}>
                <div style={{ ...formTitle, marginBottom: 8 }}>Операции смены</div>
                {shift.payments.length === 0 ? (
                  <div style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>Пока пусто</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={th}>Время</th>
                        <th style={th}>Гость</th>
                        <th style={th}>Способ</th>
                        <th style={th}>Принял</th>
                        <th style={{ ...th, textAlign: 'right' }}>Сумма</th>
                        <th style={th} />
                      </tr>
                    </thead>
                    <tbody>
                      {shift.payments.map((p) => (
                        <React.Fragment key={p.id}>
                          <tr style={{ opacity: p.voidedAt ? 0.55 : 1 }}>
                            <td style={{ ...td, whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>{fmtTime(p.paidAt)}</td>
                            <td style={td}>
                              {p.booking?.guestName ?? `бронь #${p.bookingId}`}
                              {p.booking?.room?.number ? <span style={{ color: 'var(--text-faint)' }}> · №{p.booking.room.number}</span> : null}
                              {p.voidReason && <div style={{ fontSize: '0.74rem', color: 'var(--s-overdue)' }}>отменён: {p.voidReason}</div>}
                            </td>
                            <td style={td}>{METHOD_LABELS[p.method]}</td>
                            <td style={{ ...td, color: 'var(--text-muted)' }}>{p.adminName}</td>
                            <td style={{
                              ...td, textAlign: 'right', fontWeight: 600,
                              color: p.kind === 'refund' ? 'var(--s-overdue)' : 'var(--text)',
                            }}>
                              {p.kind === 'refund' ? '−' : '+'}{money(p.amount)}
                            </td>
                            <td style={{ ...td, textAlign: 'right' }}>
                              {!p.voidedAt && canVoid && (
                                <button
                                  onClick={() => setVoidingShift(voidingShift?.id === p.id ? null : p)}
                                  style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem' }}
                                >
                                  Отменить
                                </button>
                              )}
                            </td>
                          </tr>
                          {voidingShift?.id === p.id && (
                            <tr>
                              <td style={{ ...td, borderTop: 'none' }} colSpan={6}>
                                <InlinePrompt
                                  label="Отмена ошибочной записи — деньги при этом не возвращаются. Причина:"
                                  placeholder="например: пробита не та бронь"
                                  confirmLabel="Отменить запись"
                                  onConfirm={(v) => doVoidInShift(p, v)}
                                  onCancel={() => setVoidingShift(null)}
                                />
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
