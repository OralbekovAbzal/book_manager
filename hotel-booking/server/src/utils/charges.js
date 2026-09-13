const { prisma } = require('./prisma')

/**
 * Генератор строк начислений (`BookingCharge`).
 *
 * Смысл модели (NOTES, «Ценообразование: бронь — это СУММА СТРОК»): тариф не считает
 * итог, он ПОРОЖДАЕТ строки. Итог брони = сумма строк, `Booking.totalAmount` — лишь её
 * кэш. Администратор может строку поправить, удалить или добавить свою
 * (`source='manual'` + обязательная `reason`), и тогда уступка «заехал в час ночи,
 * беру полсуток» остаётся внутри системы, а не в уме у администратора.
 *
 * Поэтому пересборка трогает ТОЛЬКО строки с `source='auto'`: ручные правки
 * переживают смену дат, тарифа и любой пересчёт.
 *
 * Те же правила продублированы в `client/src/utils/calculator.ts` (предпросмотр
 * в форме брони). Правишь здесь — правь и там.
 */

const DAY = 86400000

/** 'YYYY-MM-DD' | Date → UTC-полночь. Даты @db.Date хранятся именно так (см. NOTES). */
function toUTCDate(v) {
  const d = new Date(v)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function dateKey(v) {
  return toUTCDate(v).toISOString().slice(0, 10)
}

/** Ночи брони — полуоткрытый интервал [checkIn, checkOut). */
function nightsOf(checkIn, checkOut) {
  const from = toUTCDate(checkIn).getTime()
  const to = toUTCDate(checkOut).getTime()
  const out = []
  for (let t = from; t < to; t += DAY) out.push(new Date(t))
  return out
}

/**
 * Гости брони по типам. Деление «с питанием / без питания» здесь СКЛАДЫВАЕТСЯ:
 * на проживание оно давно не влияет (цена одинакова), а кому начислять питание —
 * теперь сказано строками BookingService, а не колонкой счётчика.
 *
 * Читать обе колонки обязательно: форма пишет всех в `*WithMeals`, но в 107 старых
 * бронях люди лежат в обеих, и сумма — единственный способ не потерять половину гостей.
 */
function guestCounts(b) {
  return {
    adults: (b.adultsWithMeals || 0) + (b.adultsNoMeals || 0),
    children: (b.childrenWithMeals || 0) + (b.childrenNoMeals || 0),
    extraBeds: (b.extraBedsWithMeals || 0) + (b.extraBedsNoMeals || 0),
  }
}

function guestLabel({ adults, children, extraBeds }) {
  const parts = []
  if (adults) parts.push(`${adults} взр.`)
  if (children) parts.push(`${children} дет.`)
  if (extraBeds) parts.push(`${extraBeds} доп.`)
  return parts.join(' + ')
}

/**
 * Подпись строки проживания.
 *
 * У ЦЕПОЧКИ (переезд) в подпись входят номер и категория — «Проживание · №12
 * Стандарт · 2 взр.»: в одном счёте оказываются ночи двух комнат по разной цене,
 * и без этого счёт выглядит как ошибка в тарифе. У одиночной брони подпись
 * прежняя, из волны 5a: номер там ровно один и повторять его в каждой ночи незачем.
 */
function stayLabel({ pricingBase, counts, roomNumber = null, categoryName = null, qualified = false }) {
  const where = qualified ? `№${roomNumber ?? '?'}${categoryName ? ` ${categoryName}` : ''}` : null
  const who = pricingBase === 'room'
    ? (where ? null : 'номер')
    : (guestLabel(counts) || 'без гостей')
  return ['Проживание', where, who].filter(Boolean).join(' · ')
}

/**
 * Цена одной ночи проживания.
 *
 * `parts` — какие именно составляющие цены не заданы ('room' | 'adult' | 'child' |
 * 'extraBed'). Раньше флаг `missing` отбрасывался вызывающим кодом, и ночь с ценой
 * только для взрослых начислялась молча без ребёнка (аудит D2-003). Строку по-прежнему
 * создаём на частичную сумму — иначе гость не получил бы счёт вовсе, — но факт
 * «цена не задана» теперь можно показать: он доезжает до предпросмотра.
 *
 * @returns {{ amount: number, missing: boolean, parts: string[] }}
 */
function priceNight(rate, pricingBase, counts) {
  let amount = 0
  const parts = []
  const take = (part, value, qty) => {
    if (qty <= 0) return
    if (!rate || value === null || value === undefined) { parts.push(part); return }
    amount += value * qty
  }

  if (pricingBase === 'room') {
    // Цена за номер нужна всегда, сколько бы гостей ни было
    if (!rate || rate.roomPrice === null || rate.roomPrice === undefined) parts.push('room')
    else amount += rate.roomPrice
    take('extraBed', rate?.extraBedPrice, counts.extraBeds)
  } else {
    take('adult', rate?.adultPrice, counts.adults)
    take('child', rate?.childPrice, counts.children)
    take('extraBed', rate?.extraBedPrice, counts.extraBeds)
  }

  return { amount, missing: parts.length > 0, parts }
}

/** Название услуги для сравнения с ручными строками — регистр и пробелы не считаем. */
function normLabel(s) {
  return String(s || '').trim().toLowerCase()
}

/**
 * Похоже ли название на авто-строку процентной скидки («Скидка 10%», «Скидка 12,5 %»).
 *
 * Нужно, чтобы отличить ПРАВЛЕННУЮ авто-скидку от ручной скидки со своим смыслом
 * («Скидка по инвалидности», «Скидка постоянному гостю»): первая заменяет процентную,
 * вторая складывается с ней. Признака «эта строка — процентная» в схеме нет, а
 * `updateCharge` при переводе авто-строки в `manual` сохраняет её название — значит
 * название и есть единственный доступный след происхождения.
 *
 * Процент в шаблоне не фиксируем: администратор мог поправить скидку при 10 %, а потом
 * сменить процент на 15 — вторую строку всё равно начислять нельзя.
 */
const PERCENT_DISCOUNT_LABEL = /^скидка\s*\d+(?:[.,]\d+)?\s*%$/
function isPercentDiscountLabel(label) {
  return PERCENT_DISCOUNT_LABEL.test(normLabel(label))
}

/**
 * Собирает строки начислений по брони. Чистая функция — всё нужное передаётся снаружи,
 * чтобы её можно было прогнать без базы.
 *
 * Проживание — ПОСУТОЧНО (одна строка на ночь): именно так уступка «полсуток за
 * поздний заезд» правится в одной конкретной ночи, и так же строится отчёт по дням.
 * Услуги — одной строкой на услугу: «убрать обед» должно быть одним действием,
 * а не удалением семи строк.
 *
 * `manualCharges` — уже существующие ручные строки. Они здесь не для того, чтобы их
 * пересоздать, а чтобы НЕ создать дубль: если администратор поправил ночь «полсуток»,
 * автоматическая строка на ту же дату не нужна — иначе ночь начислится дважды.
 */
function buildAutoChargesDetailed({ booking, pricingBase, ratesByDate, bookingServices, manualCharges = [], segments = null }) {
  const missingPrices = []

  // Отрезки цепочки (переезд = один счёт, `docs/decisions/data-and-money.md`).
  // Одиночная бронь — ОДИН отрезок из тех же аргументов, что и раньше: поведение
  // и подписи строк у неё не меняются вовсе, иначе волна 5a переписалась бы задним
  // числом. Номер и категория попадают в подпись только у цепочки — там без них
  // не понять, за какую комнату ночь.
  const segs = (Array.isArray(segments) && segments.length > 0)
    ? segments
    : [{ booking, ratesByDate, roomNumber: null, categoryName: null }]
  const multi = segs.length > 1

  const nightsBySeg = segs.map((s) => nightsOf(s.booking.checkIn, s.booking.checkOut))
  const nightCount = nightsBySeg.reduce((sum, n) => sum + n.length, 0)
  if (nightCount === 0) return { rows: [], missingPrices, nights: 0 }

  // Скидка %, предоплата и услуги — у ПОСЛЕДНЕГО отрезка: он и есть «текущее
  // состояние брони», в его форме стойка их правит (решение 2026-09-08).
  const inputs = segs[segs.length - 1].booking

  // Проживание сопоставляем по дате (на дату ровно одна строка), услуги — по названию.
  const manualStayDates = new Set(
    manualCharges.filter(c => c.kind === 'stay' && c.date).map(c => dateKey(c.date)),
  )
  const manualLabels = new Set(
    manualCharges.filter(c => c.kind !== 'stay').map(c => normLabel(c.label)),
  )

  const rows = []

  // ── Проживание ──
  // Ночи каждого отрезка — по календарю ЕГО категории и с ЕГО счётчиками гостей:
  // после переезда в другую категорию цена меняется с даты переезда, а не задним числом.
  segs.forEach((seg, i) => {
    const counts = guestCounts(seg.booking)
    const rates = seg.ratesByDate || {}
    const label = stayLabel({
      pricingBase, counts, roomNumber: seg.roomNumber, categoryName: seg.categoryName, qualified: multi,
    })

    for (const night of nightsBySeg[i]) {
      const key = dateKey(night)
      if (manualStayDates.has(key)) continue  // ночь уже посчитана вручную
      const { amount, parts } = priceNight(rates[key], pricingBase, counts)
      if (parts.length > 0) missingPrices.push({ date: key, parts })
      const value = Math.round(amount)
      if (value === 0) continue  // нет цены на эту ночь — строку не выдумываем, ноль это не цена
      rows.push({
        kind: 'stay',
        label,
        quantity: 1,
        unitPrice: value,
        amount: value,
        date: night,
      })
    }
  })

  // ── Питание и услуги ──
  // Источник — подключённые к брони строки BookingService, а не флаг
  // `Service.includedByDefault`: флагом нельзя выразить «завтрак на двоих из троих»,
  // а именно так живой отель и продаёт. Флаг остался осмысленным — он решает,
  // что форма подставит в НОВУЮ бронь.
  //
  // Названия держим короткими и стабильными («Завтрак», «Завтрак (дети)»): количество
  // видно в самой строке (кол-во × цена), а стабильное название позволяет узнать
  // услугу после пересборки и не задвоить её ручную правку.
  // Питание и услуги считаются на ВСЕ ночи цепочки набором последнего отрезка:
  // при переезде `BookingService` переносятся на продолжение, а гость завтракал
  // все ночи подряд — делить завтраки по комнатам значит выдумывать деньги.
  for (const link of bookingServices || []) {
    const s = link.service
    if (!s || !s.isActive) continue
    const isMeal = s.kind === 'meal'
    const adults = Math.max(0, link.adults || 0)
    const children = Math.max(0, link.children || 0)
    const times = link.quantity == null ? 1 : Math.max(0, link.quantity)
    // childPrice = null означает «считать по взрослой цене»
    const splitChildren = s.childPrice !== null && s.childPrice !== undefined && children > 0
    const adultHeads = splitChildren ? adults : adults + children

    const push = (text, quantity, unitPrice) => {
      if (quantity <= 0 || !unitPrice || unitPrice <= 0) return
      if (manualLabels.has(normLabel(text))) return  // эту строку администратор уже ведёт сам
      rows.push({
        kind: isMeal ? 'meal' : 'extra',
        label: text,
        quantity,
        unitPrice,
        amount: Math.round(quantity * unitPrice),
        date: null,
      })
    }

    const childLabel = `${s.name} (дети)`
    switch (s.unit) {
      case 'per_person_night':
        push(s.name, adultHeads * nightCount, s.price)
        if (splitChildren) push(childLabel, children * nightCount, s.childPrice)
        break
      case 'per_night':
        push(s.name, times * nightCount, s.price)
        break
      case 'per_person':
        push(s.name, adultHeads, s.price)
        if (splitChildren) push(childLabel, children, s.childPrice)
        break
      case 'per_booking':
      default:
        push(s.name, times, s.price)
        break
    }
  }

  // ── Скидка процентом ──
  // Считаем от всего счёта, включая ручные строки: «скидка 10%» — это 10% с того,
  // что гость реально должен, а не с той части, которую посчитал тариф.
  //
  // Ручная строка процентной скидки ПОДАВЛЯЕТ авто-строку — так же, как ручная ночь
  // подавляет авто-проживание (по дате), а ручная услуга — авто-услугу (по названию).
  // Без этой сверки правленная администратором «Скидка 10%» (уступка 8 000 вместо
  // расчётных 11 100) при любой пересборке получала соседку на 11 100, и гость
  // получал скидку дважды.
  const pct = inputs.discountPercent || 0
  const manualPercentDiscount = manualCharges.some(
    c => c.kind === 'discount' && isPercentDiscountLabel(c.label),
  )
  if (pct > 0 && !manualPercentDiscount) {
    const manualBase = manualCharges
      .filter(c => c.kind !== 'discount')
      .reduce((sum, c) => sum + (c.amount || 0), 0)
    const subtotal = rows.reduce((sum, r) => sum + r.amount, 0) + manualBase
    const value = Math.round(subtotal * pct / 100)
    if (value > 0) {
      rows.push({
        kind: 'discount',
        label: `Скидка ${pct}%`,
        quantity: 1,
        unitPrice: -value,
        amount: -value,
        date: null,
      })
    }
  }

  return { rows, missingPrices, nights: nightCount }
}

/**
 * Строки начислений без подробностей — форма, которую ждут все существующие вызовы.
 * Предпросмотр (`POST /bookings/preview`) зовёт `buildAutoChargesDetailed`, чтобы
 * получить ещё и список ночей с незаданной ценой.
 */
function buildAutoCharges(args) {
  return buildAutoChargesDetailed(args).rows
}

/**
 * Календарь цен категории на период и база расчёта объекта.
 * Вынесено из `loadChargeContext`, потому что предпросмотр (`POST /bookings/preview`)
 * считает по тем же ценам, но услуги берёт из тела запроса, а не из базы —
 * брони может ещё не существовать.
 */
async function loadRateContext({ categoryId, checkIn, checkOut }, client = prisma) {
  const [hotel, rates] = await Promise.all([
    client.hotelSettings.findUnique({ where: { id: 1 } }),
    categoryId
      ? client.ratePrice.findMany({
        where: {
          categoryId,
          date: { gte: toUTCDate(checkIn), lt: toUTCDate(checkOut) },
        },
      })
      : Promise.resolve([]),
  ])

  const ratesByDate = {}
  for (const r of rates) ratesByDate[dateKey(r.date)] = r

  return { pricingBase: hotel?.pricingBase || 'person', ratesByDate }
}

/** Тариф, подключённые к брони услуги и настройки объекта, нужные для генерации. */
async function loadChargeContext(booking, client = prisma) {
  const [rateCtx, bookingServices] = await Promise.all([
    loadRateContext({
      categoryId: booking.room?.categoryId || null,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
    }, client),
    // Именно услуги ЭТОЙ брони: сколько человек ест завтрак, знает только она.
    client.bookingService.findMany({
      where: { bookingId: booking.id },
      include: { service: true },
      orderBy: { id: 'asc' },
    }),
  ])

  return { ...rateCtx, bookingServices }
}

function sumCharges(charges) {
  return Math.round(charges.reduce((sum, c) => sum + (c.amount || 0), 0))
}

/**
 * Пересчитывает `Booking.totalAmount` как сумму строк (и предоплату — от процента).
 *
 * `keepIfEmpty`: если строк нет вообще (тариф на эти даты не заполнен), сумму брони
 * не обнуляем — иначе создание брони в отеле без прайса молча стирало бы деньги,
 * посчитанные вручную. При явных операциях со строками режим строгий.
 *
 * Предоплата пересчитывается ВСЕГДА, в том числе у брони без строк: `prepaidAmount` —
 * это процент от итога, и он обязан сходиться с самим процентом. Раньше функция при
 * пустом наборе выходила до записи, и у 107 старых броней (см. NOTES) смена процента
 * предоплаты не меняла сумму предоплаты вовсе — форма и печать показывали 50 %
 * и сумму от прежних 30 %.
 */
async function recalcBookingTotals(bookingId, { client = prisma, keepIfEmpty = false } = {}) {
  const charges = await client.bookingCharge.findMany({ where: { bookingId } })
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { prepaymentPercent: true, totalAmount: true, prepaidAmount: true },
  })
  if (!booking) return null

  // Итог без строк — прежний кэш `totalAmount`: считать его нечем, но и терять нельзя
  const keepTotal = charges.length === 0 && keepIfEmpty
  const total = keepTotal ? Math.round(booking.totalAmount || 0) : sumCharges(charges)
  const percent = await currentPrepaymentPercent(bookingId, booking, client)
  const prepaid = Math.round(total * (percent / 100))

  if (keepTotal) {
    // Итог не трогаем СОВСЕМ (даже равной записью — это чужое, посчитанное вручную
    // число), пишем только предоплату и только если она действительно изменилась
    if (prepaid !== booking.prepaidAmount) {
      await client.booking.update({ where: { id: bookingId }, data: { prepaidAmount: prepaid } })
    }
  } else {
    await client.booking.update({
      where: { id: bookingId },
      data: { totalAmount: total, prepaidAmount: prepaid },
    })
  }
  return { total, prepaidAmount: prepaid, count: charges.length }
}

/**
 * Процент предоплаты СЧЁТА — у текущего (последнего живого) отрезка цепочки.
 *
 * То же правило, что у скидки и услуг (`buildAutoChargesDetailed`: `inputs` берутся
 * у последнего отрезка): текущий отрезок и есть «состояние брони», его форму правит
 * стойка. Деньги при этом лежат на голове, поэтому пересчёт всегда зовут для неё —
 * и без этого поиска процент читался бы у головы, а записанный в продолжение
 * не влиял бы ни на что: форма показывала бы «Предоплата 30 %» рядом с суммой от 50 %.
 *
 * У одиночной брони цепочки нет — берём её собственный процент, поведение прежнее.
 */
async function currentPrepaymentPercent(bookingId, booking, client = prisma) {
  const own = booking.prepaymentPercent || 0
  const { segments } = await loadChainSegments(bookingId, client)
  if (segments.length < 2) return own
  return segments[segments.length - 1].booking.prepaymentPercent || 0
}

const LEGACY_TOTAL_LABEL = 'Проживание · по прежнему расчёту'
const LEGACY_TOTAL_REASON = 'сумма зафиксирована при первом ручном начислении'

/**
 * Фиксирует прежний итог брони строкой начислений — ПЕРЕД первой ручной строкой.
 *
 * Зачем. Итог брони = сумма строк (`recalcBookingTotals` в строгом режиме), а у 107
 * старых броней (см. NOTES) строк нет вовсе: их `totalAmount` посчитан когда-то
 * вручную и живёт только кэшем. Первая же ручная строка — штраф при отмене или
 * мини-бар — делала эту сумму единственной строкой счёта, и прежние 100 000
 * превращались в 5 000: та же транзакция открывала возврат оплаты за прожитые ночи.
 * Терять прежнюю сумму нельзя, а восстановить её потом нечем — поэтому она
 * записывается строкой ровно в тот момент, когда счёт впервые становится списком.
 *
 * `totalAmount = 0` (отель без календаря цен) не фиксируем: фиксировать нечего,
 * и ручная строка — это и есть весь счёт.
 *
 * @returns {object|null} созданная строка либо null, если фиксировать не потребовалось
 */
async function pinLegacyTotal(bookingId, { client = prisma, adminId = null } = {}) {
  // Строки уже есть — счёт живёт списком, и кэш пересчитывается по нему сам
  const existing = await client.bookingCharge.count({ where: { bookingId } })
  if (existing > 0) return null

  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    select: { totalAmount: true },
  })
  const total = Math.round(booking?.totalAmount || 0)
  if (total <= 0) return null

  return client.bookingCharge.create({
    data: {
      bookingId,
      kind: 'stay',
      label: LEGACY_TOTAL_LABEL,
      quantity: 1,
      unitPrice: total,
      amount: total,
      // Без даты: за какие именно ночи была эта сумма — уже неизвестно,
      // и приписывать ей день значило бы придумать данные.
      date: null,
      // Ручная: пересборка по тарифу (`rebuildAutoCharges`) не имеет права её стереть —
      // иначе прежний расчёт исчезнет так же тихо, как исчезал до этой правки.
      source: 'manual',
      reason: LEGACY_TOTAL_REASON,
      createdById: adminId,
    },
  })
}

/**
 * Пересобирает автоматические строки брони. Ручные (`source='manual'`) не трогает.
 * @returns {{ created: number, total: number|null }}
 */
async function rebuildAutoCharges(bookingId, { adminId = null, client = prisma, keepIfEmpty = false } = {}) {
  const booking = await client.booking.findUnique({
    where: { id: bookingId },
    include: { room: { select: { categoryId: true } } },
  })
  if (!booking) return { created: 0, total: null }

  const ctx = await loadChargeContext(booking, client)
  const manualCharges = await client.bookingCharge.findMany({ where: { bookingId, source: 'manual' } })
  const rows = buildAutoCharges({ booking, ...ctx, manualCharges })

  await client.bookingCharge.deleteMany({ where: { bookingId, source: 'auto' } })
  if (rows.length > 0) {
    await client.bookingCharge.createMany({
      data: rows.map(r => ({ ...r, bookingId, source: 'auto', createdById: adminId })),
    })
  }

  const totals = await recalcBookingTotals(bookingId, { client, keepIfEmpty })
  return { created: rows.length, total: totals ? totals.total : null }
}

// ─── Цепочка «один счёт» ─────────────────────────────────────────────────────
//
// Переезд физически делит бронь на две записи (иначе не нарисовать два блока в
// шахматке и не проверить пересечения), но для гостя это ОДИН счёт: все
// `BookingCharge` и `Payment` лежат на голове, у продолжений деньги нулевые.
// Отсюда правило: любая денежная операция работает не по `:id`, а по счёту.

/**
 * Отрезки счёта, к которому относится бронь `anyBookingId` — по её голове.
 *
 * `segments` идут по `checkIn`: голова первой, продолжения дальше. Каждому нужен
 * свой `categoryId` (цена ночи считается по календарю ЕГО категории) и номер
 * (он попадает в подпись строки проживания).
 *
 * @returns {Promise<{ headId:number, segments: Array<{booking:object, categoryId:number|null, roomNumber:string|null, categoryName:string|null}> }>}
 */
async function loadChainSegments(anyBookingId, client = prisma) {
  const id = parseInt(anyBookingId)
  const self = await client.booking.findUnique({
    where: { id },
    select: { id: true, accountBookingId: true },
  })
  if (!self) return { headId: id, segments: [] }

  const headId = self.accountBookingId ?? self.id
  const roomInclude = {
    room: { select: { id: true, number: true, categoryId: true, category: { select: { name: true } } } },
  }
  const [head, continuations] = await Promise.all([
    client.booking.findUnique({ where: { id: headId }, include: roomInclude }),
    client.booking.findMany({
      where: { accountBookingId: headId },
      include: roomInclude,
      orderBy: { checkIn: 'asc' },
    }),
  ])
  if (!head) return { headId, segments: [] }

  const toSegment = (b) => ({
    booking: b,
    categoryId: b.room?.categoryId ?? null,
    roomNumber: b.room?.number ?? null,
    categoryName: b.room?.category?.name ?? null,
  })
  // Отменённое продолжение (переезд «отыграли назад») ночей счёту не приносит.
  const live = continuations.filter((b) => b.status !== 'CANCELLED')
  return { headId, segments: [head, ...live].map(toSegment) }
}

/** Календарь цен каждому отрезку — свой: категории у номеров цепочки разные. */
async function loadSegmentRates(segments, client = prisma) {
  for (const seg of segments) {
    const { ratesByDate } = await loadRateContext({
      categoryId: seg.categoryId,
      checkIn: seg.booking.checkIn,
      checkOut: seg.booking.checkOut,
    }, client)
    seg.ratesByDate = ratesByDate
  }
  return segments
}

/**
 * Отрезки, за которые генератор действительно считает ночи.
 *
 * У брони, зафиксировавшей прежний итог строкой `pinLegacyTotal`, эта строка
 * покрывает ВЕСЬ срок до первого переезда — и проживание, и питание: за какие
 * именно ночи была та сумма, уже неизвестно. Начислить поверх неё ночи головы
 * значило бы посчитать их дважды, поэтому голова из расчёта выпадает и остаются
 * только продолжения.
 */
function segmentsToPrice(segments, charges) {
  // Только у ЦЕПОЧКИ: у одиночной брони «ночей продолжений» не существует, и
  // выбрасывать единственный отрезок значило бы менять поведение волны 5a.
  if (segments.length < 2) return segments
  const hasLegacy = (charges || []).some((c) => c.label === LEGACY_TOTAL_LABEL)
  return hasLegacy ? segments.slice(1) : segments
}

/**
 * Пересобирает автоматические строки ВСЕГО счёта на голове цепочки.
 * Ручные строки не трогает — как и `rebuildAutoCharges`, чьё место она занимает
 * везде, где бронь может оказаться частью цепочки.
 *
 * `frozenBefore` — дата, до которой ночи уже прожиты (обычно дата переезда).
 * Их строки остаются со своими суммами, а не переоцениваются по сегодняшнему
 * календарю: тот же приём «замороженных» ночей, что в `planEarlyCheckout`.
 *
 * @returns {{ created:number, total:number|null }}
 */
async function rebuildChainCharges(headId, { adminId = null, client = prisma, frozenBefore = null, keepIfEmpty = false } = {}) {
  const { headId: id, segments } = await loadChainSegments(headId, client)
  if (segments.length === 0) return { created: 0, total: null }
  await loadSegmentRates(segments, client)

  const hotel = await client.hotelSettings.findUnique({ where: { id: 1 } })
  const pricingBase = hotel?.pricingBase || 'person'

  // Услуги — текущего (последнего) отрезка: при переезде они ПЕРЕЕЗЖАЮТ на
  // продолжение, поэтому набор ровно один на всю цепочку.
  const last = segments[segments.length - 1]
  const bookingServices = await client.bookingService.findMany({
    where: { bookingId: last.booking.id },
    include: { service: true },
    orderBy: { id: 'asc' },
  })

  const all = await client.bookingCharge.findMany({ where: { bookingId: id } })
  const manual = all.filter((c) => c.source === 'manual')
  const priced = segmentsToPrice(segments, manual)

  const cut = frozenBefore ? toUTCDate(frozenBefore).getTime() : null

  // Ночь считается прожитой, только если она ЕСТЬ в новом периоде брони.
  // Иначе сокращение дат оставляло бы в счёте ночи снятого периода: они лежат
  // раньше границы, и заморозка их берегла (R13-S-001). Полуоткрытый отрезок
  // `[checkIn, checkOut)` — как везде в проекте.
  const inChain = (t) => segments.some((seg) => (
    t >= toUTCDate(seg.booking.checkIn).getTime() && t < toUTCDate(seg.booking.checkOut).getTime()
  ))
  const keptAuto = cut === null ? [] : all.filter((c) => {
    if (c.source !== 'auto' || c.kind !== 'stay' || !c.date) return false
    const t = toUTCDate(c.date).getTime()
    return t < cut && inChain(t)
  })
  const keptIds = new Set(keptAuto.map((c) => c.id))
  const dropIds = all.filter((c) => c.source === 'auto' && !keptIds.has(c.id)).map((c) => c.id)

  // «Уже посчитанные» строки для генератора: ручные + сохранённые прожитые ночи.
  // `covered` — даты ночей, которые уже чем-то закрыты; генератор их пропустит.
  const frozen = [...manual, ...keptAuto]
  const covered = new Set(frozen.filter((c) => c.kind === 'stay' && c.date).map((c) => dateKey(c.date)))

  // Прежний итог (`pinLegacyTotal`) — ОДНА строка без даты на весь срок до первого
  // переезда. Сопоставить её с конкретной ночью нечем, поэтому ночи до границы
  // закрываем заглушками: иначе генератор начислил бы их ВТОРОЙ раз поверх той же
  // суммы. Ночь до границы, у которой строки нет и прежнего итога тоже нет,
  // наоборот, отдаётся генератору — её просто не посчитали (цены на неё не было,
  // когда бронь заводили), и заглушка на 0 оставляла её неначисленной навсегда
  // (R13-S-002).
  if (cut !== null && manual.some((c) => c.label === LEGACY_TOTAL_LABEL)) {
    for (const seg of priced) {
      for (const night of nightsOf(seg.booking.checkIn, seg.booking.checkOut)) {
        if (night.getTime() >= cut) continue
        const key = dateKey(night)
        if (covered.has(key)) continue
        frozen.push({ kind: 'stay', date: night, amount: 0 })
        covered.add(key)
      }
    }
  }

  const built = buildAutoChargesDetailed({
    booking: last.booking,
    pricingBase,
    bookingServices,
    manualCharges: frozen,
    segments: priced,
  })
  // Подстраховка: уже закрытую ночь не начисляем второй раз, даже если генератор
  // её выдал. Именно «закрытую» — ночь до границы БЕЗ своей строки не трогаем,
  // иначе она так и осталась бы неначисленной (R13-S-002).
  const rows = cut === null
    ? built.rows
    : built.rows.filter((r) => !(
      r.kind === 'stay' && r.date && r.date.getTime() < cut && covered.has(dateKey(r.date))
    ))

  if (dropIds.length > 0) {
    await client.bookingCharge.deleteMany({ where: { id: { in: dropIds } } })
  }
  if (rows.length > 0) {
    await client.bookingCharge.createMany({
      data: rows.map((r) => ({ ...r, bookingId: id, source: 'auto', createdById: adminId })),
    })
  }

  // Замороженным ночам обновляем ТОЛЬКО подпись: они были посчитаны, когда бронь
  // ещё была одиночной («Проживание · 2 взр.»), а в счёте цепочки без номера уже
  // не видно, за какую комнату ночь. Суммы не трогаем — их переоценка и есть то,
  // от чего заморозка защищает.
  if (segments.length > 1 && keptAuto.length > 0) {
    for (const seg of segments) {
      const from = toUTCDate(seg.booking.checkIn).getTime()
      const to = toUTCDate(seg.booking.checkOut).getTime()
      const label = stayLabel({
        pricingBase,
        counts: guestCounts(seg.booking),
        roomNumber: seg.roomNumber,
        categoryName: seg.categoryName,
        qualified: true,
      })
      for (const c of keptAuto) {
        const t = toUTCDate(c.date).getTime()
        if (t < from || t >= to || c.label === label) continue
        await client.bookingCharge.update({ where: { id: c.id }, data: { label } })
      }
    }
  }

  const totals = await recalcBookingTotals(id, { client, keepIfEmpty })
  return { created: rows.length, total: totals ? totals.total : null }
}

// ─── Планы счёта при отмене и раннем выезде ──────────────────────────────────
//
// «План» — чистый ответ на вопрос «какими станут строки после действия»: что
// останется, что снимется, что начислится заново. Он нужен ДВАЖДЫ — в предпросмотре
// расчёта с гостем (`POST /bookings/:id/settlement/preview`, ничего не пишет) и при
// самом действии, — и обязан быть одним кодом: два вычисления «сколько к возврату»
// разошлись бы на тенге, и администратор вернул бы гостю не ту сумму. Ровно та же
// история, что с четырьмя определениями «свободно» (см. NOTES, `utils/availability.js`).

/**
 * План счёта после ОТМЕНЫ: автоматические строки снимаются, ручные остаются.
 *
 * Отмена обнуляет счёт (решение владельца 2026-09-08, `docs/decisions/data-and-money.md`):
 * гость не жил — начислять не за что. Ручные строки не трогаем: именно ими оформляется
 * удержание или штраф за отмену, и стереть их значило бы стереть решение администратора.
 *
 * @param {Array} charges все строки брони
 * @returns {{ keep: Array, dropIds: number[], create: Array }}
 */
function planCancelCharges(charges) {
  const keep = []
  const dropIds = []
  for (const c of charges) {
    if (c.source === 'auto') dropIds.push(c.id)
    else keep.push(c)
  }
  return { keep, dropIds, create: [] }
}

/**
 * План счёта после РАННЕГО ВЫЕЗДА на дату `newCheckOut` — снять со счёта непрожитое
 * (решение владельца 2026-09-08, «за фактические ночи», как в Opera/Mews/Cloudbeds).
 *
 * Почему не полная пересборка: она переоценила бы УЖЕ ПРОЖИТЫЕ ночи по сегодняшнему
 * календарю цен. Гость прожил их по цене, которая была на момент бронирования, —
 * менять её задним числом нельзя. Поэтому адресно:
 *   • auto-строки проживания за ночи `>= newCheckOut` снимаются;
 *   • прожитые auto-строки проживания остаются со своими суммами — генератору они
 *     передаются как «уже посчитанные», и он их не трогает;
 *   • посуточные питание/услуги (`per_person_night`, `per_night`) пересобираются —
 *     их количество считается от числа ночей, а ночей стало меньше;
 *   • ручные строки (`source='manual'`) не трогаются вообще: штраф за досрочный выезд
 *     администратор добавляет именно ими;
 *   • строка процентной скидки пересобирается от новой базы.
 *
 * Брони без строк начислений (107 старых, см. NOTES) не трогаем совсем: у них итог —
 * число, посчитанное когда-то вручную, и обнулять его выездом нельзя.
 *
 * @returns {{ keep: Array, dropIds: number[], create: Array, untouched: boolean }}
 *   `keep` — строки, которые остаются как есть; `dropIds` — id снимаемых;
 *   `create` — новые авто-строки (без id, без bookingId).
 */
function planEarlyCheckout({ booking, charges, newCheckOut, pricingBase, ratesByDate, bookingServices, segments = null }) {
  if (charges.length === 0) return { keep: charges, dropIds: [], create: [], untouched: true }

  const cutTime = toUTCDate(newCheckOut).getTime()
  // Непрожитая ночь: дата строки >= даты выезда (интервал полуоткрытый)
  const isUnlivedNight = (c) => (
    c.source === 'auto' && c.kind === 'stay' && c.date && toUTCDate(c.date).getTime() >= cutTime
  )
  // Всё остальное автоматическое (питание, услуги, процентная скидка) пересобирается
  const isRebuilt = (c) => c.source === 'auto' && c.kind !== 'stay'

  const keep = charges.filter((c) => !isUnlivedNight(c) && !isRebuilt(c))
  const dropIds = charges.filter((c) => isUnlivedNight(c) || isRebuilt(c)).map((c) => c.id)

  // «Уже посчитанные» строки для генератора: ручные + сохранённые ночи проживания.
  // Он пропускает ночь, для которой такая строка есть, и включает её сумму в базу
  // процентной скидки — ровно то, что нужно.
  const frozen = keep.filter((c) => c.source === 'manual' || c.kind === 'stay')
  const covered = new Set(frozen.filter((c) => c.kind === 'stay' && c.date).map((c) => dateKey(c.date)))

  // Ранний выезд из ЦЕПОЧКИ: укорачивается только последний отрезок — тот, в котором
  // гость сейчас живёт. Предыдущие отрезки прожиты целиком и в план входят как есть,
  // иначе питание пересчиталось бы по числу ночей одного номера вместо всей цепочки.
  const base = (Array.isArray(segments) && segments.length > 0)
    ? segments
    : [{ booking, ratesByDate, roomNumber: null, categoryName: null }]
  const cut = base.map((s, i) => (i === base.length - 1
    ? { ...s, booking: { ...s.booking, checkOut: newCheckOut } }
    : s))
  const priced = segmentsToPrice(cut, charges)

  // Ночь без строки (цена на неё не задана) тоже прожита — заглушка на 0 не даёт
  // генератору выдумать ей цену по сегодняшнему календарю.
  for (const seg of priced) {
    for (const night of nightsOf(seg.booking.checkIn, seg.booking.checkOut)) {
      const key = dateKey(night)
      if (covered.has(key)) continue
      frozen.push({ kind: 'stay', date: night, amount: 0 })
      covered.add(key)
    }
  }

  const create = buildAutoCharges({
    booking: (priced[priced.length - 1] || cut[cut.length - 1]).booking,
    pricingBase,
    ratesByDate,
    bookingServices,
    manualCharges: frozen,
    segments: (Array.isArray(segments) && segments.length > 0) ? priced : null,
  }).filter((r) => r.kind !== 'stay')  // подстраховка: прожитые ночи не переоцениваем

  return { keep, dropIds, create, untouched: false }
}

/**
 * Что нужно генератору, чтобы посчитать бронь на срок `checkIn … checkOut`:
 * календарь цен категории её номера и подключённые услуги.
 * Отдельно от `loadChargeContext`, потому что срок здесь ДРУГОЙ (укороченный
 * ранним выездом), а сама бронь в базе ещё со старым выездом.
 */
async function loadStayContext(booking, checkOut, client = prisma) {
  const room = await client.room.findUnique({
    where: { id: booking.roomId },
    select: { categoryId: true },
  })
  const rateCtx = await loadRateContext(
    { categoryId: room?.categoryId || null, checkIn: booking.checkIn, checkOut },
    client,
  )
  const bookingServices = await client.bookingService.findMany({
    where: { bookingId: booking.id },
    include: { service: true },
    orderBy: { id: 'asc' },
  })
  return { ...rateCtx, bookingServices }
}

/**
 * Применяет план отмены: снимает авто-строки и пересчитывает итог.
 * Режим строгий (без `keepIfEmpty`): у брони без строк итог обязан стать нулём,
 * иначе отменённая бронь так и висела бы должником со старой суммой (аудит D2-006).
 */
async function dropAutoChargesOnCancel(bookingId, tx) {
  await tx.bookingCharge.deleteMany({ where: { bookingId, source: 'auto' } })
  await recalcBookingTotals(bookingId, { client: tx })
}

/**
 * Контекст плана раннего выезда для брони, которая может быть частью цепочки:
 * отрезки счёта с их календарями цен и услуги текущего отрезка.
 * У одиночной брони `segments` — один отрезок, и план считается ровно как раньше.
 */
async function loadChainStayContext(booking, newCheckOut, client = prisma) {
  const { headId, segments } = await loadChainSegments(booking.id, client)
  if (segments.length === 0) {
    return { headId: booking.id, segments: null, ...(await loadStayContext(booking, newCheckOut, client)) }
  }
  // Последний отрезок укорачивается выездом — его календарь берём по новой дате
  const last = segments[segments.length - 1]
  const trimmed = segments.map((s, i) => (i === segments.length - 1
    ? { ...s, booking: { ...s.booking, checkOut: newCheckOut } } : s))
  await loadSegmentRates(trimmed, client)
  // Возвращаем НЕукороченные отрезки с уже загруженными ценами: укорачивает их сам
  // `planEarlyCheckout` — он же единственный, кто знает, какой отрезок закрывается.
  segments.forEach((s, i) => { s.ratesByDate = trimmed[i].ratesByDate })

  const hotel = await client.hotelSettings.findUnique({ where: { id: 1 } })
  const bookingServices = await client.bookingService.findMany({
    where: { bookingId: last.booking.id },
    include: { service: true },
    orderBy: { id: 'asc' },
  })
  return {
    headId,
    segments,
    pricingBase: hotel?.pricingBase || 'person',
    ratesByDate: last.ratesByDate || {},
    bookingServices,
  }
}

/** Применяет план раннего выезда (см. `planEarlyCheckout`). Строки — на голове счёта. */
async function trimChargesToCheckOut(existing, newCheckOut, tx, adminId) {
  const { headId, segments, ...ctx } = await loadChainStayContext(existing, newCheckOut, tx)
  const bookingId = headId
  const charges = await tx.bookingCharge.findMany({ where: { bookingId } })
  if (charges.length === 0) return null

  const plan = planEarlyCheckout({ booking: existing, charges, newCheckOut, segments, ...ctx })

  if (plan.dropIds.length > 0) {
    await tx.bookingCharge.deleteMany({ where: { id: { in: plan.dropIds } } })
  }
  if (plan.create.length > 0) {
    await tx.bookingCharge.createMany({
      data: plan.create.map((r) => ({ ...r, bookingId, source: 'auto', createdById: adminId })),
    })
  }

  // Строгий режим: строки у брони были, значит итог обязан стать их новой суммой.
  await recalcBookingTotals(bookingId, { client: tx })
  return plan
}

/**
 * Переписывает набор услуг брони целиком (удалить всё → создать заново).
 *
 * Именно «заменить», а не «досоздать»: форма присылает итоговое состояние трёх
 * блоков, и снятая галочка «Обед» обязана означать удаление строки, иначе убрать
 * питание было бы нечем.
 */
async function replaceBookingServices(bookingId, links, client = prisma) {
  const rows = normalizeServiceLinks(links)
  await client.bookingService.deleteMany({ where: { bookingId } })
  if (rows.length > 0) {
    await client.bookingService.createMany({
      data: rows.map(r => ({ ...r, bookingId })),
      skipDuplicates: true,
    })
  }
  return rows
}

/**
 * Что подставить в НОВУЮ бронь, если клиент не прислал набор услуг явно:
 * услуги с `includedByDefault` на всех гостей. Это единственное место, где флаг
 * ещё работает — и ровно в том смысле, ради которого он заведён («завтрак включён
 * в тариф»). Старые клиенты и служебные вызовы (переезд, импорт) продолжают
 * получать привычное поведение, а не бронь без питания.
 */
async function defaultServiceLinks(booking, client = prisma) {
  const services = await client.service.findMany({
    where: { isActive: true, includedByDefault: true },
    orderBy: { order: 'asc' },
  })
  if (services.length === 0) return []

  const counts = guestCounts(booking)
  const adults = counts.adults + counts.extraBeds
  const children = counts.children
  return services.map(s => ({ serviceId: s.id, adults, children, quantity: 1 }))
}

/**
 * Изменились ли входы, от которых зависят автоматические строки.
 * Правка заметки или телефона не должна переоценивать бронь по сегодняшнему тарифу —
 * та же защита, что и ключом пересчёта на клиенте.
 */
const CHARGE_INPUT_FIELDS = [
  'roomId', 'checkIn', 'checkOut',
  'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals', 'childrenNoMeals',
  'extraBedsWithMeals', 'extraBedsNoMeals', 'discountPercent',
]

/**
 * Приводит набор услуг брони к сравнимому виду: {serviceId, adults, children, quantity},
 * отсортированному по serviceId. Нужен и для записи, и для ответа на вопрос
 * «изменилось ли питание» — порядок строк в теле запроса и в базе не совпадает,
 * а сравнение «в лоб» давало бы ложную пересборку начислений на каждом сохранении.
 */
function normalizeServiceLinks(list) {
  if (!Array.isArray(list)) return []
  const byId = new Map()
  for (const raw of list) {
    const serviceId = parseInt(raw?.serviceId)
    if (!Number.isInteger(serviceId) || serviceId <= 0) continue
    // Дубль одной услуги — не две строки, а одно число едоков (см. @@unique в схеме)
    byId.set(serviceId, {
      serviceId,
      adults: Math.max(0, Math.round(Number(raw.adults) || 0)),
      children: Math.max(0, Math.round(Number(raw.children) || 0)),
      quantity: raw.quantity == null ? 1 : Math.max(0, Number(raw.quantity) || 0),
    })
  }
  return [...byId.values()].sort((a, b) => a.serviceId - b.serviceId)
}

function serviceLinksChanged(before, after) {
  const a = normalizeServiceLinks(before)
  const b = normalizeServiceLinks(after)
  if (a.length !== b.length) return true
  return a.some((x, i) => {
    const y = b[i]
    return x.serviceId !== y.serviceId || x.adults !== y.adults
      || x.children !== y.children || x.quantity !== y.quantity
  })
}

function chargeInputsChanged(before, after) {
  return CHARGE_INPUT_FIELDS.some((f) => {
    const a = before[f]
    const b = after[f]
    if (a instanceof Date || b instanceof Date) {
      return new Date(a).getTime() !== new Date(b).getTime()
    }
    return (a ?? null) !== (b ?? null)
  })
}

module.exports = {
  toUTCDate,
  dateKey,
  nightsOf,
  buildAutoCharges,
  buildAutoChargesDetailed,
  stayLabel,
  priceNight,
  loadChargeContext,
  loadRateContext,
  rebuildAutoCharges,
  loadChainSegments,
  loadSegmentRates,
  segmentsToPrice,
  loadChainStayContext,
  rebuildChainCharges,
  recalcBookingTotals,
  pinLegacyTotal,
  LEGACY_TOTAL_LABEL,
  sumCharges,
  planCancelCharges,
  planEarlyCheckout,
  loadStayContext,
  dropAutoChargesOnCancel,
  trimChargesToCheckOut,
  chargeInputsChanged,
  normalizeServiceLinks,
  serviceLinksChanged,
  replaceBookingServices,
  defaultServiceLinks,
  CHARGE_INPUT_FIELDS,
}
