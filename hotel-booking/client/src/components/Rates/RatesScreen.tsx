import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchRates, applyRates, clearRates, applyRateCells, clearRateCells, fetchRatesCount,
  type RateCell,
} from '../../api/rates'
import { confirmDialog, confirmDanger } from '../ui/ConfirmDialog'
import { fetchHotel, updateHotel } from '../../api/hotel'
import { fetchCategories } from '../../api/categories'
import { ServicesTab } from './ServicesTab'
import type { Category, HotelSettings, PriceField, RatePrice } from '../../types'
import { inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn, formTitle } from '../Settings/sections/sectionUi'

/**
 * Раздел «Тарифы и наличие» — календарь цен.
 *
 * Метафора та же, что у шахматки: строки — категории, столбцы — даты.
 * Цена хранится ПО ДНЯМ, но заполняется диапазонами: завести год поштучно
 * невозможно, а точечная правка (31 декабря) при этом остаётся.
 *
 * Пустая ячейка намеренно бросается в глаза: без цены бронь посчитается в ноль,
 * и лучше увидеть дыру здесь, чем в счёте гостя.
 */

interface Props {
  onBack: () => void
}

const WEEKDAY_LABELS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
]

const PERSON_FIELDS: { key: PriceField; label: string }[] = [
  { key: 'adultPrice', label: 'Взрослый' },
  { key: 'childPrice', label: 'Детский' },
  { key: 'extraBedPrice', label: 'Доп. место' },
]

/** 'YYYY-MM-DD' без участия часового пояса — даты @db.Date это UTC-полночь. */
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** 'YYYY-MM-DD' → '01.09.2026'. Через UTC — иначе местная зона сдвинет день назад. */
const fmtDay = (isoDate: string) =>
  new Date(`${isoDate}T00:00:00.000Z`).toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
  })

/** «01.09.2026 — 30.09.2026» или один день, если он один. */
const dayRange = (dates: string[]) => {
  if (dates.length === 0) return '—'
  const sorted = [...dates].sort()
  const from = fmtDay(sorted[0])
  const to = fmtDay(sorted[sorted.length - 1])
  return from === to ? from : `${from} — ${to}`
}

/**
 * Текст «что именно сотрётся». Календарь цен НЕ входит в снимки: вернуть его
 * можно только из ночной резервной копии целиком (D6-004), поэтому в вопросе
 * стоят настоящее число цен, категории и границы дат — а не «вы уверены?».
 */
const clearWarning = (count: number, categories: string, dates: string) => ([
  `Будет стёрто цен: ${count}.`,
  `Категории: ${categories}. Даты: ${dates}.`,
  'Календарь цен не входит в снимки — восстановить его можно только из резервной копии.',
])

/**
 * Компактная цена для узкой ячейки. Округлять до тысяч нельзя: 18 500 превратилось бы
 * в «19т», и календарь врал бы о реальной цене. Поэтому у некруглых сумм оставляем
 * десятую долю: 18 500 → «18,5т». Точное значение всегда видно в подсказке ячейки.
 */
const fmtMoney = (n: number) => {
  if (n < 1000) return String(n)
  const k = n / 1000
  return Number.isInteger(k)
    ? `${k}т`
    : `${k.toFixed(1).replace('.', ',')}т`
}

export const RatesScreen: React.FC<Props> = ({ onBack }) => {
  const today = new Date()
  const [year, setYear] = useState(today.getUTCFullYear())
  const [month, setMonth] = useState(today.getUTCMonth())

  const [hotel, setHotel] = useState<HotelSettings | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [rates, setRates] = useState<RatePrice[]>([])
  const [loading, setLoading] = useState(true)
  const [field, setField] = useState<PriceField>('adultPrice')
  const [tab, setTab] = useState<'prices' | 'meals' | 'extras'>('prices')
  const [fillOpen, setFillOpen] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef<number | undefined>(undefined)

  // ─── Выделение ──────────────────────────────────────────────────────────────
  // Заполнять календарь поячеечно — не работа для человека. Поэтому выделяем
  // мышью прямоугольник (или строку/столбец кликом по заголовку) и вводим цену
  // один раз на всё выделенное.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Якорь — в ref, а не в состоянии: при быстром протягивании мышь успевает уйти
  // на соседнюю ячейку раньше, чем React перерисуется, и выделение схлопывалось
  // в одну ячейку.
  const anchor = useRef<{ cat: number; day: number } | null>(null)
  const dragging = useRef(false)
  const [bulkValue, setBulkValue] = useState('')
  const bulkRef = useRef<HTMLInputElement>(null)

  const perRoom = hotel?.pricingBase === 'room'
  const activeField: PriceField = perRoom ? 'roomPrice' : field

  const days = useMemo(() => {
    const count = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    return Array.from({ length: count }, (_, i) => {
      const d = i + 1
      return { day: d, date: iso(year, month, d), dow: new Date(Date.UTC(year, month, d)).getUTCDay() }
    })
  }, [year, month])

  const rangeFrom = days[0]?.date
  const rangeTo = days[days.length - 1]?.date

  const load = () => {
    if (!rangeFrom || !rangeTo) return
    setLoading(true)
    Promise.all([fetchHotel(), fetchCategories(), fetchRates(rangeFrom, rangeTo)])
      .then(([h, c, r]) => { setHotel(h); setCategories(c); setRates(r) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [rangeFrom, rangeTo])
  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  const flash = (text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2200)
  }

  /** Быстрый доступ: "categoryId|YYYY-MM-DD" → цена выбранного типа. */
  const priceMap = useMemo(() => {
    const m = new Map<string, number | null>()
    for (const r of rates) m.set(`${r.categoryId}|${r.date.slice(0, 10)}`, r[activeField])
    return m
  }, [rates, activeField])

  const missing = useMemo(() => {
    let n = 0
    for (const c of categories) for (const d of days) {
      if (priceMap.get(`${c.id}|${d.date}`) == null) n++
    }
    return n
  }, [categories, days, priceMap])

  const shiftMonth = (delta: number) => {
    const d = new Date(Date.UTC(year, month + delta, 1))
    setYear(d.getUTCFullYear())
    setMonth(d.getUTCMonth())
    setSelected(new Set())
  }

  // ─── Логика выделения ───────────────────────────────────────────────────────
  const key = (catId: number, date: string) => `${catId}|${date}`

  /** Прямоугольник от точки-якоря до текущей ячейки. */
  const rectBetween = (a: { cat: number; day: number }, b: { cat: number; day: number }) => {
    const catIdx = categories.map(c => c.id)
    const [c1, c2] = [catIdx.indexOf(a.cat), catIdx.indexOf(b.cat)].sort((x, y) => x - y)
    const [d1, d2] = [a.day, b.day].sort((x, y) => x - y)
    const next = new Set<string>()
    for (let ci = c1; ci <= c2; ci++) {
      for (let d = d1; d <= d2; d++) next.add(key(catIdx[ci], iso(year, month, d)))
    }
    return next
  }

  const startDrag = (catId: number, day: number, additive: boolean) => {
    dragging.current = true
    anchor.current = { cat: catId, day }
    const cell = key(catId, iso(year, month, day))
    setSelected(prev => (additive ? new Set([...prev, cell]) : new Set([cell])))
  }

  const extendDrag = (catId: number, day: number) => {
    if (!dragging.current || !anchor.current) return
    setSelected(rectBetween(anchor.current, { cat: catId, day }))
  }

  // Отпустить кнопку могли и вне таблицы — слушаем документ.
  useEffect(() => {
    const up = () => { dragging.current = false }
    document.addEventListener('mouseup', up)
    return () => document.removeEventListener('mouseup', up)
  }, [])

  // Esc снимает выделение (и только потом, вторым нажатием, закроет раздел).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selected.size > 0) { e.stopPropagation(); setSelected(new Set()) }
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [selected.size])

  const selectRow = (catId: number) =>
    setSelected(new Set(days.map(d => key(catId, d.date))))

  const selectColumn = (date: string) =>
    setSelected(new Set(categories.map(c => key(c.id, date))))

  const selectAll = () =>
    setSelected(new Set(categories.flatMap(c => days.map(d => key(c.id, d.date)))))

  const selectedCells = (): RateCell[] =>
    [...selected].map(k => {
      const [cat, date] = k.split('|')
      return { categoryId: Number(cat), date }
    })

  const applyToSelection = async () => {
    const raw = bulkValue.trim()
    if (!raw) { flash('Введите цену'); return }
    const value = Number(raw)
    if (Number.isNaN(value) || value < 0) { flash('Цена должна быть числом'); return }
    try {
      const r = await applyRateCells(selectedCells(), { [activeField]: value })
      setRates(await fetchRates(rangeFrom!, rangeTo!))
      setBulkValue('')
      flash(`Записано цен: ${r.updated}`)
    } catch { flash('Не удалось записать цены') }
  }

  /** Ячейки выделения, в которых цена ЕСТЬ, — только они и будут стёрты. */
  const filledInSelection = useMemo(() => {
    // Ключ строки календаря, а не выбранного типа цены: `clearRateCells` удаляет
    // строку `RatePrice` целиком, вместе со взрослой, детской и ценой за номер.
    const existing = new Set(rates.map(r => `${r.categoryId}|${r.date.slice(0, 10)}`))
    return [...selected].filter(k => existing.has(k))
  }, [rates, selected])

  const clearSelection = async () => {
    const cells = selectedCells()
    if (filledInSelection.length === 0) { flash('В выделении нет заданных цен'); return }
    const catNames = categories
      .filter(c => cells.some(x => x.categoryId === c.id))
      .map(c => c.name)
      .join(', ')
    const ok = await confirmDanger({
      title: 'Стереть цены в выделении?',
      text: clearWarning(filledInSelection.length, catNames || '—', dayRange(cells.map(c => c.date))),
      confirmLabel: 'Стереть',
    })
    if (!ok) return
    try {
      const r = await clearRateCells(cells)
      setRates(await fetchRates(rangeFrom!, rangeTo!))
      flash(`Очищено: ${r.deleted}`)
    } catch { flash('Не удалось очистить') }
  }

  const setPricingBase = async (base: 'room' | 'person') => {
    if (base === (hotel?.pricingBase ?? 'person')) return
    // Способ расчёта — настройка всего объекта, а не этого экрана: он решает,
    // как посчитается КАЖДАЯ новая бронь. Одним кликом такое не меняют.
    const ok = await confirmDialog({
      title: base === 'room' ? 'Считать за номер?' : 'Считать за место?',
      text: [
        base === 'room'
          ? 'Цена будет браться за номер целиком, независимо от числа гостей.'
          : 'Цена будет считаться по гостям: взрослые, дети и дополнительные места отдельно.',
        'Изменится расчёт всех новых броней. Существующие не пересчитываются.',
      ],
      confirmLabel: 'Сменить',
    })
    if (ok !== 'confirm') return
    try {
      const updated = await updateHotel({ pricingBase: base })
      setHotel(updated)
      flash(base === 'room' ? 'Считаем за номер' : 'Считаем за место')
    } catch { flash('Не удалось сменить способ расчёта') }
  }

  return (
    <div style={{
      flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', color: 'var(--text)', overflow: 'hidden',
    }}>
      {/* Шапка раздела */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '0 24px',
        height: 60, borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <span style={{ fontSize: '1.08rem', fontWeight: 700, letterSpacing: '-0.01em' }}>Тарифы</span>
        {tab === 'prices' && missing > 0 && (
          <span style={{
            fontSize: '0.78rem', color: 'var(--s-overdue)', background: 'var(--surface-2)',
            border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '3px 9px',
          }}>
            без цены: {missing}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {tab === 'prices' && (
          <button onClick={() => setFillOpen(true)} style={primaryBtn}>Заполнить период</button>
        )}
        <button onClick={onBack} title="К шахматке (Esc)" style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.5rem',
          color: 'var(--text-faint)', padding: '0 4px', lineHeight: 1, fontWeight: 300,
        }}>×</button>
      </div>

      {/* Вкладки раздела */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '10px 24px 0',
        borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        {([
          { id: 'prices', label: 'Цены' },
          { id: 'meals', label: 'Питание' },
          { id: 'extras', label: 'Услуги' },
        ] as const).map(t => {
          const active = tab === t.id
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                height: 34, padding: '0 14px', border: 'none', background: 'transparent',
                borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                color: active ? 'var(--text)' : 'var(--text-muted)',
                fontWeight: active ? 600 : 500, fontSize: '0.9rem',
                fontFamily: 'inherit', cursor: 'pointer', marginBottom: -1,
              }}
            >{t.label}</button>
          )
        })}
      </div>

      {tab !== 'prices' ? (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px 32px' }}>
          <ServicesTab kind={tab === 'meals' ? 'meal' : 'extra'} onToast={flash} />
        </div>
      ) : (
      <>
      {/* Панель управления */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        padding: '12px 24px', borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <NavBtn onClick={() => shiftMonth(-1)} label="‹" title="Предыдущий месяц" />
          <span style={{ minWidth: 148, textAlign: 'center', fontWeight: 600, fontSize: '0.92rem' }}>
            {MONTHS[month]} {year}
          </span>
          <NavBtn onClick={() => shiftMonth(1)} label="›" title="Следующий месяц" />
        </div>

        <span style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />

        {/* Способ расчёта — настройка объекта, но управляется отсюда: она напрямую
            определяет, что показывает и что правит этот экран. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>Считаем</span>
          <Segmented
            options={[{ v: 'person', label: 'за место' }, { v: 'room', label: 'за номер' }]}
            value={hotel?.pricingBase ?? 'person'}
            onChange={v => setPricingBase(v as 'room' | 'person')}
          />
        </div>

        {!perRoom && (
          <>
            <span style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>Цена</span>
              <Segmented
                options={PERSON_FIELDS.map(f => ({ v: f.key, label: f.label }))}
                value={field}
                onChange={v => setField(v as PriceField)}
              />
            </div>
          </>
        )}
      </div>

      {/* Панель действий над выделением */}
      {selected.size > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '10px 24px', flexShrink: 0,
          background: 'var(--accent-bg)', borderBottom: '1px solid var(--border-subtle)',
        }}>
          <span style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--accent-text)' }}>
            Выделено: {selected.size} {cellWord(selected.size)}
          </span>
          <input
            ref={bulkRef}
            value={bulkValue}
            onChange={e => setBulkValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyToSelection() }}
            placeholder="Цена"
            style={{ ...inputStyle, width: 130, height: 32 }}
          />
          <button onClick={applyToSelection} style={{ ...primaryBtn, height: 32 }}>
            Применить
          </button>
          {/* Многоточие — обещание вопроса: кнопка стоит вплотную к «Применить»,
              и без него промах читался бы как «сейчас сотрёт молча». */}
          <button onClick={clearSelection} style={{ ...secondaryBtn, height: 32, color: 'var(--s-overdue)' }}>
            Очистить цены…
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={() => setSelected(new Set())} style={{ ...secondaryBtn, height: 32 }}>
            Снять выделение
          </button>
        </div>
      )}

      {/* Календарь */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '16px 24px 32px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-faint)' }}>Загрузка…</div>
        ) : categories.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-faint)' }}>
            Сначала заведите категории номеров в настройках.
          </div>
        ) : (
          <>
            {/* table-layout: fixed + width 100% — месяц всегда влезает целиком.
                Раньше при 31 дне таблица уезжала за экран и последние числа терялись. */}
            <table style={{
              width: '100%', tableLayout: 'fixed', borderCollapse: 'separate',
              borderSpacing: 0, fontSize: '0.78rem', userSelect: 'none',
            }}>
              <colgroup>
                <col style={{ width: 116 }} />
                {days.map(d => <col key={d.date} />)}
              </colgroup>
              <thead>
                <tr>
                  <th
                    onClick={selectAll}
                    title="Выделить весь месяц"
                    style={{
                      textAlign: 'left', padding: '0 10px 8px 0', cursor: 'pointer',
                      fontWeight: 600, fontSize: '0.68rem', letterSpacing: '0.06em',
                      textTransform: 'uppercase', color: 'var(--text-faint)',
                    }}
                  >Категория</th>
                  {days.map(d => {
                    const weekend = d.dow === 0 || d.dow === 6
                    return (
                      <th
                        key={d.date}
                        onClick={() => selectColumn(d.date)}
                        title={`Выделить ${d.day} число по всем категориям`}
                        style={{
                          padding: '0 0 8px', fontWeight: 600, cursor: 'pointer',
                          color: weekend ? 'var(--s-overdue)' : 'var(--text-faint)',
                        }}
                      >
                        <div style={{ fontSize: '0.82rem' }}>{d.day}</div>
                        <div style={{ fontSize: '0.64rem', fontWeight: 500 }}>{WEEKDAY_LABELS[d.dow]}</div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {categories.map(c => (
                  <tr key={c.id}>
                    <td
                      onClick={() => selectRow(c.id)}
                      title="Выделить всю строку за месяц"
                      style={{ padding: '0 10px 4px 0', whiteSpace: 'nowrap', cursor: 'pointer' }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
                      </span>
                    </td>
                    {days.map(d => (
                      <PriceCell
                        key={d.date}
                        value={priceMap.get(`${c.id}|${d.date}`) ?? null}
                        weekend={d.dow === 0 || d.dow === 6}
                        selected={selected.has(`${c.id}|${d.date}`)}
                        onMouseDown={e => {
                          e.preventDefault()
                          startDrag(c.id, d.day, e.ctrlKey || e.metaKey)
                          window.setTimeout(() => bulkRef.current?.focus(), 0)
                        }}
                        onMouseEnter={() => extendDrag(c.id, d.day)}
                      />
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ marginTop: 14, fontSize: '0.78rem', color: 'var(--text-faint)', lineHeight: 1.6 }}>
              Протяните мышью по ячейкам, чтобы выделить период. Клик по названию категории —
              вся строка за месяц, клик по числу — весь день по категориям, клик по слову
              «Категория» — весь месяц. Затем введите цену один раз.
            </div>
          </>
        )}
      </div>

      </>
      )}

      {fillOpen && tab === 'prices' && (
        <FillDialog
          categories={categories}
          perRoom={perRoom}
          defaultFrom={rangeFrom ?? ''}
          defaultTo={rangeTo ?? ''}
          onClose={() => setFillOpen(false)}
          onDone={(msg) => { setFillOpen(false); flash(msg); load() }}
        />
      )}

      {toast && (
        <div style={{
          position: 'fixed', bottom: 26, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--text)', color: 'var(--text-inverse)', padding: '9px 16px',
          borderRadius: 8, fontSize: '0.85rem', fontWeight: 500, boxShadow: 'var(--shadow-md)',
          zIndex: 620, pointerEvents: 'none',
        }}>{toast}</div>
      )}
    </div>
  )
}

// ─── Ячейка цены ──────────────────────────────────────────────────────────────

/**
 * Ячейка только отображает и участвует в выделении. Отдельного ввода внутри
 * ячейки нет намеренно: выделил одну ячейку — печатаешь в общем поле, тот же
 * результат меньшим числом сущностей.
 */
const PriceCell: React.FC<{
  value: number | null
  weekend: boolean
  selected: boolean
  onMouseDown: (e: React.MouseEvent) => void
  onMouseEnter: () => void
}> = ({ value, weekend, selected, onMouseDown, onMouseEnter }) => {
  const empty = value == null
  return (
    <td
      onMouseDown={onMouseDown}
      onMouseEnter={onMouseEnter}
      title={empty ? 'Цена не задана' : value!.toLocaleString('ru-RU')}
      style={{
        padding: '0 2px 4px 0',
        cursor: 'cell',
      }}
    >
      <div style={{
        height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 5, fontSize: '0.78rem', fontWeight: empty ? 400 : 600,
        // Пустая цена подсвечена намеренно: без неё бронь посчитается в ноль.
        background: selected
          ? 'var(--accent)'
          : empty ? 'var(--surface-2)' : weekend ? 'var(--accent-bg)' : 'transparent',
        border: `1px solid ${selected ? 'var(--accent)' : empty ? 'var(--border-subtle)' : 'transparent'}`,
        color: selected ? '#fff' : empty ? 'var(--text-faint)' : 'var(--text)',
      }}>
        {empty ? '—' : fmtMoney(value!)}
      </div>
    </td>
  )
}

function cellWord(n: number) {
  const t = n % 100
  if (t >= 11 && t <= 14) return 'ячеек'
  switch (n % 10) {
    case 1: return 'ячейка'
    case 2: case 3: case 4: return 'ячейки'
    default: return 'ячеек'
  }
}

// ─── Заполнение периода ───────────────────────────────────────────────────────

const FillDialog: React.FC<{
  categories: Category[]
  perRoom: boolean
  defaultFrom: string
  defaultTo: string
  onClose: () => void
  onDone: (msg: string) => void
}> = ({ categories, perRoom, defaultFrom, defaultTo, onClose, onDone }) => {
  const [picked, setPicked] = useState<number[]>(categories.map(c => c.id))
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(defaultTo)
  const [weekdays, setWeekdays] = useState<number[]>([])
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const fields = perRoom ? [{ key: 'roomPrice', label: 'Цена за номер' }] : PERSON_FIELDS

  const toggle = (arr: number[], v: number) =>
    arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]

  /** Проверка, общая для «Применить» и «Очистить период». */
  const validate = () => {
    setError('')
    if (picked.length === 0) { setError('Выберите хотя бы одну категорию'); return false }
    if (!from || !to) { setError('Укажите даты периода'); return false }
    return true
  }

  const apply = async () => {
    if (!validate()) return
    setBusy(true)
    try {
      const filled = Object.fromEntries(
        Object.entries(prices).filter(([, v]) => v.trim() !== '')
      )
      if (Object.keys(filled).length === 0) { setError('Не заполнена ни одна цена'); setBusy(false); return }
      const r = await applyRates({ categoryIds: picked, dateFrom: from, dateTo: to, weekdays, prices: filled })
      onDone(`Записано цен: ${r.updated} за ${r.days} дн.`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Не удалось применить')
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!validate()) return
    const catNames = categories.filter(c => picked.includes(c.id)).map(c => c.name).join(', ')
    // Сколько цен реально лежит в периоде, спрашиваем у СЕРВЕРА: «категорий ×
    // дней» соврало бы — в календаре почти всегда есть пустые ячейки, и вопрос
    // «стереть 310 цен» там, где их 12, отучает читать вопросы.
    setBusy(true)
    let count: number | null = null
    try {
      count = await fetchRatesCount(picked, from, to)
    } catch {
      // Старый сервер без /rates/count. Молчать нельзя — спрашиваем без числа.
      count = null
    }
    setBusy(false)
    if (count === 0) { setError('В этом периоде цен нет — стирать нечего'); return }
    const ok = await confirmDanger({
      title: 'Стереть цены за период?',
      text: count == null
        ? [
            `Категории: ${catNames}. Даты: ${fmtDay(from)} — ${fmtDay(to)}.`,
            'Все заданные цены этого периода будут удалены.',
            'Календарь цен не входит в снимки — восстановить его можно только из резервной копии.',
          ]
        : clearWarning(count, catNames, `${fmtDay(from)} — ${fmtDay(to)}`),
      confirmLabel: 'Стереть',
    })
    if (!ok) return
    setBusy(true)
    try {
      const r = await clearRates(picked, from, to)
      onDone(`Очищено цен: ${r.deleted}`)
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Не удалось очистить')
      setBusy(false)
    }
  }

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg)', borderRadius: 14, width: '100%', maxWidth: 560,
        maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ ...formTitle, fontSize: '1rem' }}>Заполнить период</span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Категории</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
              {categories.map(c => (
                <Chip
                  key={c.id}
                  active={picked.includes(c.id)}
                  color={c.color}
                  label={c.name}
                  onClick={() => setPicked(p => toggle(p, c.id))}
                />
              ))}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>С даты</label>
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>По дату</label>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inputStyle} />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Дни недели</label>
            <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <Chip
                  key={d}
                  active={weekdays.includes(d)}
                  label={WEEKDAY_LABELS[d]}
                  onClick={() => setWeekdays(w => toggle(w, d))}
                />
              ))}
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: 5 }}>
              {weekdays.length === 0
                ? 'Ничего не выбрано — цена ляжет на все дни периода.'
                : 'Цена ляжет только на выбранные дни недели.'}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: perRoom ? '1fr' : '1fr 1fr 1fr', gap: 10 }}>
            {fields.map(f => (
              <div key={f.key}>
                <label style={labelStyle}>{f.label}</label>
                <input
                  value={prices[f.key] ?? ''}
                  onChange={e => setPrices(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder="—"
                  style={inputStyle}
                />
              </div>
            ))}
          </div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: -6 }}>
            Незаполненное поле не тронет уже заданную цену.
          </div>

          {error && <div style={errorStyle}>{error}</div>}

          {/* Удаление стоит ОТДЕЛЬНО от «Применить», за чертой и своим текстом.
              Раньше «Очистить период» была равноправной кнопкой в том же подвале
              рядом с «Применить»: промах мышью стирал календарь цен на месяц
              без единого вопроса (D6-004, D7-011). */}
          <div style={{
            marginTop: 6, paddingTop: 14, borderTop: '1px solid var(--border-subtle)',
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}>
            <div style={{ flex: '1 1 260px', minWidth: 0, fontSize: '0.76rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Удалить уже заданные цены выбранных категорий за весь период.
              Дни недели при удалении не учитываются.
            </div>
            <button
              onClick={clear}
              disabled={busy}
              style={{ ...secondaryBtn, height: 32, color: 'var(--s-overdue)' }}
            >
              Очистить период…
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} disabled={busy} style={secondaryBtn}>Отмена</button>
          <button onClick={apply} disabled={busy} style={primaryBtn}>
            {busy ? 'Применяю…' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Мелочи ───────────────────────────────────────────────────────────────────

const NavBtn: React.FC<{ onClick: () => void; label: string; title: string }> = ({ onClick, label, title }) => (
  <button onClick={onClick} title={title} style={{
    width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7,
    color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1rem', fontFamily: 'inherit',
  }}>{label}</button>
)

const Segmented: React.FC<{
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}> = ({ options, value, onChange }) => (
  <div style={{
    display: 'inline-flex', gap: 3, padding: 3, background: 'var(--surface-2)',
    border: '1px solid var(--border-subtle)', borderRadius: 9,
  }}>
    {options.map(o => {
      const active = o.v === value
      return (
        <button key={o.v} onClick={() => onChange(o.v)} style={{
          height: 26, padding: '0 11px', border: 'none', borderRadius: 6,
          background: active ? 'var(--bg)' : 'transparent',
          color: active ? 'var(--text)' : 'var(--text-muted)',
          fontWeight: active ? 600 : 500, fontSize: '0.82rem',
          fontFamily: 'inherit', cursor: 'pointer',
          boxShadow: active ? 'var(--shadow-sm)' : 'none',
        }}>{o.label}</button>
      )
    })}
  </div>
)

const Chip: React.FC<{
  active: boolean
  label: string
  color?: string
  onClick: () => void
}> = ({ active, label, color, onClick }) => (
  <button onClick={onClick} style={{
    display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px',
    borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.83rem',
    fontWeight: active ? 600 : 500,
    background: active ? 'var(--accent-bg)' : 'var(--surface-2)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
    color: active ? 'var(--accent-text)' : 'var(--text-muted)',
  }}>
    {color && <span style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />}
    {label}
  </button>
)
