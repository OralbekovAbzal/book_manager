import React, { useEffect, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { fetchCategories } from '../../api/rooms'
import type { Category } from '../../types'

const LS_COLLAPSED = 'filters_collapsed'

interface Draft {
  building:    string
  categoryId:  string
  floor:       string
  capacity:    string
  features:    string
  guestSearch: string
  jumpDate:    string
}

export const Filters: React.FC = () => {
  const { filters, guestSearch, data, setFilter, setGuestSearch, applyFilters, jumpToDate } = useGridStore()
  const { filterSettings, roomFund } = useSettingsStore()
  const [categories, setCategories] = useState<Category[]>([])

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem(LS_COLLAPSED)
    if (saved !== null) return saved === '1'
    return filterSettings.collapsedByDefault
  })

  // Draft (локальные несохранённые значения)
  const [draft, setDraft] = useState<Draft>({
    building:    filters.building,
    categoryId:  filters.categoryId,
    floor:       filters.floor,
    capacity:    filters.capacity,
    features:    filters.features,
    guestSearch: guestSearch,
    jumpDate:    '',
  })

  useEffect(() => { fetchCategories().then(setCategories) }, [])
  useEffect(() => {
    localStorage.setItem(LS_COLLAPSED, collapsed ? '1' : '0')
  }, [collapsed])

  // Sync draft when applied filters change externally (через сброс из родителя)
  useEffect(() => {
    setDraft(d => ({
      ...d,
      building:    filters.building,
      categoryId:  filters.categoryId,
      floor:       filters.floor,
      capacity:    filters.capacity,
      features:    filters.features,
      guestSearch: guestSearch,
    }))
  }, [filters.building, filters.categoryId, filters.floor, filters.capacity, filters.features, guestSearch])

  const buildings = Array.from(
    new Set(data?.categories.flatMap((c) => c.rooms.map((r) => r.building)) ?? [])
  ).sort()

  const floors = Array.from(
    new Set(data?.categories.flatMap((c) => c.rooms.map((r) => r.floor)) ?? [])
  ).sort((a, b) => a - b)

  const dirty =
    draft.building    !== filters.building   ||
    draft.categoryId  !== filters.categoryId ||
    draft.floor       !== filters.floor      ||
    draft.capacity    !== filters.capacity   ||
    draft.features    !== filters.features    ||
    draft.guestSearch !== guestSearch        ||
    draft.jumpDate    !== ''

  const hasAppliedFilters =
    filters.building || filters.categoryId || filters.floor || filters.capacity || filters.features || guestSearch

  const activeCount =
    (filters.building   ? 1 : 0) +
    (filters.categoryId ? 1 : 0) +
    (filters.floor      ? 1 : 0) +
    (filters.capacity   ? 1 : 0) +
    (filters.features   ? 1 : 0) +
    (guestSearch        ? 1 : 0)

  const onApply = () => {
    setFilter('building',   draft.building)
    setFilter('categoryId', draft.categoryId)
    setFilter('floor',      draft.floor)
    setFilter('capacity',   draft.capacity)
    setFilter('features',   draft.features)
    setGuestSearch(draft.guestSearch)
    if (draft.jumpDate) {
      jumpToDate(draft.jumpDate)
    } else {
      applyFilters()
    }
    // Поля НЕ зачищаются — остаются в том виде, как ввёл пользователь
  }

  const onReset = () => {
    const cleared: Draft = { building: '', categoryId: '', floor: '', capacity: '', features: '', guestSearch: '', jumpDate: '' }
    setDraft(cleared)
    setFilter('building', '')
    setFilter('categoryId', '')
    setFilter('floor', '')
    setFilter('capacity', '')
    setFilter('features', '')
    setGuestSearch('')
    applyFilters()
  }

  // ─── Свёрнутый вид ─────────────────────────────────────────────────
  if (collapsed) {
    return (
      <aside style={{
        width: 36, flexShrink: 0,
        background: 'var(--surface)',
        borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', padding: '10px 0', gap: 10,
      }}>
        <button
          onClick={() => setCollapsed(false)}
          title="Показать фильтры"
          style={iconBtnStyle}
        >›</button>
        <div style={{
          writingMode: 'vertical-rl', transform: 'rotate(180deg)',
          fontSize: '0.77rem', fontWeight: 700, color: 'var(--text-muted)',
          letterSpacing: '0.12em', textTransform: 'uppercase', userSelect: 'none',
        }}>Фильтры</div>
        {activeCount > 0 && (
          <div style={{
            padding: '2px 6px', borderRadius: 8,
            background: 'var(--accent)', color: '#fff',
            fontSize: '0.77rem', fontWeight: 700,
          }}>{activeCount}</div>
        )}
      </aside>
    )
  }

  // ─── Развёрнутый ───────────────────────────────────────────────────
  return (
    <aside style={{
      width: 240, flexShrink: 0,
      background: 'var(--surface)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{
          fontSize: '0.85em', fontWeight: 700, color: 'var(--text)',
          letterSpacing: '0.06em', textTransform: 'uppercase',
        }}>Фильтры</span>
        <button onClick={() => setCollapsed(true)} title="Скрыть фильтры" style={iconBtnStyle}>‹</button>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: 14,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Search by name */}
        <Field label="Поиск по имени">
          <input
            type="text"
            value={draft.guestSearch}
            placeholder="Иванов"
            onChange={e => setDraft({ ...draft, guestSearch: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onApply() }}
            style={inputStyle}
          />
        </Field>

        {/* Jump to date */}
        <Field label="Перейти к дате">
          <input
            type="date"
            value={draft.jumpDate}
            onChange={e => setDraft({ ...draft, jumpDate: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onApply() }}
            style={inputStyle}
          />
        </Field>

        {filterSettings.showBuilding && (
          <Field label="Корпус">
            <select
              value={draft.building}
              onChange={e => setDraft({ ...draft, building: e.target.value })}
              style={inputStyle}
            >
              <option value="">Все</option>
              {buildings.map(b => <option key={b} value={b}>Корпус {b}</option>)}
            </select>
          </Field>
        )}

        {filterSettings.showCategory && (
          <Field label="Категория">
            <select
              value={draft.categoryId}
              onChange={e => setDraft({ ...draft, categoryId: e.target.value })}
              style={inputStyle}
            >
              <option value="">Все</option>
              {categories.map(c => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </Field>
        )}

        {filterSettings.showFloor && (
          <Field label="Этаж">
            <select
              value={draft.floor}
              onChange={e => setDraft({ ...draft, floor: e.target.value })}
              style={inputStyle}
            >
              <option value="">Все</option>
              {floors.map(f => <option key={f} value={String(f)}>{f} этаж</option>)}
            </select>
          </Field>
        )}

        {filterSettings.showCapacity && roomFund.capacities.length > 0 && (
          <Field label="Вместимость">
            <select
              value={draft.capacity}
              onChange={e => setDraft({ ...draft, capacity: e.target.value })}
              style={inputStyle}
            >
              <option value="">Все</option>
              {roomFund.capacities.map(c => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </Field>
        )}

        {filterSettings.showFeatures && roomFund.features.length > 0 && (
          <Field label="Особенности">
            <select
              value={draft.features}
              onChange={e => setDraft({ ...draft, features: e.target.value })}
              style={inputStyle}
            >
              <option value="">Все</option>
              {roomFund.features.map(f => (
                <option key={f.id} value={f.name}>{f.emoji} {f.name}</option>
              ))}
            </select>
          </Field>
        )}

        {/* Action buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <button
            onClick={onApply}
            disabled={!dirty}
            style={{
              padding: '8px 0',
              background: dirty ? 'var(--accent)' : 'var(--surface-3)',
              border: 'none',
              borderRadius: 'var(--ui-radius)',
              fontSize: 'inherit',
              fontWeight: 600,
              color: dirty ? '#ffffff' : 'var(--text-faint)',
              cursor: dirty ? 'pointer' : 'not-allowed',
              transition: 'background 0.12s',
            }}
          >
            Применить
          </button>
          {hasAppliedFilters && (
            <button
              onClick={onReset}
              style={{
                padding: '7px 0',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 'var(--ui-radius)',
                fontSize: 'inherit',
                color: 'var(--text)',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              Сбросить ({activeCount})
            </button>
          )}
        </div>
      </div>

      {/* Footer */}
      {data && (
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '0.85rem', color: 'var(--text-faint)',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>Показано</span>
          <span style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
            {data.totalRooms} {pluralRooms(data.totalRooms)}
          </span>
        </div>
      )}
    </aside>
  )
}

function pluralRooms(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'номер'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'номера'
  return 'номеров'
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{
      fontSize: '0.77rem', fontWeight: 700,
      color: 'var(--text-faint)',
      letterSpacing: '0.06em', textTransform: 'uppercase',
    }}>{label}</span>
    {children}
  </div>
)

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
  fontWeight: 500,
}

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  width: 24, height: 24,
  cursor: 'pointer',
  color: 'var(--text)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 'inherit', fontWeight: 700,
  padding: 0,
}
