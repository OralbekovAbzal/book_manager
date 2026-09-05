import React, { useEffect, useMemo, useState } from 'react'
import { fetchGuests } from '../../api/guests'
import type { Guest, GuestBook, GuestBooking, GuestDocument, UnnamedGuestGroup } from '../../types'
import { EmptyBox, inputStyle, secondaryBtn } from '../Settings/sections/sectionUi'

/**
 * Вкладка «Гости» справочника — адресная книга постояльцев.
 *
 * Записей гостей в базе нет: карточка собирается сервером из существующих
 * броней по нормализованному телефону (server/src/controllers/guestController.js).
 * Заводить руками нечего, книга копится сама.
 *
 * Ключ — телефон, а не имя: «Асель», «Асель К.» и «Асель Каримова» пишут
 * по-разному, а номер один. По имени склеились бы разные люди.
 */

// ─── Константы объявлены ДО компонента ────────────────────────────────────────
// Объявленная ниже падает при горячей перезагрузке с «is not defined»
// (временная мёртвая зона). Ловили дважды — см. NOTES.md.

const contentWrap: React.CSSProperties = { maxWidth: 1280, margin: '0 auto' }

const cardGrid: React.CSSProperties = {
  display: 'grid', gap: 10,
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
}

const STATUS_LABELS: Record<string, string> = {
  CONFIRMED: 'Подтверждена',
  CHECKED_IN: 'Проживает',
  CHECKED_OUT: 'Выехал',
  CANCELLED: 'Отменена',
  NO_SHOW: 'Неявка',
}

const STATUS_COLORS: Record<string, string> = {
  CONFIRMED: 'var(--s-confirmed)',
  CHECKED_IN: 'var(--s-in)',
  CHECKED_OUT: 'var(--s-out)',
  CANCELLED: 'var(--s-overdue)',
  NO_SHOW: 'var(--s-maint)',
}

// Подписи типов документа — те же слова, что в форме брони и в её просмотре:
// одно поле не должно называться по-разному в трёх окнах.
const DOC_TYPE_LABELS: Record<string, string> = {
  passport: 'Паспорт',
  id_card: 'Удостоверение личности',
  other: 'Документ',
}

type SortKey = 'recent' | 'visits' | 'name'

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'recent', label: 'По последней брони' },
  { key: 'visits', label: 'По числу визитов' },
  { key: 'name', label: 'По имени' },
]

type Chip = 'all' | 'regular' | 'upcoming' | 'nophone'

// Сколько карточек рисуем за раз. Книга копится годами, и без ограничения
// экран однажды попробует отрисовать несколько тысяч карточек разом. Виртуализации
// здесь нет (в отличие от шахматки), а находят гостя всё равно поиском, не листанием.
const RENDER_LIMIT = 200

const ICON_COPY = (
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </>
)

const onlyDigits = (s: string) => s.replace(/\D/g, '')

/**
 * `@db.Date` доезжает сюда строкой YYYY-MM-DD, но `new Date('2026-07-03')`
 * это UTC-полночь: без timeZone:'UTC' в UTC+5 покажется 2 июля.
 */
const fmtDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('ru-RU', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  })

function plural(n: number, one: string, few: string, many: string) {
  const t = n % 100
  if (t >= 11 && t <= 14) return many
  switch (n % 10) {
    case 1: return one
    case 2: case 3: case 4: return few
    default: return many
  }
}

const visitsWord = (n: number) => plural(n, 'раз', 'раза', 'раз')
const nightsWord = (n: number) => plural(n, 'ночь', 'ночи', 'ночей')
const bookingsWord = (n: number) => plural(n, 'бронь', 'брони', 'броней')

interface Props {
  /** Копирование номера — берём готовое из справочника (там есть запасной путь для Electron). */
  onCopyPhone: (phone: string) => void
  /** Переход к брони в шахматке. Реализует ReferenceWindow: он же закрывает раздел. */
  onJump: (booking: GuestBooking) => void
}

export const GuestsTab: React.FC<Props> = ({ onCopyPhone, onJump }) => {
  const [book, setBook] = useState<GuestBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [chip, setChip] = useState<Chip>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  // Открытая карточка. Держим ключ, а не объект: после перезагрузки книги
  // объект был бы старым, а ключ найдёт свежую версию.
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [openUnnamed, setOpenUnnamed] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchGuests()
      .then(b => { if (!cancelled) { setBook(b); setLoading(false) } })
      .catch(() => { if (!cancelled) { setError('Не удалось загрузить гостей'); setLoading(false) } })
    return () => { cancelled = true }
  }, [])

  // Esc закрывает сначала карточку гостя. Слушатель в фазе ПЕРЕХВАТА: справочник
  // тоже слушает Esc на document (закрыть раздел), и без перехвата одно нажатие
  // закрывало бы и карточку, и весь раздел разом.
  useEffect(() => {
    if (!openKey && !openUnnamed) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpenKey(null)
      setOpenUnnamed(null)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [openKey, openUnnamed])

  const guests = book?.guests ?? []
  const unnamed = book?.unnamed ?? []

  // ─── Поиск ──────────────────────────────────────────────────────────────────
  // Ищем по всем вариантам написания имени и по цифрам номера: администратор
  // набирает «701 234» или «Асель», не зная, как гость записан в базе.
  const matchGuest = (g: Guest, q: string, qDigits: string) => {
    if (qDigits.length >= 2 && g.phoneKey.includes(qDigits)) return true
    if (!q) return false
    return g.nameVariants.some(n => n.toLowerCase().includes(q))
  }

  const filteredGuests = useMemo(() => {
    const q = query.trim().toLowerCase()
    const qDigits = onlyDigits(q)
    let out = guests
    if (q) out = out.filter(g => matchGuest(g, q, qDigits))
    if (chip === 'regular') out = out.filter(g => g.visits >= 2)
    if (chip === 'upcoming') out = out.filter(g => g.upcoming > 0)

    const sorted = [...out]
    if (sort === 'visits') {
      sorted.sort((a, b) => (b.visits - a.visits) || (b.nights - a.nights) || a.name.localeCompare(b.name, 'ru'))
    } else if (sort === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    }
    // 'recent' — порядок уже задан сервером (по дате последней брони).
    return sorted
  }, [guests, query, chip, sort])

  const filteredUnnamed = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return unnamed
    return unnamed.filter(u => u.name.toLowerCase().includes(q))
  }, [unnamed, query])

  const openGuest = openKey ? guests.find(g => g.phoneKey === openKey) ?? null : null
  const openGroup = openUnnamed ? unnamed.find(u => u.key === openUnnamed) ?? null : null

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-faint)' }}>Загрузка…</div>
  }
  if (error) {
    return <EmptyBox>{error}</EmptyBox>
  }

  const meta = book?.meta
  const showingUnnamed = chip === 'nophone'

  return (
    <>
      {/* Поиск и фильтры. Липкие: экран поисковый, и уезжающая наверх строка
          поиска при листании карточек — первое, обо что спотыкаешься. */}
      <div style={{
        ...contentWrap, marginBottom: 14,
        position: 'sticky', top: 0, zIndex: 2,
        background: 'var(--bg)', paddingTop: 4, marginTop: -4, paddingBottom: 8,
      }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: '1 1 320px', maxWidth: 560, minWidth: 240 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
              strokeWidth="2" strokeLinecap="round"
              style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" />
            </svg>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Поиск гостя: имя или номер телефона…"
              style={{ ...inputStyle, height: 44, paddingLeft: 40, fontSize: '0.95rem' }}
            />
            {query && (
              <button onClick={() => setQuery('')} title="Очистить" style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-faint)',
                fontSize: '1.1rem', lineHeight: 1,
              }}>×</button>
            )}
          </div>

          <select value={sort} onChange={e => setSort(e.target.value as SortKey)}
            style={{ ...inputStyle, height: 44, width: 'auto', minWidth: 190, cursor: 'pointer' }}>
            {SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 3, flexWrap: 'wrap',
          marginTop: 10, padding: 4, background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)', borderRadius: 10,
        }}>
          <Pill active={chip === 'all'} label="Все" count={guests.length} onClick={() => setChip('all')} />
          <Pill active={chip === 'regular'} label="Постоянные" dotColor="var(--s-in)"
            count={guests.filter(g => g.visits >= 2).length} onClick={() => setChip('regular')} />
          <Pill active={chip === 'upcoming'} label="Ожидаются" dotColor="var(--s-confirmed)"
            count={guests.filter(g => g.upcoming > 0).length} onClick={() => setChip('upcoming')} />
          {unnamed.length > 0 && (
            <Pill active={chip === 'nophone'} label="Без телефона" dotColor="var(--s-maint)"
              count={unnamed.length} onClick={() => setChip('nophone')} />
          )}
        </div>
      </div>

      {/* Список */}
      <div style={contentWrap}>
        {showingUnnamed ? (
          <>
            {/* Честная подпись: это НЕ карточки гостей. Без номера одинаковое имя
                ничего не доказывает, поэтому объединение здесь — только по точному
                совпадению строки имени, и мы прямо об этом пишем. */}
            <div style={{
              padding: '11px 14px', marginBottom: 12, borderRadius: 10,
              background: 'var(--surface)', border: '1px solid var(--border-subtle)',
              fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.5,
            }}>
              Телефон в брони — поле необязательное. Эти брони сгруппированы по{' '}
              <b>точному совпадению имени</b>, и это не карточка гостя: без номера нельзя
              утверждать, что за одинаковым именем один человек. Впишите телефон в бронь —
              и она сама переедет к гостям.
            </div>

            {filteredUnnamed.length === 0 ? (
              <EmptyBox>По запросу «{query}» ничего не найдено</EmptyBox>
            ) : (
              <>
                <div style={cardGrid}>
                  {filteredUnnamed.slice(0, RENDER_LIMIT).map(u => (
                    <UnnamedCard key={u.key} group={u} onOpen={() => setOpenUnnamed(u.key)} />
                  ))}
                </div>
                <MoreHint shown={Math.min(filteredUnnamed.length, RENDER_LIMIT)} total={filteredUnnamed.length} />
              </>
            )}
          </>
        ) : guests.length === 0 ? (
          <EmptyBox>
            Пока ни в одной брони нет телефона, поэтому книга гостей пуста.<br />
            Ключ гостя — номер, а не имя: по имени склеились бы разные люди.
            {unnamed.length > 0 && (
              <>
                <br /><br />
                <LinkBtn onClick={() => setChip('nophone')}>
                  Показать {unnamed.length} {plural(unnamed.length, 'запись', 'записи', 'записей')} без телефона
                </LinkBtn>
              </>
            )}
          </EmptyBox>
        ) : filteredGuests.length === 0 ? (
          <EmptyBox>
            {query ? <>По запросу «{query}» ничего не найдено</> : <>В этой выборке пока пусто</>}
          </EmptyBox>
        ) : (
          <>
            <div style={cardGrid}>
              {filteredGuests.slice(0, RENDER_LIMIT).map(g => (
                <GuestCard key={g.phoneKey} guest={g} onCopy={onCopyPhone} onOpen={() => setOpenKey(g.phoneKey)} />
              ))}
            </div>
            <MoreHint shown={Math.min(filteredGuests.length, RENDER_LIMIT)} total={filteredGuests.length} />
          </>
        )}

        {/* Сводка внизу: сколько броней вообще участвует в подсчёте */}
        {meta && (
          <div style={{ marginTop: 18, fontSize: '0.78rem', color: 'var(--text-faint)', lineHeight: 1.6 }}>
            Собрано из {meta.bookingsTotal} {bookingsWord(meta.bookingsTotal)}:
            {' '}{meta.bookingsWithPhone} с телефоном, {meta.bookingsWithoutPhone} без.
            {' '}Ремонтные блоки не считаются — это не гости.
          </div>
        )}
      </div>

      {/* Карточка гостя */}
      {openGuest && (
        <DetailModal
          title={openGuest.name}
          onClose={() => setOpenKey(null)}
          head={
            <>
              <button onClick={() => onCopyPhone(openGuest.phone)} title="Нажмите, чтобы скопировать"
                style={phoneChip}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  {ICON_COPY}
                </svg>
                {openGuest.phone}
              </button>

              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
                <Stat value={String(openGuest.visits)} label={`${visitsWord(openGuest.visits)} жил`} />
                <Stat value={String(openGuest.nights)} label={nightsWord(openGuest.nights)} />
                <Stat value={openGuest.lastVisit ? fmtDate(openGuest.lastVisit) : '—'} label="последний визит" />
                {openGuest.nextVisit && (
                  <Stat value={fmtDate(openGuest.nextVisit)} label="ближайший заезд" color="var(--s-confirmed)" />
                )}
                {openGuest.upcoming > 0 && (
                  <Stat value={String(openGuest.upcoming)}
                    label={`${bookingsWord(openGuest.upcoming)} впереди`} color="var(--s-confirmed)" />
                )}
                {openGuest.cancelled > 0 && (
                  <Stat value={String(openGuest.cancelled)} label="отменено" color="var(--s-overdue)" />
                )}
              </div>

              {/* Документ гостя — из самого свежего визита, где он заполнен.
                  Ради него карточка и заводилась: «звонит постоянный гость» —
                  паспорт уже есть, диктовать заново не надо. */}
              {openGuest.document && <DocumentBox doc={openGuest.document} />}

              {/* Доказательства склейки: администратор должен ВИДЕТЬ, что мы
                  объединили, а не верить нам на слово. */}
              {openGuest.nameVariants.length > 1 && (
                <Note>В бронях записан как: {openGuest.nameVariants.join(' · ')}</Note>
              )}
              {openGuest.phoneVariants.length > 1 && (
                <Note>Номер записан по-разному: {openGuest.phoneVariants.join(' · ')} — это один номер</Note>
              )}
            </>
          }
          bookings={openGuest.bookings}
          onJump={onJump}
        />
      )}

      {/* Группа без телефона */}
      {openGroup && (
        <DetailModal
          title={openGroup.name}
          onClose={() => setOpenUnnamed(null)}
          head={
            <>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                <Stat value={String(openGroup.bookings.length)} label={bookingsWord(openGroup.bookings.length)} />
                <Stat value={String(openGroup.nights)} label={nightsWord(openGroup.nights)} />
              </div>
              <Note>
                Телефона нет{openGroup.phoneRaw ? ` (в брони записано «${openGroup.phoneRaw}» — не похоже на номер)` : ''}.
                Совпало только имя, поэтому это могут быть разные люди.
              </Note>
            </>
          }
          bookings={openGroup.bookings}
          onJump={onJump}
        />
      )}
    </>
  )
}

// ─── Карточки ─────────────────────────────────────────────────────────────────

const phoneChip: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
  borderRadius: 7, padding: '4px 9px', fontSize: '0.86rem', fontWeight: 600,
  color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
}

const cardBase: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 9, padding: '13px 14px',
  background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border-subtle)',
  textAlign: 'left', fontFamily: 'inherit', cursor: 'pointer', width: '100%',
  transition: 'border-color 0.12s, box-shadow 0.12s',
}

const Avatar: React.FC<{ letter: string; color: string }> = ({ letter, color }) => (
  <div style={{
    width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: `color-mix(in srgb, ${color} 16%, transparent)`,
    color, fontSize: '0.9rem', fontWeight: 700,
  }}>{letter}</div>
)

const GuestCard: React.FC<{
  guest: Guest
  onCopy: (p: string) => void
  onOpen: () => void
}> = ({ guest: g, onCopy, onOpen }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    style={cardBase}
    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <Avatar letter={g.name.trim().charAt(0).toUpperCase() || '?'} color="var(--accent)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{g.name}</div>
        <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)', marginTop: 1 }}>
          {g.visits} {visitsWord(g.visits)} · {g.nights} {nightsWord(g.nights)}
        </div>
      </div>
      {g.upcoming > 0 && (
        <span style={{
          flexShrink: 0, fontSize: '0.72rem', fontWeight: 700, padding: '3px 7px', borderRadius: 6,
          background: 'color-mix(in srgb, var(--s-confirmed) 16%, transparent)', color: 'var(--s-confirmed)',
        }}>ждём</span>
      )}
    </div>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      <button
        onClick={e => { e.stopPropagation(); onCopy(g.phone) }}
        title="Нажмите, чтобы скопировать"
        style={phoneChip}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'var(--accent-bg)'
          e.currentTarget.style.borderColor = 'var(--accent)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'var(--surface-2)'
          e.currentTarget.style.borderColor = 'var(--border-subtle)'
        }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          {ICON_COPY}
        </svg>
        {g.phone}
      </button>
    </div>

    {/* Ближайший заезд важнее прошлого: «бронировал на июль» — это про будущее.
        Прошлый визит показываем, когда впереди ничего нет. */}
    <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)' }}>
      {g.nextVisit
        ? <>Заезд: <span style={{ color: 'var(--s-confirmed)', fontWeight: 600 }}>{fmtDate(g.nextVisit)}</span></>
        : g.lastVisit
          ? <>Последний визит: {fmtDate(g.lastVisit)}</>
          : <>Ещё не заезжал</>}
    </div>
  </div>
)

const UnnamedCard: React.FC<{ group: UnnamedGuestGroup; onOpen: () => void }> = ({ group: u, onOpen }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    style={cardBase}
    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)' }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-subtle)' }}
  >
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <Avatar letter={u.name.trim().charAt(0).toUpperCase() || '?'} color="var(--s-maint)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{u.name}</div>
        <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)', marginTop: 1 }}>
          {u.bookings.length} {bookingsWord(u.bookings.length)} · {u.nights} {nightsWord(u.nights)}
        </div>
      </div>
    </div>
    <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)' }}>
      {u.bookings.length > 1 ? 'Совпало только имя' : 'Телефона нет'}
      {u.bookings[0] && <> · {fmtDate(u.bookings[0].checkIn)}</>}
    </div>
  </div>
)

// ─── Окно карточки ────────────────────────────────────────────────────────────

const DetailModal: React.FC<{
  title: string
  head: React.ReactNode
  bookings: GuestBooking[]
  onClose: () => void
  onJump: (b: GuestBooking) => void
}> = ({ title, head, bookings, onClose, onJump }) => (
  <div
    onClick={e => { if (e.target === e.currentTarget) onClose() }}
    style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 600,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}
  >
    <div style={{
      background: 'var(--bg)', borderRadius: 14, width: '100%', maxWidth: 640,
      maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column',
      boxShadow: 'var(--shadow-lg)', border: '1px solid var(--border)', overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px',
        borderBottom: '1px solid var(--border-subtle)', flexShrink: 0,
      }}>
        <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ flex: 1 }} />
        <button onClick={onClose} title="Закрыть (Esc)" style={{
          background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.4rem',
          color: 'var(--text-faint)', padding: '0 2px', lineHeight: 1, fontWeight: 300,
        }}>×</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {head}

        <div style={{
          fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-muted)',
          margin: '18px 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em',
        }}>
          Брони — {bookings.length}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bookings.map(b => <BookingRow key={b.id} booking={b} onJump={onJump} />)}
        </div>
      </div>
    </div>
  </div>
)

const BookingRow: React.FC<{ booking: GuestBooking; onJump: (b: GuestBooking) => void }> = ({ booking: b, onJump }) => {
  // Отменённых броней в шахматке нет вообще (occupancyController их отсекает),
  // поэтому переход по ним никуда не приведёт — не делаем его кликабельным.
  const jumpable = b.status !== 'CANCELLED'
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
      background: 'var(--surface)', borderRadius: 9, border: '1px solid var(--border-subtle)',
      flexWrap: 'wrap',
    }}>
      <span style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: STATUS_COLORS[b.status] ?? 'var(--s-maint)',
      }} />
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <div style={{ fontSize: '0.86rem', fontWeight: 600, color: 'var(--text)' }}>
          {fmtDate(b.checkIn)} — {fmtDate(b.checkOut)}
        </div>
        <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: 1 }}>
          Номер {b.roomNumber} · {b.nights} {nightsWord(b.nights)} · {STATUS_LABELS[b.status] ?? b.status}
        </div>
      </div>
      {jumpable ? (
        <button onClick={() => onJump(b)} style={{ ...secondaryBtn, height: 30, padding: '0 12px', fontSize: '0.8rem' }}>
          В шахматку
        </button>
      ) : (
        <span style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>нет в шахматке</span>
      )}
    </div>
  )
}

// ─── Мелочи ───────────────────────────────────────────────────────────────────

const Stat: React.FC<{ value: string; label: string; color?: string }> = ({ value, label, color }) => (
  <div>
    <div style={{ fontSize: '1.05rem', fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
    <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: 1 }}>{label}</div>
  </div>
)

/** Показывается, только когда список упёрся в RENDER_LIMIT — иначе молчит. */
const MoreHint: React.FC<{ shown: number; total: number }> = ({ shown, total }) => (
  total > shown
    ? <div style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--text-faint)' }}>
        Показаны первые {shown} из {total} — уточните поиск.
      </div>
    : null
)

/**
 * Документ гостя в его карточке. Показываем гражданство, тип и номер — то, что
 * стойка переписывает в тетрадь и о чём спрашивают чаще всего.
 *
 * Подпись «из брони …» не украшение: документ взят из ОДНОГО конкретного визита
 * (самого свежего с заполненным паспортом), и администратор должен видеть, из
 * какого именно — паспорт меняют, и старый номер здесь может быть просто старым.
 */
const DocumentBox: React.FC<{ doc: GuestDocument }> = ({ doc }) => {
  const typeLabel = doc.guestDocType
    ? DOC_TYPE_LABELS[doc.guestDocType] ?? doc.guestDocType
    : 'Документ'
  const number = (doc.guestDocNumber ?? '').trim()
  return (
    <div style={{
      marginTop: 12, padding: '10px 12px', borderRadius: 8,
      background: 'var(--surface)', border: '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text)' }}>
          {typeLabel}{number ? ` ${number}` : ''}
        </span>
        {doc.guestCitizenship && (
          <span style={{
            fontSize: '0.78rem', fontWeight: 600, padding: '2px 8px', borderRadius: 6,
            background: 'var(--surface-2)', color: 'var(--text-muted)',
          }}>{doc.guestCitizenship}</span>
        )}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-faint)', marginTop: 5 }}>
        Из брони{doc.from.roomNumber ? ` №${doc.from.roomNumber}` : ''} от {fmtDate(doc.from.checkIn)}
      </div>
    </div>
  )
}

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{
    marginTop: 12, padding: '8px 11px', borderRadius: 8,
    background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
    fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5,
  }}>{children}</div>
)

const LinkBtn: React.FC<{ onClick: () => void; children: React.ReactNode }> = ({ onClick, children }) => (
  <button onClick={onClick} style={{
    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
    color: 'var(--accent)', fontFamily: 'inherit', fontSize: 'inherit',
    fontWeight: 600, textDecoration: 'underline',
  }}>{children}</button>
)

const Pill: React.FC<{
  active: boolean
  label: string
  count: number
  dotColor?: string
  onClick: () => void
}> = ({ active, label, count, dotColor, onClick }) => (
  <button
    onClick={onClick}
    style={{
      display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 12px',
      borderRadius: 7, fontFamily: 'inherit', fontSize: '0.86rem',
      cursor: 'pointer', whiteSpace: 'nowrap', border: 'none',
      background: active ? 'var(--bg)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-muted)',
      fontWeight: active ? 600 : 500,
      boxShadow: active ? 'var(--shadow-sm)' : 'none',
      opacity: count === 0 && !active ? 0.45 : 1,
      transition: 'background 0.12s, opacity 0.12s',
    }}
  >
    {dotColor && <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />}
    {label}
    <span style={{ color: 'var(--text-faint)', fontWeight: 500, fontSize: '0.8rem' }}>{count}</span>
  </button>
)
