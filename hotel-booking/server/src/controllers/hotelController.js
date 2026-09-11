const { prisma } = require('../utils/prisma')
const { createError } = require('../middleware/errorHandler')

const PRICING_BASES = ['room', 'person']

/**
 * Реквизиты для печатных документов (счёт турфирме, подтверждение брони гостю).
 * Порядок ровно тот, в котором они идут в шапке документа.
 *
 * Все — необязательные строки: печать не блокируется отсутствием реквизита,
 * а выводит то, что заполнено. Иначе свежая установка не смогла бы напечатать
 * подтверждение брони, пока владелец не найдёт свой IBAN.
 */
const REQUISITE_FIELDS = [
  'legalName', 'bin', 'address', 'phone', 'email',
  'bankName', 'iban', 'signerName', 'signerTitle',
]

/**
 * Пустое поле формы и явный null — одно и то же: «реквизит не заполнен».
 * Хранить «» нельзя — тогда печать не сможет отличить «нет реквизита»
 * (строку не выводим) от «есть, но пустой» (выведем пустую строку в шапке).
 */
function cleanText(v) {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/**
 * БИН/ИИН из свидетельства часто копируют группами («123 456 789 012») —
 * пробелы убираем молча, а не отвечаем 400 на верный номер.
 */
function cleanBin(v) {
  const s = cleanText(v)
  return s === null ? null : s.replace(/[\s-]/g, '')
}

/**
 * IBAN печатают на бланках группами по четыре и в разном регистре.
 * Приводим к каноническому виду — сплошная строка заглавными: по этому же
 * значению банк сверяет счёт, а в документе мы разобьём его на группы сами.
 */
function cleanIban(v) {
  const s = cleanText(v)
  return s === null ? null : s.replace(/\s/g, '').toUpperCase()
}

/**
 * Что `GET/PUT /api/hotel` отдаёт наружу. Именно БЕЛЫЙ список, а не «всё, кроме
 * перечисленного» (`omit`): в `HotelSettings` лежит строка на одну установку, и
 * туда со временем попадает всё, чему нужна единственная строка настроек, — в том
 * числе секреты (приватный ключ личности установки, `instancePrivateKey`).
 * При чёрном списке новая колонка публикуется в тот же день, когда её добавили в
 * схему, и заметить это некому: тест на «в ответе нет лишнего» никто не пишет
 * заранее. При белом — новое поле по умолчанию НЕ уходит клиенту, а чтобы его
 * отдать, надо дописать строку здесь, то есть подумать.
 *
 * Порядок — как в схеме: общие настройки, отметка мастера, реквизиты, `updatedAt`.
 */
const PUBLIC_FIELDS = [
  'id', 'name', 'city', 'currency', 'pricingBase', 'lateArrivalHour',
  'setupCompletedAt',
  ...REQUISITE_FIELDS,
  'updatedAt',
]

/** Тот же список в виде `select` для Prisma — чтобы лишнее не покидало базу. */
const PUBLIC_SELECT = Object.fromEntries(PUBLIC_FIELDS.map((f) => [f, true]))

/**
 * Белый список на выходе из контроллера. Дублирует `select` намеренно: `select`
 * стоит там, где мы ЧИТАЕМ готовую строку, а запись (`create`/`update`) отдаёт
 * то, что записала, — и один пропущенный `select` не должен превращаться в утечку.
 * Ключи, которых в строке нет (свежесозданная строка), просто отсутствуют.
 */
function publicOnly(row) {
  if (!row) return row
  const out = {}
  for (const f of PUBLIC_FIELDS) if (f in row) out[f] = row[f]
  return out
}

/** Настройки объекта — всегда одна строка (id = 1). Создаём при первом обращении. */
async function getSettings() {
  const existing = await prisma.hotelSettings.findUnique({
    where: { id: 1 },
    select: PUBLIC_SELECT,
  })
  if (existing) return publicOnly(existing)
  return publicOnly(await prisma.hotelSettings.create({ data: { id: 1 } }))
}

// GET /api/hotel
async function get(_req, res, next) {
  try {
    res.json({ data: await getSettings() })
  } catch (err) {
    next(err)
  }
}

// PUT /api/hotel
async function update(req, res, next) {
  try {
    const { name, city, currency, pricingBase, lateArrivalHour } = req.body

    if (pricingBase !== undefined && !PRICING_BASES.includes(pricingBase)) {
      return next(createError("pricingBase должен быть 'room' или 'person'", 400))
    }
    if (lateArrivalHour !== undefined && lateArrivalHour !== null) {
      const h = parseInt(lateArrivalHour)
      if (Number.isNaN(h) || h < 0 || h > 23) {
        return next(createError('Час позднего заезда — целое число от 0 до 23', 400))
      }
    }

    /**
     * PUT здесь ЧАСТИЧНЫЙ: в data попадает только то, что реально пришло.
     * Реквизиты заполняют один раз в настройках, а сохранять настройки объекта
     * будут потом из других мест (мастер, экран «Объект»), где полей реквизитов
     * в форме нет вовсе — полное перезаписывание молча стёрло бы IBAN.
     * Пришедшее пустым (null или «») — наоборот, стирает: опечатку в реквизите
     * надо чем-то исправлять.
     */
    const requisites = {}
    for (const field of REQUISITE_FIELDS) {
      if (req.body[field] === undefined) continue
      if (field === 'bin') requisites.bin = cleanBin(req.body.bin)
      else if (field === 'iban') requisites.iban = cleanIban(req.body.iban)
      else requisites[field] = cleanText(req.body[field])
    }

    await getSettings()  // гарантируем, что строка есть
    const data = await prisma.hotelSettings.update({
      where: { id: 1 },
      data: {
        ...(name !== undefined && { name: String(name).trim() || 'Отель' }),
        ...(city !== undefined && { city: city?.trim() || null }),
        ...(currency !== undefined && { currency: String(currency).trim() || 'KZT' }),
        ...(pricingBase !== undefined && { pricingBase }),
        ...(lateArrivalHour !== undefined && {
          lateArrivalHour: lateArrivalHour === null ? null : parseInt(lateArrivalHour),
        }),
        ...requisites,
      },
    })
    res.json({ data: publicOnly(data) })
  } catch (err) {
    next(err)
  }
}

module.exports = {
  get,
  update,
  getSettings,
  // Для правил валидации в routes/hotel.js и для тестов: нормализация обязана
  // быть ОДНА на роут и контроллер, иначе роут проверит одно, а сохранится другое.
  REQUISITE_FIELDS,
  PUBLIC_FIELDS,
  PUBLIC_SELECT,
  publicOnly,
  cleanText,
  cleanBin,
  cleanIban,
}
