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
 *   --months-back=9    сколько месяцев истории засевать (1…24)
 *   --months-ahead=4   на сколько месяцев вперёд стоят будущие заезды (1…12)
 *   --occupancy=0.55   целевая заполняемость ПИКА сезона (0.2…0.9); по месяцам
 *                      она умножается на сезонный коэффициент (см. SEASON_OCCUPANCY)
 *   --services=0.35    доля броней, у которых есть питание/услуги (0…1)
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
const MONTHS_BACK = Math.min(24, Math.max(1, Math.round(Number(optValue('months-back', '9'))) || 9))
const MONTHS_AHEAD = Math.min(12, Math.max(1, Math.round(Number(optValue('months-ahead', '4'))) || 4))
// Доля броней с питанием/услугами. Вынесена ключом, потому что «сколько гостей
// берут питание» у разных объектов отличается в разы: у базы с пансионом это
// почти все, у придорожной гостиницы — единицы.
const SERVICES_SHARE = Math.min(1, Math.max(0, Number(optValue('services', '0.35'))))

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
const FROM = monthStart(TODAY, -MONTHS_BACK)   // начало самого раннего месяца истории
const TO = monthEnd(TODAY, MONTHS_AHEAD)       // конец последнего будущего месяца
// Тарифы — с запасом в месяц по обе стороны: раскладка по номеру начинается
// раньше FROM (разгон, см. planRoomStays) и обрывается позже TO, а ночь без
// цены дала бы бронь с нулевым итогом.
const RATES_FROM = monthStart(TODAY, -(MONTHS_BACK + 1))
const RATES_TO = monthEnd(TODAY, MONTHS_AHEAD + 1)
const SHIFTS_FROM = FROM

// ─── Сезонность ───────────────────────────────────────────────────────────────
//
// Год данных без сезона бесполезен: отчёт «загрузка по месяцам» рисует прямую,
// а владелец на показе как раз тычет пальцем в «вот здесь лето, вот здесь мёртвый
// февраль». Коэффициенты — по календарному месяцу (0 = январь), а не по смещению
// от сегодняшней даты: период теперь больше года и одно и то же лето попадает в
// него и «назад», и «вперёд».

/** Множитель заполняемости: 1.0 — пик (июль-август), 0.35 — межсезонье. */
const SEASON_OCCUPANCY = [0.40, 0.35, 0.40, 0.45, 0.65, 0.85, 1.00, 1.00, 0.78, 0.55, 0.40, 0.58]
/** Множитель цены за ночь. Дороже там же, где плотнее, но мягче. */
const SEASON_PRICE = [0.85, 0.80, 0.85, 0.90, 1.00, 1.15, 1.25, 1.20, 1.05, 0.90, 0.85, 1.00]

/** Новогодние каникулы: 25 декабря — 8 января. Цены выше, номера разбирают. */
function isNewYearSeason(date) {
  const m = date.getUTCMonth()
  const day = date.getUTCDate()
  return (m === 11 && day >= 25) || (m === 0 && day <= 8)
}

const seasonOccupancy = (date) =>
  SEASON_OCCUPANCY[date.getUTCMonth()] * (isNewYearSeason(date) ? 1.35 : 1)
const seasonPrice = (date) =>
  SEASON_PRICE[date.getUTCMonth()] * (isNewYearSeason(date) ? 1.3 : 1)

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

// Первая учётка — SUPER_ADMIN: ею переименовывается главный администратор базы
// (см. seedAdmins). Остальные — ADMIN: роль STAFF убрана решением 2026-09-08.
const ADMINS = [
  { username: 'aigerim', name: 'Айгерим Сейткали', role: 'SUPER_ADMIN' },
  { username: 'erlan', name: 'Ерлан Абдрахманов', role: 'ADMIN' },
  { username: 'madina', name: 'Мадина Оспанова', role: 'ADMIN' },
  { username: 'arman', name: 'Арман Дюсенов', role: 'ADMIN' },
  { username: 'zhanna', name: 'Жанна Абиева', role: 'ADMIN' },
  { username: 'nurbol', name: 'Нурбол Ержанов', role: 'ADMIN' },
]
const DEMO_PASSWORD = 'Demo2026!'

const BUILDINGS = [
  { code: 'main', name: 'ГЛАВНЫЙ КОРПУС', description: 'Двухэтажный корпус с рестораном и конференц-залом', order: 0 },
  { code: 'cottages', name: 'КОТТЕДЖИ', description: 'Отдельные двухэтажные коттеджи у озера', order: 1 },
  { code: 'eco', name: 'ЭКО-ДОМИКИ', description: 'Деревянные домики в сосновой роще', order: 2 },
  { code: 'terrace', name: 'ТЕРРАСА', description: 'Новый корпус у реки: студии и апартаменты с террасами', order: 3 },
]

const CATEGORIES = [
  { name: 'Стандарт', color: '#C0DD97', description: 'Номер с двумя кроватями, душ' },
  { name: 'Комфорт', color: '#B5D4F4', description: 'Улучшенный номер с балконом' },
  { name: 'Люкс', color: '#D4A8E1', description: 'Двухкомнатный номер с видом на горы' },
  { name: 'Семейный коттедж', color: '#FAC775', description: 'Отдельный коттедж на 4–6 человек' },
  { name: 'Эко-домик', color: '#9FD8CB', description: 'Домик из бруса на 2–3 человека' },
  { name: 'Студия', color: '#F7C6DE', description: 'Студия с террасой и кухонной зоной' },
  { name: 'Апартаменты', color: '#C9BDF2', description: 'Двухкомнатные апартаменты с кухней, до 5 человек' },
]

const FEATURES = [
  { code: 'balcony', name: 'Балкон', emoji: '🪟', order: 0 },
  { code: 'mountain_view', name: 'Вид на горы', emoji: '🏔', order: 1 },
  { code: 'lake_view', name: 'Вид на озеро', emoji: '🏞', order: 2 },
  { code: 'jacuzzi', name: 'Джакузи', emoji: '🛁', order: 3 },
  { code: 'ac', name: 'Кондиционер', emoji: '❄️', order: 4 },
  { code: 'fireplace', name: 'Камин', emoji: '🔥', order: 5 },
  { code: 'terrace', name: 'Терраса', emoji: '🌿', order: 6 },
  { code: 'kitchen', name: 'Кухонная зона', emoji: '🍳', order: 7 },
  { code: 'river_view', name: 'Вид на реку', emoji: '🌊', order: 8 },
]

const CAPACITIES = [
  { code: 'single', label: 'Одноместный', value: 1, order: 0 },
  { code: 'double', label: 'Двухместный', value: 2, order: 1 },
  { code: 'triple', label: 'Трёхместный', value: 3, order: 2 },
  { code: 'quad', label: 'Четырёхместный', value: 4, order: 3 },
  { code: 'quint', label: 'Пятиместный', value: 5, order: 4 },
  { code: 'family', label: 'Шестиместный', value: 6, order: 5 },
]

// Метки — те же коды, что в electron/db/seed.sql: демо не должно вводить свой словарь.
const FLAGS = [
  { code: 'late_checkout', label: 'Поздний выезд', color: '#F4A8A8', effects: { bufferAfter: 1 }, order: 1 },
  { code: 'vip', label: 'VIP', color: '#E1C84A', effects: {}, order: 2 },
  { code: 'no_move', label: 'Не перемещать', color: '#A8C8F4', effects: { pin: true }, order: 3 },
]

// Цена за взрослого в будни, базовый сезон. Выходные +20 %, сезон — SEASON_PRICE.
const CATEGORY_PRICING = {
  'Стандарт':         { adult: 14000, child: 8000, extraBed: 7000, base: 2 },
  'Комфорт':          { adult: 18000, child: 10000, extraBed: 9000, base: 2 },
  'Люкс':             { adult: 26000, child: 15000, extraBed: 13000, base: 2 },
  'Семейный коттедж': { adult: 22000, child: 12000, extraBed: 11000, base: 4 },
  'Эко-домик':        { adult: 20000, child: 11000, extraBed: 10000, base: 2 },
  'Студия':           { adult: 16000, child: 9000, extraBed: 8000, base: 2 },
  'Апартаменты':      { adult: 24000, child: 13000, extraBed: 12000, base: 4 },
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
  {
    name: '«Алтын Сапар»', color: '#2FA37C', defaultCheckInDay: 1, defaultNights: 6,
    commissionPercent: 10, contactPerson: 'Сауле Кенжебаева', contactPhone: '+7 727 311 55 42',
    notes: 'Недельные заезды по путёвкам, квота на стандарты главного корпуса',
  },
  {
    name: 'Silk Road Tours', color: '#C77C2E', defaultCheckInDay: 4, defaultNights: 3,
    commissionPercent: 15, contactPerson: 'Руслан Хайруллин', contactPhone: '+7 705 640 70 18',
    notes: 'Иностранные группы, требуют уведомления о прибытии — документы обязательны',
  },
  {
    name: '«Жетысу Тревел»', color: '#7A6BD6', defaultCheckInDay: 5, defaultNights: 2,
    commissionPercent: 8, contactPerson: 'Динара Мукашева', contactPhone: '+7 747 208 33 91',
    notes: 'Школьные и семейные туры выходного дня, эко-домики',
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
    // Пробный период — заново с каждого пересева: демо-база не должна упереться
    // в гейт лицензии посреди показа (14 дней без ключа, utils/trial.js).
    update: { ...HOTEL, setupCompletedAt: new Date(), trialStartedAt: new Date() },
    create: { id: 1, ...HOTEL, setupCompletedAt: new Date(), trialStartedAt: new Date() },
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
  // Корпус «Терраса», два этажа: Т-101…Т-108 студии, Т-201…Т-206 апартаменты.
  // Номера трёхзначные с буквой корпуса — так их и пишут на ключах, и в
  // шахматке видно, что это другой корпус, без чтения колонки «корпус».
  for (let i = 1; i <= 8; i++) {
    plan.push({
      number: `Т-10${i}`, category: 'Студия', building: 'ТЕРРАСА', floor: 1,
      capacity: i % 4 === 0 ? 'triple' : 'double',
      features: ['Терраса', 'Кондиционер', 'Кухонная зона', i % 2 === 0 ? 'Вид на реку' : 'Вид на горы'],
    })
  }
  for (let i = 1; i <= 6; i++) {
    plan.push({
      number: `Т-20${i}`, category: 'Апартаменты', building: 'ТЕРРАСА', floor: 2,
      capacity: i <= 3 ? 'quint' : 'quad',
      features: ['Балкон', 'Кондиционер', 'Кухонная зона', 'Вид на реку', ...(i === 1 ? ['Джакузи'] : [])],
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
      // Сезон: лето и новогодние каникулы дороже, межсезонье дешевле — иначе
      // отчёт «выручка по месяцам» рисует прямую линию и ничего не показывает.
      const season = seasonPrice(date)
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

  const blocked = (from, to) => blockedRanges.some((b) => from < b.to && to > b.from)

  /**
   * Средний зазор до следующего заезда в этот день года. Заполняемость месяца =
   * TARGET_OCCUPANCY × сезонный коэффициент, отсюда и пауза между гостями:
   * в июле она почти нулевая, в феврале — три недели.
   */
  const meanGapAt = (date) => {
    const occ = Math.min(0.92, Math.max(0.05, TARGET_OCCUPANCY * seasonOccupancy(date)))
    return Math.max(0.3, meanStay * (1 - occ) / occ - 0.5)
  }

  // Период теперь до 3 лет (24 месяца назад + 12 вперёд), а зимой цикл «гость +
  // пауза» доходит до месяца — запас по итерациям берём с большим избытком:
  // упереться в guard значит молча недосеять хвост периода.
  let guard = 0
  while (cursor < TO && guard++ < 5000) {
    const gap = Math.round(rng() * meanGapAt(cursor) * 2)
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

/** Казахстанский мобильный в том виде, в каком его набирает администратор: +7 7xx xxx xx xx. */
function phone() {
  const codes = ['700', '701', '702', '705', '707', '747', '771', '775', '777', '778']
  const p2 = String(int(0, 999)).padStart(3, '0')
  const p3 = String(int(0, 99)).padStart(2, '0')
  const p4 = String(int(0, 99)).padStart(2, '0')
  return `+7 ${pick(codes)} ${p2} ${p3} ${p4}`
}

/** Номер удостоверения / паспорта РК — выдуманный, но в правильном формате. */
function docNumber() {
  return `N${String(int(0, 99999999)).padStart(8, '0')}`
}

/**
 * Постоянные гости. Вкладка «Гости» собирается свёрткой броней по телефону
 * (`guestController.js`), поэтому «постоянный гость» — это буквально один и тот
 * же телефон на нескольких бронях. Без такого пула вкладка показывает тысячу
 * человек с одним визитом каждый, и вся история визитов не видна на показе.
 * Документ у постоянного тоже один и тот же — иначе подстановка из прошлого
 * визита (`GET /guests/lookup`) на показе противоречила бы сама себе.
 */
function buildRegulars(count) {
  const out = []
  for (let i = 0; i < count; i++) {
    const female = chance(0.5)
    const citizenship = pick(CITIZENSHIPS)
    out.push({
      guestName: female ? `${pick(FIRST_F)} ${pick(LAST_F)}` : `${pick(FIRST_M)} ${pick(LAST_M)}`,
      guestPhone: phone(),
      sex: female ? 'f' : 'm',
      guestCitizenship: citizenship,
      guestDocType: citizenship === 'Казахстан' ? (chance(0.7) ? 'id_card' : 'passport') : 'passport',
      guestDocNumber: docNumber(),
      guestBirthDate: d(`${TODAY.getUTCFullYear() - int(22, 62)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`),
      guestDocExpiry: d(`${TODAY.getUTCFullYear() + int(1, 8)}-${String(int(1, 12)).padStart(2, '0')}-15`),
    })
  }
  return out
}

// ─── Засев броней ─────────────────────────────────────────────────────────────

async function seedBookings({
  rooms, capacityByCode, services, adminIds, shiftByDate, quotaBlocks, quotaSales, partners, regulars,
}) {
  const created = []
  const plans = []

  for (const room of rooms) {
    const blocked = quotaBlocks.get(room.id) || []
    const stays = planRoomStays(blocked)
    stays.forEach((s, i) => plans.push({ room, ...s, gapAfter: gapAfter(stays, i) }))
  }

  // Реализованная квота: партнёр продал выделенный ему номер. Эти отрезки лежат
  // ровно в границах квоты, куда планировщик не заходит (blockedRanges), поэтому
  // пересечься с обычной бронью они не могут по построению.
  for (const s of quotaSales) {
    plans.push({ room: s.room, checkIn: s.checkIn, checkOut: s.checkOut, gapAfter: 0, partner: s.partner })
  }

  // Ремонтные блоки — номер выведен из продажи. Гостей ноль, поэтому генератор
  // начислений не выпишет ни строки: ремонт не продажа, и в выручку он попасть
  // не должен (в отчётах он отдельно помечен `isMaintenance`). Один блок висит
  // на рабочей дате (его видно на показе), второй — в прошлом, чтобы отчёт по
  // загрузке за год не выглядел так, будто отель никогда не ремонтируется.
  const repairPlans = [
    {
      room: rooms.find((r) => r.number === '118'),
      from: addDays(TODAY, -4), to: addDays(TODAY, 16),
      notes: 'Замена сантехники и покраска, подрядчик «Тау Сервис»',
    },
    {
      room: rooms.find((r) => r.number === 'Т-206'),
      from: addDays(TODAY, -150), to: addDays(TODAY, -128),
      notes: 'Ввод корпуса «Терраса»: отделка и мебель',
    },
  ].filter((r) => r.room && r.to > FROM)

  const cleared = plans.filter((p) => !repairPlans.some(
    (r) => p.room.id === r.room.id && p.checkIn < r.to && p.checkOut > r.from,
  ))

  cleared.sort((a, b) => a.checkIn - b.checkIn || a.room.id - b.room.id)

  // Отмены и незаезды — долей от всего массива, а не фиксированным числом:
  // иначе на годовом периоде семь отмен теряются среди полутора тысяч броней,
  // и отчёт «процент отмен» показывает ноль целых.
  const pickShare = (pool, share) => {
    const want = Math.round(pool.length * share)
    const set = new Set()
    for (let i = 0; i < want * 8 && set.size < want && pool.length; i++) {
      set.add(pool[Math.floor(rng() * pool.length)])
    }
    return set
  }
  // Отменяют и будущие, и прошлые — но не тех, кто уже живёт в номере сегодня.
  const cancellable = cleared.filter((p) => p.checkIn > TODAY || p.checkOut <= TODAY)
  const cancelledSet = pickShare(cancellable, 0.04)
  const noShowPool = cleared.filter((p) => p.checkOut <= TODAY && p.checkIn >= FROM && !cancelledSet.has(p))
  const noShowSet = pickShare(noShowPool, 0.012)

  const svc = (code) => services.get(code)
  // Партнёрские заезды без квоты: турфирма привезла гостя в обычный номер.
  const partnerPool = partners.filter((p) => p.name !== 'Corporate — Kaspi Team Building')
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
    if (chance(0.18)) {
      if (chance(0.4) && p.gapAfter >= 1) flags.push('late_checkout')
      else flags.push(chance(0.7) ? 'vip' : 'no_move')
    }

    // Постоянный гость: то же имя, тот же телефон, тот же документ. Повтор даёт
    // непустую историю визитов во вкладке «Гости» и рабочую подстановку по телефону.
    const regular = chance(0.22) ? pick(regulars) : null
    const partner = p.partner || (chance(0.08) ? pick(partnerPool) : null)
    // Партнёрскую бронь оформляют по телефону или на стойке — «онлайн» и «Каспи»
    // для неё бессмысленны (гость платит турфирме, а не отелю).
    const source = partner ? pick(['телефон', 'стойка']) : pick(SOURCES)
    const lateArrival = chance(0.14)
    // Документ есть примерно у 40 % броней: на стойке его переписывают не всегда,
    // а у брони «на будущее» его ещё физически нет. У постоянного гостя документ
    // подставляется из прошлого визита, поэтому там он есть чаще. Доли подобраны
    // так, чтобы В СУММЕ вышло ~40 % (0,22×0,70 + 0,78×0,32).
    const withDoc = regular ? chance(0.7) : chance(0.32)
    const createdAt = at(
      new Date(Math.max(
        FROM.getTime() - 20 * DAY,
        Math.min(TODAY.getTime(), p.checkIn.getTime() - int(2, 45) * DAY),
      )),
      7,
    )

    const noteParts = []
    if (chance(0.24)) noteParts.push(pick(NOTES_POOL))
    if (lateArrival && (status === 'CHECKED_IN' || status === 'CHECKED_OUT') && chance(0.6)) {
      noteParts.push('Поздний заезд — ключ у охраны')
    }
    if (partner) noteParts.push(`Заезд от ${partner.name}, ваучер №${partner.name.slice(0, 2).toUpperCase()}-${int(1000, 9999)}`)

    const data = {
      roomId: p.room.id,
      guestName: regular ? regular.guestName : g.guestName,
      guestPhone: regular ? regular.guestPhone : phone(),
      checkIn: p.checkIn,
      checkOut: p.checkOut,
      status,
      source,
      notes: noteParts.length ? noteParts.join(' · ') : null,
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
      partnerId: partner ? partner.id : null,
      shiftId: shiftByDate.get(iso(createdAt))?.id ?? null,
      adminId: pick(adminIds),
      createdAt,
    }

    if (withDoc) {
      if (regular) {
        data.guestCitizenship = regular.guestCitizenship
        data.guestDocType = regular.guestDocType
        data.guestDocNumber = regular.guestDocNumber
        data.guestDocExpiry = regular.guestDocExpiry
        data.guestBirthDate = regular.guestBirthDate
        data.guestSex = regular.sex
      } else {
        data.guestCitizenship = pick(CITIZENSHIPS)
        data.guestDocType = data.guestCitizenship === 'Казахстан' ? (chance(0.7) ? 'id_card' : 'passport') : 'passport'
        data.guestDocNumber = docNumber()
        data.guestDocExpiry = d(`${TODAY.getUTCFullYear() + int(1, 8)}-${String(int(1, 12)).padStart(2, '0')}-15`)
        data.guestBirthDate = d(`${TODAY.getUTCFullYear() - int(20, 60)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`)
        data.guestSex = g.sex
      }
    }
    if (status === 'CHECKED_IN' || status === 'CHECKED_OUT') {
      data.actualCheckInAt = at(p.checkIn, lateArrival ? 17 : 9)
    }
    if (status === 'CHECKED_OUT') {
      data.actualCheckOutAt = at(p.checkOut, flags.includes('late_checkout') ? 10 : 6)
    }

    const booking = await prisma.booking.create({ data })

    // Питание и услуги: набор передаём явно, а не полагаемся на
    // `includedByDefault` — демо должно быть воспроизводимым.
    // Доля броней с услугами задаётся ключом --services (см. SERVICES_SHARE):
    // у объекта с пансионом питание берут почти все, у придорожной гостиницы — единицы.
    const links = []
    if (chance(SERVICES_SHARE)) {
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
      // Количества: баню топят несколько раз за заезд (per_booking → quantity =
      // число посещений), велосипедов берут по числу гостей (per_night → штук).
      if (chance(0.35)) {
        links.push({ serviceId: svc('sauna').id, adults: 0, children: 0, quantity: stayNights >= 5 ? int(1, 3) : 1 })
      }
      if (chance(0.28)) links.push({ serviceId: svc('transfer').id, adults: g.adults, children: g.children, quantity: 1 })
      if (chance(0.22) && stayNights >= 3) {
        links.push({ serviceId: svc('bikes').id, adults: 0, children: 0, quantity: int(1, Math.max(1, g.adults)) })
      }
      if (g.children > 0 && chance(0.4)) links.push({ serviceId: svc('kids_club').id, adults: 0, children: g.children, quantity: 1 })
    }

    // Пустой набор — лишний DELETE на бронь, которой ещё никто не касался.
    // На полутора тысячах броней это полторы тысячи круговых поездок в базу.
    if (links.length) await replaceBookingServices(booking.id, links)

    created.push({ ...p, booking, status, guest: g, nights: stayNights, hasServices: links.length > 0 })
    n++
  }

  // Ремонтные блоки пишем последними — они не участвуют ни в статусах, ни в деньгах.
  const repairs = []
  for (const r of repairPlans) {
    repairs.push(await prisma.booking.create({
      data: {
        roomId: r.room.id,
        guestName: 'Ремонт',
        checkIn: r.from,
        checkOut: r.to,
        status: 'CONFIRMED',
        source: 'ремонт',
        notes: r.notes,
        prepaymentPercent: 0,
        adminId: adminIds[0],
        shiftId: shiftByDate.get(iso(r.from))?.id ?? null,
        createdAt: at(r.from, 6),
      },
    }))
  }

  return { created, repairs, planned: n }
}

/**
 * Переезды (цепочки). Голова закрывается датой переезда (CHECKED_OUT + фактический
 * выезд), продолжение создаётся в свободном номере со ссылкой `accountBookingId`
 * на голову — ровно так, как это делает `bookingController.move`. Деньги остаются
 * на голове.
 *
 * Кандидатов перебираем в СЛУЧАЙНОМ порядке: `created` отсортирован по дате
 * заезда, и обход подряд сложил бы все переезды в первую неделю периода.
 */
async function seedChains({ created, rooms, occupied, adminIds, quotaBlocks, maxChains }) {
  const chains = []
  const candidates = created
    .filter((c) => (c.status === 'CHECKED_IN' || c.status === 'CHECKED_OUT') && c.nights >= 4 && c.checkIn >= FROM)
  // Перемешивание тем же детерминированным ГПСЧ — повторный засев даёт те же цепочки.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  for (const head of candidates) {
    if (chains.length >= maxChains) break
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
    const targetRoom = rooms.find((r) => r.categoryId !== head.room.categoryId && free(r))
      || rooms.find(free)
    if (!targetRoom) continue

    await prisma.booking.update({
      where: { id: head.booking.id },
      data: {
        checkOut: moveDate,
        status: 'CHECKED_OUT',
        actualCheckOutAt: at(moveDate, 8),
        notes: [head.booking.notes, `Переезд в №${targetRoom.number} (${iso(moveDate)})`].filter(Boolean).join(' · '),
      },
    })

    // Продолжение живёт по календарю: если весь заезд уже в прошлом, гость из
    // него тоже выехал. Иначе в шахматке за март висел бы вечный «проживающий».
    const contClosed = head.checkOut <= TODAY

    const cont = await prisma.booking.create({
      data: {
        roomId: targetRoom.id,
        guestName: head.booking.guestName,
        guestPhone: head.booking.guestPhone,
        guestCitizenship: head.booking.guestCitizenship,
        guestDocType: head.booking.guestDocType,
        guestDocNumber: head.booking.guestDocNumber,
        guestDocExpiry: head.booking.guestDocExpiry,
        guestBirthDate: head.booking.guestBirthDate,
        guestSex: head.booking.guestSex,
        checkIn: moveDate,
        checkOut: head.checkOut,
        status: contClosed ? 'CHECKED_OUT' : 'CHECKED_IN',
        actualCheckOutAt: contClosed ? at(head.checkOut, 6) : null,
        partnerId: head.booking.partnerId,
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

    occupied.get(targetRoom.id).push({ checkIn: moveDate, checkOut: head.checkOut })
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
 * Ручная строка начисления — так же, как её выписывает «расчёт с гостем»
 * (`settlementController`): `source: 'manual'` и обязательная причина.
 * `kind: 'extra'` для штрафа (сумма > 0), `kind: 'discount'` для снятия
 * начисленного (сумма < 0 — так это описано в схеме `BookingCharge`).
 */
async function addManualCharge(bookingId, amount, label, reason, adminId, kind = 'extra') {
  await prisma.bookingCharge.create({
    data: {
      bookingId, kind, label, quantity: 1,
      unitPrice: amount, amount, source: 'manual', reason, createdById: adminId,
    },
  })
  const rows = await prisma.bookingCharge.findMany({ where: { bookingId } })
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0))
  await prisma.booking.update({ where: { id: bookingId }, data: { totalAmount: total } })
  return total
}

// Доли, на которые опирается касса. Держим их числами в одном месте: «сколько
// у нас должников» — первый вопрос владельца на показе, и подкрутить его надо
// одной строкой, а не поиском по коду.
const DEBT_SHARE = 0.13      // доля выехавших, не закрывших счёт (задание: 10–15 %)
// Возвраты бывают двух видов — по отменённой броне (за вычетом штрафа) и по
// раннему выезду. Доля ниже — только для второго: вместе с отменами выходит ~4 %.
const REFUND_SHARE = 0.025
const VOID_SHARE = 0.012     // доля ошибочных записей кассира, отменённых и введённых заново

/**
 * Способ оплаты. В схеме их ровно три (`paymentController.METHODS`:
 * cash | card | transfer), и вводить четвёртый нельзя — касса, отчёты и подписи
 * на клиенте перечисляют именно эти три. Kaspi в Казахстане приходит переводом,
 * поэтому он живёт не отдельным способом, а комментарием к переводу (и источником
 * брони «Каспи»): в конце смены такой платёж сверяется с выпиской, как и любой перевод.
 */
function payMethod(kind = 'any') {
  if (kind === 'remote') return chance(0.55) ? 'transfer' : 'card'
  if (kind === 'desk') return chance(0.55) ? 'cash' : 'card'
  return pick(['cash', 'card', 'transfer'])
}
function methodComment(method, base) {
  if (method === 'transfer' && chance(0.5)) return `${base} · Kaspi перевод`
  return base
}

async function seedPayments({ created, chains, admins, shiftByDate }) {
  const adminIds = admins.map((a) => a.id)
  const byId = new Map(admins.map((a) => [a.id, a]))
  const chainHeads = new Set(chains.map((c) => c.headId))
  const stats = { payments: 0, refunds: 0, voided: 0, debtors: 0, byMethod: { cash: 0, card: 0, transfer: 0 } }

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
        comment: extra.comment ? methodComment(method, extra.comment) : null,
        refundOfId: extra.refundOfId || null,
        createdAt: at(date, extra.hour ?? 9),
      },
    })
    stats.payments++
    if (stats.byMethod[method] !== undefined) stats.byMethod[method]++
    return row
  }

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
      // именно так закрывает отмену «расчёт с гостем». У части отмен предоплаты
      // не было вовсе (отменили за месяц) — тогда и денег по броне нет.
      if (chance(0.55)) {
        const prepaid = 20000 + int(0, 6) * 5000
        const method = payMethod('remote')
        const original = await pay(id, prepaid, method, addDays(c.checkIn, -10),
          { comment: 'Предоплата при бронировании' })
        if (chance(0.7)) {
          const penalty = Math.round(prepaid * pick([0.3, 0.3, 0.5]) / 500) * 500
          await addManualCharge(id, penalty, 'Штраф: поздняя отмена', 'отмена менее чем за сутки', adminIds[0])
          await pay(id, prepaid - penalty, method, addDays(c.checkIn, -1),
            { kind: 'refund', refundOfId: original.id, comment: 'Возврат за вычетом штрафа' })
          stats.refunds++
        } else {
          // Отмена день в день: удерживаем всю предоплату, возвращать нечего.
          await addManualCharge(id, prepaid, 'Штраф: отмена в день заезда', 'отмена в день заезда, предоплата удержана', adminIds[0])
        }
      }
      await recalcBookingPaid(id)
      continue
    }

    if (c.status === 'NO_SHOW') {
      // Незаезд: предоплата остаётся отелю, счёт закрывается штрафом в её размере.
      const prepaid = 25000 + int(0, 5) * 5000
      await pay(id, prepaid, payMethod('remote'), addDays(c.checkIn, -7),
        { comment: 'Предоплата при бронировании' })
      await addManualCharge(id, prepaid, 'Штраф за незаезд', 'гость не приехал, предоплата удержана', adminIds[0])
      await recalcBookingPaid(id)
      continue
    }

    if (charged <= 0) { await recalcBookingPaid(id); continue }

    const percent = fresh.prepaymentPercent || 50
    const prepayment = Math.round(charged * percent / 100 / 100) * 100

    if (c.status === 'CHECKED_OUT' || chainHeads.has(id)) {
      // Долг у выехавшего: счёт закрыт не полностью. Этих броней должно быть
      // заметное меньшинство — иначе «Долги» показывают весь отель.
      const debt = chance(DEBT_SHARE)
      const target = debt ? Math.round(charged * (0.4 + rng() * 0.45) / 100) * 100 : charged
      if (debt) stats.debtors++

      const roll = rng()
      if (roll < 0.5) {
        // Предоплата переводом заранее + доплата на стойке при заселении
        const first = Math.min(prepayment, target)
        await pay(id, first, payMethod('remote'), addDays(c.checkIn, -int(4, 20)),
          { comment: 'Предоплата при бронировании' })
        await pay(id, target - first, payMethod('desk'), c.checkIn,
          { comment: 'Доплата при заселении' })
      } else if (roll < 0.62) {
        // Три части: бронь, заселение, расчёт при выезде — так платят длинные заезды
        const first = Math.round(target * 0.3 / 100) * 100
        const second = Math.round(target * 0.35 / 100) * 100
        await pay(id, first, payMethod('remote'), addDays(c.checkIn, -int(5, 30)), { comment: 'Предоплата при бронировании' })
        await pay(id, second, payMethod('desk'), c.checkIn, { comment: 'Доплата при заселении' })
        await pay(id, target - first - second, payMethod('desk'), c.checkOut > TODAY ? TODAY : c.checkOut,
          { comment: 'Расчёт при выезде' })
      } else if (chance(VOID_SHARE / 0.38)) {
        // Ошибочная запись кассира: сумма не та, строка отменена и введена заново.
        const wrong = await pay(id, Math.round(target / 2), 'cash', c.checkIn, { comment: 'Оплата наличными' })
        const voider = pick(adminIds)
        await prisma.payment.update({
          where: { id: wrong.id },
          data: {
            voidedAt: at(c.checkIn, 12), voidedById: voider,
            voidReason: pick(['Ошибка кассира: сумма введена не та', 'Ошибка кассира: платёж по чужой броне']),
          },
        })
        stats.voided++
        await pay(id, target, payMethod('desk'), c.checkIn, { comment: 'Оплата наличными (исправлено)' })
      } else {
        await pay(id, target, payMethod(), c.checkOut > TODAY ? TODAY : c.checkOut,
          { comment: 'Расчёт при выезде' })
      }

      // Возврат по живой брони: гость уехал раньше, ночь снята и деньги отданы.
      // ВАЖНО: вместе с возвратом снимаем и начисление. Иначе счёт остаётся на
      // прежнюю сумму, а принято становится меньше — и гость, которому ОТЕЛЬ
      // вернул деньги, попадает в список должников (ровно так и вышло на первом
      // прогоне: 46 фантомных долгов). В программе то же делает ранний выезд,
      // он снимает строки за непрожитые ночи.
      if (!debt && chance(REFUND_SHARE / 0.6)) {
        const last = await prisma.payment.findFirst({
          where: { bookingId: id, kind: 'payment', voidedAt: null }, orderBy: { id: 'desc' },
        })
        if (last && last.amount > 20000) {
          const back = Math.round(last.amount * (0.1 + rng() * 0.2) / 500) * 500
          await addManualCharge(id, -back, 'Снята ночь: ранний выезд', 'гость уехал раньше срока',
            adminIds[0], 'discount')
          await pay(id, back, last.method, c.checkOut,
            { kind: 'refund', refundOfId: last.id, comment: pick(['Возврат за ранний выезд', 'Возврат: снята одна ночь']) })
          stats.refunds++
        }
      }
    } else if (c.status === 'CHECKED_IN') {
      await pay(id, prepayment, payMethod('remote'), addDays(c.checkIn, -int(3, 14)),
        { comment: 'Предоплата при бронировании' })
      if (chance(0.4)) {
        await pay(id, Math.round((charged - prepayment) / 2 / 100) * 100, payMethod('desk'), c.checkIn,
          { comment: 'Частичная доплата' })
      }
    } else if (chance(0.55)) {
      // Будущий заезд: предоплату взяли, когда бронировали, — то есть В ПРОШЛОМ.
      // Без этого ограничения `pay` подтянул бы дату к сегодняшней смене, и вся
      // предоплата будущих заездов свалилась бы в одну кассу.
      const when = d(Math.min(
        addDays(c.checkIn, -int(3, 25)).getTime(),
        addDays(TODAY, -int(0, 14)).getTime(),
      ))
      await pay(id, prepayment, payMethod('remote'), when, { comment: 'Предоплата при бронировании' })
    }

    await recalcBookingPaid(id)
  }

  // Касса СЕГОДНЯШНЕЙ смены должна быть непустой: показ начинается с неё.
  const todayGuests = created.filter((c) => c.status === 'CHECKED_IN' && !c.booking.accountBookingId)
  let todayPaid = await prisma.payment.count({ where: { businessDate: TODAY } })
  for (const c of todayGuests) {
    if (todayPaid >= 12) break
    const fresh = await prisma.booking.findUnique({
      where: { id: c.booking.id }, select: { totalAmount: true, paidAmount: true },
    })
    const due = Math.round((fresh.totalAmount || 0) - (fresh.paidAmount || 0))
    if (due <= 1000) continue
    await pay(c.booking.id, Math.round(due / 2 / 100) * 100, payMethod('desk'), TODAY,
      { comment: 'Доплата на стойке', hour: 7 })
    await recalcBookingPaid(c.booking.id)
    todayPaid++
  }

  return stats
}

// ─── Квоты партнёров ──────────────────────────────────────────────────────────

/**
 * Квоты считаются ДО генерации броней и передаются в планировщик: иначе подбор
 * продал бы номер, который уже отдан партнёру, и шахматка показала бы «занято»
 * поверх квоты.
 *
 * Квоты ставим только на БУДУЩИЕ месяцы — на прошедшие они бессмысленны
 * (квота это «номера зарезервированы за турфирмой до релиза»), и не дальше
 * MONTHS_AHEAD: за границей периода нет ни цен, ни смысла.
 *
 * Релиз — это временный возврат части квоты в свободную продажу. Он не декорация:
 * `utils/allotment.js` вычитает released-дни из квоты, поэтому освобождённые дни
 * мы отдаём обычному планировщику, и в них появляются прямые брони. Оставь мы их
 * заблокированными — релиз в базе был бы, а увидеть его эффект было бы негде.
 */
function planPartnerQuotas(rooms, partnerByName) {
  const byNumber = (list) => rooms.filter((r) => list.includes(r.number))
  const months = [1, 2, 3, 4].filter((m) => m <= MONTHS_AHEAD)
  // По кругу, а не «зажать в последний»: при --months-ahead=1 всем достаётся один
  // и тот же месяц, и одинаковые квоты накладывались бы друг на друга. Совпадения
  // всё равно возможны — их отсекает проверка на пересечение в seedPartnersAndQuotas.
  const M = (i) => months[i % months.length]

  const out = []

  /** Все выходные (пт→вс, две ночи) внутри месяца со смещением `shift`. */
  const weekends = (shift) => {
    const from = monthStart(TODAY, shift)
    const to = monthEnd(TODAY, shift)
    const res = []
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const day = new Date(t)
      if (day.getUTCDay() !== 5) continue
      const end = addDays(day, 2)
      if (nights(day, end > to ? to : end) >= 1) res.push({ from: day, to: end > to ? to : end })
    }
    return res
  }

  /** Недельные заезды (пн→вс) внутри месяца со смещением `shift`. */
  const weeks = (shift) => {
    const from = monthStart(TODAY, shift)
    const to = monthEnd(TODAY, shift)
    const res = []
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const day = new Date(t)
      if (day.getUTCDay() !== 1) continue
      const end = addDays(day, 6)
      if (nights(day, end > to ? to : end) >= 2) res.push({ from: day, to: end > to ? to : end })
    }
    return res
  }

  const add = (partner, roomList, ranges, notes, releasePlan) => {
    const p = partnerByName.get(partner)
    if (!p) return
    for (const range of ranges) {
      for (const room of roomList) {
        out.push({ partner: p, room, from: range.from, to: range.to, notes, releases: releasePlan(range) })
      }
    }
  }

  // Kompas Travel — коттеджи на выходные двух ближайших месяцев. Часть выходных
  // партнёр возвращает целиком (группа не набралась) — релиз на весь отрезок.
  add(
    'Kompas Travel', byNumber(['К-1', 'К-2', 'К-3', 'К-4']),
    [...weekends(M(0)), ...weekends(M(1))],
    'Квота на выходные, релиз за 5 дней до заезда',
    (range) => (chance(0.22)
      ? [{ from: range.from, to: range.to, reason: 'Группа не набралась, квота возвращена в продажу' }]
      : []),
  )

  // «Жетысу Тревел» — эко-домики на выходные ближайшего месяца, семейные туры.
  add(
    '«Жетысу Тревел»', byNumber(['Э-1', 'Э-2', 'Э-3']),
    weekends(M(0)),
    'Туры выходного дня, подтверждение состава за 3 дня',
    (range) => (chance(0.15) ? [{ from: range.from, to: range.to, reason: 'Тур отменён' }] : []),
  )

  // «Алтын Сапар» — стандарты главного корпуса под недельные путёвки.
  // Хвост недели чаще всего остаётся непроданным и уходит в релиз.
  add(
    '«Алтын Сапар»', byNumber(['101', '102', '103', '104', '105', '106']),
    [...weeks(M(1)), ...weeks(M(2))],
    'Недельные путёвки, квота держится до понедельника предыдущей недели',
    (range) => (chance(0.3)
      ? [{ from: addDays(range.to, -2), to: range.to, reason: 'Хвост недели возвращён в свободную продажу' }]
      : []),
  )

  // Silk Road Tours — люксы под иностранную группу, один длинный блок.
  const silkFrom = addDays(monthStart(TODAY, M(3)), 9)
  add(
    'Silk Road Tours', byNumber(['213', '214', '215', '216']),
    [{ from: silkFrom, to: addDays(silkFrom, 5) }],
    'Группа по Шёлковому пути, документы гостей присылают заранее',
    () => [],
  )

  return out
}

/** Диапазон `range` минус «дыры» (релизы). Возвращает 0–2 отрезка. */
function subtractHoles(range, holes) {
  let pieces = [{ from: range.from, to: range.to }]
  for (const h of holes) {
    const next = []
    for (const p of pieces) {
      if (h.to <= p.from || h.from >= p.to) { next.push(p); continue }
      if (h.from > p.from) next.push({ from: p.from, to: h.from })
      if (h.to < p.to) next.push({ from: h.to, to: p.to })
    }
    pieces = next
  }
  return pieces.filter((p) => nights(p.from, p.to) >= 1)
}

async function seedPartnersAndQuotas(rooms) {
  const partners = []
  for (const p of PARTNERS) partners.push(await prisma.partner.create({ data: { ...p, isActive: true } }))
  const partnerByName = new Map(partners.map((p) => [p.name, p]))

  const planned = planPartnerQuotas(rooms, partnerByName)
  const byRoom = new Map()
  const quotaSales = []
  let releaseCount = 0

  // Две квоты на один номер и одни даты — это не «две турфирмы поделили номер»,
  // а ошибка засева: реализованные квоты стали бы двумя бронями в одном номере
  // на одни сутки, и база отвергла бы вторую (booking_no_overlap). Накладку
  // отбрасываем здесь, а не надеемся, что планировщик месяцев её не создаст:
  // при --months-ahead=1 все квоты честно приходятся на один и тот же месяц.
  const takenByRoom = new Map()
  const overlapsTaken = (roomId, from, to) =>
    (takenByRoom.get(roomId) || []).some((r) => from < r.to && to > r.from)

  for (const q of planned) {
    if (overlapsTaken(q.room.id, q.from, q.to)) continue
    if (!takenByRoom.has(q.room.id)) takenByRoom.set(q.room.id, [])
    takenByRoom.get(q.room.id).push({ from: q.from, to: q.to })

    const allotment = await prisma.allotment.create({
      data: {
        partnerId: q.partner.id, roomId: q.room.id, dateFrom: q.from, dateTo: q.to, notes: q.notes,
      },
    })
    for (const r of q.releases) {
      await prisma.release.create({
        data: { allotmentId: allotment.id, dateFrom: r.from, dateTo: r.to, reason: r.reason },
      })
      releaseCount++
    }

    // Планировщику отдаём квоту БЕЗ освобождённых дней: в релизе отель продаёт сам.
    const effective = subtractHoles({ from: q.from, to: q.to }, q.releases)
    if (!byRoom.has(q.room.id)) byRoom.set(q.room.id, [])
    for (const piece of effective) {
      byRoom.get(q.room.id).push(piece)
      // Часть квоты партнёр реализовал — эти дни занимает его гость. Остальное
      // стоит пустым: «зарезервировано за турфирмой, заезда ещё нет».
      if (chance(0.45)) {
        quotaSales.push({ room: q.room, checkIn: piece.from, checkOut: piece.to, partner: q.partner })
      }
    }
  }

  const allotments = await prisma.allotment.count()
  return { partners, quotaBlocks: byRoom, quotaSales, allotments, releases: releaseCount }
}

// ─── Журнал действий ──────────────────────────────────────────────────────────

/**
 * Журнал действий. Пишем окно последних 45 дней, а не весь период: журнал у
 * реального объекта чистится по сроку (`AUDIT_RETENTION_DAYS`), и полтора года
 * записей — это не «как в жизни», а просто мусор в базе показа. Число строк —
 * от размера базы: 0,4 записи на бронь примерно соответствует живому темпу
 * (бронь заводят, правят, заселяют, принимают деньги — но в журнал попадает
 * далеко не каждое действие каждой брони).
 */
async function seedAuditLog(admins, created) {
  const WINDOW_DAYS = 45
  const total = Math.max(60, Math.round(created.length * 0.4))
  const sample = created.filter((c) => c.checkIn >= addDays(TODAY, -WINDOW_DAYS))
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

  for (let i = 0; i < total; i++) {
    const admin = pick(admins)
    const when = at(addDays(TODAY, -int(0, WINDOW_DAYS)), int(4, 15))
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
    'release', 'shift', 'booking', 'bookingService', 'bookingCharge', 'payment', 'auditLog']) {
    t[name] = await prisma[name].count()
  }
  return t
}

/**
 * Сводка для показа: сколько чего получилось. Считаем SQL'ом по факту записанного,
 * а не по счётчикам генератора — если засев где-то разошёлся с задуманным, отчёт
 * должен показать базу, а не намерение.
 */
async function summary() {
  const byStatus = await prisma.booking.groupBy({ by: ['status'], _count: { _all: true } })
  const money = await prisma.$queryRawUnsafe(`
    SELECT
      (SELECT COALESCE(sum(amount),0) FROM "Payment" WHERE kind='payment' AND "voidedAt" IS NULL)::float AS taken,
      (SELECT COALESCE(sum(amount),0) FROM "Payment" WHERE kind='refund'  AND "voidedAt" IS NULL)::float AS refunded,
      (SELECT count(*) FROM "Payment" WHERE kind='refund')::int AS refunds,
      (SELECT count(*) FROM "Payment" WHERE "voidedAt" IS NOT NULL)::int AS voided,
      (SELECT COALESCE(sum("totalAmount"),0) FROM "Booking" WHERE "accountBookingId" IS NULL)::float AS charged
  `)
  // Долг считаем по счетам (голова цепочки), как это делают касса и отчёт «Долги»:
  // у продолжения своих денег нет.
  const debts = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n, COALESCE(sum("totalAmount" - "paidAmount"),0)::float AS amount
    FROM "Booking"
    WHERE "accountBookingId" IS NULL
      AND status IN ('CHECKED_OUT','NO_SHOW')
      AND round(("totalAmount" - "paidAmount")::numeric, 2) > 0
  `)
  const byMethod = await prisma.payment.groupBy({
    by: ['method'], where: { kind: 'payment', voidedAt: null }, _count: { _all: true }, _sum: { amount: true },
  })
  const withDocs = await prisma.booking.count({ where: { guestDocNumber: { not: null } } })
  const withPartner = await prisma.booking.count({ where: { partnerId: { not: null } } })
  const withServices = await prisma.$queryRawUnsafe(
    'SELECT count(DISTINCT "bookingId")::int AS n FROM "BookingService"',
  )
  const guests = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM (
      SELECT "guestPhone" FROM "Booking" WHERE "guestPhone" IS NOT NULL
      GROUP BY "guestPhone" HAVING count(*) > 1
    ) q
  `)
  return {
    byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    taken: money[0].taken,
    refunded: money[0].refunded,
    refunds: money[0].refunds,
    voided: money[0].voided,
    charged: money[0].charged,
    debtCount: debts[0].n,
    debtAmount: debts[0].amount,
    byMethod,
    withDocs,
    withPartner,
    withServices: withServices[0].n,
    repeatGuests: guests[0].n,
  }
}

// ─── Точка входа ──────────────────────────────────────────────────────────────

async function main() {
  const dbName = (process.env.DATABASE_URL || '').split('/').pop().split('?')[0]
  log(`База: ${dbName}   рабочая дата демо: ${iso(TODAY)}   период: ${iso(FROM)} … ${iso(TO)}`)

  // Предохранитель (13.09.2026): `npm run db:demo` берёт DATABASE_URL из server/.env,
  // то есть указывает на РАБОЧУЮ базу разработчика. Скрипт стирает всё, поэтому
  // без явного разрешения он работает только с базой, в имени которой есть
  // «demo» или «audit». Стенд на встроенном Postgres (база `hotel_booking` на другом
  // порту) запускается с `--allow-db=hotel_booking`.
  const allowed = /demo|audit/i.test(dbName) || optValue('allow-db', '') === dbName
  if (!allowed) {
    console.error(
      `\nБаза «${dbName}» не похожа на демо-базу (в имени нет «demo»/«audit»).\n` +
      'Скрипт стирает данные. Если это точно не рабочая база — запусти с ключом ' +
      `--allow-db=${dbName}\n`,
    )
    process.exitCode = 1
    return
  }

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

  log('Партнёры, квоты и релизы…')
  const { partners, quotaBlocks, quotaSales, allotments, releases } = await seedPartnersAndQuotas(rooms)

  log('Смены…')
  const { byDate: shiftByDate } = await seedShifts(adminIds)

  log('Брони…')
  // Постоянных гостей берём примерно по одному на 25 броней периода: меньше —
  // повторных визитов не видно, больше — весь отель состоит из одних и тех же людей.
  const regulars = buildRegulars(Math.max(20, Math.round(rooms.length * (MONTHS_BACK + MONTHS_AHEAD) / 8)))
  const { created, repairs } = await seedBookings({
    rooms, capacityByCode, services, adminIds, shiftByDate, quotaBlocks, quotaSales, partners, regulars,
  })

  const occupied = new Map(rooms.map((r) => [r.id, []]))
  for (const c of created) occupied.get(c.room.id).push({ checkIn: c.checkIn, checkOut: c.checkOut })
  // Ремонтный блок — тоже занятость: без него переезд «в свободный номер»
  // упирался бы в exclusion-constraint (проверено — падало именно на нём).
  for (const r of repairs) occupied.get(r.roomId).push({ checkIn: r.checkIn, checkOut: r.checkOut })

  log('Переезды…')
  // Примерно один переезд на сотню броней: переезд — событие редкое, но на показе
  // без него не объяснить, что такое «один счёт на цепочку».
  const chains = await seedChains({
    created, rooms, occupied, adminIds, quotaBlocks,
    maxChains: Math.max(3, Math.round(created.length / 100)),
  })

  log('Начисления…')
  await buildCharges({ created, chains, adminIds })

  log('Платежи…')
  // Счётчики генератора здесь не нужны: сводка ниже считает всё SQL'ом по факту
  // записанного — так видно базу, а не намерение скрипта.
  await seedPayments({ created, chains, admins, shiftByDate })

  log('Журнал действий…')
  await seedAuditLog(admins, created)

  const t = await counts()
  const v = await verify()
  const s = await summary()

  const kzt = (n) => new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ₸'
  const pct = (n, of) => (of ? ` (${Math.round(n / of * 100)} %)` : '')
  const st = (k) => s.byStatus[k] || 0
  const methodLine = ['cash', 'card', 'transfer']
    .map((m) => {
      const row = s.byMethod.find((x) => x.method === m)
      const label = { cash: 'наличные', card: 'карта', transfer: 'перевод' }[m]
      return `${label} ${row ? row._count._all : 0}`
    })
    .join(' · ')

  console.log('\n─── Демо-данные записаны ─────────────────────────────────────')
  console.log(`  база .................. ${dbName}`)
  console.log(`  рабочая дата .......... ${iso(TODAY)} (последняя смена)`)
  console.log(`  период броней ......... ${iso(FROM)} … ${iso(TO)}  (−${MONTHS_BACK} / +${MONTHS_AHEAD} мес.)`)
  console.log(`  номера ................ ${t.room} в ${t.building} корпусах, ${t.category} категорий`)
  console.log(`  цены .................. ${rateCount} строк (${iso(RATES_FROM)} … ${iso(RATES_TO)})`)
  console.log(`  смены ................. ${t.shift} (закрыты по дням, открыта смена ${iso(TODAY)})`)
  console.log(`  брони ................. ${t.booking} (переездов: ${chains.length}, ремонтных блоков: ${repairs.length})`)
  console.log(`    проживают сейчас .... ${st('CHECKED_IN')}`)
  console.log(`    выехали ............. ${st('CHECKED_OUT')}`)
  console.log(`    подтверждены ........ ${st('CONFIRMED')}`)
  console.log(`    отменены ............ ${st('CANCELLED')}${pct(st('CANCELLED'), t.booking)}`)
  console.log(`    незаезды ............ ${st('NO_SHOW')}${pct(st('NO_SHOW'), t.booking)}`)
  console.log(`  начисления / услуги ... ${t.bookingCharge} / ${t.bookingService} строк, услуги у ${s.withServices} броней${pct(s.withServices, t.booking)}`)
  console.log(`  начислено гостям ...... ${kzt(s.charged)}`)
  console.log(`  принято ............... ${kzt(s.taken)} за ${t.payment} платежей (${methodLine})`)
  console.log(`  возвращено ............ ${kzt(s.refunded)} по ${s.refunds} возвратам${pct(s.refunds, t.booking)}, отменённых записей: ${s.voided}`)
  console.log(`  долги (выехали/незаезд) ${s.debtCount} броней${pct(s.debtCount, st('CHECKED_OUT') + st('NO_SHOW'))} на ${kzt(s.debtAmount)}`)
  console.log(`  документы гостей ...... ${s.withDocs} броней${pct(s.withDocs, t.booking)}, повторных гостей (по телефону): ${s.repeatGuests}`)
  console.log(`  партнёры .............. ${t.partner}, квот ${allotments}, релизов ${releases}, броней от партнёров ${s.withPartner}`)
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
