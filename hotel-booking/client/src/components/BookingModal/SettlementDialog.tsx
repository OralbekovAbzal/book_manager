import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  previewSettlement, settleBooking,
  type SettlementAction, type SettlementPreview, type SettlementResult,
} from '../../api/bookings'
import { METHOD_LABELS, type PaymentMethod } from '../../api/payments'
import { inputStyle, labelStyle } from '../Settings/sections/sectionUi'
import { money } from '../Payments/paymentsUi'
import { formatApiError } from '../Setup/accountRules'

/**
 * Расчёт с гостем: отмена, ранний выезд и возврат переплаты — в одном окне.
 *
 * Зачем именно так (слова владельца): «чтобы можно было сразу сделать возврат,
 * не лезть в кассу: тот же калькулятор выводит, сколько к возврату, админ может
 * менять данные, так как бывают разные ситуации — какую часть вернуть и сколько
 * штраф». Раньше отмена и выезд только меняли статус, а деньги оставались висеть
 * переплатой, и за возвратом приходилось идти в раздел «Касса» и искать там ту
 * же бронь.
 *
 * Считает ВСЁ сервер (`/bookings/:id/settlement/preview`) — тем же кодом, что и
 * сохранение брони. Клиент пересчитывает только одно: как штраф, введённый
 * прямо сейчас, влияет на «к возврату». Иначе пришлось бы дёргать сервер на
 * каждую нажатую цифру, а второй калькулятор на клиенте мы уже выпиливали
 * в волне 5a (аудит D7-009) и заводить заново не будем: штраф — это плюс одна
 * строка счёта, вся «формула» здесь — одно вычитание.
 *
 * Действие, штраф и возврат уходят ОДНИМ запросом: сервер проводит их в одной
 * транзакции и сам раскладывает возврат по конкретным платежам (возврат без
 * исходного платежа запрещён — `docs/decisions/data-and-money.md`).
 */

// ─── Константы ДО компонента ──────────────────────────────────────────────────
// Объявленная ниже константа падает при горячей перезагрузке с «is not defined»
// (временная мёртвая зона) — на этом в проекте спотыкались дважды.

const METHODS: PaymentMethod[] = ['cash', 'card', 'transfer']

const TITLES: Record<SettlementAction, string> = {
  cancel: 'Отмена брони',
  checkout: 'Ранний выезд',
  none: 'Возврат переплаты',
}

const CONFIRM_LABELS: Record<SettlementAction, string> = {
  cancel: 'Отменить и вернуть',
  checkout: 'Оформить выезд',
  none: 'Вернуть',
}

const BUSY_LABELS: Record<SettlementAction, string> = {
  cancel: 'Отменяем…',
  checkout: 'Оформляем…',
  none: 'Возвращаем…',
}

/** Пояснение под заголовком: что произойдёт с самой бронью, а не с деньгами. */
const HINTS: Record<SettlementAction, string> = {
  cancel: 'Бронь останется в истории со статусом «Отменена», автоматические начисления будут сняты.',
  checkout: 'Дата выезда станет сегодняшней, непрожитые ночи снимутся со счёта.',
  none: 'Статус брони не меняется — только деньги.',
}

const fmt = (n: number) => `${money(n)} ₸`

/** «1 ночь / 2 ночи / 5 ночей» — склонение нужно в одной строке про выезд. */
const nightsWord = (n: number) => {
  const t = n % 10, h = n % 100
  if (t === 1 && h !== 11) return 'ночь'
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return 'ночи'
  return 'ночей'
}

/** Пустое поле = 0, а не NaN: «штраф не вводили» и «штраф 0» — одно и то же. */
const parseMoney = (raw: string): number => {
  const s = raw.trim().replace(/\s/g, '').replace(',', '.')
  if (!s) return 0
  const v = Number(s)
  return Number.isFinite(v) ? v : NaN
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
  // Выше диалога приёма оплаты (700) и окна отмены из шахматки: расчёт всегда
  // открывается поверх них, а не под ними.
  zIndex: 800,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
  padding: '24px 16px', overflowY: 'auto',
}

const cardStyle: React.CSSProperties = {
  width: '100%', maxWidth: 560,
  background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 14, boxShadow: 'var(--shadow-lg)',
  display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 48px)', overflow: 'hidden',
}

const sumRowStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
  gap: 10, fontSize: '0.9rem', padding: '3px 0',
}

const boxStyle: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border-subtle)',
  borderRadius: 10, padding: '10px 13px',
}

const secondaryBtnStyle: React.CSSProperties = {
  height: 36, padding: '0 16px', background: 'transparent',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontSize: '0.88rem', fontFamily: 'inherit', cursor: 'pointer', color: 'var(--text)',
}

interface Props {
  bookingId: number
  action: SettlementAction
  /** Гость и номер в шапке: видно, по какой брони считаем. */
  guestName?: string
  subtitle?: string
  onClose: () => void
  /** Успешно проведено. Закрытие и обновление списков — на вызывающем. */
  onDone: (result: SettlementResult) => void
}

export const SettlementDialog: React.FC<Props> = ({
  bookingId, action, guestName, subtitle, onClose, onDone,
}) => {
  const [preview, setPreview] = useState<SettlementPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [penaltyRaw, setPenaltyRaw] = useState('')
  const [penaltyReason, setPenaltyReason] = useState('')
  // null — поле «Вернуть» ещё не трогали: показываем пересчитанное «к возврату»
  // и ведём его за штрафом. Как только сумму поправили руками, она своя.
  const [refundRaw, setRefundRaw] = useState<string | null>(null)
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('cash')
  const [refundComment, setRefundComment] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Одна отправка на нажатие: `saving` ставится синхронно, но React обновит
  // разметку только следующим кадром — двойной клик успевает проскочить.
  const submittedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError('')
    previewSettlement(bookingId, action)
      .then((p) => {
        if (cancelled) return
        setPreview(p)
        // Способ возврата по умолчанию — тот, которым платили в последний раз:
        // наличные вернули картой и наоборот — обычная причина расхождения кассы.
        const last = p.payments.filter((x) => x.refundable > 0).slice(-1)[0]
        if (last) setRefundMethod(last.method)
      })
      .catch((e) => { if (!cancelled) setLoadError(formatApiError(e, 'Не удалось получить расчёт')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bookingId, action])

  // Escape закрывает СНАЧАЛА этот диалог: форма брони и просмотр брони слушают
  // Escape на document во всплытии, иначе одно нажатие закрыло бы всё окно.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (!saving) onClose()
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [onClose, saving])

  const penalty = parseMoney(penaltyRaw)
  const penaltyValid = Number.isFinite(penalty) && penalty >= 0

  const calc = useMemo(() => {
    const paid = preview?.paid ?? 0
    const charged = (preview?.charged ?? 0) + (penaltyValid ? penalty : 0)
    return {
      paid,
      charged,
      /** Столько можно вернуть после штрафа */
      toReturn: Math.max(0, paid - charged),
      /** Столько гость остаётся должен */
      due: Math.max(0, charged - paid),
    }
  }, [preview, penalty, penaltyValid])

  const refundValue = refundRaw === null
    ? Math.round(calc.toReturn * 100) / 100
    : parseMoney(refundRaw)
  const refundValid = Number.isFinite(refundValue) && refundValue >= 0
  const refundTooBig = refundValid && refundValue > calc.toReturn + 0.005

  // Итог операции: что удержали, что отдали и что осталось висеть на брони.
  const kept = Math.max(0, calc.paid - (refundValid ? refundValue : 0))
  const rest = calc.charged - kept   // >0 — долг гостя, <0 — переплата

  const needReason = penaltyValid && penalty > 0 && !penaltyReason.trim()

  const canSubmit = !!preview && !loading && !saving
    && penaltyValid && refundValid && !refundTooBig && !needReason

  const submit = async () => {
    if (!canSubmit || submittedRef.current) return
    submittedRef.current = true
    setSaving(true)
    setError('')
    try {
      const result = await settleBooking(bookingId, {
        action,
        ...(penalty > 0 ? { penalty: { amount: penalty, reason: penaltyReason.trim() } } : {}),
        ...(refundValue > 0
          ? {
              refund: {
                amount: refundValue,
                method: refundMethod,
                ...(refundComment.trim() ? { comment: refundComment.trim() } : {}),
              },
            }
          : {}),
      })
      onDone(result)
    } catch (e) {
      // Текст сервера: он объясняет причину («возврат больше доступного», не тот
      // статус, нет прав), а своё «Не удалось» это скрывало (аудит D5-005).
      setError(formatApiError(e, 'Не удалось провести расчёт'))
      submittedRef.current = false
      setSaving(false)
    }
  }

  const nights = preview?.nights

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
      style={overlayStyle}
    >
      <div style={cardStyle}>
        {/* Шапка */}
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '1.05rem', fontWeight: 600, letterSpacing: '-0.01em' }}>
              {TITLES[action]}
            </div>
            {(guestName || subtitle) && (
              <div style={{
                fontSize: '0.78rem', color: 'var(--text-faint)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {[guestName, subtitle].filter(Boolean).join(' · ')}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => { if (!saving) onClose() }}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.5rem',
              color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px', fontWeight: 300,
            }}
          >×</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {loading && (
            <div style={{ fontSize: '0.88rem', color: 'var(--text-faint)' }}>Считаем…</div>
          )}

          {!loading && loadError && (
            <div style={{ fontSize: '0.9rem', color: 'var(--s-overdue)' }}>{loadError}</div>
          )}

          {!loading && preview && (
            <>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {HINTS[action]}
              </div>

              {/* Ночи — только при выезде: при отмене снимается всё, считать нечего. */}
              {action === 'checkout' && nights && (
                <div style={{ ...boxStyle, fontSize: '0.88rem' }}>
                  Прожито <strong>{nights.stayed}</strong> из <strong>{nights.planned}</strong>{' '}
                  {nightsWord(nights.planned)}, снимается{' '}
                  <strong>{nights.removed}</strong> {nightsWord(nights.removed)}.
                </div>
              )}

              {/* Три цифры. «Начислено» — уже с учётом штрафа, иначе на экране
                  снова оказались бы два разных итога. */}
              <div style={boxStyle}>
                <div style={sumRowStyle}>
                  <span style={{ color: 'var(--text-muted)' }}>Начислено</span>
                  <span className="mono" style={{ fontWeight: 600 }}>{fmt(calc.charged)}</span>
                </div>
                <div style={sumRowStyle}>
                  <span style={{ color: 'var(--text-muted)' }}>Принято</span>
                  <span className="mono" style={{ fontWeight: 600, color: 'var(--s-in)' }}>{fmt(calc.paid)}</span>
                </div>
                <div style={{ ...sumRowStyle, borderTop: '1px solid var(--border-subtle)', marginTop: 4, paddingTop: 7 }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {calc.due > 0 ? 'Гость должен' : 'К возврату'}
                  </span>
                  <span className="mono" style={{
                    fontWeight: 700, fontSize: '1.05rem',
                    color: calc.due > 0 ? 'var(--s-overdue)' : 'var(--s-in)',
                  }}>
                    {fmt(calc.due > 0 ? calc.due : calc.toReturn)}
                  </span>
                </div>
              </div>

              {/* Строки счёта после действия — чтобы «Начислено» не было
                  числом с потолка: видно, за что именно. */}
              {preview.rows.length > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', fontSize: '0.82rem', color: 'var(--text-faint)' }}>
                    Счёт после действия — {preview.rows.length} стр.
                  </summary>
                  <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {preview.rows.map((r, i) => (
                      <div key={i} style={{ ...sumRowStyle, fontSize: '0.82rem' }}>
                        <span style={{ color: 'var(--text-muted)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {r.label}
                          {r.source === 'manual' && (
                            <span style={{ color: 'var(--text-faint)' }}> · вручную</span>
                          )}
                        </span>
                        <span className="mono">{fmt(r.amount)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Штраф — ручная строка счёта. Отдельной настройки штрафа нет
                  намеренно: ситуации разные, сумму решает администратор
                  (`docs/decisions/data-and-money.md`). */}
              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 150px' }}>
                    <label style={labelStyle}>Штраф, ₸</label>
                    <input
                      value={penaltyRaw}
                      onChange={(e) => setPenaltyRaw(e.target.value)}
                      inputMode="decimal"
                      placeholder="0"
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ flex: '2 1 220px' }}>
                    <label style={labelStyle}>Причина штрафа</label>
                    <input
                      value={penaltyReason}
                      onChange={(e) => setPenaltyReason(e.target.value)}
                      placeholder={penalty > 0 ? 'обязательно' : 'необязательно'}
                      style={inputStyle}
                    />
                  </div>
                </div>
                {!penaltyValid && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--s-overdue)' }}>
                    Штраф — число не меньше нуля.
                  </div>
                )}
                {needReason && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--s-overdue)' }}>
                    У штрафа должна быть причина — она попадёт в строку счёта.
                  </div>
                )}
              </div>

              {/* Возврат. Сумму можно уменьшить — «вернём половину сейчас,
                  остальное завтра»: остаток так и останется переплатой. */}
              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: '1 1 150px' }}>
                    <label style={labelStyle}>Вернуть, ₸</label>
                    <input
                      value={refundRaw === null ? String(refundValue) : refundRaw}
                      onChange={(e) => setRefundRaw(e.target.value)}
                      inputMode="decimal"
                      disabled={calc.toReturn <= 0}
                      style={{ ...inputStyle, opacity: calc.toReturn <= 0 ? 0.6 : 1 }}
                    />
                  </div>
                  <div style={{ flex: '1 1 150px' }}>
                    <label style={labelStyle}>Способ</label>
                    <select
                      value={refundMethod}
                      onChange={(e) => setRefundMethod(e.target.value as PaymentMethod)}
                      disabled={calc.toReturn <= 0}
                      style={{ ...inputStyle, opacity: calc.toReturn <= 0 ? 0.6 : 1 }}
                    >
                      {METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <label style={labelStyle}>Комментарий</label>
                  <input
                    value={refundComment}
                    onChange={(e) => setRefundComment(e.target.value)}
                    placeholder="необязательно"
                    disabled={calc.toReturn <= 0}
                    style={{ ...inputStyle, opacity: calc.toReturn <= 0 ? 0.6 : 1 }}
                  />
                </div>
                {!refundValid && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--s-overdue)' }}>
                    Сумма возврата — число не меньше нуля.
                  </div>
                )}
                {refundTooBig && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--s-overdue)' }}>
                    Больше, чем можно вернуть ({fmt(calc.toReturn)}).
                  </div>
                )}
                {calc.toReturn <= 0 && (
                  <div style={{ marginTop: 6, fontSize: '0.8rem', color: 'var(--text-faint)' }}>
                    Возвращать нечего: принято не больше, чем начислено.
                  </div>
                )}
              </div>

              {/* Итоговая фраза — единственное место, где видно всю операцию целиком. */}
              <div style={{
                ...boxStyle, fontSize: '0.88rem', lineHeight: 1.5,
                background: 'var(--surface-2)',
              }}>
                Удерживаем <strong>{fmt(kept)}</strong>
                {' · '}возвращаем <strong>{fmt(refundValid ? refundValue : 0)}</strong>
                {' · '}остаётся <strong>{fmt(Math.abs(rest))}</strong>
                {Math.abs(rest) < 0.005
                  ? ' — расчёт закрыт'
                  : rest > 0 ? ' — долг гостя' : ' — переплата'}
              </div>

              {error && (
                <div style={{ fontSize: '0.88rem', color: 'var(--s-overdue)' }}>{error}</div>
              )}
            </>
          )}
        </div>

        {/* Кнопки */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '12px 18px', borderTop: '1px solid var(--border-subtle)', flexShrink: 0,
        }}>
          <button type="button" onClick={onClose} disabled={saving} style={secondaryBtnStyle}>
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            style={{
              height: 36, padding: '0 18px', border: 'none', borderRadius: 'var(--ui-radius)',
              background: action === 'cancel' ? 'var(--s-overdue)' : 'var(--accent)', color: '#fff',
              fontSize: '0.88rem', fontWeight: 600, fontFamily: 'inherit',
              cursor: canSubmit ? 'pointer' : 'not-allowed', opacity: canSubmit ? 1 : 0.6,
            }}
          >
            {saving ? BUSY_LABELS[action] : CONFIRM_LABELS[action]}
          </button>
        </div>
      </div>
    </div>
  )
}
