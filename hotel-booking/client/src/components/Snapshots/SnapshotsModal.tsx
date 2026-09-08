import React, { useEffect, useState, useCallback } from 'react'
import {
  fetchSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
  fetchSnapshotImpact, readRestoreFailure,
  type Snapshot, type SnapshotKind, type SnapshotImpact,
  type RestoreAssessment, type RestoreResult,
} from '../../api/snapshots'
import { useGridStore } from '../../store/useGridStore'
// Диалог «восстановление сотрёт деньги» общий с окном резервных копий
// (Settings/sections/BackupSection.tsx): вопрос к пользователю один и тот же,
// и выглядеть он обязан одинаково — иначе второй раз его читают заново.
import {
  MoneyImpactRow, ConsentCheckbox, formatMoney, trimApiHint,
  impactBoxStyle, impactRowStyle, impactNameStyle, impactValueStyle,
  restoreErrorBoxStyle as errorBoxStyle,
  confirmBtnStyle as confirmRestoreBtnStyle, dangerBtnStyle as dangerRestoreBtnStyle,
} from '../ui/restoreUi'

interface Props {
  open: boolean
  onClose: () => void
}

// ── Константы и помощники объявлены ДО компонента: объявленная ниже константа
// падает при горячей перезагрузке с «is not defined» (временная мёртвая зона).

const KIND_META: Record<SnapshotKind, { label: string; icon: string; color: string }> = {
  shift:  { label: 'Старт смены',  icon: '🔄', color: '#6366f1' },
  manual: { label: 'Вручную',      icon: '📌', color: '#0891b2' },
  auto:   { label: 'Авто',         icon: '•',  color: '#9ca3af' },
  safety: { label: 'Перед откатом', icon: '🛟', color: '#d97706' },
}

function formatWhen(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

/** Текст галочки согласия — зависит от того, что именно теряется. */
function consentLabel(a: RestoreAssessment): string {
  if (a.payments.lost > 0) {
    return `Понимаю: платежей будет стёрто ${a.payments.lost} на ${formatMoney(a.payments.lostAmount)}`
      + ' — восстановить их будет нечем'
  }
  const lost: string[] = []
  if (a.charges.lost > 0) lost.push(`начислений ${a.charges.lost}`)
  if (a.services.lost > 0) lost.push(`услуг ${a.services.lost}`)
  return `Понимаю: снимок старого формата, денежные записи (${lost.join(', ') || 'все'}) будут стёрты`
}

function describeRestoreResult(r: RestoreResult): string {
  const parts = [`броней ${r.restored}`]
  if (r.charges > 0) parts.push(`начислений ${r.charges}`)
  if (r.payments > 0) parts.push(`платежей ${r.payments}`)
  if (r.services > 0) parts.push(`услуг ${r.services}`)
  let text = `Восстановлено: ${parts.join(', ')}`
  if (r.skipped > 0) text += ` · пропущено броней: ${r.skipped}`
  if (r.lostPayments > 0) text += ` · стёрто платежей: ${r.lostPayments}`
  return text
}

// ── Стили (тоже до компонента) ────────────────────────────────────────────────

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '1.3rem', color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}
const restoreBtnStyle: React.CSSProperties = {
  padding: '6px 12px', background: 'var(--accent-bg)', color: 'var(--accent-text)',
  border: '1px solid var(--accent)', borderRadius: 'var(--ui-radius)',
  fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}
const trashBtnStyle: React.CSSProperties = {
  padding: '6px 9px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: '0.9rem', cursor: 'pointer', flexShrink: 0,
}
const legacyChipStyle: React.CSSProperties = {
  marginLeft: 6, padding: '1px 6px', borderRadius: 5, whiteSpace: 'nowrap',
  border: '1px solid var(--s-overdue)', color: 'var(--s-overdue)',
  fontSize: '0.75rem', fontWeight: 600,
}
export const SnapshotsModal: React.FC<Props> = ({ open, onClose }) => {
  const { fetchGrid, fetchToday } = useGridStore()
  // Откат, удаление и сводка последствий доступны любому вошедшему: ролей
  // осталось две, и обе — администраторы (interface.md, 2026-09-08). Проверка
  // «ADMIN или SUPER_ADMIN» стала тождественно истинной и убрана, чтобы никто
  // не принял её за настоящее ограничение.

  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<Snapshot | null>(null)
  const [toast, setToast] = useState('')

  // Сводка последствий выбранного отката
  const [impact, setImpact] = useState<SnapshotImpact | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [dialogError, setDialogError] = useState('')
  /** Сводка, пришедшая вместе с отказом 409 — она свежее той, что показали до клика */
  const [refusal, setRefusal] = useState<RestoreAssessment | null>(null)
  const [agreed, setAgreed] = useState(false)
  /** Счётчик попыток: им перезапускаем запрос сводки после сбоя или отказа */
  const [impactAttempt, setImpactAttempt] = useState(0)

  // Версия формата приходит в самом списке (`data->>'version'` на сервере), поэтому
  // метку «старый формат» видно сразу — без похода за сводкой по каждой строке.
  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSnapshots(await fetchSnapshots())
    } catch {
      setError('Не удалось загрузить список снимков')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, busy])

  // Последствия отката спрашиваем ДО подтверждения: сколько броней вернётся и
  // что из денег исчезнет. Иначе пользователь узнаёт об этом только из отказа.
  useEffect(() => {
    if (!confirmTarget) return
    let cancelled = false
    setImpact(null); setRefusal(null); setDialogError(''); setAgreed(false); setImpactLoading(true)
    fetchSnapshotImpact(confirmTarget.id)
      .then(res => {
        if (cancelled) return
        setImpact(res)
      })
      .catch(err => {
        if (cancelled) return
        setDialogError(readRestoreFailure(err, 'Не удалось получить сводку последствий').message)
      })
      .finally(() => { if (!cancelled) setImpactLoading(false) })
    return () => { cancelled = true }
  }, [confirmTarget, impactAttempt])

  if (!open) return null

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 5000)
  }

  const handleManual = async () => {
    setBusy(true); setError('')
    try {
      await createSnapshot('Ручной снимок')
      await load()
      showToast('Снимок создан')
    } catch (err) {
      setError(readRestoreFailure(err, 'Не удалось создать снимок').message)
    } finally { setBusy(false) }
  }

  const handleRestore = async (snap: Snapshot, allowMoneyLoss: boolean) => {
    setBusy(true); setDialogError('')
    try {
      const res = await restoreSnapshot(snap.id, { allowMoneyLoss })
      setConfirmTarget(null)
      await Promise.all([fetchGrid(), fetchToday()])
      await load()
      showToast(describeRestoreResult(res))
    } catch (err) {
      // Текст сервера объясняет причину лучше любой нашей заглушки, а сводку
      // последствий он прикладывает прямо к отказу — показываем и её.
      const failure = readRestoreFailure(err, 'Не удалось восстановить снимок')
      setDialogError(failure.message)
      if (failure.impact) {
        setRefusal(failure.impact)
        setAgreed(false)
      }
    } finally { setBusy(false) }
  }

  const handleDelete = async (snap: Snapshot) => {
    setBusy(true); setError('')
    try {
      await deleteSnapshot(snap.id)
      await load()
    } catch (err) {
      setError(readRestoreFailure(err, 'Не удалось удалить снимок').message)
    } finally { setBusy(false) }
  }

  // Сводка из отказа свежее той, что показали до клика
  const assessment: RestoreAssessment | null = refusal ?? impact
  const needsConsent = assessment?.requiresConfirmation === true
  const canSubmit = !busy && !!assessment && (!needsConsent || agreed)
  const hasLegacy = snapshots.some(s => s.version === 1)

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 450, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '90vw', maxWidth: 640, height: '85vh',
        background: 'var(--bg)', color: 'var(--text)',
        borderRadius: 14, border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>История и откат</div>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Точки восстановления состояния броней
            </div>
          </div>
          <button onClick={onClose} disabled={busy} style={closeBtnStyle}>✕</button>
        </div>

        {/* Toolbar */}
        <div style={{
          padding: '12px 22px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <button onClick={handleManual} disabled={busy} style={primaryBtnStyle}>
            📌 Создать снимок сейчас
          </button>
          <button onClick={load} disabled={busy} style={secondaryBtnStyle}>Обновить</button>
          {toast && (
            <span style={{
              marginLeft: 'auto', fontSize: '0.86rem', color: 'var(--s-in)',
              fontWeight: 600, textAlign: 'right', minWidth: 0,
            }}>
              {toast}
            </span>
          )}
        </div>

        {error && <div style={{ ...errorBoxStyle, margin: '12px 22px 0' }}>{error}</div>}

        {hasLegacy && (
          <div style={{ padding: '10px 22px 0', fontSize: '0.85rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
            Снимки с меткой <strong style={{ color: 'var(--s-overdue)' }}>старый формат</strong> хранят
            только брони: откат на такой снимок стирает начисления, платежи и услуги — вернуть их оттуда нечем.
          </div>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px' }}>
          {loading ? (
            <div style={{ color: 'var(--text-faint)', padding: 20 }}>Загрузка…</div>
          ) : snapshots.length === 0 ? (
            <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: 40 }}>
              Снимков пока нет. Они создаются автоматически при изменении броней и в начале смены.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {snapshots.map(s => {
                const meta = KIND_META[s.kind]
                const version = s.version
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 14px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                  }}>
                    <span title={meta.label} style={{
                      width: 30, height: 30, flexShrink: 0, borderRadius: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: `${meta.color}22`, color: meta.color, fontSize: '1rem',
                    }}>{meta.icon}</span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.98rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', marginTop: 1 }}>
                        {formatWhen(s.createdAt)} · {s.bookingCount} броней
                        <span style={{ color: meta.color, fontWeight: 600 }}> · {meta.label}</span>
                        {version === 1 && (
                          <span
                            style={legacyChipStyle}
                            title="Снимок хранит только брони. Откат на него сотрёт начисления, платежи и услуги — восстановить их будет нечем."
                          >
                            старый формат
                          </span>
                        )}
                      </div>
                    </div>

                    <button onClick={() => setConfirmTarget(s)} disabled={busy} style={restoreBtnStyle}>
                      Восстановить
                    </button>
                    <button onClick={() => handleDelete(s)} disabled={busy} title="Удалить снимок" style={trashBtnStyle}>
                      🗑
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Confirm restore */}
      {confirmTarget && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setConfirmTarget(null) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 460, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div style={{
            width: '100%', maxWidth: 540, maxHeight: '86vh', overflowY: 'auto',
            background: 'var(--bg)', color: 'var(--text)',
            borderRadius: 12, border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', padding: 24,
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: needsConsent ? 'var(--surface-2)' : 'var(--accent-bg)',
                color: needsConsent ? 'var(--s-overdue)' : '#d97706',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem',
              }}>{needsConsent ? '⚠' : '⟲'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '1.12rem', fontWeight: 700, marginBottom: 6 }}>
                  Откатить к этому снимку?
                </div>
                <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Всё состояние броней будет заменено снимком{' '}
                  <strong style={{ color: 'var(--text)' }}>«{confirmTarget.label}»</strong>{' '}
                  от {formatWhen(confirmTarget.createdAt)}.
                  Перед откатом автоматически сохранится снимок текущего состояния.
                </div>
              </div>
            </div>

            {impactLoading && (
              <div style={{ ...impactBoxStyle, color: 'var(--text-faint)' }}>Считаем последствия…</div>
            )}

            {impact && !impactLoading && (
              <div style={impactBoxStyle}>
                <div style={impactRowStyle}>
                  <span style={impactNameStyle}>Брони</span>
                  <span style={impactValueStyle}>
                    вернётся <strong>{impact.bookings.restored}</strong>
                    <span style={{ color: 'var(--text-faint)' }}> из {impact.bookings.inSnapshot} в снимке</span>
                    {impact.bookings.skipped > 0 && (
                      <span style={{ color: 'var(--s-overdue)', fontWeight: 600 }}>
                        {' '}· пропустим {impact.bookings.skipped} (номер удалён)
                      </span>
                    )}
                  </span>
                </div>
                <MoneyImpactRow name="Начисления" data={impact.charges} />
                <MoneyImpactRow name="Платежи" data={impact.payments} />
                <div style={impactRowStyle}>
                  <span style={impactNameStyle}>Услуги в бронях</span>
                  <span style={impactValueStyle}>
                    вернётся <strong>{impact.services.restored}</strong>
                    <span style={{ color: 'var(--text-faint)' }}> · сейчас {impact.services.current}</span>
                    {impact.services.lost > 0 && (
                      <span style={{ color: 'var(--s-overdue)', fontWeight: 600 }}> · исчезнет {impact.services.lost}</span>
                    )}
                  </span>
                </div>
                {impact.legacyFormat && (
                  <div style={{ fontSize: '0.82rem', color: 'var(--s-overdue)', paddingTop: 2 }}>
                    Снимок старого формата (версия {impact.version}) — денег он не хранит вовсе.
                  </div>
                )}
              </div>
            )}

            {/* Готовый текст сервера про то, что исчезнет */}
            {needsConsent && impact?.warning && !dialogError && (
              <div style={{ ...errorBoxStyle, marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>Так откат не пройдёт</div>
                {trimApiHint(impact.warning, 'allowMoneyLoss')}
              </div>
            )}

            {dialogError && <div style={{ ...errorBoxStyle, marginTop: 12 }}>{dialogError}</div>}

            {needsConsent && assessment && (
              <ConsentCheckbox checked={agreed} disabled={busy} onChange={setAgreed}>
                {consentLabel(assessment)}
              </ConsentCheckbox>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              <button onClick={() => setConfirmTarget(null)} disabled={busy} style={secondaryBtnStyle}>
                Отмена
              </button>
              {/* Сводку могли не получить (сбой сети) или она успела устареть
                  (сосед принял оплату) — даём пересчитать, не закрывая окно */}
              {dialogError && !impactLoading && (
                <button
                  onClick={() => { setDialogError(''); setRefusal(null); setImpactAttempt(n => n + 1) }}
                  disabled={busy}
                  style={secondaryBtnStyle}
                >
                  Проверить заново
                </button>
              )}
              <button
                onClick={() => handleRestore(confirmTarget, needsConsent)}
                disabled={!canSubmit}
                style={{
                  ...(needsConsent ? dangerRestoreBtnStyle : confirmRestoreBtnStyle),
                  ...(canSubmit ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
                }}
              >
                {busy
                  ? 'Восстановление…'
                  : needsConsent ? 'Восстановить и стереть деньги' : 'Восстановить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
