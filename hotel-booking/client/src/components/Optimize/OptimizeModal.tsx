import React, { useEffect, useState } from 'react'
import {
  runOptimization,
  applyOptimization,
  type OptimizeResult,
  type OptimizeMove,
} from '../../api/occupancy'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'

interface Props {
  open: boolean
  onClose: () => void
}

export const OptimizeModal: React.FC<Props> = ({ open, onClose }) => {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<OptimizeResult | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [applying, setApplying] = useState(false)
  const { fetchGrid, fetchToday } = useGridStore()
  const { optimizer, roomFund } = useSettingsStore()

  // Карта эффектов меток для алгоритма: { flagId: { bufferAfter, bufferBefore, pin } }
  const flagEffects: Record<string, unknown> = {}
  for (const f of roomFund.bookingFlags ?? []) {
    if (f.effects) flagEffects[f.id] = f.effects
  }

  // Запускаем оптимизацию при открытии
  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError('')
    setResult(null)
    setSelected(new Set())
    runOptimization(optimizer, flagEffects)
      .then(r => {
        setResult(r)
        // По умолчанию все предложения выбраны
        setSelected(new Set(r.moves.map(m => m.bookingId)))
      })
      .catch((e: unknown) => {
        const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
        setError(msg ?? 'Не удалось запустить оптимизацию')
      })
      .finally(() => setLoading(false))
  }, [open])

  // Escape
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])

  if (!open) return null

  const toggleMove = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (!result) return
    if (selected.size === result.moves.length) setSelected(new Set())
    else setSelected(new Set(result.moves.map(m => m.bookingId)))
  }

  const onApply = async () => {
    if (!result || selected.size === 0) return
    setApplying(true)
    try {
      const moves = result.moves
        .filter(m => selected.has(m.bookingId))
        .map(m => ({ bookingId: m.bookingId, toRoomId: m.to.roomId }))
      await applyOptimization(moves)
      await Promise.all([fetchGrid(), fetchToday()])
      onClose()
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error
      setError(msg ?? 'Ошибка применения изменений')
    } finally {
      setApplying(false)
    }
  }

  // Группировка по категории для красоты
  const movesByCategory: Record<string, OptimizeMove[]> = {}
  if (result) {
    for (const m of result.moves) {
      if (!movesByCategory[m.categoryName]) movesByCategory[m.categoryName] = []
      movesByCategory[m.categoryName].push(m)
    }
  }

  return (
    <div style={overlayStyle}>
      <div style={modalStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: 'var(--text)' }}>
              🪄 Оптимизация распределения
            </h2>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginTop: 4 }}>
              Подбор раскладки броней по номерам для минимизации простоев
            </div>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>Закрыть</button>
        </div>

        {/* Body */}
        <div style={bodyStyle}>
          {loading && (
            <div style={centerStyle}>
              <Spinner />
              <div style={{ marginTop: 12, color: 'var(--text-muted)' }}>Считаем варианты…</div>
            </div>
          )}

          {error && (
            <div style={errorBoxStyle}>{error}</div>
          )}

          {!loading && result && (
            <>
              {/* Метрики до/после */}
              <div style={metricsRowStyle}>
                <MetricCard
                  title="Сейчас"
                  totalGaps={result.before.totalGaps}
                  shortGaps={result.before.shortGaps}
                  lostNights={result.before.lostNights}
                  variant="neutral"
                />
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '1.5rem', color: 'var(--text-faint)',
                }}>→</div>
                <MetricCard
                  title="После оптимизации"
                  totalGaps={result.after.totalGaps}
                  shortGaps={result.after.shortGaps}
                  lostNights={result.after.lostNights}
                  variant={result.totalMoves > 0 ? 'good' : 'neutral'}
                />
              </div>

              {/* Сводка */}
              {result.totalMoves === 0 ? (
                <div style={{
                  textAlign: 'center', padding: '40px 20px',
                  color: 'var(--text-muted)', fontSize: '1.05rem',
                }}>
                  ✓ Раскладка уже оптимальная — улучшать нечего
                </div>
              ) : (
                <>
                  <div style={summaryStyle}>
                    Найдено <strong>{result.totalMoves}</strong>{' '}
                    {pluralMoves(result.totalMoves)}. Можно сократить
                    окна на <strong style={{ color: '#16a34a' }}>
                      {result.improvement.nightsReclaimed}
                    </strong>{' '}
                    {pluralNights(result.improvement.nightsReclaimed)}.
                    {(() => {
                      const useful = result.moves.filter(m => (m.gapsClosed ?? 0) > 0 || (m.shortGapsClosed ?? 0) > 0 || (m.nightsClosed ?? 0) > 0).length
                      const chain = result.moves.length - useful
                      if (chain === 0) return null
                      return (
                        <div style={{ marginTop: 4, fontSize: '0.88rem' }}>
                          Из них закрывают окна: <strong>{useful}</strong>, парных перестановок: <strong>{chain}</strong>.
                        </div>
                      )
                    })()}
                  </div>

                  {/* Toggle all */}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '8px 12px', marginBottom: 8,
                    borderRadius: 'var(--ui-radius)', background: 'var(--surface-2)',
                  }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>
                      Выбрано: {selected.size} из {result.moves.length}
                    </span>
                    <button onClick={toggleAll} style={miniBtnStyle}>
                      {selected.size === result.moves.length ? 'Снять все' : 'Выбрать все'}
                    </button>
                  </div>

                  {/* Список перемещений по категориям */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Object.entries(movesByCategory).map(([catName, moves]) => (
                      <div key={catName}>
                        <div style={catHeaderStyle}>{catName}</div>
                        <div style={{
                          border: '1px solid var(--border)',
                          borderRadius: 'var(--ui-radius)',
                          overflow: 'hidden', background: 'var(--bg)',
                        }}>
                          {moves.map((m, idx) => (
                            <MoveRow
                              key={m.bookingId}
                              move={m}
                              checked={selected.has(m.bookingId)}
                              onToggle={() => toggleMove(m.bookingId)}
                              isLast={idx === moves.length - 1}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          <button onClick={onClose} style={cancelBtnStyle}>Отмена</button>
          <button
            onClick={onApply}
            disabled={applying || !result || selected.size === 0}
            style={applyBtnStyle(applying || !result || selected.size === 0)}
          >
            {applying
              ? 'Применяем…'
              : selected.size === 0
                ? 'Применить'
                : `Применить (${selected.size})`
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const MetricCard: React.FC<{
  title: string
  totalGaps: number
  shortGaps: number
  lostNights: number
  variant: 'neutral' | 'good'
}> = ({ title, totalGaps, shortGaps, lostNights, variant }) => (
  <div style={{
    flex: 1, padding: '14px 16px',
    borderRadius: 'var(--ui-radius)',
    background: variant === 'good' ? '#f0fdf4' : 'var(--surface-2)',
    border: `1px solid ${variant === 'good' ? '#86efac' : 'var(--border)'}`,
  }}>
    <div style={{
      fontSize: '0.78rem', fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.06em', color: 'var(--text-faint)', marginBottom: 8,
    }}>{title}</div>
    <Metric label="Окон всего" value={totalGaps} />
    <Metric label="Коротких (≤2 н.)" value={shortGaps} highlight={shortGaps > 0} />
    <Metric label="Пустых ночей" value={lostNights} />
  </div>
)

const Metric: React.FC<{ label: string; value: number; highlight?: boolean }> = ({ label, value, highlight }) => (
  <div style={{
    display: 'flex', justifyContent: 'space-between',
    fontSize: '0.92rem', padding: '3px 0',
  }}>
    <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span style={{
      fontWeight: 700,
      color: highlight ? '#dc2626' : 'var(--text)',
    }}>{value}</span>
  </div>
)

const MoveRow: React.FC<{
  move: OptimizeMove
  checked: boolean
  onToggle: () => void
  isLast: boolean
}> = ({ move, checked, onToggle, isLast }) => (
  <label style={{
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 12px',
    borderBottom: isLast ? 'none' : '1px solid var(--border-subtle)',
    cursor: 'pointer',
    background: checked ? 'var(--accent-bg)' : 'transparent',
  }}>
    <input
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      style={{ width: 16, height: 16, cursor: 'pointer', accentColor: 'var(--accent)' }}
    />

    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.96rem' }}>
        {move.guestName}
        <span style={{ marginLeft: 8, color: 'var(--text-faint)', fontWeight: 400, fontSize: '0.85rem' }}>
          {move.checkIn.slice(0, 10)} → {move.checkOut.slice(0, 10)}
        </span>
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginTop: 4, fontSize: '0.88rem',
      }}>
        <span style={{
          padding: '2px 8px', borderRadius: 5,
          background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 600,
        }}>
          №{move.from.roomNumber}
        </span>
        <span style={{ color: 'var(--text-faint)' }}>→</span>
        <span style={{
          padding: '2px 8px', borderRadius: 5,
          background: '#dcfce7', color: '#15803d', fontWeight: 700,
        }}>
          №{move.to.roomNumber}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.82rem' }}>
          корп. {move.to.building}, эт. {move.to.floor}
        </span>
        <BenefitBadge move={move} />
      </div>
    </div>
  </label>
)

/** Бейдж «сколько окон/ночей закроет этот ход». */
const BenefitBadge: React.FC<{ move: OptimizeMove }> = ({ move }) => {
  const gaps = move.gapsClosed ?? 0
  const shortGaps = move.shortGapsClosed ?? 0
  const nights = move.nightsClosed ?? 0

  let text = ''
  let positive = false
  if (gaps > 0) { text = `−${gaps} ${pluralWindows(gaps)}`; positive = true }
  else if (shortGaps > 0) { text = `−${shortGaps} коротких`; positive = true }
  else if (nights > 0) { text = `−${nights} ${pluralNights(nights)}`; positive = true }
  else if (move.partOfChain) { text = '↔ в связке' }
  else { text = 'перестановка' }

  return (
    <span style={{
      marginLeft: 'auto',
      padding: '2px 8px', borderRadius: 5,
      fontSize: '0.82rem', fontWeight: 700,
      background: positive ? '#dcfce7' : 'var(--surface-2)',
      color: positive ? '#15803d' : 'var(--text-faint)',
      whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  )
}

const Spinner: React.FC = () => (
  <div style={{
    width: 28, height: 28, borderRadius: '50%',
    border: '2px solid var(--border)',
    borderTopColor: 'var(--accent)',
    animation: 'spin 0.7s linear infinite',
  }} />
)

function pluralMoves(n: number): string {
  const m = n % 10, m100 = n % 100
  if (m === 1 && m100 !== 11) return 'перемещение'
  if (m >= 2 && m <= 4 && (m100 < 10 || m100 >= 20)) return 'перемещения'
  return 'перемещений'
}

function pluralNights(n: number): string {
  const m = n % 10, m100 = n % 100
  if (m === 1 && m100 !== 11) return 'ночь'
  if (m >= 2 && m <= 4 && (m100 < 10 || m100 >= 20)) return 'ночи'
  return 'ночей'
}

function pluralWindows(n: number): string {
  const m = n % 10, m100 = n % 100
  if (m === 1 && m100 !== 11) return 'окно'
  if (m >= 2 && m <= 4 && (m100 < 10 || m100 >= 20)) return 'окна'
  return 'окон'
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0,
  background: 'rgba(0,0,0,0.45)',
  zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: 24,
}

const modalStyle: React.CSSProperties = {
  background: 'var(--bg)',
  borderRadius: 14,
  width: '100%', maxWidth: 720,
  maxHeight: '90vh',
  display: 'flex', flexDirection: 'column',
  boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
  overflow: 'hidden',
}

const headerStyle: React.CSSProperties = {
  padding: '18px 22px',
  borderBottom: '1px solid var(--border)',
  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
  gap: 14, flexShrink: 0,
}

const bodyStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: 22,
  display: 'flex', flexDirection: 'column', gap: 18,
}

const footerStyle: React.CSSProperties = {
  padding: '14px 22px',
  borderTop: '1px solid var(--border)',
  display: 'flex', justifyContent: 'flex-end', gap: 10,
  flexShrink: 0, background: 'var(--bg)',
}

const centerStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  padding: '60px 20px',
}

const errorBoxStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 8,
  background: '#fef2f2', color: '#dc2626',
  border: '1px solid #fca5a5',
}

const metricsRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 32px 1fr',
  gap: 10,
}

const summaryStyle: React.CSSProperties = {
  padding: '10px 14px',
  background: '#fef3c7', color: '#92400e',
  borderRadius: 'var(--ui-radius)',
  fontSize: '0.96rem',
}

const catHeaderStyle: React.CSSProperties = {
  fontSize: '0.82rem', fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.06em',
  color: 'var(--text-faint)', marginBottom: 6,
  paddingLeft: 4,
}

const closeBtnStyle: React.CSSProperties = {
  padding: '6px 12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer',
  color: 'var(--text-muted)', fontWeight: 600,
}

const miniBtnStyle: React.CSSProperties = {
  padding: '4px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6, cursor: 'pointer',
  fontSize: '0.85rem', fontWeight: 600,
  color: 'var(--text)',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', cursor: 'pointer',
  color: 'var(--text)',
}

const applyBtnStyle = (disabled: boolean): React.CSSProperties => ({
  padding: '8px 18px',
  background: disabled ? 'var(--surface-3)' : 'var(--accent)',
  color: disabled ? 'var(--text-faint)' : '#fff',
  border: 'none',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
})
