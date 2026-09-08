import React, { useEffect, useState } from 'react'
import {
  fetchBookingPayments, createPayment, refundPayment, voidPayment,
  METHOD_LABELS,
  type BookingMoney, type Payment, type PaymentMethod,
} from '../../api/payments'
import { useAuthStore } from '../../store/useAuthStore'
import { inputStyle, labelStyle, primaryBtn, secondaryBtn, formTitle } from '../Settings/sections/sectionUi'
import { apiErrorText, card, fmtTime, InlinePrompt, money, Stat, td } from './paymentsUi'

/**
 * Деньги ОДНОЙ брони: сводка «начислено / принято / долг», приём оплаты и журнал.
 *
 * Один и тот же компонент работает в разделе «Касса» (справа от списка долгов) и
 * в диалоге приёма оплаты из формы брони. Две копии работы с деньгами держать
 * нельзя: правка в одном экране молча разошлась бы со вторым, а расходятся
 * такие копии именно там, где это дороже всего.
 *
 * Права: приём оплаты и возврат доступны любому вошедшему — деньги принимает
 * стойка (`server/src/routes/payments.js`). Отмена ОШИБОЧНОЙ записи правит уже
 * закрытую кассу — только ADMIN.
 *
 * Возврат делается ТОЛЬКО по конкретному платежу — кнопкой в строке журнала.
 * «Свободного» возврата из формы приёма больше нет: кнопка стояла вплотную к
 * «Принять», сумма была предзаполнена всем долгом, и промах записывал «деньги
 * отданы гостю» (аудит D6-011). Сервер такой запрос теперь и не принимает —
 * `POST /payments` с `kind: refund` отвечает 400.
 */

const METHODS: PaymentMethod[] = ['cash', 'card', 'transfer']

/** Суммы, известные вызывающему до загрузки журнала (строка списка долгов). */
export interface MoneyFallback {
  charged: number
  paid: number
  due: number
}

interface Props {
  bookingId: number
  /** Показать, пока грузится журнал: иначе карточка мигает прочерками. */
  fallback?: MoneyFallback | null
  /** Шапка карточки сводки — гость, номер, даты. */
  header?: React.ReactNode
  /** Уведомление пользователю; тост рисует владелец экрана. */
  onFlash: (text: string) => void
  /** Деньги брони изменились — владельцу пора обновить свои списки и поля. */
  onChanged?: (summary: BookingMoney) => void
  /** Диалог открывают ради ввода суммы — ставим в неё курсор сразу. */
  autoFocusAmount?: boolean
}

export const BookingPaymentPanel: React.FC<Props> = ({
  bookingId, fallback, header, onFlash, onChanged, autoFocusAmount,
}) => {
  const admin = useAuthStore((s) => s.admin)
  const canVoid = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [journal, setJournal] = useState<Payment[]>([])
  const [summary, setSummary] = useState<BookingMoney | null>(null)
  const [loading, setLoading] = useState(true)

  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Открытая мини-форма в журнале: возврат по платежу или отмена записи
  const [refunding, setRefunding] = useState<Payment | null>(null)
  const [voiding, setVoiding] = useState<Payment | null>(null)

  // Смена брони — полная перезагрузка: панель переиспользуется в списке долгов,
  // где выбор строки не размонтирует компонент.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(''); setComment(''); setAmount('')
    setJournal([]); setSummary(null)
    setRefunding(null); setVoiding(null)
    fetchBookingPayments(bookingId)
      .then((d) => {
        if (cancelled) return
        setJournal(d.payments)
        setSummary(d.summary)
        // Подставляем остаток долга: чаще всего принимают именно его.
        if (d.summary.due > 0) setAmount(String(d.summary.due))
      })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить платежи брони') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bookingId])

  const reload = async () => {
    const d = await fetchBookingPayments(bookingId)
    setJournal(d.payments)
    setSummary(d.summary)
    onChanged?.(d.summary)
  }

  /** Только приём. Возврат — `doRefund` по строке журнала, см. комментарий выше. */
  const submitPayment = async () => {
    const value = Number(String(amount).replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) { setError('Сумма должна быть больше нуля'); return }
    setSaving(true); setError('')
    try {
      const res = await createPayment({
        bookingId, amount: value, kind: 'payment', method, comment: comment.trim() || undefined,
      })
      setSummary(res.summary)
      setJournal((prev) => [res.payment, ...prev])
      setAmount(''); setComment('')
      onChanged?.(res.summary)
      onFlash(`Принято ${money(value)}`)
    } catch (e) {
      setError(apiErrorText(e, 'Не удалось сохранить платёж'))
    } finally {
      setSaving(false)
    }
  }

  const doRefund = async (p: Payment, raw: string) => {
    const value = Number(raw.replace(',', '.'))
    if (!Number.isFinite(value) || value <= 0) { onFlash('Сумма возврата должна быть больше нуля'); return }
    setRefunding(null)
    try {
      await refundPayment(p.id, { amount: value })
      await reload()
      onFlash(`Возврат ${money(value)} проведён`)
    } catch (e) {
      onFlash(apiErrorText(e, 'Не удалось провести возврат'))
    }
  }

  const doVoid = async (p: Payment, reason: string) => {
    if (!reason.trim()) { onFlash('Причина отмены обязательна'); return }
    setVoiding(null)
    try {
      await voidPayment(p.id, reason.trim())
      await reload()
      onFlash('Запись отменена')
    } catch (e) {
      onFlash(apiErrorText(e, 'Не удалось отменить запись'))
    }
  }

  const charged = summary?.charged ?? fallback?.charged ?? 0
  const paid = summary?.paid ?? fallback?.paid ?? 0
  const due = summary?.due ?? fallback?.due ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={card}>
        {header}
        <div style={{ display: 'flex', gap: 10, marginTop: header ? 12 : 0, flexWrap: 'wrap' }}>
          <Stat
            label="Начислено"
            value={money(charged)}
            hint={summary && !summary.chargesFromRows ? 'строк начислений ещё нет' : undefined}
          />
          <Stat label="Принято" value={money(paid)} tone="plus" />
          <Stat label="Долг" value={money(due)} tone={due > 0 ? 'minus' : 'plain'} />
        </div>
      </div>

      <div style={card}>
        <div style={{ ...formTitle, marginBottom: 10 }}>Принять оплату</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label style={labelStyle}>Сумма</label>
            <input
              autoFocus={autoFocusAmount}
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
          <button
            type="button"
            disabled={saving}
            onClick={() => submitPayment()}
            style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}
          >
            Принять
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: '0.76rem', color: 'var(--text-faint)', lineHeight: 1.4 }}>
          Возврат делается по конкретному платежу — кнопкой «Возврат» в истории ниже.
        </div>
      </div>

      <div style={card}>
        <div style={{ ...formTitle, marginBottom: 8 }}>
          История платежей
          {loading && <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · загрузка…</span>}
        </div>
        {journal.length === 0 ? (
          <div style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>
            {loading ? '' : 'Платежей ещё не было'}
          </div>
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
                    {refunding?.id === p.id && (
                      <InlinePrompt
                        label={`Возврат по платежу от ${fmtTime(p.paidAt)} · принято ${money(p.amount)}`}
                        initial={String(p.amount)}
                        confirmLabel="Вернуть"
                        onConfirm={(v) => doRefund(p, v)}
                        onCancel={() => setRefunding(null)}
                      />
                    )}
                    {voiding?.id === p.id && (
                      <InlinePrompt
                        label="Отмена ошибочной записи — деньги при этом не возвращаются. Причина:"
                        placeholder="например: пробита не та бронь"
                        confirmLabel="Отменить запись"
                        onConfirm={(v) => doVoid(p, v)}
                        onCancel={() => setVoiding(null)}
                      />
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                    {!p.voidedAt && p.kind === 'payment' && (
                      <button
                        type="button"
                        onClick={() => { setVoiding(null); setRefunding(refunding?.id === p.id ? null : p) }}
                        style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem' }}
                      >
                        Возврат
                      </button>
                    )}
                    {!p.voidedAt && canVoid && (
                      <button
                        type="button"
                        onClick={() => { setRefunding(null); setVoiding(voiding?.id === p.id ? null : p) }}
                        title="Ошибочная запись"
                        style={{ ...secondaryBtn, height: 28, padding: '0 10px', fontSize: '0.78rem', marginLeft: 6 }}
                      >
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
  )
}
