import React, { useEffect, useState } from 'react'
import { useGridStore } from '../../store/useGridStore'
import { useSettingsStore } from '../../store/useSettingsStore'
import { fetchCategories } from '../../api/rooms'
import type { Category } from '../../types'
import { DatePicker } from '../ui/DatePicker'

interface Props {
  /** Видимость панели управляется кнопкой в тулбаре (TodayStats). */
  open: boolean
}

interface Draft {
  building:    string
  categoryId:  string
  floor:       string
  capacity:    string
  features:    string
  guestSearch: string
  jumpDate:    string
}

export const Filters: React.FC<Props> = ({ open }) => {
  const { filters, guestSearch, data, setFilter, setGuestSearch, applyFilters, jumpToDate, hiddenCategoryIds, toggleCategoryVisible } = useGridStore()
  const { filterSettings, roomFund } = useSettingsStore()
  const [categories, setCategories] = useState<Category[]>([])

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

  // Видимость управляется кнопкой в тулбаре (TodayStats)
  if (!open) return null

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
          fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-faint)',
          letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>Фильтры</span>
      </div>

      {/* Body */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: 14,
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Search by name */}
        <div style={{ position: 'relative' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-faint)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={draft.guestSearch}
            placeholder="Гость, телефон…"
            onChange={e => setDraft({ ...draft, guestSearch: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') onApply() }}
            style={{ ...inputStyle, paddingLeft: 32, height: 34, borderRadius: 8 }}
          />
        </div>

        {/* Категория — чекбоксы (мгновенный клиентский фильтр, как в демо) */}
        {filterSettings.showCategory && categories.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{
              fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-faint)',
              letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4,
            }}>Категория</span>
            {categories.map(c => {
              const visible = !hiddenCategoryIds.includes(c.id)
              return (
                <label key={c.id} style={{
                  display: 'flex', alignItems: 'center', gap: 9, height: 30, cursor: 'pointer',
                  fontSize: '0.86rem', color: 'var(--text-muted)',
                }}>
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => toggleCategoryVisible(c.id)}
                    style={{ width: 15, height: 15, accentColor: 'var(--accent)', cursor: 'pointer' }}
                  />
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                  {c.name}
                </label>
              )
            })}
          </div>
        )}

        {/* Корпус / Этаж / Вместимость / Особенности — все на виду, в едином стиле */}
        {filterSettings.showBuilding && (
          <Field label="Корпус">
            <select value={draft.building} onChange={e => setDraft({ ...draft, building: e.target.value })} style={inputStyle}>
              <option value="">Все корпуса</option>
              {buildings.map(b => <option key={b} value={b}>Корпус {b}</option>)}
            </select>
          </Field>
        )}

        {filterSettings.showFloor && (
          <Field label="Этаж">
            <select value={draft.floor} onChange={e => setDraft({ ...draft, floor: e.target.value })} style={inputStyle}>
              <option value="">Все этажи</option>
              {floors.map(f => <option key={f} value={String(f)}>{f} этаж</option>)}
            </select>
          </Field>
        )}

        {filterSettings.showCapacity && roomFund.capacities.length > 0 && (
          <Field label="Вместимость">
            <select value={draft.capacity} onChange={e => setDraft({ ...draft, capacity: e.target.value })} style={inputStyle}>
              <option value="">Любая</option>
              {roomFund.capacities.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </Field>
        )}

        {filterSettings.showFeatures && roomFund.features.length > 0 && (
          <Field label="Особенности">
            <select value={draft.features} onChange={e => setDraft({ ...draft, features: e.target.value })} style={inputStyle}>
              <option value="">Любые</option>
              {roomFund.features.map(f => <option key={f.id} value={f.name}>{f.emoji} {f.name}</option>)}
            </select>
          </Field>
        )}

        <Field label="Перейти к дате">
          <DatePicker
            value={draft.jumpDate}
            onChange={v => setDraft({ ...draft, jumpDate: v })}
          />
        </Field>

        {/* Применить / Сбросить */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <button onClick={onApply} disabled={!dirty} style={{
            height: 36, background: dirty ? 'var(--accent)' : 'var(--surface-3)', border: 'none',
            borderRadius: 8, fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600,
            color: dirty ? '#fff' : 'var(--text-faint)', cursor: dirty ? 'pointer' : 'not-allowed',
            transition: 'background 0.12s',
          }}>Применить</button>
          {hasAppliedFilters && (
            <button onClick={onReset} style={{
              height: 34, background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 8, fontFamily: 'inherit', fontSize: '0.84rem', color: 'var(--text-muted)',
              cursor: 'pointer', fontWeight: 500,
            }}>Сбросить ({activeCount})</button>
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
  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
    <span style={{
      fontSize: '0.7rem', fontWeight: 600,
      color: 'var(--text-faint)',
      letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{label}</span>
    {children}
  </div>
)

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: 34,
  padding: '0 10px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.86rem',
  background: 'var(--bg)',
  color: 'var(--text)',
  outline: 'none',
  fontFamily: 'inherit',
}

