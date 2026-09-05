const { prisma } = require('./prisma')
const { createError } = require('../middleware/errorHandler')
const logger = require('./logger')

/**
 * Точки отката состояния броней.
 *
 * ВАЖНО ПРО ДЕНЬГИ. Бронь — корень каскада: `BookingCharge`, `Payment` и
 * `BookingService` привязаны к ней через `onDelete: Cascade`. Откат физически
 * удаляет все брони и создаёт их заново, поэтому снимок ОБЯЗАН содержать эти три
 * таблицы: иначе `booking.deleteMany({})` уносит всю кассу, а восстановить её
 * нечем. До версии формата 2 снимок хранил только колонки самой брони — такие
 * снимки без явного подтверждения не откатываются (см. assessRestore).
 */

// Сколько снимков каждого вида храним (ротация). JSON крошечный — диск не нагружает.
const RETENTION = {
  auto:   parseInt(process.env.SNAPSHOT_KEEP_AUTO   || '15', 10),
  shift:  parseInt(process.env.SNAPSHOT_KEEP_SHIFT  || '15', 10),
  manual: parseInt(process.env.SNAPSHOT_KEEP_MANUAL || '20', 10),
  safety: parseInt(process.env.SNAPSHOT_KEEP_SAFETY || '10', 10),
}

const AUTO_DEBOUNCE_MS = parseInt(process.env.SNAPSHOT_DEBOUNCE_MS || '1200', 10)

/**
 * Версия формата поля `data`:
 *   1 (нет поля `version`) — только `bookings`. Денежные строки в таком снимке
 *     отсутствуют, откат на него стирает начисления, платежи и услуги.
 *   2 — `bookings` + `charges` + `payments` + `services`.
 */
const SNAPSHOT_VERSION = 2

/**
 * Единственное место, где записано правило чтения версии: нет поля — формат 1.
 * Читают его двое, и по-разному: откат берёт значение из разобранного `data`
 * (число), список — из SQL `data->>'version'` (строка или NULL). Поэтому правило
 * живёт здесь, а не двумя копиями, которые однажды разойдутся.
 */
function readVersion(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 1
}

// Пока идёт восстановление — не делаем авто-снимки (чтобы не «снять» сам откат как изменение)
let restoreInProgress = false

// ─── Захват состояния ───────────────────────────────────────────────────────────

/**
 * Снимаем брони и всё, что уйдёт вместе с ними по каскаду.
 * Читаем четырьмя запросами целиком, а не через include: строки нужны плоскими
 * (ровно так они и вставляются обратно), и связь booking↔строки всё равно
 * восстанавливается по `bookingId`.
 */
async function captureState() {
  const [bookings, charges, payments, services] = await Promise.all([
    prisma.booking.findMany({ orderBy: { id: 'asc' } }),
    prisma.bookingCharge.findMany({ orderBy: { id: 'asc' } }),
    prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    prisma.bookingService.findMany({ orderBy: { id: 'asc' } }),
  ])
  // Date → ISO-строки, чтобы значение было валидным JSON для колонки Json
  return JSON.parse(JSON.stringify({
    version: SNAPSHOT_VERSION,
    bookings, charges, payments, services,
  }))
}

// ─── Создание снимка ──────────────────────────────────────────────────────────────

async function createSnapshot({ kind, label, createdById = null }) {
  const state = await captureState()
  const snap = await prisma.snapshot.create({
    data: {
      kind,
      label,
      bookingCount: state.bookings.length,
      data: state,
      createdById,
    },
    select: { id: true, kind: true, label: true, bookingCount: true, createdAt: true },
  })
  await pruneByKind(kind)
  return snap
}

async function pruneByKind(kind) {
  const keep = RETENTION[kind] ?? 15
  const extra = await prisma.snapshot.findMany({
    where: { kind },
    orderBy: { createdAt: 'desc' },
    skip: keep,
    select: { id: true },
  })
  if (extra.length > 0) {
    await prisma.snapshot.deleteMany({ where: { id: { in: extra.map(s => s.id) } } })
  }
}

// ─── Авто-снимок (дебаунс) ────────────────────────────────────────────────────────
// Несколько быстрых изменений (переезд = 2 события, оптимизация = много) → один снимок.

let autoTimer = null
let pendingLabel = 'Изменение брони'

function scheduleAuto(label = 'Изменение брони') {
  if (restoreInProgress) return
  pendingLabel = label
  if (autoTimer) clearTimeout(autoTimer)
  autoTimer = setTimeout(async () => {
    autoTimer = null
    try {
      await createSnapshot({ kind: 'auto', label: pendingLabel })
    } catch (err) {
      logger.error('Auto-snapshot failed:', err.message)
    }
  }, AUTO_DEBOUNCE_MS)
}

// ─── Список снимков ───────────────────────────────────────────────────────────────

async function listSnapshots() {
  // `data` намеренно не выбираем целиком: в формате 2 это самая тяжёлая колонка
  // (брони + начисления + платежи + услуги), два десятка снимков — больше мегабайта.
  // Но версия формата нужна списку: снимок формата 1 денег не хранит, и откат к
  // нему стирает кассу — это должно быть видно ДО выбора точки отката, а не в
  // момент отказа. Prisma не умеет положить вложенное поле Json в `select`
  // (`select: { data: true }` притащил бы всё тело), поэтому версию берём отдельным
  // сырым запросом: `->>` возвращает скаляр, и по сети едет одна строка на снимок.
  const [snaps, versions] = await Promise.all([
    prisma.snapshot.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, kind: true, label: true, bookingCount: true, createdAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    }),
    prisma.$queryRaw`SELECT id, data->>'version' AS version FROM "Snapshot"`,
  ])

  const versionById = new Map(versions.map(r => [r.id, readVersion(r.version)]))
  // Снимок, созданный между двумя запросами, в карту не попадёт — считаем его
  // форматом 1, как и снимок без поля. Ошибка в эту сторону покажет лишнее
  // предупреждение, обратная — спрячет реальную потерю денег.
  return snaps.map(s => ({ ...s, version: versionById.get(s.id) ?? 1 }))
}

// ─── Восстановление ────────────────────────────────────────────────────────────────

const BOOKING_FIELDS = [
  'id', 'roomId', 'guestName', 'guestPhone', 'checkIn', 'checkOut', 'status',
  'source', 'notes', 'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals',
  'childrenNoMeals', 'extraBedsWithMeals', 'extraBedsNoMeals', 'disabledAdults',
  'disabledChildren', 'discountPercent', 'prepaymentPercent', 'totalAmount',
  'prepaidAmount', 'paidAmount', 'flags', 'partnerId', 'shiftId', 'adminId',
  'actualCheckInAt', 'actualCheckOutAt',
  'createdAt', 'updatedAt',
]
// actualCheckInAt/actualCheckOutAt — настоящие timestamp'ы: в JSON снимка они лежат
// строками, и без этого списка pickRow вернул бы строку туда, где Prisma ждёт Date.
const BOOKING_DATE_FIELDS = [
  'checkIn', 'checkOut', 'actualCheckInAt', 'actualCheckOutAt', 'createdAt', 'updatedAt',
]

const CHARGE_FIELDS = [
  'id', 'bookingId', 'kind', 'label', 'quantity', 'unitPrice', 'amount', 'date',
  'source', 'reason', 'createdById', 'createdAt', 'updatedAt',
]
const CHARGE_DATE_FIELDS = ['date', 'createdAt', 'updatedAt']

const PAYMENT_FIELDS = [
  'id', 'bookingId', 'kind', 'amount', 'method', 'adminId', 'adminName',
  'shiftId', 'businessDate', 'paidAt', 'comment', 'refundOfId',
  'voidedAt', 'voidedById', 'voidReason', 'createdAt', 'updatedAt',
]
const PAYMENT_DATE_FIELDS = ['businessDate', 'paidAt', 'voidedAt', 'createdAt', 'updatedAt']

const SERVICE_FIELDS = ['id', 'bookingId', 'serviceId', 'adults', 'children', 'quantity', 'createdAt', 'updatedAt']
const SERVICE_DATE_FIELDS = ['createdAt', 'updatedAt']

// Вставляем пачками: одна INSERT-строка на тысячи записей упирается в лимит
// параметров Postgres (32767), а брони с начислениями до него дорастают.
const INSERT_CHUNK = 500

function pickRow(src, fields, dateFields) {
  const row = {}
  for (const f of fields) {
    if (src[f] === undefined) continue
    row[f] = dateFields.includes(f) && src[f] != null ? new Date(src[f]) : src[f]
  }
  return row
}

/**
 * Списки полей выше — белые: колонка, которой в них нет, при откате теряется молча.
 * Схема живёт своей жизнью (новую колонку добавляет другой агент), поэтому при
 * восстановлении сверяем снимок со списком и жалуемся в лог, а не делаем вид,
 * что всё в порядке.
 */
function warnUnknownFields(table, sample, fields) {
  if (!sample) return
  const unknown = Object.keys(sample).filter(k => !fields.includes(k))
  if (unknown.length > 0) {
    logger.warn(`Snapshot restore: в снимке есть колонки ${table}, которых нет в списке восстановления: ${unknown.join(', ')}`)
  }
}

/** Деньги — с двумя знаками, как в paymentController: копить ошибку double нельзя. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

/** Вклад платежа в `paidAmount`: возврат вычитается, отменённый не считается вовсе. */
function signedPayment(p) {
  if (p.voidedAt) return 0
  return p.kind === 'refund' ? -(p.amount || 0) : (p.amount || 0)
}

function formatMoney(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(round2(n))
}

async function createManyChunked(model, rows) {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await model.createMany({ data: rows.slice(i, i + INSERT_CHUNK) })
  }
}

/**
 * Готовит план восстановления: какие строки вернутся, какие внешние ключи
 * починены и что из нынешнего состояния будет потеряно.
 *
 * Вынесено отдельно, чтобы «показать последствия» (describeRestore) и сам откат
 * считали ОДНО И ТО ЖЕ: предупреждение, расходящееся с фактом, хуже отсутствия
 * предупреждения.
 */
async function prepareRestore(id, adminId = null) {
  const snap = await prisma.snapshot.findUnique({ where: { id } })
  if (!snap) throw createError('Снимок не найден', 404)

  const data = snap.data || {}
  const version = readVersion(data.version)
  const asArray = (v) => (Array.isArray(v) ? v : [])
  const snapBookings = asArray(data.bookings)
  const snapCharges  = asArray(data.charges)
  const snapPayments = asArray(data.payments)
  const snapServices = asArray(data.services)

  warnUnknownFields('Booking', snapBookings[0], BOOKING_FIELDS)
  warnUnknownFields('BookingCharge', snapCharges[0], CHARGE_FIELDS)
  warnUnknownFields('Payment', snapPayments[0], PAYMENT_FIELDS)
  warnUnknownFields('BookingService', snapServices[0], SERVICE_FIELDS)

  // Действующие внешние ключи — чтобы восстановление не упало на удалённых сущностях
  const [rooms, admins, shifts, partners, services] = await Promise.all([
    prisma.room.findMany({ select: { id: true } }),
    prisma.admin.findMany({ select: { id: true } }),
    prisma.shift.findMany({ select: { id: true } }),
    prisma.partner.findMany({ select: { id: true } }),
    prisma.service.findMany({ select: { id: true } }),
  ])
  const roomIds    = new Set(rooms.map(r => r.id))
  const adminIds   = new Set(admins.map(a => a.id))
  const shiftIds   = new Set(shifts.map(s => s.id))
  const partnerIds = new Set(partners.map(p => p.id))
  const serviceIds = new Set(services.map(s => s.id))

  const fallbackAdminId = adminId && adminIds.has(adminId)
    ? adminId
    : (admins[0]?.id ?? null)

  // ── Брони ──
  let skipped = 0
  const bookingRows = []
  for (const b of snapBookings) {
    if (!roomIds.has(b.roomId)) { skipped++; continue }  // номер удалён — пропускаем

    const row = pickRow(b, BOOKING_FIELDS, BOOKING_DATE_FIELDS)
    // Чиним внешние ключи, которых уже нет
    if (!adminIds.has(row.adminId)) row.adminId = fallbackAdminId
    if (row.adminId == null) { skipped++; continue }
    if (row.shiftId != null && !shiftIds.has(row.shiftId)) row.shiftId = null
    if (row.partnerId != null && !partnerIds.has(row.partnerId)) row.partnerId = null
    bookingRows.push(row)
  }
  const keptBookingIds = new Set(bookingRows.map(r => r.id))

  // ── Начисления ──
  const chargeRows = []
  for (const c of snapCharges) {
    if (!keptBookingIds.has(c.bookingId)) continue  // бронь не восстановилась — строке не к чему привязаться
    const row = pickRow(c, CHARGE_FIELDS, CHARGE_DATE_FIELDS)
    // Автор строки мог быть удалён; сама строка от этого не теряет смысла (в схеме SetNull)
    if (row.createdById != null && !adminIds.has(row.createdById)) row.createdById = null
    chargeRows.push(row)
  }

  // ── Платежи ──
  const paymentRows = []
  for (const p of snapPayments) {
    if (!keptBookingIds.has(p.bookingId)) continue
    const row = pickRow(p, PAYMENT_FIELDS, PAYMENT_DATE_FIELDS)
    // Кто принял — восстанавливаем как в схеме: ссылка может обнулиться,
    // но `adminName` строкой остаётся, ради этого он и продублирован.
    if (row.adminId != null && !adminIds.has(row.adminId)) row.adminId = null
    if (row.voidedById != null && !adminIds.has(row.voidedById)) row.voidedById = null
    if (row.shiftId != null && !shiftIds.has(row.shiftId)) row.shiftId = null
    paymentRows.push(row)
  }

  // Самоссылка возврата на исходный платёж. Вставляем ВСЕ платежи с пустой
  // ссылкой и проставляем её вторым проходом: иначе результат зависит от порядка
  // строк в снимке и от того, как Prisma разобьёт createMany на пачки.
  const restoredPaymentIds = new Set(paymentRows.map(r => r.id))
  const refundLinks = []
  for (const row of paymentRows) {
    if (row.refundOfId == null) continue
    // Исходный платёж не восстанавливается (его бронь пропущена) — ссылку теряем,
    // сам возврат сохраняем: строка кассы важнее связи.
    if (restoredPaymentIds.has(row.refundOfId)) {
      // `updatedAt` передаём явно: у поля @updatedAt Prisma иначе проставит
      // «сейчас», и восстановленная строка отличалась бы от снятой
      refundLinks.push({ id: row.id, refundOfId: row.refundOfId, updatedAt: row.updatedAt })
    }
    row.refundOfId = null
  }

  // ── Услуги брони ──
  const serviceRows = []
  const seenServiceLink = new Set()
  let skippedServices = 0
  for (const s of snapServices) {
    if (!keptBookingIds.has(s.bookingId)) continue
    // serviceId обязателен (Cascade от справочника) — услуги, удалённой из
    // справочника, вернуть некуда. Деньги за неё живут строкой начисления.
    if (!serviceIds.has(s.serviceId)) { skippedServices++; continue }
    const key = `${s.bookingId}:${s.serviceId}`
    if (seenServiceLink.has(key)) continue  // @@unique([bookingId, serviceId])
    seenServiceLink.add(key)
    serviceRows.push(pickRow(s, SERVICE_FIELDS, SERVICE_DATE_FIELDS))
  }

  // ── Кэши сумм в брони ──
  // `totalAmount` и `paidAmount` — кэши сумм строк, поэтому после отката они
  // считаются ИЗ восстановленных строк. Но только если строки есть: у 105 старых
  // броней начислений нет вовсе, и пересчёт «в ноль» стёр бы их суммы.
  const chargeSum = new Map()
  for (const c of chargeRows) chargeSum.set(c.bookingId, (chargeSum.get(c.bookingId) || 0) + (c.amount || 0))
  const paidSum = new Map()
  for (const p of paymentRows) paidSum.set(p.bookingId, (paidSum.get(p.bookingId) || 0) + signedPayment(p))
  for (const b of bookingRows) {
    if (chargeSum.has(b.id)) b.totalAmount = round2(chargeSum.get(b.id))
    if (paidSum.has(b.id)) b.paidAmount = round2(paidSum.get(b.id))
  }

  const impact = await assessRestore({ version, paymentRows, chargeRows, serviceRows })

  return {
    snapshot: {
      id: snap.id, kind: snap.kind, label: snap.label,
      createdAt: snap.createdAt, version,
    },
    bookingRows, chargeRows, paymentRows, serviceRows, refundLinks,
    skipped, skippedServices,
    impact,
  }
}

/**
 * Что нынешнее состояние потеряет от отката.
 *
 * Гейт — ПЛАТЕЖИ: это принятые наличные и карты, единственное, что нельзя
 * восстановить пересчётом. Начисления и услуги в сводке показываем, но откат из-за
 * них не блокируем: удаление строк брони, которую откатывают, — это и есть смысл
 * отката, и защитный снимок их вернёт.
 *
 * Отдельный случай — снимок формата 1: в нём денежных строк нет вообще, и любой
 * откат на него стирает всю кассу молча. Такой снимок требует подтверждения,
 * даже если платежей в базе ещё нет, а есть только начисления и услуги.
 */
async function assessRestore({ version, paymentRows, chargeRows, serviceRows }) {
  const [currentPayments, currentCharges, currentServices] = await Promise.all([
    prisma.payment.findMany({ select: { id: true, kind: true, amount: true, voidedAt: true } }),
    prisma.bookingCharge.findMany({ select: { id: true, amount: true } }),
    prisma.bookingService.findMany({ select: { id: true } }),
  ])

  const willRestorePayments = new Set(paymentRows.map(r => r.id))
  const willRestoreCharges  = new Set(chargeRows.map(r => r.id))
  const willRestoreServices = new Set(serviceRows.map(r => r.id))

  const lostPayments = currentPayments.filter(p => !willRestorePayments.has(p.id))
  const lostCharges  = currentCharges.filter(c => !willRestoreCharges.has(c.id))
  const lostServices = currentServices.filter(s => !willRestoreServices.has(s.id))

  const legacyWithMoney = version < 2 && (currentPayments.length > 0 || currentCharges.length > 0 || currentServices.length > 0)

  return {
    version,
    legacyFormat: version < 2,
    payments: {
      current: currentPayments.length,
      restored: paymentRows.length,
      lost: lostPayments.length,
      lostAmount: round2(lostPayments.reduce((s, p) => s + signedPayment(p), 0)),
    },
    charges: {
      current: currentCharges.length,
      restored: chargeRows.length,
      lost: lostCharges.length,
      lostAmount: round2(lostCharges.reduce((s, c) => s + (c.amount || 0), 0)),
    },
    services: {
      current: currentServices.length,
      restored: serviceRows.length,
      lost: lostServices.length,
    },
    requiresConfirmation: lostPayments.length > 0 || legacyWithMoney,
  }
}

/** Текст отказа: что именно исчезнет и что с этим делать. */
function moneyLossMessage(impact) {
  const lost = []
  if (impact.payments.lost > 0) {
    lost.push(`платежей — ${impact.payments.lost} (на ${formatMoney(impact.payments.lostAmount)} ₸)`)
  }
  if (impact.charges.lost > 0) lost.push(`начислений — ${impact.charges.lost}`)
  if (impact.services.lost > 0) lost.push(`услуг в бронях — ${impact.services.lost}`)

  const parts = ['Откат отменён: он удалит денежные записи, которых нет в снимке.']
  if (lost.length > 0) parts.push(`Будет стёрто: ${lost.join(', ')}.`)
  if (impact.legacyFormat) {
    parts.push('Снимок сделан в старом формате — он хранит только брони, вернуть из него кассу нечем.')
  }
  parts.push('Перед откатом создаётся защитный снимок, но потерю нужно подтвердить явно: повторите запрос с "allowMoneyLoss": true.')
  return parts.join(' ')
}

/**
 * Сводка последствий отката — для окна подтверждения. Ничего не меняет.
 */
async function describeRestore(id, adminId = null) {
  const plan = await prepareRestore(id, adminId)
  return {
    snapshot: plan.snapshot,
    bookings: {
      inSnapshot: plan.bookingRows.length + plan.skipped,
      restored: plan.bookingRows.length,
      skipped: plan.skipped,
    },
    charges: plan.impact.charges,
    payments: plan.impact.payments,
    services: { ...plan.impact.services, skipped: plan.skippedServices },
    legacyFormat: plan.impact.legacyFormat,
    version: plan.impact.version,
    requiresConfirmation: plan.impact.requiresConfirmation,
    warning: plan.impact.requiresConfirmation ? moneyLossMessage(plan.impact) : null,
  }
}

async function restoreSnapshot(id, adminId = null, options = {}) {
  const allowMoneyLoss = options.allowMoneyLoss === true
  const plan = await prepareRestore(id, adminId)
  const { bookingRows, chargeRows, paymentRows, serviceRows, refundLinks, impact } = plan

  if (impact.requiresConfirmation && !allowMoneyLoss) {
    logger.warn(
      `Snapshot #${id} restore refused: ${impact.payments.lost} payments `
      + `(${impact.payments.lostAmount}) would be lost, snapshot format v${impact.version}`,
    )
    const err = createError(moneyLossMessage(impact), 409)
    err.impact = impact
    throw err
  }

  restoreInProgress = true
  try {
    // Защитный снимок текущего состояния — на случай ошибочного отката.
    // Он в новом формате, поэтому «откат отката» вернёт и деньги тоже.
    await createSnapshot({
      kind: 'safety',
      label: `Перед откатом → «${plan.snapshot.label}»`,
      createdById: adminId,
    })

    await prisma.$transaction(async (tx) => {
      // Пересчёт последствий уже внутри транзакции: между показом предупреждения
      // и откатом второй администратор мог принять оплату, и её удаление было бы
      // ровно тем «молча», от которого защищаемся.
      if (!allowMoneyLoss) {
        const fresh = await tx.payment.findMany({ select: { id: true } })
        const willRestore = new Set(paymentRows.map(r => r.id))
        const lost = fresh.filter(p => !willRestore.has(p.id)).length
        if (lost > 0) {
          throw createError(
            `Откат отменён: пока подтверждали, в кассе появились новые платежи (${lost}). Проверьте последствия заново.`,
            409,
          )
        }
      }

      // Каскадом уходят начисления, платежи и услуги — все они вставляются ниже
      await tx.booking.deleteMany({})
      await createManyChunked(tx.booking, bookingRows)
      await createManyChunked(tx.bookingCharge, chargeRows)
      await createManyChunked(tx.payment, paymentRows)
      await createManyChunked(tx.bookingService, serviceRows)

      // Возврат ссылается на платёж из этого же набора — ставим ссылку, когда
      // все строки уже на месте (см. комментарий в prepareRestore)
      for (const link of refundLinks) {
        await tx.payment.update({
          where: { id: link.id },
          data: { refundOfId: link.refundOfId, ...(link.updatedAt ? { updatedAt: link.updatedAt } : {}) },
        })
      }

      // Счётчики автоинкремента — у КАЖДОЙ восстановленной таблицы: id вставлены
      // явные, и без сброса следующая же строка (новое начисление, новый платёж)
      // упрётся в занятый id.
      for (const table of ['Booking', 'BookingCharge', 'Payment', 'BookingService']) {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`,
        )
      }
    }, { timeout: 120000, maxWait: 20000 })
  } finally {
    restoreInProgress = false
  }

  // Сбрасываем кэш сетки и оповещаем подключённых клиентов
  try {
    const { invalidateGridCache } = require('../controllers/occupancyController')
    invalidateGridCache()
    const { getIO } = require('../socket/socketManager')
    getIO().to('bookings').emit('snapshot:restored', { snapshotId: id })
  } catch { /* socket/cache недоступны — не критично */ }

  logger.info(
    `Snapshot #${id} (v${plan.snapshot.version}) restored: ${bookingRows.length} bookings, `
    + `${chargeRows.length} charges, ${paymentRows.length} payments, ${serviceRows.length} services, `
    + `${plan.skipped} bookings skipped`,
  )

  return {
    restored: bookingRows.length,
    skipped: plan.skipped,
    charges: chargeRows.length,
    payments: paymentRows.length,
    services: serviceRows.length,
    skippedServices: plan.skippedServices,
    version: plan.snapshot.version,
    // Что снесли осознанно — чтобы это было видно и в журнале действий, и в ответе
    lostPayments: impact.payments.lost,
    lostPaymentsAmount: impact.payments.lostAmount,
  }
}

async function deleteSnapshot(id) {
  await prisma.snapshot.delete({ where: { id } })
}

module.exports = {
  createSnapshot,
  scheduleAuto,
  listSnapshots,
  describeRestore,
  restoreSnapshot,
  deleteSnapshot,
  SNAPSHOT_VERSION,
}
