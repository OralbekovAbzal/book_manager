import React from 'react'
import {
  useSettingsStore,
  type CompatRule,
  type FloorRule,
} from '../../../store/useSettingsStore'
import { SectionHeader, secondaryBtn } from './sectionUi'

export const OptimizerSection: React.FC = () => {
  const { optimizer, setOptimizer, resetOptimizer, roomFund } = useSettingsStore()

  return (
    <div style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SectionHeader
        title="Оптимизатор распределения"
        subtitle="Какие перемещения броней допустимы и насколько сильно штрафуются простои."
      />

      {/* ─── Правила совместимости ─── */}
      <Section
        title="Правила совместимости"
        hint='«Жёстко» — нельзя нарушать. «Мягко» — можно, но со штрафом. «Игнорировать» — алгоритм не учитывает.'
      >
        <CompatRow
          label="Вместимость"
          hint="Можно ли переставить бронь между двух- и трёхместными номерами"
          value={optimizer.capacityRule}
          onChange={(v) => setOptimizer('capacityRule', v)}
        />
        <CompatRow
          label="Особенности номера"
          hint="Списки features номера должны полностью совпадать (балкон, односпалки и т.д.)"
          value={optimizer.featuresRule}
          onChange={(v) => setOptimizer('featuresRule', v)}
        />
        <FloorRow
          label="Этаж"
          hint="Старается ли алгоритм держать гостя на том же этаже"
          value={optimizer.floorRule}
          onChange={(v) => setOptimizer('floorRule', v)}
        />
      </Section>

      {/* ─── Веса штрафов ─── */}
      <Section
        title="Веса штрафов"
        hint="Чем выше число — тем сильнее алгоритм избегает таких ситуаций."
      >
        <NumberRow
          label="Что считать коротким окном"
          hint="Окна ≤ N ночей считаются особо плохими (вряд ли продадутся)"
          value={optimizer.shortGapThreshold}
          min={1} max={7}
          suffix=" ночей"
          onChange={(v) => setOptimizer('shortGapThreshold', v)}
        />
        <NumberRow
          label="Множитель для коротких окон"
          hint="Во сколько раз короткое окно хуже обычного"
          value={optimizer.shortGapMultiplier}
          min={1} max={20}
          suffix="×"
          onChange={(v) => setOptimizer('shortGapMultiplier', v)}
        />
        <NumberRow
          label="Базовый штраф за пустую ночь"
          hint="Стоимость каждой пустой ночи в счёте оптимизации"
          value={optimizer.emptyNightPenalty}
          min={0} max={20}
          onChange={(v) => setOptimizer('emptyNightPenalty', v)}
        />
        <NumberRow
          label="Штраф за смену этажа"
          hint="Применяется если правило «Этаж» = мягкий штраф"
          value={optimizer.floorChangePenalty}
          min={0} max={50}
          disabled={optimizer.floorRule !== 'soft'}
          onChange={(v) => setOptimizer('floorChangePenalty', v)}
        />
        <NumberRow
          label="Штраф за несовпадение вместимости"
          hint="Применяется если правило «Вместимость» = мягкий штраф"
          value={optimizer.capacityMismatchPenalty}
          min={0} max={100}
          disabled={optimizer.capacityRule !== 'soft'}
          onChange={(v) => setOptimizer('capacityMismatchPenalty', v)}
        />
        <NumberRow
          label="Штраф за несовпадение особенностей"
          hint="Применяется если правило «Особенности» = мягкий штраф"
          value={optimizer.featuresMismatchPenalty}
          min={0} max={100}
          disabled={optimizer.featuresRule !== 'soft'}
          onChange={(v) => setOptimizer('featuresMismatchPenalty', v)}
        />
      </Section>

      {/* ─── Защита и ограничения ─── */}
      <Section
        title="Защита и ограничения"
        hint="Какие брони не трогать и сколько перемещений можно за раз."
      >
        <Toggle
          label="Не двигать оплаченные брони"
          hint="Брони с paidAmount > 0 будут зафиксированы"
          value={optimizer.protectPaidBookings}
          onChange={(v) => setOptimizer('protectPaidBookings', v)}
        />

        {/* Защищённые метки */}
        <div style={cardStyle}>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
            Защищённые метки
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
            Брони с этими метками алгоритм не будет перемещать
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {(roomFund.bookingFlags ?? []).length === 0 && (
              <span style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>
                Меток ещё нет — добавьте в разделе «Метки броней»
              </span>
            )}
            {(roomFund.bookingFlags ?? []).map(flag => {
              const active = optimizer.protectFlaggedIds.includes(flag.id)
              return (
                <button
                  key={flag.id}
                  type="button"
                  onClick={() => {
                    const next = active
                      ? optimizer.protectFlaggedIds.filter(x => x !== flag.id)
                      : [...optimizer.protectFlaggedIds, flag.id]
                    setOptimizer('protectFlaggedIds', next)
                  }}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 20,
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                    background: active ? 'var(--accent-bg)' : 'var(--surface)',
                    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
                    fontSize: '0.92rem',
                    fontWeight: active ? 700 : 500,
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                  }}
                >
                  {active && <span style={{ marginRight: 4 }}>✓</span>}
                  {flag.label}
                </button>
              )
            })}
          </div>
        </div>

        <NumberRow
          label="Максимум перемещений за раз"
          hint="0 = без лимита. Полезно если страшно переделывать всю сетку сразу"
          value={optimizer.maxMovesPerRun}
          min={0} max={500}
          onChange={(v) => setOptimizer('maxMovesPerRun', v)}
        />
        <NumberRow
          label="Горизонт планирования"
          hint="Учитывать только следующие N дней. 0 = всё что есть"
          value={optimizer.maxDaysAhead}
          min={0} max={365}
          suffix=" дней"
          onChange={(v) => setOptimizer('maxDaysAhead', v)}
        />
      </Section>

      {/* ─── Алгоритм ─── */}
      <Section
        title="Алгоритм"
        hint="Параметры внутреннего поиска. Обычно менять не нужно."
      >
        <Toggle
          label="Локальный поиск (улучшение swap-ами)"
          hint="После начальной раскладки пробует попарно обменивать брони если так лучше"
          value={optimizer.enableLocalSearch}
          onChange={(v) => setOptimizer('enableLocalSearch', v)}
        />
        <NumberRow
          label="Итераций локального поиска"
          hint="Больше = точнее, но медленнее"
          value={optimizer.localSearchIterations}
          min={10} max={2000} step={10}
          disabled={!optimizer.enableLocalSearch}
          onChange={(v) => setOptimizer('localSearchIterations', v)}
        />
        <Toggle
          label="Предпочитать оставлять в исходном номере"
          hint="При равном выигрыше алгоритм оставит бронь там где была"
          value={optimizer.preferSameRoom}
          onChange={(v) => setOptimizer('preferSameRoom', v)}
        />
      </Section>

      <button onClick={resetOptimizer} style={{ ...secondaryBtn, alignSelf: 'flex-start' }}>
        Сбросить настройки оптимизатора
      </button>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <div>
    <div style={{
      fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-faint)',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginBottom: hint ? 4 : 12,
    }}>
      {title}
    </div>
    {hint && (
      <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.4 }}>
        {hint}
      </div>
    )}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {children}
    </div>
  </div>
)

const cardStyle: React.CSSProperties = {
  padding: '10px 14px',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
}

interface ToggleProps {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

const Toggle: React.FC<ToggleProps> = ({ label, hint, value, onChange, disabled }) => (
  <label style={{
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    cursor: disabled ? 'not-allowed' : 'pointer', gap: 12,
    padding: '10px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      {hint && (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
    <div
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 40, height: 22, borderRadius: 11, flexShrink: 0,
        background: value ? 'var(--accent)' : 'var(--surface-3)',
        position: 'relative', transition: 'background 0.2s',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <div style={{
        position: 'absolute', top: 3, left: value ? 21 : 3,
        width: 16, height: 16, borderRadius: '50%', background: '#fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.3)', transition: 'left 0.2s',
      }} />
    </div>
  </label>
)

interface NumberRowProps {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  suffix?: string
  disabled?: boolean
  onChange: (v: number) => void
}

const NumberRow: React.FC<NumberRowProps> = ({
  label, hint, value, min, max, step = 1, suffix, disabled, onChange,
}) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '10px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    opacity: disabled ? 0.5 : 1,
  }}>
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
      {hint && (
        <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
          {hint}
        </div>
      )}
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)))
        }}
        style={{
          width: 76, padding: '6px 8px',
          border: '1px solid var(--border)',
          borderRadius: 6, textAlign: 'right',
          fontSize: '1rem', background: 'var(--bg)', color: 'var(--text)',
          fontWeight: 600,
        }}
      />
      {suffix && <span style={{ fontSize: '0.92rem', color: 'var(--text-faint)' }}>{suffix}</span>}
    </div>
  </div>
)

interface CompatRowProps {
  label: string
  hint?: string
  value: CompatRule
  onChange: (v: CompatRule) => void
}

const CompatRow: React.FC<CompatRowProps> = ({ label, hint, value, onChange }) => (
  <div style={{
    padding: '10px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {hint && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
      <div style={segmentStyle}>
        <SegBtn label="Жёстко"    active={value === 'strict'} onClick={() => onChange('strict')} />
        <SegBtn label="Мягко"     active={value === 'soft'}   onClick={() => onChange('soft')} />
        <SegBtn label="Игнор."    active={value === 'ignore'} onClick={() => onChange('ignore')} />
      </div>
    </div>
  </div>
)

interface FloorRowProps {
  label: string
  hint?: string
  value: FloorRule
  onChange: (v: FloorRule) => void
}

const FloorRow: React.FC<FloorRowProps> = ({ label, hint, value, onChange }) => (
  <div style={{
    padding: '10px 14px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {hint && (
          <div style={{ fontSize: '0.85rem', color: 'var(--text-faint)', marginTop: 3, lineHeight: 1.4 }}>
            {hint}
          </div>
        )}
      </div>
      <div style={segmentStyle}>
        <SegBtn label="Игнор."  active={value === 'ignore'} onClick={() => onChange('ignore')} />
        <SegBtn label="Мягко"   active={value === 'soft'}   onClick={() => onChange('soft')} />
        <SegBtn label="Жёстко"  active={value === 'strict'} onClick={() => onChange('strict')} />
      </div>
    </div>
  </div>
)

const segmentStyle: React.CSSProperties = {
  display: 'inline-flex',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 2,
  flexShrink: 0,
}

const SegBtn: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    style={{
      padding: '5px 12px',
      background: active ? 'var(--accent)' : 'transparent',
      color: active ? '#fff' : 'var(--text-muted)',
      border: 'none',
      borderRadius: 6,
      fontSize: '0.88rem',
      fontWeight: 600,
      cursor: 'pointer',
      transition: 'background 0.12s',
    }}
  >
    {label}
  </button>
)

