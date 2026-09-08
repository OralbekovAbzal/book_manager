import React, { useCallback, useEffect, useState } from 'react'
import {
  fetchCharges, addCharge, updateCharge, deleteCharge, rebuildCharges,
  CHARGE_KIND_LABELS,
} from '../../api/charges'
import type { BookingCharge, ChargeKind, ChargePayload } from '../../api/charges'
import type { Booking } from '../../types'
import { useAuthStore } from '../../store/useAuthStore'

/**
 * Строки начислений брони: что начислено, откуда взялось и что правил администратор.
 *
 * Ради этого экрана всё и затевалось (NOTES, «Ценообразование»): итог брони — сумма
 * строк, а не результат формулы. Уступка «заехал в час ночи, беру полсуток» правится
 * здесь конкретной ночью, с причиной и автором, и остаётся внутри системы.
 */

const fmt = (n: number) => `${Math.round(n).toLocaleString('ru-RU')} ₸`

interface Props {
  bookingId: number
  /**
   * Закрытая/отменённая бронь: существующие строки не правятся и не удаляются,
   * пересборка по тарифу недоступна. НО администратору оставлена одна дверь —
   * добавить ручную строку (штраф за отмену или досрочный выезд). Так решено
   * в `docs/decisions/data-and-money.md`: отдельной настройки штрафа не делаем,
   * он оформляется строкой с причиной и автором.
   */
  readOnly?: boolean
  /** Итог изменился: у брони новый totalAmount/prepaidAmount */
  onChanged?: (booking: Booking | null) => void
}

interface EditState {
  id: number
  label: string
  quantity: string
  unitPrice: string
  reason: string
}

const emptyDraft = {
  kind: 'extra' as ChargeKind,
  label: '',
  quantity: '1',
  unitPrice: '',
  reason: '',
}

export const ChargesPanel: React.FC<Props> = ({ bookingId, readOnly, onChanged }) => {
  const admin = useAuthStore(s => s.admin)
  // Штраф на закрытой брони — действие администратора, а не стойки.
  const canAddOnClosed = !!readOnly && (admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN')
  const canAdd = !readOnly || canAddOnClosed
  const [charges, setCharges] = useState<BookingCharge[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showStayDetail, setShowStayDetail] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const [draft, setDraft] = useState(emptyDraft)
  const [adding, setAdding] = useState(false)

  const apply = useCallback((res: { data: BookingCharge[]; total: number; booking: Booking | null }) => {
    setCharges(res.data)
    onChanged?.(res.booking)
  }, [onChanged])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetchCharges(bookingId)
      .then(res => {
        if (cancelled) return
        setCharges(res.data)
      })
      .catch(() => { if (!cancelled) setError('Не удалось загрузить начисления') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bookingId])

  const run = async (fn: () => Promise<{ data: BookingCharge[]; total: number; booking: Booking | null }>) => {
    setBusy(true)
    setError('')
    try {
      apply(await fn())
      return true
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string; details?: { message: string }[] } } })?.response?.data
      setError(msg?.details?.[0]?.message ?? msg?.error ?? 'Не удалось сохранить')
      return false
    } finally {
      setBusy(false)
    }
  }

  const stayRows = charges.filter(c => c.kind === 'stay')
  const otherRows = charges.filter(c => c.kind !== 'stay')
  const stayTotal = stayRows.reduce((s, c) => s + c.amount, 0)

  const startEdit = (c: BookingCharge) => setEdit({
    id: c.id,
    label: c.label,
    quantity: String(c.quantity),
    unitPrice: String(c.unitPrice),
    reason: '',
  })

  const saveEdit = async () => {
    if (!edit) return
    if (!edit.reason.trim()) { setError('Укажите причину правки'); return }
    const ok = await run(() => updateCharge(bookingId, edit.id, {
      label: edit.label.trim(),
      quantity: Number(edit.quantity) || 0,
      unitPrice: Number(edit.unitPrice) || 0,
      reason: edit.reason.trim(),
    }))
    if (ok) setEdit(null)
  }

  const remove = async (c: BookingCharge) => {
    if (!confirm(`Удалить строку «${c.label}» на ${fmt(c.amount)}?`)) return
    await run(() => deleteCharge(bookingId, c.id))
  }

  const saveDraft = async () => {
    if (!draft.label.trim()) { setError('Укажите название строки'); return }
    if (!draft.reason.trim()) { setError('Укажите причину — без неё строка не сохраняется'); return }
    const payload: ChargePayload = {
      kind: draft.kind,
      label: draft.label.trim(),
      quantity: Number(draft.quantity) || 0,
      unitPrice: Number(draft.unitPrice) || 0,
      reason: draft.reason.trim(),
    }
    const ok = await run(() => addCharge(bookingId, payload))
    if (ok) { setDraft(emptyDraft); setAdding(false) }
  }

  const rebuild = async () => {
    if (!confirm('Пересобрать автоматические строки по тарифу?\nРучные строки останутся, удалённые автоматические вернутся.')) return
    await run(() => rebuildCharges(bookingId))
  }

  const renderRow = (c: BookingCharge, opts: { compact?: boolean } = {}) => {
    if (edit?.id === c.id) {
      return (
        <div key={c.id} style={editBoxStyle}>
          <input
            value={edit.label}
            onChange={e => setEdit({ ...edit, label: e.target.value })}
            placeholder="Название"
            style={miniInput}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={edit.quantity}
              onChange={e => setEdit({ ...edit, quantity: e.target.value })}
              type="number" step="0.5" min={0} title="Количество"
              style={{ ...miniInput, width: 64 }}
            />
            <span style={{ alignSelf: 'center', color: 'var(--text-faint)' }}>×</span>
            <input
              value={edit.unitPrice}
              onChange={e => setEdit({ ...edit, unitPrice: e.target.value })}
              type="number" title="Цена за единицу"
              style={{ ...miniInput, flex: 1 }}
            />
          </div>
          <input
            value={edit.reason}
            onChange={e => setEdit({ ...edit, reason: e.target.value })}
            placeholder="Причина правки (обязательно)"
            style={{ ...miniInput, borderColor: edit.reason.trim() ? 'var(--border)' : '#fca5a5' }}
          />
          {/* Ошибку показываем внутри формы: список длинный, внизу панели её не видно */}
          {error && <div style={errorBoxStyle}>{error}</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" onClick={() => setEdit(null)} style={miniBtn}>Отмена</button>
            <button type="button" onClick={saveEdit} disabled={busy} style={{ ...miniBtn, ...miniBtnPrimary }}>
              Сохранить
            </button>
          </div>
        </div>
      )
    }

    return (
      <div key={c.id} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0' }}>
        <span style={{
          flex: 1, minWidth: 0, fontSize: opts.compact ? '0.8rem' : '0.88rem',
          color: c.kind === 'discount' ? '#d97706' : 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }} title={c.label}>
          {c.source === 'manual' && (
            <span
              title={`Правка администратора${c.createdBy ? ` · ${c.createdBy.name}` : ''}${c.reason ? `\nПричина: ${c.reason}` : ''}`}
              style={{
                marginRight: 5, padding: '0 4px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
                background: '#fef3c7', color: '#92400e',
              }}
            >✎</span>
          )}
          {c.label}
          {c.quantity !== 1 && (
            <span className="mono" style={{ marginLeft: 5, fontSize: '0.75rem', color: 'var(--text-faint)' }}>
              {c.quantity} × {c.unitPrice.toLocaleString('ru-RU')}
            </span>
          )}
        </span>
        <span className="mono" style={{
          fontSize: opts.compact ? '0.8rem' : '0.88rem', fontWeight: 600, whiteSpace: 'nowrap',
          color: c.amount < 0 ? '#d97706' : 'var(--text)',
        }}>{fmt(c.amount)}</span>
        {!readOnly && (
          <span style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            <button type="button" title="Изменить" onClick={() => startEdit(c)} style={iconBtn}>✎</button>
            <button type="button" title="Удалить" onClick={() => remove(c)} style={iconBtn}>✕</button>
          </span>
        )}
      </div>
    )
  }

  if (loading) {
    return <div style={{ padding: '10px 0', color: 'var(--text-faint)', fontSize: '0.88rem' }}>Загрузка начислений…</div>
  }

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 10, marginBottom: 12, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 12px',
        background: 'var(--surface)', borderBottom: '1px solid var(--border-subtle)',
      }}>
        <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }}>Начисления</span>
        <span style={{ flex: 1 }} />
        {!readOnly && (
          <button type="button" onClick={rebuild} disabled={busy} title="Пересобрать автоматические строки по тарифу"
            style={{ ...miniBtn, padding: '3px 8px' }}>
            ⟳ По тарифу
          </button>
        )}
      </div>

      <div style={{ padding: '8px 12px' }}>
        {charges.length === 0 && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', padding: '6px 0' }}>
            {readOnly
              // У отменённой брони строк нет по делу: отмена снимает начисления.
              // Предлагать «По тарифу» здесь было бы неправдой — кнопки нет.
              ? 'Начислений нет: у закрытой брони автоматические строки сняты.'
              : 'Строк нет. Либо тариф на эти даты не заполнен, либо всё удалено вручную — нажмите «По тарифу» или добавьте строку.'}
          </div>
        )}

        {stayRows.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '3px 0' }}>
              <button type="button" onClick={() => setShowStayDetail(v => !v)} style={{
                flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none', padding: 0,
                cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.88rem', color: 'var(--text-muted)',
              }}>
                {showStayDetail ? '▾' : '▸'} Проживание · {stayRows.length} ноч.
                {stayRows.some(c => c.source === 'manual') && (
                  <span style={{ marginLeft: 5, color: '#92400e' }} title="Есть правки администратора">✎</span>
                )}
              </button>
              <span className="mono" style={{ fontSize: '0.88rem', fontWeight: 600 }}>{fmt(stayTotal)}</span>
              {!readOnly && <span style={{ width: 40, flexShrink: 0 }} />}
            </div>
            {showStayDetail && (
              <div style={{ paddingLeft: 12, borderLeft: '2px solid var(--border-subtle)', marginBottom: 4 }}>
                {stayRows.map(c => (
                  <div key={c.id}>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>
                      {c.date ? c.date.slice(0, 10) : ''}
                    </div>
                    {renderRow(c, { compact: true })}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {otherRows.map(c => renderRow(c))}

        {/* «Итого по строкам» здесь больше НЕ печатается: тот же итог показывает
            карточка предпросмотра внизу формы (числа из `POST /bookings/preview`),
            а «Начислено» — полоса денег сразу под этой панелью. Три числа об одном
            и том же расходились между собой — аудит D7-009. */}

        {error && !edit && !adding && <div style={{ ...errorBoxStyle, marginTop: 8 }}>{error}</div>}

        {canAddOnClosed && !adding && (
          <div style={{
            marginTop: 8, fontSize: '0.78rem', color: 'var(--text-faint)', lineHeight: 1.4,
          }}>
            Бронь закрыта: строки не правятся. Добавить можно только ручную —
            например, штраф за отмену или досрочный выезд.
          </div>
        )}

        {canAdd && (adding ? (
          <div style={{ ...editBoxStyle, marginTop: 8 }}>
            <select
              value={draft.kind}
              onChange={e => setDraft({ ...draft, kind: e.target.value as ChargeKind })}
              style={miniInput}
            >
              {(Object.keys(CHARGE_KIND_LABELS) as ChargeKind[]).map(k => (
                <option key={k} value={k}>{CHARGE_KIND_LABELS[k]}</option>
              ))}
            </select>
            <input
              value={draft.label}
              onChange={e => setDraft({ ...draft, label: e.target.value })}
              placeholder="Название строки"
              style={miniInput}
            />
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={draft.quantity}
                onChange={e => setDraft({ ...draft, quantity: e.target.value })}
                type="number" step="0.5" min={0} title="Количество"
                style={{ ...miniInput, width: 64 }}
              />
              <span style={{ alignSelf: 'center', color: 'var(--text-faint)' }}>×</span>
              <input
                value={draft.unitPrice}
                onChange={e => setDraft({ ...draft, unitPrice: e.target.value })}
                type="number" placeholder="Цена" title="Цена за единицу"
                style={{ ...miniInput, flex: 1 }}
              />
            </div>
            {draft.kind === 'discount' && (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}>
                Скидка запишется со знаком минус автоматически.
              </div>
            )}
            <input
              value={draft.reason}
              onChange={e => setDraft({ ...draft, reason: e.target.value })}
              placeholder="Причина (обязательно)"
              style={{ ...miniInput, borderColor: draft.reason.trim() ? 'var(--border)' : '#fca5a5' }}
            />
            {error && <div style={errorBoxStyle}>{error}</div>}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => { setAdding(false); setDraft(emptyDraft) }} style={miniBtn}>Отмена</button>
              <button type="button" onClick={saveDraft} disabled={busy} style={{ ...miniBtn, ...miniBtnPrimary }}>
                Добавить
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => { setAdding(true); setError('') }} style={{
            marginTop: 8, width: '100%', padding: '6px', background: 'none',
            border: '1px dashed var(--border)', borderRadius: 8, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: '0.85rem', color: 'var(--text-muted)',
          }}>
            + Добавить строку
          </button>
        ))}
      </div>
    </div>
  )
}

const miniInput: React.CSSProperties = {
  padding: '5px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: '0.85rem',
  fontFamily: 'inherit',
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const miniBtn: React.CSSProperties = {
  padding: '4px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--text)',
  fontSize: '0.82rem',
  fontFamily: 'inherit',
  cursor: 'pointer',
}

const miniBtnPrimary: React.CSSProperties = {
  background: 'var(--accent)',
  color: '#fff',
  border: '1px solid var(--accent)',
  fontWeight: 600,
}

const iconBtn: React.CSSProperties = {
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--text-faint)',
  cursor: 'pointer',
  fontSize: '0.8rem',
  lineHeight: 1,
}

const errorBoxStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 6,
  background: '#fef2f2',
  color: '#dc2626',
  fontSize: '0.82rem',
}

const editBoxStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 8,
  margin: '4px 0',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--surface)',
}
