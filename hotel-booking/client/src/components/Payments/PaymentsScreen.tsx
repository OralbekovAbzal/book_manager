import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchDebts, fetchBookingPayments, fetchCurrentShiftSummary,
  createPayment, refundPayment, voidPayment,
  METHOD_LABELS,
  type DebtRow, type Payment, type BookingMoney, type PaymentMethod, type ShiftSummary,
} from '../../api/payments'
import { useAuthStore } from '../../store/useAuthStore'
import {
  inputStyle, labelStyle, primaryBtn, secondaryBtn, formTitle, EmptyBox,
} from '../Settings/sections/sectionUi'

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
 */

interface Props {
  onBack: () => void
}

const METHODS: PaymentMethod[] = ['cash', 'card', 'transfer']

const money = (n: number) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n ?? 0)

/** Даты `@db.Date` — UTC-полночь, рендерим в UTC, иначе съезжает на день. */
const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('ru-RU', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' })
}
/** Время приёма денег — реальные часы, местная зона. */
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

const card: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border-subtle)',
  borderRadius: 12, padding: 14,
}

const th: React.CSSProperties = {
  textAlign: 'left', fontSize: '0.74rem', fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '0.03em', color: 'var(--text-faint)', padding: '6px 10px', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  padding: '9px 10px', fontSize: '0.85rem', color: 'var(--text)', borderTop: '1px solid var(--border-subtle)',
}

const Stat: React.FC<{ label: string; value: string; tone?: 'plus' | 'minus' | 'plain'; hint?: string }> = ({ label, value, tone = 'plain', hint }) => (
  <div style={{ ...card, flex: '1 1 160px', minWidth: 150 }}>
    <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
    <div style={{
      fontSize: '1.32rem', fontWeight: 600, letterSpacing: '-0.02em',
      color: tone === 'plus' ? 'var(--s-in)' : tone === 'minus' ? 'var(--s-overdue)' : 'var(--text)',
    }}>{value}</div>
    {hint && <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)', marginTop: 3 }}>{hint}</div>}
  </div>
)

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
  const [journal, setJournal] = useState<Payment[]>([])
  const [summary, setSummary] = useState<BookingMoney | null>(null)
  const [loadingJournal, setLoadingJournal] = useState(false)

  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

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

  const loadJournal = (bookingId: number) => {
    setLoadingJournal(true)
    fetchBookingPayments(bookingId)
      .then((d) => { setJournal(d.payments); setSummary(d.summary) })
      .catch(() => {})
      .finally(() => setLoadingJournal(false))
  }

  const select = (row: DebtRow) => {
    setSelectedId(row.id)
    setError('')
    setComment('')
    // Подставляем остаток долга: чаще всего принимают именно его.
    setAmount(row.due > 0 ? String(row.due) : '')
    loadJournal(row.id)
  }

  const selected = useMemo(() => debts.find((d) => d.id === selectedId) || null, [debts, selectedId])

  const visibleDebts = useMemo(
    () => (onlyDebt ? debts.filter((d) => d.due > 0) : debts),
    [debts, onlyDebt],
  )

  const totalDue = useMemo(
    () => debts.reduce((s, d) => s + (d.due > 0 ? d.due : 0), 0),
    [debts],
  )

  const submitPayment = async (kind: 'payment' | 'refund') => {
    if (!selectedId) return
    const value = Number(String(amount).replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) { setError('Сумма должна быть больше нуля'); return }
    setSaving(true); setError('')
    try {
      const res = await createPayment({ bookingId: selectedId, amount: value, kind, method, comment: comment.trim() || undefined })
      setSummary(res.summary)
      setJournal((prev) => [res.payment, ...prev])
      setAmount(''); setComment('')
      flash(kind === 'refund' ? `Возврат ${money(value)} проведён` : `Принято ${money(value)}`)
      loadDebts(query.trim())
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Не удалось сохранить платёж')
    } finally {
      setSaving(false)
    }
  }

  const doRefund = async (p: Payment) => {
    const raw = window.prompt(`Возврат по платежу от ${fmtTime(p.paidAt)}. Сумма (принято ${money(p.amount)}):`, String(p.amount))
    if (raw == null) return
    const value = Number(raw.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) { flash('Сумма возврата должна быть больше нуля'); return }
    try {
      const res = await refundPayment(p.id, { amount: value })
      setSummary(res.summary)
      if (selectedId) loadJournal(selectedId)
      loadDebts(query.trim())
      flash(`Возврат ${money(value)} проведён`)
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Не удалось провести возврат')
    }
  }

  const doVoid = async (p: Payment, after?: () => void) => {
    const reason = window.prompt('Отмена ОШИБОЧНОЙ записи (деньги при этом не возвращаются).\nПричина:')
    if (reason == null) return
    if (!reason.trim()) { flash('Причина отмены обязательна'); return }
    try {
      await voidPayment(p.id, reason.trim())
      flash('Запись отменена')
      if (selectedId) loadJournal(selectedId)
      loadDebts(query.trim())
      after?.()
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Не удалось отменить запись')
    }
  }

  // ─── Смена ─────────────────────────────────────────────────────────────────
  const [shift, setShift] = useState<ShiftSummary | null>(null)
  const [shiftError, setShiftError] = useState('')
  const [loadingShift, setLoadingShift] = useState(false)

  const loadShift = () => {
    setLoadingShift(true); setShiftError('')
    fetchCurrentShiftSummary()
      .then(setShift)
      .catch((e) => setShiftError(e?.response?.data?.error || 'Не удалось загрузить кассу смены'))
      .finally(() => setLoadingShift(false))
  }
  useEffect(() => { if (tab === 'shift') loadShift() }, [tab])

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
                        onClick={() => select(b)}
                        style={{
                          cursor: 'pointer',
                          background: b.id === selectedId ? 'var(--accent-bg)' : 'transparent',
                        }}
                      >
                        <td style={td}>
                          <div style={{ fontWeight: 600 }}>{b.guestName}</div>
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
              <>
                <div style={card}>
                  <div style={{ ...formTitle, marginBottom: 2 }}>{selected.guestName}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
                    Номер {selected.room?.number ?? '—'} · {fmtDate(selected.checkIn)} — {fmtDate(selected.checkOut)}
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                    <Stat label="Начислено" value={money(summary?.charged ?? selected.charged)}
                      hint={summary && !summary.chargesFromRows ? 'строк начислений ещё нет' : undefined} />
                    <Stat label="Принято" value={money(summary?.paid ?? selected.paid)} tone="plus" />
                    <Stat label="Долг" value={money(summary?.due ?? selected.due)}
                      tone={(summary?.due ?? selected.due) > 0 ? 'minus' : 'plain'} />
                  </div>
                </div>

                <div style={card}>
                  <div style={{ ...formTitle, marginBottom: 10 }}>Принять оплату</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 140px' }}>
                      <label style={labelStyle}>Сумма</label>
                      <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="decimal"
                        placeholder="0"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ flex: '1 1 140px' }}>
                      <label style={labelStyle}>Способ</label>
                      <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)} style={inputStyle}>
                        {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <label style={labelStyle}>Комментарий</label>
                    <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="необязательно" style={inputStyle} />
                  </div>
                  {error && <div style={{ marginTop: 8, fontSize: '0.82rem', color: 'var(--s-overdue)' }}>{error}</div>}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                    <button disabled={saving} onClick={() => submitPayment('payment')} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
                      Принять
                    </button>
                    <button disabled={saving} onClick={() => submitPayment('refund')} style={secondaryBtn} title="Деньги отданы гостю">
                      Возврат
                    </button>
                  </div>
                </div>

                <div style={card}>
                  <div style={{ ...formTitle, marginBottom: 8 }}>
                    История платежей {loadingJournal && <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>· загрузка…</span>}
                  </div>
                  {journal.length === 0 ? (
                    <div style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>Платежей ещё не было</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {journal.map((p) => (
                          <tr key={p.id} style={{ opacity: p.voidedAt ? 0.55 : 1 }}>
                            <td style={{ ...td, whiteSpace: 'nowrap' }}>
                              <div style={{ fontWeight: 600, color: p.kind === 'refund' ? 'var(--s-overdue)' : 'var(--text)' }}>
                                {p.kind === 'refund' ? '−' : '+'}{money(p.amount)}
                                {p.voidedAt && <span style={{ marginLeft: 6, fontWeight: 400, fontSize: '0.74rem' }}>отменён</span>}
                              </div>
                              <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)' }}>
                                {METHOD_LABELS[p.method]} · {fmtTime(p.paidAt)} · {p.adminName}
                              </div>
                              {p.comment && <div style={{ fontSize: '0.74rem', color: 'var(--text-faint)' }}>{p.comment}</div>}
                              {p.voidReason && <div style={{ fontSize: '0.74rem', color: 'var(--s-overdue)' }}>причина: {p.voidReason}</div>}
                            </td>
                            <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {!p.voidedAt && p.kind === 'payment' && (
                                <button onClick={() => doRefund(p)} style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem' }}>
                                  Возврат
                                </button>
                              )}
                              {!p.voidedAt && canVoid && (
                                <button onClick={() => doVoid(p)} title="Ошибочная запись"
                                  style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem', marginLeft: 6 }}>
                                  Отменить
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </>
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
                        <tr key={p.id} style={{ opacity: p.voidedAt ? 0.55 : 1 }}>
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
                              <button onClick={() => doVoid(p, loadShift)}
                                style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem' }}>
                                Отменить
                              </button>
                            )}
                          </td>
                        </tr>
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
