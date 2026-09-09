#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  ДЕМО-ДАННЫЕ ДЛЯ ПОКАЗА. ЗАПУСКАТЬ ТОЛЬКО НА ПУСТОЙ ИЛИ ДЕМО-БАЗЕ.       ║
 * ║  Скрипт СТИРАЕТ всё, кроме главного администратора (одна учётка),        ║
 * ║  настроек объекта, лицензии и таблицы миграций, и записывает вместо      ║
 * ║  этого выдуманную базу отдыха. На рабочей базе отеля запускать НЕЛЬЗЯ.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Зачем он есть: пустая программа не продаётся. Клиенту показывают шахматку с
 * гостями, кассу с деньгами и отчёты с цифрами — значит эти данные должны
 * откуда-то взяться, причём СОГЛАСОВАННЫМИ с логикой программы.
 *
 * Поэтому здесь почти нет сырых INSERT'ов в деньги: начисления собираются теми же
 * функциями, что и сервер (`utils/charges.js` → `rebuildAutoCharges` /
 * `rebuildChainCharges`), а кэш `Booking.paidAmount` пересчитывается
 * `paymentController.recalcBookingPaid`. Иначе суммы в шахматке, кассе и отчётах
 * разошлись бы на тенге — и именно это увидел бы клиент на показе.
 *
 * Запуск:
 *   DATABASE_URL=postgresql://…/hotel_booking_demo node scripts/demo-seed.js --reset
 *   npm run db:demo -- --reset            (из hotel-booking/)
 *
 * Ключи:
 *   --reset            стереть прежние данные перед засевом (обязателен, если в
 *                      базе уже есть брони или платежи — защита от запуска на рабочей)
 *   --today=YYYY-MM-DD рабочая дата демо (по умолчанию — сегодняшняя, UTC).
 *                      От неё считаются смены, статусы броней и период данных.
 *   --occupancy=0.55   целевая заполняемость (0.2…0.9), влияет на плотность броней
 *   --quiet            без построчного вывода
 *
 * Идемпотентность: генератор случайных чисел детерминированный (seed от даты),
 * поэтому повторный запуск с теми же ключами даёт те же числа.
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

// Сервер работает в UTC (server.js), и все даты @db.Date хранятся UTC-полночью.
// Без этого арифметика дат ниже поехала бы на день в зависимости от зоны машины.
process.env.TZ = 'UTC'

const bcrypt = require('bcryptjs')
const { prisma } = require('../src/utils/prisma')
const {
  rebuildAutoCharges,
  rebuildChainCharges,
  replaceBookingServices,
} = require('../src/utils/charges')
const { recalcBookingPaid } = require('../src/controllers/paymentController')

// ─── Ключи запуска ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const optValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

const RESET = hasFlag('reset')
const QUIET = hasFlag('quiet')
const TARGET_OCCUPANCY = Math.min(0.9, Math.max(0.2, Number(optValue('occupancy', '0.62')) || 0.62))

const log = (...a) => { if (!QUIET) console.log(...a) }

// ─── Даты ─────────────────────────────────────────────────────────────────────

const DAY = 86400000

/** 'YYYY-MM-DD' | Date → UTC-полночь (так же, как хранит @db.Date). */
function d(v) {
  const x = new Date(v)
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()))
}
const addDays = (date, n) => new Date(date.getTime() + n * DAY)
const nights = (a, b) => Math.round((d(b) - d(a)) / DAY)
const iso = (date) => d(date).toISOString().slice(0, 10)
const monthStart = (date, shift = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + shift, 1))
const monthEnd = (date, shift = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + shift + 1, 0))
/** Время суток внутри местных суток отеля: сервер в UTC, Алматы +5 — 09:00 UTC = 14:00. */
const at = (date, hourUTC) => new Date(d(date).getTime() + hourUTC * 3600000)
const isWeekendNight = (date) => [5, 6].includes(d(date).getUTCDay()) // ночь с пт и с сб

const TODAY = d(optValue('today', new Date().toISOString().slice(0, 10)))
const FROM = monthStart(TODAY, -1)        // начало прошлого месяца
const TO = monthEnd(TODAY, 1)             // конец следующего месяца (последняя дата выезда)
const RATES_FROM = monthStart(TODAY, -2)
const RATES_TO = monthEnd(TODAY, 2)
const SHIFTS_FROM = FROM

// ─── Детерминированный ГПСЧ ───────────────────────────────────────────────────
// Повторный запуск обязан дать те же числа: иначе «проверь, что счётчики те же»
// невозможно, а демо-база после перезасева выглядит по-новому.

function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(Number(iso(TODAY).replace(/-/g, '')) % 2147483647)
const pick = (arr) => arr[Math.floor(rng() * arr.length)]
const int = (min, max) => min + Math.floor(rng() * (max - min + 1))
const chance = (p) => rng() < p

// ─── Справочные наборы ────────────────────────────────────────────────────────

const HOTEL = {
  name: 'База отдыха «Алтын Арқа»',
  city: 'Алматинская область',
  currency: 'KZT',
  pricingBase: 'person',
  legalName: 'ИП «Алтын Арқа»',
  bin: '870514300716',
  address: 'Алматинская область, Талгарский р-н, с. Бесагаш, ул. Жетысу, 14',
  phone: '+7 727 350 44 12',
  email: 'info@altynarka.kz',
  bankName: 'АО «Kaspi Bank»',
  iban: 'KZ86125KZT5004100100',
  signerName: 'Сейткали А. Б.',
  signerTitle: 'Директор',
}

const ADMINS = [
  { username: 'aigerim', name: 'Айгерим Сейткали', role: 'SUPER_ADMIN' },
  { username: 'erlan', name: 'Ерлан Абдрахманов', role: 'ADMIN' },
  { username: 'madina', name: 'Мадина Оспанова', role: 'ADMIN' },
]
const DEMO_PASSWORD = 'Demo2026!'

const BUILDINGS = [
  { code: 'main', name: 'ГЛАВНЫЙ КОРПУС', description: 'Двухэтажный корпус с рестораном и конференц-залом', order: 0 },
  { code: 'cottages', name: 'КОТТЕДЖИ', description: 'Отдельные двухэтажные коттеджи у озера', order: 1 },
  { code: 'eco', name: 'ЭКО-ДОМИКИ', description: 'Деревянные домики в сосновой роще', order: 2 },
]

const CATEGORIES = [
  { name: 'Стандарт', color: '#C0DD97', description: 'Номер с двумя кроватями, душ' },
  { name: 'Комфорт', color: '#B5D4F4', description: 'Улучшенный номер с балконом' },
  { name: 'Люкс', color: '#D4A8E1', description: 'Двухкомнатный номер с видом на горы' },
  { name: 'Семейный коттедж', color: '#FAC775', description: 'Отдельный коттедж на 4–6 человек' },
  { name: 'Эко-домик', color: '#9FD8CB', description: 'Домик из бруса на 2–3 человека' },
]

const FEATURES = [
  { code: 'balcony', name: 'Балкон', emoji: '🪟', order: 0 },
  { code: 'mountain_view', name: 'Вид на горы', emoji: '🏔', order: 1 },
  { code: 'lake_view', name: 'Вид на озеро', emoji: '🏞', order: 2 },
  { code: 'jacuzzi', name: 'Джакузи', emoji: '🛁', order: 3 },
  { code: 'ac', name: 'Кондиционер', emoji: '❄️', order: 4 },
  { code: 'fireplace', name: 'Камин', emoji: '🔥', order: 5 },
  { code: 'terrace', name: 'Терраса', emoji: '🌿', order: 6 },
]

const CAPACITIES = [
  { code: 'single', label: 'Одноместный', value: 1, order: 0 },
  { code: 'double', label: 'Двухместный', value: 2, order: 1 },
  { code: 'triple', label: 'Трёхместный', value: 3, order: 2 },
  { code: 'quad', label: 'Четырёхместный', value: 4, order: 3 },
  { code: 'family', label: 'Шестиместный', value: 6, order: 4 },
]

// Метки — те же коды, что в electron/db/seed.sql: демо не должно вводить свой словарь.
const FLAGS = [
  { code: 'late_checkout', label: 'Поздний выезд', color: '#F4A8A8', effects: { bufferAfter: 1 }, order: 1 },
  { code: 'vip', label: 'VIP', color: '#E1C84A', effects: {}, order: 2 },
  { code: 'no_move', label: 'Не перемещать', color: '#A8C8F4', effects: { pin: true }, order: 3 },
]

// Цена за взрослого в будни, базовый сезон. Выходные +20 %, август +15 %, октябрь −10 %.
const CATEGORY_PRICING = {
  'Стандарт':         { adult: 14000, child: 8000, extraBed: 7000, base: 2 },
  'Комфорт':          { adult: 18000, child: 10000, extraBed: 9000, base: 2 },
  'Люкс':             { adult: 26000, child: 15000, extraBed: 13000, base: 2 },
  'Семейный коттедж': { adult: 22000, child: 12000, extraBed: 11000, base: 4 },
  'Эко-домик':        { adult: 20000, child: 11000, extraBed: 10000, base: 2 },
}

const SERVICES = [
  // Коды питания — те же, что в `POST /api/services/defaults`: пресеты MealPlan
  // ссылаются на них по коду, и свой словарь здесь сломал бы кнопки «BB/HB/FB».
  { code: 'breakfast', name: 'Завтрак', price: 3500, childPrice: 2000, unit: 'per_person_night', kind: 'meal', includedByDefault: true, order: 1 },
  { code: 'lunch', name: 'Обед', price: 4500, childPrice: 2500, unit: 'per_person_night', kind: 'meal', includedByDefault: false, order: 2 },
  { code: 'dinner', name: 'Ужин', price: 5000, childPrice: 3000, unit: 'per_person_night', kind: 'meal', includedByDefault: false, order: 3 },
  { code: 'sauna', name: 'Баня на дровах', price: 18000, childPrice: null, unit: 'per_booking', kind: 'extra', includedByDefault: false, order: 4 },
  { code: 'transfer', name: 'Трансфер из Алматы', price: 7000, childPrice: null, unit: 'per_person', kind: 'extra', includedByDefault: false, order: 5 },
  { code: 'bikes', name: 'Прокат велосипедов', price: 3000, childPrice: null, unit: 'per_night', kind: 'extra', includedByDefault: false, order: 6 },
  { code: 'kids_club', name: 'Детская анимация', price: 2500, childPrice: 2500, unit: 'per_person_night', kind: 'extra', includedByDefault: false, order: 7 },
]

const MEAL_PLANS = [
  { code: 'no_meals', name: 'Без питания', serviceCodes: [], order: 1 },
  { code: 'bb', name: 'Только завтрак', serviceCodes: ['breakfast'], order: 2 },
  { code: 'hb', name: 'Полупансион', serviceCodes: ['breakfast', 'dinner'], order: 3 },
  { code: 'fb', name: 'Полный пансион', serviceCodes: ['breakfast', 'lunch', 'dinner'], order: 4 },
]

const CONTACTS = [
  { name: 'Скорая помощь', role: 'Единый номер', group: 'Экстренные', phones: ['103'], isPinned: true, order: 0 },
  { name: 'Пожарная служба', role: 'Единый номер', group: 'Экстренные', phones: ['101'], isPinned: true, order: 1 },
  { name: 'Полиция', role: 'Талгарский РОВД', group: 'Экстренные', phones: ['102', '+7 727 296 11 20'], isPinned: true, order: 2 },
  { name: 'Такси «Бесагаш»', role: 'Диспетчер', group: 'Службы отеля', phones: ['+7 701 334 88 21'], notes: 'Подача 15–20 мин, до Алматы 6 000 ₸', order: 3 },
  { name: 'Прачечная «Ак Жол»', role: 'Приём белья', group: 'Подрядчики', phones: ['+7 705 118 40 07'], notes: 'Забирают по вторникам и пятницам до 11:00', order: 4 },
  { name: 'Аварийная служба', role: 'Электрика и отопление', group: 'Подрядчики', phones: ['+7 747 902 55 13'], notes: 'Круглосуточно, выезд до 40 мин', isPinned: true, order: 5 },
  { name: 'Поставщик воды «Тау Су»', role: 'Менеджер Аскар', group: 'Подрядчики', phones: ['+7 702 445 19 66'], notes: 'Доставка 19 л, заявка до 16:00', order: 6 },
  { name: 'Вывоз мусора', role: 'ТОО «Тазалык Талгар»', group: 'Подрядчики', phones: ['+7 727 388 12 04'], order: 7 },
  { name: 'Шеф-повар Нурбол', role: 'Кухня', group: 'Сотрудники', phones: ['+7 777 210 63 45'], notes: 'Смена с 07:00', order: 8 },
  { name: 'Завхоз Галина Петровна', role: 'Хозчасть', group: 'Сотрудники', phones: ['+7 701 556 72 39'], order: 9 },
]

const PARTNERS = [
  {
    name: 'Kompas Travel', color: '#4F8DF7', defaultCheckInDay: 5, defaultNights: 2,
    commissionPercent: 12, contactPerson: 'Жанна Тулегенова', contactPhone: '+7 727 344 90 10',
    notes: 'Квота на коттеджи по выходным сентября, отчёт по заездам раз в месяц',
  },
  {
    name: 'Corporate — Kaspi Team Building', color: '#E0544C', defaultCheckInDay: 5, defaultNights: 2,
    commissionPercent: null, contactPerson: 'Ержан Смагулов', contactPhone: '+7 701 700 12 00',
    notes: 'Корпоративные выезды, оплата по счёту на юрлицо',
  },
]

// Источники брони — только те, что принимает валидатор `routes/bookings.js`
// (SOURCES) и предлагает форма. Партнёрские заезды помечаются заметкой,
// а не своим источником: иначе такую бронь нельзя было бы сохранить из формы.
const SOURCES = ['стойка', 'телефон', 'онлайн', 'Каспи']

const FIRST_M = ['Нурлан', 'Тимур', 'Ерлан', 'Данияр', 'Аскар', 'Бауыржан', 'Азамат', 'Серик', 'Алексей', 'Дмитрий', 'Сергей', 'Игорь', 'Максим', 'Виктор', 'Арман', 'Санжар', 'Олжас', 'Рустам']
const FIRST_F = ['Асель', 'Дина', 'Айгуль', 'Гульнара', 'Жанна', 'Сауле', 'Мадина', 'Алия', 'Ольга', 'Елена', 'Наталья', 'Ирина', 'Светлана', 'Татьяна', 'Анна', 'Камила', 'Динара', 'Марина']
const LAST_M = ['Бекенов', 'Жаксыбеков', 'Каримов', 'Абишев', 'Оспанов', 'Сериков', 'Нурланов', 'Смирнов', 'Ковалёв', 'Петров', 'Соколов', 'Ким', 'Ахметов', 'Досжанов', 'Байжанов', 'Волков']
const LAST_F = ['Бекенова', 'Жаксыбекова', 'Каримова', 'Абишева', 'Оспанова', 'Серикова', 'Нурланова', 'Смирнова', 'Ковалёва', 'Петрова', 'Соколова', 'Ким', 'Ахметова', 'Досжанова', 'Байжанова', 'Волкова']

const NOTES_POOL = [
  'Поздний заезд после 22:00, предупредить охрану',
  'Аллергия на орехи — передать на кухню',
  'Годовщина свадьбы, заказали торт к ужину',
  'Просят номер подальше от ресторана',
  'Едут с собакой (маленькая, в переноске)',
  'Нужна детская кроватка',
  'Оплата по счёту на юрлицо, счёт отправлен',
  'Постоянный гость, третий заезд за год',
  'Заезд от Kompas Travel, ваучер №KT-2261',
  'Корпоративный выезд Kaspi, счёт на компанию',
  'Просили тихий номер, работают удалённо',
  'Ранний завтрак к 07:00 — уезжают в горы',
]

const CITIZENSHIPS = ['Казахстан', 'Казахстан', 'Казахстан', 'Казахстан', 'Россия', 'Кыргызстан', 'Узбекистан']

// ─── Очистка ──────────────────────────────────────────────────────────────────

/**
 * Стирает всё, что засевает этот скрипт. Не трогает: одну учётку главного
 * администратора (её переименовывает засев — иначе на свежей установке после
 * мастера пропала бы единственная возможность войти), `HotelSettings` (строка
 * обновляется), `License` и `_prisma_migrations`.
 *
 * Порядок продиктован внешними ключами: `Booking.adminId` и `Shift.createdById`
 * обязательные, поэтому учётки уходят последними.
 */
async function resetDemoData(keepAdminId) {
  const steps = [
    ['Payment', () => prisma.payment.deleteMany({})],
    ['BookingCharge', () => prisma.bookingCharge.deleteMany({})],
    ['BookingService', () => prisma.bookingService.deleteMany({})],
    // accountBookingId — самоссылка с ON DELETE SET NULL, поэтому массовое
    // удаление проходит без предварительного обнуления ссылок.
    ['Booking', () => prisma.booking.deleteMany({})],
    ['Snapshot', () => prisma.snapshot.deleteMany({})],
    ['AuditLog', () => prisma.auditLog.deleteMany({})],
    ['BackupLog', () => prisma.backupLog.deleteMany({})],
    ['Release', () => prisma.release.deleteMany({})],
    ['Allotment', () => prisma.allotment.deleteMany({})],
    ['Partner', () => prisma.partner.deleteMany({})],
    ['Shift', () => prisma.shift.deleteMany({})],
    ['Room', () => prisma.room.deleteMany({})],
    ['RatePrice', () => prisma.ratePrice.deleteMany({})],
    ['Category', () => prisma.category.deleteMany({})],
    ['Contact', () => prisma.contact.deleteMany({})],
    ['Service', () => prisma.service.deleteMany({})],
    ['MealPlan', () => prisma.mealPlan.deleteMany({})],
    ['BookingFlag', () => prisma.bookingFlag.deleteMany({})],
    ['Building', () => prisma.building.deleteMany({})],
    ['RoomFeature', () => prisma.roomFeature.deleteMany({})],
    ['RoomCapacity', () => prisma.roomCapacity.deleteMany({})],
    ['ReportDefinition', () => prisma.reportDefinition.deleteMany({})],
    ['Admin (кроме главного)', () => prisma.admin.deleteMany({ where: { id: { not: keepAdminId } } })],
  ]
  for (const [name, run] of steps) {
    const { count } = await run()
    if (count > 0) log(`  очищено ${name}: ${count}`)
  }
}

// ─── Справочники ──────────────────────────────────────────────────────────────

async function seedAdmins(keepAdminId) {
  const hash = await bcrypt.hash(DEMO_PASSWORD, 12)
  const out = []
  // Главную учётку ПЕРЕИМЕНОВЫВАЕМ, а не создаём заново: на свежей установке
  // после мастера это единственная запись, на которую ссылаются старые снимки
  // и журнал, и удалять её ради одинакового кода было бы дороже.
  out.push(await prisma.admin.update({
    where: { id: keepAdminId },
    data: { ...ADMINS[0], password: hash, isActive: true },
  }))
  for (const a of ADMINS.slice(1)) {
    out.push(await prisma.admin.create({ data: { ...a, password: hash, isActive: true } }))
  }
  return out
}

async function seedHotelSettings() {
  return prisma.hotelSettings.upsert({
    where: { id: 1 },
    update: { ...HOTEL, setupCompletedAt: new Date() },
    create: { id: 1, ...HOTEL, setupCompletedAt: new Date() },
  })
}

async function seedDirectories() {
  for (const b of BUILDINGS) await prisma.building.create({ data: b })
  for (const f of FEATURES) await prisma.roomFeature.create({ data: f })
  for (const c of CAPACITIES) await prisma.roomCapacity.create({ data: c })
  for (const f of FLAGS) await prisma.bookingFlag.create({ data: f })

  const categories = new Map()
  for (const c of CATEGORIES) {
    const row = await prisma.category.create({ data: c })
    categories.set(c.name, row)
  }

  const services = new Map()
  for (const s of SERVICES) {
    const row = await prisma.service.create({ data: { ...s, isActive: true } })
    services.set(s.code, row)
  }
  for (const p of MEAL_PLANS) await prisma.mealPlan.create({ data: p })
  for (const c of CONTACTS) await prisma.contact.create({ data: { ...c, isActive: true } })

  return { categories, services }
}

/**
 * Номерной фонд. `Room.building` — НАЗВАНИЕ корпуса в верхнем регистре,
 * `Room.features` — НАЗВАНИЯ особенностей, `Room.capacity` — КОД вместимости:
 * связь со справочниками идёт строками, без внешних ключей (см. schema.prisma).
 */
async function seedRooms(categories) {
  const plan = []

  // Главный корпус, 1 этаж: 101–118 — стандарт и комфорт
  for (let n = 101; n <= 118; n++) {
    const isComfort = n >= 113
    plan.push({
      number: String(n), category: isComfort ? 'Комфорт' : 'Стандарт',
      building: 'ГЛАВНЫЙ КОРПУС', floor: 1,
      capacity: n % 6 === 0 ? 'triple' : 'double',
      features: isComfort ? ['Кондиционер', 'Балкон'] : ['Кондиционер'],
    })
  }
  // Главный корпус, 2 этаж: 201–216 — комфорт и люкс
  for (let n = 201; n <= 216; n++) {
    const isLux = n >= 213
    plan.push({
      number: String(n), category: isLux ? 'Люкс' : 'Комфорт',
      building: 'ГЛАВНЫЙ КОРПУС', floor: 2,
      capacity: isLux ? 'triple' : (n % 5 === 0 ? 'triple' : 'double'),
      features: isLux
        ? ['Кондиционер', 'Балкон', 'Вид на горы', 'Джакузи']
        : ['Кондиционер', 'Балкон', n % 2 === 0 ? 'Вид на горы' : 'Вид на озеро'],
    })
  }
  // Коттеджи К-1…К-6
  for (let i = 1; i <= 6; i++) {
    plan.push({
      number: `К-${i}`, category: 'Семейный коттедж', building: 'КОТТЕДЖИ', floor: 1,
      capacity: i <= 4 ? 'family' : 'quad',
      features: ['Терраса', 'Камин', 'Вид на озеро', ...(i <= 2 ? ['Джакузи'] : [])],
    })
  }
  // Эко-домики Э-1…Э-6
  for (let i = 1; i <= 6; i++) {
    plan.push({
      number: `Э-${i}`, category: 'Эко-домик', building: 'ЭКО-ДОМИКИ', floor: 1,
      capacity: i % 3 === 0 ? 'triple' : 'double',
      features: ['Терраса', 'Вид на горы', ...(i % 2 === 0 ? ['Камин'] : [])],
    })
  }

  const rooms = []
  for (const r of plan) {
    rooms.push(await prisma.room.create({
      data: {
        number: r.number,
        categoryId: categories.get(r.category).id,
        building: r.building,
        floor: r.floor,
        features: r.features,
        capacity: r.capacity,
        isActive: true,
      },
      include: { category: true },
    }))
  }
  return rooms
}

/**
 * Календарь цен на пять месяцев (текущий ± 2) по всем категориям.
 * `pricingBase = 'person'`, поэтому работают `adultPrice/childPrice/extraBedPrice`;
 * `roomPrice` заполняем тем же расчётом на случай, если объект переключат на
 * цену за номер — иначе после переключения весь календарь оказался бы пустым.
 */
async function seedRates(categories) {
  const rows = []
  for (const [name, p] of Object.entries(CATEGORY_PRICING)) {
    const categoryId = categories.get(name).id
    for (let t = RATES_FROM.getTime(); t <= RATES_TO.getTime(); t += DAY) {
      const date = new Date(t)
      const month = date.getUTCMonth()
      // Сезон: середина лета дороже, поздняя осень дешевле — иначе отчёт
      // «выручка по месяцам» рисует прямую линию и ничего не показывает.
      const season = month === 6 ? 1.2 : month === 7 ? 1.15 : month === 8 ? 1.0 : month === 9 ? 0.9 : 0.85
      const weekend = isWeekendNight(date) ? 1.2 : 1
      const k = season * weekend
      const r = (v) => Math.round(v * k / 500) * 500
      rows.push({
        categoryId,
        date,
        adultPrice: r(p.adult),
        childPrice: r(p.child),
        extraBedPrice: r(p.extraBed),
        roomPrice: r(p.adult * p.base),
      })
    }
  }
  await prisma.ratePrice.createMany({ data: rows })
  return rows.length
}

async function seedShifts(adminIds) {
  const rows = []
  for (let t = SHIFTS_FROM.getTime(); t <= TODAY.getTime(); t += DAY) {
    rows.push({ date: new Date(t), createdById: pick(adminIds), createdAt: at(new Date(t), 5) })
  }
  await prisma.shift.createMany({ data: rows })
  const shifts = await prisma.shift.findMany({ orderBy: { date: 'asc' } })
  const byDate = new Map(shifts.map((s) => [iso(s.date), s]))
  return { shifts, byDate }
}

// ─── Планирование броней ──────────────────────────────────────────────────────

/**
 * Раскладка по одному номеру: цепочка непересекающихся отрезков от начала периода
 * до конца. Пересечения физически запрещены constraint'ом `booking_no_overlap`,
 * но полагаться на отказ базы нельзя — скрипт обязан не падать, поэтому даты
 * подбираются заведомо непересекающимися, а зазор между соседями ≥ 1 дня там,
 * где стоит метка с буфером (`late_checkout` → bufferAfter 1).
 *
 * Даты полуоткрытые: выезд в день заезда следующего гостя пересечением НЕ является,
 * поэтому нулевой зазор допустим — он и даёт «плотную» шахматку.
 */
function planRoomStays(blockedRanges) {
  const stays = []
  // Раскладку начинаем РАНЬШЕ показываемого периода и обрываем позже него.
  // Иначе у первого дня видно «ступеньку»: каждый номер начинает свою цепочку
  // с зазора, и 1 августа в шахматке стояло три брони вместо тридцати
  // (проверено на первой версии), а последний день был забит выездами.
  let cursor = addDays(FROM, -12)

  // Средняя ночёвка по распределению ниже ≈ 5,75. Зазор подбираем от целевой
  // заполняемости, вычитая ~0,5 дня, которые в среднем съедает сдвиг заезда
  // к пятнице (иначе шахматка выходит заметно реже заказанного).
  const meanStay = 5.75
  const meanGap = Math.max(0.3, meanStay * (1 - TARGET_OCCUPANCY) / TARGET_OCCUPANCY - 0.5)

  const blocked = (from, to) => blockedRanges.some((b) => from < b.to && to > b.from)

  // Сезон: конец лета плотнее, глубокая осень реже — иначе три месяца выглядят
  // одинаково и отчёт «загрузка по месяцам» ничего не показывает.
  const density = (date) => {
    const m = date.getUTCMonth() - TODAY.getUTCMonth()
    return m < 0 ? 0.75 : m === 0 ? 1 : 1.6
  }

  let guard = 0
  while (cursor < TO && guard++ < 200) {
    const gap = Math.round(rng() * meanGap * 2 * density(cursor))
    cursor = addDays(cursor, gap)
    if (cursor >= TO) break

    let n
    const roll = rng()
    if (roll < 0.35) {
      // Заезд на выходные: сдвигаем к ближайшей пятнице — так выходные заполнены
      // плотнее будней, как в живом загородном отеле. Сдвиг дальше трёх дней не
      // делаем: он выел бы половину будней и уронил общую заполняемость.
      const delta = (5 - cursor.getUTCDay() + 7) % 7
      if (delta <= 3) cursor = addDays(cursor, delta)
      n = chance(0.7) ? 2 : 3
    } else if (roll < 0.75) {
      n = int(4, 7)
    } else {
      n = int(8, 14)
    }
    if (cursor >= TO) break

    const checkIn = cursor
    // Последний отрезок НЕ обрезаем по границе периода: обрезка собрала бы все
    // выезды в один день. Тарифы заведены с запасом в месяц по обе стороны.
    const checkOut = addDays(checkIn, n)

    if (blocked(checkIn, checkOut)) {
      // Номер выделен партнёру на этот период — квоту не продаём, ждём её конца
      const hit = blockedRanges.find((b) => checkIn < b.to && checkOut > b.from)
      cursor = hit.to
      continue
    }

    stays.push({ checkIn, checkOut })
    cursor = checkOut
  }
  // Разгонные отрезки, целиком оставшиеся до начала периода, в базу не пишем:
  // они нужны были только чтобы 1-е число уже было занято.
  return stays.filter((s) => s.checkOut > FROM)
}

/** Сколько дней свободно после этого отрезка — от этого зависит право на метку с буфером. */
function gapAfter(stays, i) {
  const next = stays[i + 1]
  return next ? nights(stays[i].checkOut, next.checkIn) : 999
}

function guestFor(capacityValue) {
  const female = chance(0.5)
  const name = female
    ? `${pick(FIRST_F)} ${pick(LAST_F)}`
    : `${pick(FIRST_M)} ${pick(LAST_M)}`
  const maxAdults = Math.max(1, Math.min(capacityValue, 4))
  let adults = int(1, maxAdults)
  let children = 0
  if (capacityValue >= 3 && chance(0.35)) children = int(1, Math.min(3, capacityValue - adults + 1))
  if (adults + children > capacityValue + 1) adults = Math.max(1, capacityValue - children)
  const extraBeds = (adults + children) > capacityValue ? 1 : (chance(0.08) ? 1 : 0)
  return { guestName: name, sex: female ? 'f' : 'm', adults, children, extraBeds }
}

function phone() {
  const codes = ['700', '701', '702', '705', '707', '747', '771', '775', '777', '778']
  return `+7 ${pick(codes)} ${int(100, 999)} ${String(int(0, 9999)).padStart(4, '0')}`
}

/** Номер удостоверения / паспорта РК — выдуманный, но в правильном формате. */
function docNumber() {
  return `N${String(int(0, 99999999)).padStart(8, '0')}`
}

// ─── Засев броней ─────────────────────────────────────────────────────────────

async function seedBookings({ rooms, capacityByCode, services, adminIds, shiftByDate, quotaBlocks }) {
  const created = []
  const plans = []

  for (const room of rooms) {
    const blocked = quotaBlocks.get(room.id) || []
    const stays = planRoomStays(blocked)
    stays.forEach((s, i) => plans.push({ room, ...s, gapAfter: gapAfter(stays, i) }))
  }

  // Ремонтный блок — одна комната выведена из продажи. Гостей ноль, поэтому
  // генератор начислений не выпишет ни строки: ремонт не продажа, и в выручку
  // он попасть не должен (в отчётах он отдельно помечен `isMaintenance`).
  const repairRoom = rooms.find((r) => r.number === '118')
  const repairFrom = addDays(TODAY, -4)
  const repairTo = addDays(TODAY, 16)
  const cleared = plans.filter((p) => !(p.room.id === repairRoom.id && p.checkIn < repairTo && p.checkOut > repairFrom))

  cleared.sort((a, b) => a.checkIn - b.checkIn || a.room.id - b.room.id)

  // Кого объявляем отменённым и незаехавшим: берём брони второй половины периода,
  // чтобы отмены не приходились только на август.
  const cancellable = cleared.filter((p) => p.checkIn >= addDays(TODAY, -20))
  const cancelledSet = new Set()
  for (let i = 0; i < 60 && cancelledSet.size < 7 && cancellable.length; i++) {
    cancelledSet.add(cancellable[Math.floor(rng() * cancellable.length)])
  }
  const noShowPool = cleared.filter((p) => p.checkOut <= TODAY && p.checkIn >= FROM && !cancelledSet.has(p))
  const noShowSet = new Set()
  for (let i = 0; i < 30 && noShowSet.size < 2 && noShowPool.length; i++) {
    noShowSet.add(noShowPool[Math.floor(rng() * noShowPool.length)])
  }

  const svc = (code) => services.get(code)
  let n = 0

  for (const p of cleared) {
    const capValue = capacityByCode.get(p.room.capacity)?.value || 2
    const g = guestFor(capValue)
    const stayNights = nights(p.checkIn, p.checkOut)

    let status
    if (cancelledSet.has(p)) status = 'CANCELLED'
    else if (noShowSet.has(p)) status = 'NO_SHOW'
    else if (p.checkOut <= TODAY) status = 'CHECKED_OUT'
    else if (p.checkIn <= TODAY) status = 'CHECKED_IN'
    else status = 'CONFIRMED'

    // Метка с буфером — только там, где после брони действительно есть свободный день
    const flags = []
    if (chance(0.15)) {
      if (chance(0.4) && p.gapAfter >= 1) flags.push('late_checkout')
      else flags.push(chance(0.7) ? 'vip' : 'no_move')
    }

    const source = pick(SOURCES)
    const withDoc = chance(0.3)
    const createdAt = at(
      new Date(Math.max(
        FROM.getTime() - 20 * DAY,
        Math.min(TODAY.getTime(), p.checkIn.getTime() - int(2, 45) * DAY),
      )),
      7,
    )

    const data = {
      roomId: p.room.id,
      guestName: g.guestName,
      guestPhone: phone(),
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      status,
      source,
      notes: chance(0.28) ? pick(NOTES_POOL) : null,
      adultsWithMeals: g.adults,
      childrenWithMeals: g.children,
      adultsNoMeals: 0,
      childrenNoMeals: 0,
      extraBedsWithMeals: g.extraBeds,
      extraBedsNoMeals: 0,
      disabledAdults: 0,
      disabledChildren: 0,
      discountPercent: chance(0.12) ? pick([5, 10, 15]) : 0,
      prepaymentPercent: pick([30, 40, 50, 50]),
      flags,
      shiftId: shiftByDate.get(iso(createdAt))?.id ?? null,
      adminId: pick(adminIds),
      createdAt,
    }

    if (withDoc) {
      data.guestCitizenship = pick(CITIZENSHIPS)
      data.guestDocType = data.guestCitizenship === 'Казахстан' ? (chance(0.7) ? 'id_card' : 'passport') : 'passport'
      data.guestDocNumber = docNumber()
      data.guestDocExpiry = d(`${TODAY.getUTCFullYear() + int(1, 8)}-${String(int(1, 12)).padStart(2, '0')}-15`)
      data.guestBirthDate = d(`${TODAY.getUTCFullYear() - int(20, 60)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`)
      data.guestSex = g.sex
    }
    if (status === 'CHECKED_IN' || status === 'CHECKED_OUT') {
      data.actualCheckInAt = at(p.checkIn, chance(0.15) ? 17 : 9)
    }
    if (status === 'CHECKED_OUT') {
      data.actualCheckOutAt = at(p.checkOut, flags.includes('late_checkout') ? 10 : 6)
    }

    const booking = await prisma.booking.create({ data })

    // Питание и услуги: набор передаём явно, а не полагаемся на
    // `includedByDefault` — демо должно быть воспроизводимым.
    const links = []
    const mealRoll = rng()
    const eaters = { adults: g.adults + g.extraBeds, children: g.children }
    if (mealRoll < 0.45) links.push({ serviceId: svc('breakfast').id, ...eaters, quantity: 1 })
    else if (mealRoll < 0.75) {
      links.push({ serviceId: svc('breakfast').id, ...eaters, quantity: 1 })
      links.push({ serviceId: svc('dinner').id, ...eaters, quantity: 1 })
    } else if (mealRoll < 0.9) {
      links.push({ serviceId: svc('breakfast').id, ...eaters, quantity: 1 })
      links.push({ serviceId: svc('lunch').id, ...eaters, quantity: 1 })
      links.push({ serviceId: svc('dinner').id, ...eaters, quantity: 1 })
    }
    if (chance(0.2)) links.push({ serviceId: svc('sauna').id, adults: 0, children: 0, quantity: 1 })
    if (chance(0.15)) links.push({ serviceId: svc('transfer').id, adults: g.adults, children: g.children, quantity: 1 })
    if (chance(0.1) && stayNights >= 3) links.push({ serviceId: svc('bikes').id, adults: 0, children: 0, quantity: 1 })
    if (g.children > 0 && chance(0.35)) links.push({ serviceId: svc('kids_club').id, adults: 0, children: g.children, quantity: 1 })

    await replaceBookingServices(booking.id, links)

    created.push({ ...p, booking, status, guest: g, nights: stayNights })
    n++
  }

  // Ремонтный блок пишем последним — он не участвует ни в статусах, ни в деньгах.
  const repair = await prisma.booking.create({
    data: {
      roomId: repairRoom.id,
      guestName: 'Ремонт',
      checkIn: repairFrom,
      checkOut: repairTo,
      status: 'CONFIRMED',
      source: 'ремонт',
      notes: 'Замена сантехники и покраска, подрядчик «Тау Сервис»',
      prepaymentPercent: 0,
      adminId: adminIds[0],
      shiftId: shiftByDate.get(iso(repairFrom))?.id ?? null,
      createdAt: at(repairFrom, 6),
    },
  })

  return { created, repair, planned: n }
}

/**
 * Три переезда. Голова закрывается датой переезда (CHECKED_OUT + фактический выезд),
 * продолжение создаётся в свободном номере со ссылкой `accountBookingId` на голову —
 * ровно так, как это делает `bookingController.move`. Деньги остаются на голове.
 */
async function seedChains({ created, rooms, occupied, adminIds, quotaBlocks }) {
  const chains = []
  const candidates = created.filter((c) => c.status === 'CHECKED_IN' && c.nights >= 4)

  for (const head of candidates) {
    if (chains.length >= 3) break
    const moveDate = addDays(head.checkIn, Math.max(1, Math.floor(head.nights / 2)))
    if (moveDate >= head.checkOut || moveDate > TODAY) continue

    const free = (r) => {
      if (r.id === head.room.id) return false
      // Квотный номер продавать нельзя (оптимизатор и подбор его тоже обходят),
      // а ремонтный блок лежит в `occupied` наравне с бронями.
      if ((quotaBlocks.get(r.id) || []).some((q) => moveDate < q.to && head.checkOut > q.from)) return false
      const list = occupied.get(r.id) || []
      return !list.some((b) => moveDate < b.checkOut && head.checkOut > b.checkIn)
    }
    // Переезд в ДРУГУЮ категорию интереснее для показа: в одном счёте видно
    // ночи по разной цене — ровно то, ради чего сделана цепочка.
    const target = rooms.find((r) => r.categoryId !== head.room.categoryId && free(r))
      || rooms.find(free)
    if (!target) continue

    await prisma.booking.update({
      where: { id: head.booking.id },
      data: {
        checkOut: moveDate,
        status: 'CHECKED_OUT',
        actualCheckOutAt: at(moveDate, 8),
        notes: [head.booking.notes, `Переезд в №${target.number} (${iso(moveDate)})`].filter(Boolean).join(' · '),
      },
    })

    const cont = await prisma.booking.create({
      data: {
        roomId: target.id,
        guestName: head.booking.guestName,
        guestPhone: head.booking.guestPhone,
        checkIn: moveDate,
        checkOut: head.checkOut,
        status: 'CHECKED_IN',
        source: head.booking.source,
        notes: `Переезд из №${head.room.number} (${iso(moveDate)})`,
        adultsWithMeals: head.booking.adultsWithMeals,
        childrenWithMeals: head.booking.childrenWithMeals,
        extraBedsWithMeals: head.booking.extraBedsWithMeals,
        discountPercent: head.booking.discountPercent,
        prepaymentPercent: head.booking.prepaymentPercent,
        accountBookingId: head.booking.id,
        totalAmount: 0, prepaidAmount: 0, paidAmount: 0,
        flags: head.booking.flags,
        actualCheckInAt: at(moveDate, 8),
        adminId: pick(adminIds),
        shiftId: head.booking.shiftId,
        createdAt: at(moveDate, 8),
      },
    })

    // Питание и услуги переезжают на продолжение — счёт один, и его набор
    // всегда у текущего отрезка (так же делает `move`).
    await prisma.bookingService.updateMany({
      where: { bookingId: head.booking.id },
      data: { bookingId: cont.id },
    })

    occupied.get(target.id).push({ checkIn: moveDate, checkOut: head.checkOut })
    head.movedTo = cont
    head.status = 'CHECKED_OUT'
    chains.push({ headId: head.booking.id, contId: cont.id })
  }
  return chains
}

// ─── Деньги ───────────────────────────────────────────────────────────────────

async function buildCharges({ created, chains, adminIds }) {
  const chainHeads = new Set(chains.map((c) => c.headId))
  let withCharges = 0

  for (const c of created) {
    const id = c.booking.id
    if (chainHeads.has(id)) {
      await rebuildChainCharges(id, { adminId: adminIds[0] })
      withCharges++
      continue
    }
    // Отмена и незаезд счёт обнуляют (решение владельца 2026-09-08): у них
    // автоматических строк нет, вместо них ниже появляется ручной штраф.
    if (c.status === 'CANCELLED' || c.status === 'NO_SHOW') continue
    await rebuildAutoCharges(id, { adminId: pick(adminIds) })
    withCharges++
  }
  return withCharges
}

/**
 * Штраф ручной строкой — так же, как его выписывает «расчёт с гостем»
 * (`settlementController`): `kind: 'extra'`, `source: 'manual'` и обязательная причина.
 */
async function addPenalty(bookingId, amount, label, reason, adminId) {
  await prisma.bookingCharge.create({
    data: {
      bookingId, kind: 'extra', label, quantity: 1,
      unitPrice: amount, amount, source: 'manual', reason, createdById: adminId,
    },
  })
  const rows = await prisma.bookingCharge.findMany({ where: { bookingId } })
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0))
  await prisma.booking.update({ where: { id: bookingId }, data: { totalAmount: total } })
  return total
}

async function seedPayments({ created, chains, admins, shiftByDate }) {
  const adminIds = admins.map((a) => a.id)
  const byId = new Map(admins.map((a) => [a.id, a]))
  const chainHeads = new Set(chains.map((c) => c.headId))
  const stats = { payments: 0, refunds: 0, voided: 0, debtors: 0 }

  /** Платёж как его пишет `paymentController`: смена и бизнес-дата по дате приёма. */
  const pay = async (bookingId, amount, method, when, extra = {}) => {
    if (amount <= 0) return null
    const date = d(Math.min(Math.max(when.getTime(), SHIFTS_FROM.getTime()), TODAY.getTime()))
    const shift = shiftByDate.get(iso(date))
    const adminId = pick(adminIds)
    const row = await prisma.payment.create({
      data: {
        bookingId,
        kind: extra.kind || 'payment',
        amount: Math.round(amount),
        method,
        adminId,
        adminName: byId.get(adminId).name,
        shiftId: shift?.id ?? null,
        businessDate: date,
        paidAt: at(date, extra.hour ?? int(6, 14)),
        comment: extra.comment || null,
        refundOfId: extra.refundOfId || null,
        createdAt: at(date, extra.hour ?? 9),
      },
    })
    stats.payments++
    return row
  }

  // 5 броней с долгом — заранее выбранные из прошлых, чтобы список долгов был непустым
  const pastPaid = created.filter((c) => c.status === 'CHECKED_OUT')
  const debtSet = new Set()
  for (let i = 0; i < 50 && debtSet.size < 5 && pastPaid.length; i++) {
    debtSet.add(pastPaid[Math.floor(rng() * pastPaid.length)])
  }

  let voidedDone = false
  let refundsDone = 0

  for (const c of created) {
    const id = c.booking.id
    // У продолжения цепочки своих денег нет — всё на голове
    if (c.booking.accountBookingId) continue

    const fresh = await prisma.booking.findUnique({
      where: { id }, select: { totalAmount: true, prepaymentPercent: true, status: true },
    })
    const charged = Math.round(fresh.totalAmount || 0)

    if (c.status === 'CANCELLED') {
      // Отменённая с предоплатой: часть удержана штрафом, остаток возвращён —
      // именно так закрывает отмену «расчёт с гостем».
      if (refundsDone < 1 && charged === 0 && chance(0.6)) {
        const prepaid = 20000 + int(0, 6) * 5000
        const original = await pay(id, prepaid, pick(['card', 'transfer']), addDays(c.checkIn, -10),
          { comment: 'Предоплата при бронировании' })
        const penalty = Math.round(prepaid * 0.3 / 500) * 500
        await addPenalty(id, penalty, 'Штраф: поздняя отмена', 'отмена менее чем за сутки', adminIds[0])
        await pay(id, prepaid - penalty, original.method, addDays(c.checkIn, -1),
          { kind: 'refund', refundOfId: original.id, comment: 'Возврат за вычетом штрафа' })
        stats.refunds++
        refundsDone++
      }
      await recalcBookingPaid(id)
      continue
    }

    if (c.status === 'NO_SHOW') {
      // Незаезд: предоплата остаётся отелю, счёт закрывается штрафом в её размере.
      const prepaid = 25000 + int(0, 5) * 5000
      await pay(id, prepaid, pick(['card', 'transfer']), addDays(c.checkIn, -7),
        { comment: 'Предоплата при бронировании' })
      await addPenalty(id, prepaid, 'Штраф за незаезд', 'гость не приехал, предоплата удержана', adminIds[0])
      await recalcBookingPaid(id)
      continue
    }

    if (charged <= 0) { await recalcBookingPaid(id); continue }

    const percent = fresh.prepaymentPercent || 50
    const prepayment = Math.round(charged * percent / 100 / 100) * 100

    if (c.status === 'CHECKED_OUT' || chainHeads.has(id)) {
      const debt = debtSet.has(c)
      const target = debt ? Math.round(charged * (0.5 + rng() * 0.3) / 100) * 100 : charged
      if (debt) stats.debtors++

      if (chance(0.55)) {
        const first = Math.min(prepayment, target)
        await pay(id, first, pick(['transfer', 'card']), addDays(c.checkIn, -7),
          { comment: 'Предоплата за неделю до заезда' })
        await pay(id, target - first, pick(['cash', 'card']), c.checkIn,
          { comment: 'Доплата при заселении' })
      } else if (!voidedDone && chance(0.3)) {
        // Одна ошибочная запись кассира: сумма не та, строка отменена и введена заново.
        voidedDone = true
        const wrong = await pay(id, Math.round(target / 2), 'cash', c.checkIn, { comment: 'Оплата наличными' })
        const voider = pick(adminIds)
        await prisma.payment.update({
          where: { id: wrong.id },
          data: {
            voidedAt: at(c.checkIn, 12), voidedById: voider,
            voidReason: 'Ошибка кассира: сумма введена не та',
          },
        })
        stats.voided++
        await pay(id, target, pick(['cash', 'card']), c.checkIn, { comment: 'Оплата наличными (исправлено)' })
      } else {
        await pay(id, target, pick(['cash', 'card', 'transfer']), c.checkOut > TODAY ? TODAY : c.checkOut,
          { comment: 'Расчёт при выезде' })
      }

      // Один возврат по живой брони: гость уехал раньше, вернули за две ночи.
      if (refundsDone < 2 && !debt && chance(0.08)) {
        const last = await prisma.payment.findFirst({
          where: { bookingId: id, kind: 'payment', voidedAt: null }, orderBy: { id: 'desc' },
        })
        if (last && last.amount > 20000) {
          const back = Math.round(last.amount * 0.15 / 500) * 500
          await pay(id, back, last.method, c.checkOut,
            { kind: 'refund', refundOfId: last.id, comment: 'Возврат за ранний выезд' })
          stats.refunds++
          refundsDone++
        }
      }
    } else if (c.status === 'CHECKED_IN') {
      await pay(id, prepayment, pick(['transfer', 'card', 'cash']), addDays(c.checkIn, -5),
        { comment: 'Предоплата при бронировании' })
      if (chance(0.4)) {
        await pay(id, Math.round((charged - prepayment) / 2 / 100) * 100, 'cash', c.checkIn,
          { comment: 'Частичная доплата' })
      }
    } else if (chance(0.5)) {
      // Будущий заезд: предоплату взяли, когда бронировали, — то есть В ПРОШЛОМ.
      // Без этого ограничения `pay` подтянул бы дату к сегодняшней смене, и вся
      // предоплата будущих заездов свалилась бы в одну кассу.
      const when = d(Math.min(
        addDays(c.checkIn, -int(3, 25)).getTime(),
        addDays(TODAY, -int(0, 14)).getTime(),
      ))
      await pay(id, prepayment, pick(['transfer', 'card', 'cash']), when,
        { comment: 'Предоплата при бронировании' })
    }

    await recalcBookingPaid(id)
  }

  // Касса СЕГОДНЯШНЕЙ смены должна быть непустой: показ начинается с неё.
  const todayGuests = created.filter((c) => c.status === 'CHECKED_IN' && !c.booking.accountBookingId)
  let todayPaid = await prisma.payment.count({ where: { businessDate: TODAY } })
  for (const c of todayGuests) {
    if (todayPaid >= 6) break
    const fresh = await prisma.booking.findUnique({
      where: { id: c.booking.id }, select: { totalAmount: true, paidAmount: true },
    })
    const due = Math.round((fresh.totalAmount || 0) - (fresh.paidAmount || 0))
    if (due <= 1000) continue
    await pay(c.booking.id, Math.round(due / 2 / 100) * 100, pick(['cash', 'card']), TODAY,
      { comment: 'Доплата на стойке', hour: 7 })
    await recalcBookingPaid(c.booking.id)
    todayPaid++
  }

  return stats
}

// ─── Квоты партнёров ──────────────────────────────────────────────────────────

/**
 * Квота Kompas Travel: коттеджи К-1…К-4 на выходные текущего месяца.
 * Диапазоны считаются ДО генерации броней и передаются в планировщик, иначе
 * подбор продал бы номер, который уже отдан партнёру, и шахматка показала бы
 * «занято» поверх квоты.
 */
function planQuotaRanges(rooms) {
  const cottages = rooms.filter((r) => ['К-1', 'К-2', 'К-3', 'К-4'].includes(r.number))
  const ranges = []
  const from = monthStart(TODAY)
  const to = monthEnd(TODAY)
  for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
    const day = new Date(t)
    if (day.getUTCDay() !== 5) continue // пятница
    const end = addDays(day, 2)         // ночи с пт и с сб, выезд в воскресенье
    for (const room of cottages) ranges.push({ roomId: room.id, from: day, to: end > to ? to : end })
  }
  return ranges
}

async function seedPartnersAndQuotas(rooms) {
  const partners = []
  for (const p of PARTNERS) partners.push(await prisma.partner.create({ data: { ...p, isActive: true } }))

  const kompas = partners[0]
  const ranges = planQuotaRanges(rooms)
  const byRoom = new Map()
  for (const r of ranges) {
    await prisma.allotment.create({
      data: {
        partnerId: kompas.id, roomId: r.roomId, dateFrom: r.from, dateTo: r.to,
        notes: 'Квота на выходные, релиз за 5 дней до заезда',
      },
    })
    if (!byRoom.has(r.roomId)) byRoom.set(r.roomId, [])
    byRoom.get(r.roomId).push({ from: r.from, to: r.to })
  }
  return { partners, quotaBlocks: byRoom, allotments: ranges.length }
}

// ─── Журнал действий ──────────────────────────────────────────────────────────

async function seedAuditLog(admins, created) {
  const sample = created.filter((c) => c.checkIn >= addDays(TODAY, -12))
  const rows = []
  const templates = [
    (b) => ({ action: 'POST /bookings', entity: 'bookings', entityId: b.id, details: { roomId: b.roomId, guestName: b.guestName, checkIn: iso(b.checkIn), checkOut: iso(b.checkOut) } }),
    (b) => ({ action: `PUT /bookings/${b.id}`, entity: 'bookings', entityId: b.id, details: { notes: 'уточнили время заезда', guestPhone: b.guestPhone } }),
    (b) => ({ action: `PATCH /bookings/${b.id}/checkin`, entity: 'bookings', entityId: b.id, details: null }),
    (b) => ({ action: `PATCH /bookings/${b.id}/checkout`, entity: 'bookings', entityId: b.id, details: null }),
    (b) => ({ action: 'POST /payments', entity: 'payments', entityId: b.id, details: { bookingId: b.id, amount: 25000, method: 'cash' } }),
    (b) => ({ action: `POST /bookings/${b.id}/charges`, entity: 'bookings', entityId: b.id, details: { kind: 'extra', label: 'Мини-бар', amount: 4500, reason: 'по факту' } }),
    () => ({ action: 'POST /shifts/next-day', entity: 'shifts', entityId: null, details: null }),
    () => ({ action: 'PUT /rates', entity: 'rates', entityId: null, details: { categoryId: 2, from: iso(addDays(TODAY, 20)), to: iso(addDays(TODAY, 50)) } }),
    () => ({ action: 'POST /system/backup', entity: 'system', entityId: null, details: null }),
  ]

  for (let i = 0; i < 60; i++) {
    const admin = pick(admins)
    const when = at(addDays(TODAY, -int(0, 9)), int(4, 15))
    const b = sample.length ? pick(sample).booking : null
    const t = b ? pick(templates) : templates[6]
    const rec = t(b)
    rows.push({
      adminId: admin.id,
      adminName: admin.name,
      action: rec.action,
      entity: rec.entity,
      entityId: rec.entityId,
      ...(rec.details ? { details: rec.details } : {}),
      ip: pick(['192.168.1.14', '192.168.1.22', '127.0.0.1']),
      createdAt: when,
    })
  }
  await prisma.auditLog.createMany({ data: rows })
  return rows.length
}

// ─── Проверки ─────────────────────────────────────────────────────────────────

async function verify() {
  const overlaps = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n
    FROM "Booking" a JOIN "Booking" b
      ON a."roomId" = b."roomId" AND a.id < b.id
     AND a."checkIn" < b."checkOut" AND a."checkOut" > b."checkIn"
    WHERE a.status IN ('CONFIRMED','CHECKED_IN') AND b.status IN ('CONFIRMED','CHECKED_IN')
  `)
  const money = await prisma.$queryRawUnsafe(`
    SELECT
      (SELECT COALESCE(sum(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0)
         FROM "Payment" WHERE "voidedAt" IS NULL)::float AS payments,
      (SELECT COALESCE(sum("paidAmount"), 0) FROM "Booking")::float AS cached
  `)
  const charges = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM "Booking" b
    WHERE b."accountBookingId" IS NULL
      AND b."totalAmount" <> COALESCE((SELECT round(sum(c.amount)::numeric) FROM "BookingCharge" c WHERE c."bookingId" = b.id), 0)
  `)
  return {
    overlaps: overlaps[0].n,
    paymentsSum: money[0].payments,
    cachedPaid: money[0].cached,
    totalsMismatch: charges[0].n,
  }
}

async function counts() {
  const t = {}
  for (const name of ['admin', 'building', 'roomFeature', 'roomCapacity', 'category', 'room',
    'ratePrice', 'service', 'mealPlan', 'bookingFlag', 'contact', 'partner', 'allotment',
    'shift', 'booking', 'bookingService', 'bookingCharge', 'payment', 'auditLog']) {
    t[name] = await prisma[name].count()
  }
  return t
}

// ─── Точка входа ──────────────────────────────────────────────────────────────

async function main() {
  const dbName = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0]
  log(`База: ${dbName}   рабочая дата демо: ${iso(TODAY)}   период: ${iso(FROM)} … ${iso(TO)}`)

  const existing = await prisma.booking.count() + await prisma.payment.count()
  if (existing > 0 && !RESET) {
    console.error(
      `\nВ базе «${dbName}» уже есть данные (${existing} броней и платежей).\n` +
      'Скрипт демо-данных стирает всё, кроме главного администратора и настроек.\n' +
      'Если это действительно демо-база — запусти повторно с ключом --reset.\n',
    )
    process.exitCode = 1
    return
  }

  // Кого оставляем: главный администратор (SUPER_ADMIN с наименьшим id), а если
  // такого нет — просто самая старая учётка. Без неё в базу нельзя будет войти.
  const keeper = await prisma.admin.findFirst({ orderBy: [{ role: 'asc' }, { id: 'asc' }] })
  if (!keeper) {
    console.error('В базе нет ни одной учётки — сначала пройди мастер первого запуска или накати electron/db/seed.sql')
    process.exitCode = 1
    return
  }

  log('Очистка…')
  await resetDemoData(keeper.id)

  log('Настройки объекта и учётки…')
  await seedHotelSettings()
  const admins = await seedAdmins(keeper.id)
  const adminIds = admins.map((a) => a.id)

  log('Справочники…')
  const { categories, services } = await seedDirectories()
  const rooms = await seedRooms(categories)
  const capacityByCode = new Map(CAPACITIES.map((c) => [c.code, c]))

  log('Тарифы…')
  const rateCount = await seedRates(categories)

  log('Партнёры и квоты…')
  const { quotaBlocks, allotments } = await seedPartnersAndQuotas(rooms)

  log('Смены…')
  const { byDate: shiftByDate } = await seedShifts(adminIds)

  log('Брони…')
  const { created, repair } = await seedBookings({
    rooms, capacityByCode, services, adminIds, shiftByDate, quotaBlocks,
  })

  const occupied = new Map(rooms.map((r) => [r.id, []]))
  for (const c of created) occupied.get(c.room.id).push({ checkIn: c.checkIn, checkOut: c.checkOut })
  // Ремонтный блок — тоже занятость: без него переезд «в свободный номер»
  // упирался бы в exclusion-constraint (проверено — падало именно на нём).
  occupied.get(repair.roomId).push({ checkIn: repair.checkIn, checkOut: repair.checkOut })

  log('Переезды…')
  const chains = await seedChains({ created, rooms, occupied, adminIds, quotaBlocks })

  log('Начисления…')
  await buildCharges({ created, chains, adminIds })

  log('Платежи…')
  const money = await seedPayments({ created, chains, admins, shiftByDate })

  log('Журнал действий…')
  await seedAuditLog(admins, created)

  const t = await counts()
  const v = await verify()

  console.log('\n─── Демо-данные записаны ─────────────────────────────────────')
  console.log(`  база .................. ${dbName}`)
  console.log(`  рабочая дата .......... ${iso(TODAY)} (последняя смена)`)
  console.log(`  номера ................ ${t.room} в ${t.building} корпусах, ${t.category} категорий`)
  console.log(`  цены .................. ${rateCount} строк (${iso(RATES_FROM)} … ${iso(RATES_TO)})`)
  console.log(`  смены ................. ${t.shift}`)
  console.log(`  брони ................. ${t.booking} (переездов: ${chains.length})`)
  console.log(`  начисления / услуги ... ${t.bookingCharge} / ${t.bookingService}`)
  console.log(`  платежи ............... ${t.payment} (возвратов: ${money.refunds}, отменённых: ${money.voided})`)
  console.log(`  партнёры / квоты ...... ${t.partner} / ${allotments}`)
  console.log(`  контакты / журнал ..... ${t.contact} / ${t.auditLog}`)
  console.log(`  учётки ................ ${t.admin} (${ADMINS.map((a) => a.username).join(', ')}), пароль ${DEMO_PASSWORD}`)
  console.log('─── Проверки ─────────────────────────────────────────────────')
  console.log(`  пересечений активных броней ... ${v.overlaps} (должно быть 0)`)
  console.log(`  сумма платежей ................ ${v.paymentsSum}`)
  console.log(`  сумма кэша Booking.paidAmount . ${v.cachedPaid}`)
  console.log(`  брони с расхождением итога .... ${v.totalsMismatch} (должно быть 0)`)
  console.log('──────────────────────────────────────────────────────────────\n')

  if (v.overlaps !== 0 || Math.abs(v.paymentsSum - v.cachedPaid) > 0.01 || v.totalsMismatch !== 0) {
    console.error('ВНИМАНИЕ: проверки не сошлись — данные записаны, но их надо разобрать.')
    process.exitCode = 2
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
