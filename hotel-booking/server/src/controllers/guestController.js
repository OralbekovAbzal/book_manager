const { prisma } = require('../utils/prisma')
const { getCurrentBusinessDate } = require('../utils/businessDate')

/**
 * Адресная книга постояльцев, собранная из существующих броней.
 *
 * Новых таблиц нет и не нужно: гость — это не запись в БД, а СВЁРТКА броней
 * по одному телефону. Заводить руками ничего не надо, книга копится сама.
 * Решает боль стойки: «звонит гость, бронировал на июль» — сейчас его можно
 * найти только листая шахматку.
 */

// ─── Нормализация телефона ────────────────────────────────────────────────────

/**
 * Ключ группировки. Самое опасное место всей задачи: правило пожёстче склеит
 * РАЗНЫХ людей в одну карточку (и стойка даст скидку не тому), правило помягче
 * размножит одного гостя на пять карточек (и книга станет бесполезной).
 *
 * Поэтому здесь только ДОКАЗУЕМЫЕ преобразования плана нумерации, без догадок:
 *
 *   1. выбрасываем всё, кроме цифр — скобки, пробелы, дефисы и «+» не несут
 *      информации: «+7 (701) 234-56-78» и «+77012345678» это одна строка цифр;
 *   2. ведущий международный префикс «00» — это тот же «+», убираем его;
 *   3. 11 цифр, первая «8» → меняем на «7». «8» — междугородний префикс ВНУТРИ
 *      страны, «+7» — код страны, и это тождество, а не предположение:
 *      8-701-234-56-78 и +7-701-234-56-78 физически один и тот же абонент;
 *   4. 11 цифр, первая «7» → уже канонический вид, не трогаем;
 *   5. 10 цифр, первая «7» → местная запись без префикса, дописываем «7».
 *      Ограничение «первая цифра 7» здесь существенное: ВСЕ казахстанские
 *      номера после кода страны начинаются на 7 (мобильные 70x/74x/77x,
 *      городские 7xxx). Десятизначный номер с другой первой цифрой —
 *      иностранный или битый, и дописать ему «+7» значило бы ВЫДУМАТЬ
 *      казахстанский номер, которого не существует;
 *   6. всё остальное (иностранные, служебные, мусор) остаётся как есть —
 *      равными считаются только полностью одинаковые строки цифр.
 *
 * Чего правило НАМЕРЕННО не делает: не берёт «последние 10 цифр» и вообще
 * не подрезает длину. Это самый частый способ склеить разных людей —
 * у номеров разных стран хвосты совпадают, а +7 701 234 56 78 и
 * +996 701 234 56 78 это два разных человека.
 *
 * @returns {string|null} строка цифр-ключ либо null, если номер не опознан
 */
const MIN_KEY_DIGITS = 10

function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (!d) return null

  if (d.length >= 12 && d.startsWith('00')) d = d.slice(2)

  if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1)
  else if (d.length === 10 && d[0] === '7') d = '7' + d

  // Короче десяти цифр — это не номер, а обрывок («701», «12»). Такую бронь
  // честнее отправить в «не опознано», чем сделать из обрывка личность гостя:
  // «103» у двух разных броней ничего не доказывает.
  if (d.length < MIN_KEY_DIGITS) return null
  return d
}

/** Показ канонического казахстанского номера. Чужие форматы не выдумываем. */
function formatPhone(key, fallbackRaw) {
  if (key.length === 11 && key[0] === '7') {
    return `+7 ${key.slice(1, 4)} ${key.slice(4, 7)} ${key.slice(7, 9)} ${key.slice(9, 11)}`
  }
  return fallbackRaw || key
}

// ─── Вспомогательное ──────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000

/** `@db.Date` хранится UTC-полночью — режем ISO, чтобы не поймать сдвиг на день. */
const isoDate = (d) => new Date(d).toISOString().slice(0, 10)

const nightsBetween = (checkIn, checkOut) =>
  Math.max(0, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / DAY))

/** Имя без регистра и лишних пробелов — для сравнения вариантов написания. */
const nameKey = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

/** Отменённые и неявки не считаем проживанием, но из списка броней не прячем. */
const isRealStay = (status) => status !== 'CANCELLED' && status !== 'NO_SHOW'

function bookingRow(b) {
  return {
    id: b.id,
    guestName: b.guestName,
    roomId: b.roomId,
    roomNumber: b.room?.number ?? '—',
    checkIn: isoDate(b.checkIn),
    checkOut: isoDate(b.checkOut),
    nights: nightsBetween(b.checkIn, b.checkOut),
    status: b.status,
    source: b.source,
    totalAmount: b.totalAmount,
  }
}

// ─── GET /api/guests ──────────────────────────────────────────────────────────

/**
 * Отдаём книгу целиком, а не постранично: поиск идёт локально на клиенте и
 * должен срабатывать мгновенно — стойка ищет гостя, пока держит трубку.
 * Это десктоп в локальной сети с историей одного отеля: даже несколько тысяч
 * броней сворачиваются в компактный ответ (карточка, а не сырые строки).
 */
async function list(_req, res, next) {
  try {
    const [rows, businessDate] = await Promise.all([
      prisma.booking.findMany({
        select: {
          id: true, guestName: true, guestPhone: true,
          checkIn: true, checkOut: true, status: true, source: true,
          totalAmount: true, roomId: true,
          room: { select: { number: true } },
        },
        orderBy: { checkIn: 'desc' },
      }),
      getCurrentBusinessDate(),
    ])

    const today = businessDate.getTime()

    // Ремонт — это блок номера, а не гость: в адресной книге ему делать нечего.
    // Каноническая метка — source === 'ремонт' (так проверяет bookingController
    // и отчёты). Имя тоже сверяем: форма брони подставляет ровно 'Ремонт'
    // (BookingModal.tsx), и у старых блоков source остался 'стойка'.
    const bookings = rows.filter(b =>
      b.source !== 'ремонт' && String(b.guestName ?? '').trim().toLowerCase() !== 'ремонт')

    const byPhone = new Map()
    const unidentified = []

    for (const b of bookings) {
      const key = normalizePhone(b.guestPhone)
      if (!key) { unidentified.push(b); continue }

      let g = byPhone.get(key)
      if (!g) {
        g = { phoneKey: key, rawPhones: [], names: [], bookings: [] }
        byPhone.set(key, g)
      }
      const raw = String(b.guestPhone ?? '').trim()
      if (raw && !g.rawPhones.includes(raw)) g.rawPhones.push(raw)
      g.names.push(b.guestName)
      g.bookings.push(b)
    }

    const guests = [...byPhone.values()].map(g => {
      // Имя карточки — самый ПОЛНЫЙ вариант написания: «Асель Каримова»
      // информативнее, чем «Асель К.» или «Асель». Варианты отдаём рядом,
      // чтобы администратор своими глазами видел, кого именно склеили,
      // и мог заметить ошибочное объединение, а не поверить нам на слово.
      const variants = []
      for (const n of g.names) {
        const t = String(n ?? '').trim()
        if (t && !variants.some(v => nameKey(v) === nameKey(t))) variants.push(t)
      }
      const name = [...variants].sort((a, b) => b.length - a.length)[0] ?? '—'

      const stays = g.bookings.filter(b => isRealStay(b.status))
      const past = stays.filter(b => new Date(b.checkIn).getTime() <= today)
      const upcoming = stays.filter(b => new Date(b.checkIn).getTime() > today)

      const lastVisit = past.length
        ? isoDate(past.reduce((a, b) => (new Date(a.checkIn) > new Date(b.checkIn) ? a : b)).checkIn)
        : null
      const firstVisit = stays.length
        ? isoDate(stays.reduce((a, b) => (new Date(a.checkIn) < new Date(b.checkIn) ? a : b)).checkIn)
        : null
      // Ближайший заезд впереди. Ради него книгу и открывают: «звонит гость,
      // бронировал на июль» — нужна дата, а не «ещё не заезжал».
      const nextVisit = upcoming.length
        ? isoDate(upcoming.reduce((a, b) => (new Date(a.checkIn) < new Date(b.checkIn) ? a : b)).checkIn)
        : null

      return {
        phoneKey: g.phoneKey,
        phone: formatPhone(g.phoneKey, g.rawPhones[g.rawPhones.length - 1]),
        // Разные написания одного номера. Показываем только когда их больше
        // одного — это и есть доказательство, что склейка была оправдана.
        phoneVariants: g.rawPhones,
        name,
        nameVariants: variants,
        visits: stays.length,
        nights: stays.reduce((sum, b) => sum + nightsBetween(b.checkIn, b.checkOut), 0),
        cancelled: g.bookings.length - stays.length,
        upcoming: upcoming.length,
        firstVisit,
        lastVisit,
        nextVisit,
        bookings: g.bookings
          .map(bookingRow)
          .sort((a, b) => (a.checkIn < b.checkIn ? 1 : -1)),
      }
    })

    // Сортировка по умолчанию — по последней активности: кто был недавно,
    // тот вероятнее и звонит. Постоянные гости всплывают через фильтр на клиенте.
    guests.sort((a, b) => {
      const ax = a.bookings[0]?.checkIn ?? ''
      const bx = b.bookings[0]?.checkIn ?? ''
      if (ax !== bx) return ax < bx ? 1 : -1
      return a.name.localeCompare(b.name, 'ru')
    })

    // ─── Брони без опознанного телефона ───────────────────────────────────────
    // Их НЕЛЬЗЯ свернуть в карточку гостя: без номера одинаковое имя ничего
    // не доказывает (два «Ахметов А.» — обычное дело). Поэтому здесь не «гости»,
    // а группы по ТОЧНОМУ совпадению имени, и подписаны они именно так.
    // Не показывать их вовсе тоже нельзя: телефон — поле необязательное, и в
    // реальной базе им заполнена меньшая часть броней; спрятав их, мы бы сделали
    // вкладку пустой на живых данных и потеряли главный сценарий поиска.
    const nameGroups = new Map()
    for (const b of unidentified) {
      const k = nameKey(b.guestName) || '—'
      let grp = nameGroups.get(k)
      if (!grp) {
        grp = { key: k, name: String(b.guestName ?? '').trim() || '—', bookings: [], phoneRaw: null }
        nameGroups.set(k, grp)
      }
      grp.bookings.push(b)
      // Номер был, но не распознан (обрывок) — покажем его, чтобы можно было починить.
      const raw = String(b.guestPhone ?? '').trim()
      if (raw && !grp.phoneRaw) grp.phoneRaw = raw
    }

    const unnamed = [...nameGroups.values()].map(g => {
      const stays = g.bookings.filter(b => isRealStay(b.status))
      return {
        key: g.key,
        name: g.name,
        phoneRaw: g.phoneRaw,
        visits: stays.length,
        nights: stays.reduce((sum, b) => sum + nightsBetween(b.checkIn, b.checkOut), 0),
        cancelled: g.bookings.length - stays.length,
        bookings: g.bookings
          .map(bookingRow)
          .sort((a, b) => (a.checkIn < b.checkIn ? 1 : -1)),
      }
    })

    unnamed.sort((a, b) => {
      const ax = a.bookings[0]?.checkIn ?? ''
      const bx = b.bookings[0]?.checkIn ?? ''
      if (ax !== bx) return ax < bx ? 1 : -1
      return a.name.localeCompare(b.name, 'ru')
    })

    res.json({
      data: {
        guests,
        unnamed,
        meta: {
          bookingsTotal: bookings.length,
          bookingsWithPhone: bookings.length - unidentified.length,
          bookingsWithoutPhone: unidentified.length,
        },
      },
    })
  } catch (err) {
    next(err)
  }
}

module.exports = { list, normalizePhone, formatPhone }
