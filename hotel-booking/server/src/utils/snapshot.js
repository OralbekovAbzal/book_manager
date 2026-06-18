const { prisma } = require('./prisma')
const logger = require('./logger')

// Сколько снимков каждого вида храним (ротация). JSON крошечный — диск не нагружает.
const RETENTION = {
  auto:   parseInt(process.env.SNAPSHOT_KEEP_AUTO   || '15', 10),
  shift:  parseInt(process.env.SNAPSHOT_KEEP_SHIFT  || '15', 10),
  manual: parseInt(process.env.SNAPSHOT_KEEP_MANUAL || '20', 10),
  safety: parseInt(process.env.SNAPSHOT_KEEP_SAFETY || '10', 10),
}

const AUTO_DEBOUNCE_MS = parseInt(process.env.SNAPSHOT_DEBOUNCE_MS || '1200', 10)

// Пока идёт восстановление — не делаем авто-снимки (чтобы не «снять» сам откат как изменение)
let restoreInProgress = false

// ─── Захват состояния ───────────────────────────────────────────────────────────

async function captureBookings() {
  const bookings = await prisma.booking.findMany({ orderBy: { id: 'asc' } })
  // Преобразуем Date → ISO-строки, чтобы значение было валидным JSON для колонки Json
  return JSON.parse(JSON.stringify(bookings))
}

// ─── Создание снимка ──────────────────────────────────────────────────────────────

async function createSnapshot({ kind, label, createdById = null }) {
  const bookings = await captureBookings()
  const snap = await prisma.snapshot.create({
    data: {
      kind,
      label,
      bookingCount: bookings.length,
      data: { bookings },
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
  return prisma.snapshot.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, kind: true, label: true, bookingCount: true, createdAt: true,
      createdBy: { select: { id: true, name: true } },
    },
  })
}

// ─── Восстановление ────────────────────────────────────────────────────────────────

const RESTORABLE_FIELDS = [
  'id', 'roomId', 'guestName', 'guestPhone', 'checkIn', 'checkOut', 'status',
  'source', 'notes', 'adultsWithMeals', 'childrenWithMeals', 'adultsNoMeals',
  'childrenNoMeals', 'extraBedsWithMeals', 'extraBedsNoMeals', 'disabledAdults',
  'disabledChildren', 'discountPercent', 'prepaymentPercent', 'totalAmount',
  'prepaidAmount', 'paidAmount', 'flags', 'partnerId', 'shiftId', 'adminId',
  'createdAt', 'updatedAt',
]

const DATE_FIELDS = ['checkIn', 'checkOut', 'createdAt', 'updatedAt']

async function restoreSnapshot(id, adminId = null) {
  const snap = await prisma.snapshot.findUnique({ where: { id } })
  if (!snap) throw new Error('Снимок не найден')

  const bookings = snap.data?.bookings ?? []

  // Действующие внешние ключи — чтобы восстановление не упало на удалённых сущностях
  const [rooms, admins, shifts, partners] = await Promise.all([
    prisma.room.findMany({ select: { id: true } }),
    prisma.admin.findMany({ select: { id: true } }),
    prisma.shift.findMany({ select: { id: true } }),
    prisma.partner.findMany({ select: { id: true } }),
  ])
  const roomIds    = new Set(rooms.map(r => r.id))
  const adminIds   = new Set(admins.map(a => a.id))
  const shiftIds   = new Set(shifts.map(s => s.id))
  const partnerIds = new Set(partners.map(p => p.id))

  const fallbackAdminId = adminId && adminIds.has(adminId)
    ? adminId
    : (admins[0]?.id ?? null)

  let skipped = 0
  const rows = []
  for (const b of bookings) {
    if (!roomIds.has(b.roomId)) { skipped++; continue }  // номер удалён — пропускаем

    const row = {}
    for (const f of RESTORABLE_FIELDS) {
      if (b[f] === undefined) continue
      row[f] = DATE_FIELDS.includes(f) && b[f] != null ? new Date(b[f]) : b[f]
    }
    // Чиним внешние ключи, которых уже нет
    if (!adminIds.has(row.adminId)) row.adminId = fallbackAdminId
    if (row.adminId == null) { skipped++; continue }
    if (row.shiftId != null && !shiftIds.has(row.shiftId)) row.shiftId = null
    if (row.partnerId != null && !partnerIds.has(row.partnerId)) row.partnerId = null
    rows.push(row)
  }

  restoreInProgress = true
  try {
    // Защитный снимок текущего состояния — на случай ошибочного отката
    await createSnapshot({
      kind: 'safety',
      label: `Перед откатом → «${snap.label}»`,
      createdById: adminId,
    })

    await prisma.$transaction(async (tx) => {
      await tx.booking.deleteMany({})
      if (rows.length > 0) {
        await tx.booking.createMany({ data: rows })
      }
    })

    // Сбрасываем счётчик автоинкремента, чтобы новые брони не конфликтовали по id
    await prisma.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('"Booking"', 'id'), COALESCE((SELECT MAX(id) FROM "Booking"), 0) + 1, false)`
    )
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

  logger.info(`Snapshot #${id} restored: ${rows.length} bookings, ${skipped} skipped`)
  return { restored: rows.length, skipped }
}

async function deleteSnapshot(id) {
  await prisma.snapshot.delete({ where: { id } })
}

module.exports = {
  createSnapshot,
  scheduleAuto,
  listSnapshots,
  restoreSnapshot,
  deleteSnapshot,
}
