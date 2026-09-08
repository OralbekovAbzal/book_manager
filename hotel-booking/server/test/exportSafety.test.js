import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Безопасность выгрузок отчётов (аудит D4-001, D4-002).
 *
 * Две разные беды, обе воспроизводятся на живых данных:
 *  • Excel: имя листа берётся из заголовка отчёта, а `: / \ ? * [ ]` в имени листа
 *    запрещены — «Долги: за июль» роняло экспорт в 500 прямо на кнопке;
 *  • CSV: значение, начинающееся с `=`, `@`, `+`, `-` или табуляции, Excel считает
 *    ФОРМУЛОЙ. Имя гостя `=1+1` — безобидно, `=cmd|'/c calc'!A0` — уже нет, а имя
 *    гостя вводит кто угодно с стойки.
 *
 * При этом нейтрализация не должна портить нормальные данные: телефон `+7 701…`
 * и отрицательная сумма `-5` обязаны остаться собой, иначе выгрузку нельзя считать.
 */

const load = () => loadCjs('src/reports/export.js', {
  stubs: {
    '../middleware/errorHandler': {
      createError: (message, status = 400) => Object.assign(new Error(message), { status }),
    },
    '../utils/logger': silentLogger,
  },
})

/** Понятная красная строка вместо «is not a function», пока функции нет. */
function need(mod, name) {
  const fn = mod[name]
  if (typeof fn !== 'function') {
    return () => { throw new Error(`src/reports/export.js не экспортирует ${name}() — контракт волны «Отчёты и клиент»`) }
  }
  return fn
}

const FORBIDDEN = /[:/\\?*[\]]/

const result = (over = {}) => ({
  report: { id: 'debts', title: 'Долги', ...(over.report || {}) },
  columns: over.columns || [
    { key: 'guestName', title: 'Гость', type: 'text' },
    { key: 'due', title: 'Долг', type: 'money', align: 'right' },
  ],
  rows: over.rows || [],
  totals: over.totals || null,
  params: { period: { from: '2026-09-01', to: '2026-09-30' } },
  meta: { hotelName: 'Туран', generatedAt: '2026-09-09T06:00:00Z', requestedBy: 'Админ' },
})

const csvText = (mod, res) => mod.buildCsv(res, 'Итого').toString('utf8')
const csvLines = (mod, res) => csvText(mod, res).replace(/^﻿/, '').split('\r\n')

// ─── Имя листа Excel ─────────────────────────────────────────────────────────

describe('safeSheetName — заголовок отчёта в имя листа Excel', () => {
  it('запрещённые Excel символы убраны, имя не длиннее 31 знака', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    const name = safeSheetName('Долги: тест / проверка?')
    expect(name).not.toMatch(FORBIDDEN)
    expect(name.length).toBeLessThanOrEqual(31)
    expect(name.length).toBeGreaterThan(0)
  })

  it('все шесть запрещённых знаков сразу — включая скобки и звёздочку', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName('А:Б/В\\Г?Д*Е[Ж]З')).not.toMatch(FORBIDDEN)
  })

  it('апострофы по краям убраны — Excel не принимает их в имени листа', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    const name = safeSheetName("'Отчёт'")
    expect(name.startsWith("'")).toBe(false)
    expect(name.endsWith("'")).toBe(false)
  })

  it('пустое имя и зарезервированное «History» заменяются на «Отчёт»', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName('')).toBe('Отчёт')
    expect(safeSheetName('History')).toBe('Отчёт')
    expect(safeSheetName('history')).toBe('Отчёт')  // регистр Excel не различает
  })

  it('сорок символов обрезаются до тридцати одного', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName('А'.repeat(40))).toHaveLength(31)
  })

  it('обычный заголовок не трогается', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName('Выручка за период')).toBe('Выручка за период')
  })

  it('заголовок из одних запрещённых знаков не даёт пустого имени', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName(':::')).toBe('Отчёт')
    expect(safeSheetName('   ')).toBe('Отчёт')
  })

  it('обрезка не оставляет апостроф на новом краю', () => {
    // Тридцать первый символ — апостроф: после обрезки он оказался бы последним,
    // а Excel такое имя листа не принимает.
    const safeSheetName = need(load(), 'safeSheetName')
    const name = safeSheetName('А'.repeat(30) + "'" + 'Б'.repeat(10))
    expect(name.endsWith("'")).toBe(false)
    expect(name.length).toBeLessThanOrEqual(31)
  })

  it('null и число вместо заголовка не роняют выгрузку', () => {
    const safeSheetName = need(load(), 'safeSheetName')
    expect(safeSheetName(null)).toBe('Отчёт')
    expect(safeSheetName(undefined)).toBe('Отчёт')
    expect(safeSheetName(2026)).toBe('2026')
  })
})

// ─── Формулы в CSV ───────────────────────────────────────────────────────────

describe('csvSafe — значение из ячейки не должно стать формулой', () => {
  it('знаки начала формулы получают апостроф', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('=1+1')).toBe("'=1+1")
    expect(csvSafe('@SUM')).toBe("'@SUM")
    expect(csvSafe('\tx')).toBe("'\tx")
  })

  it('плюс и минус перед текстом — тоже формула', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('-cmd|x')).toBe("'-cmd|x")
    expect(csvSafe('+cmd')).toBe("'+cmd")
  })

  it('телефон и отрицательное число остаются собой', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('+7 701 123-45-67')).toBe('+7 701 123-45-67')
    expect(csvSafe('-5')).toBe('-5')
  })

  it('обычный текст и пустая строка не меняются', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('Иванов')).toBe('Иванов')
    expect(csvSafe('')).toBe('')
  })

  it('телефон со скобками и дефисами тоже остаётся собой', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('+7 (701) 123-45-67')).toBe('+7 (701) 123-45-67')
    expect(csvSafe('+7-701-123-45-67')).toBe('+7-701-123-45-67')
  })

  // ОЖИДАЕМО ПАДАЕТ — находка, не поломка. `export.js`, комментарий над
  // `PLAIN_NUMBER` прямо называет `-1 200,50` случаем, который портить нельзя,
  // но в самом выражении `/^[+-]?\d[\d\s().-]*$/` нет запятой — русский формат
  // отрицательной суммы получает апостроф. Опасность практическая низкая:
  // денежные колонки идут числовой веткой `buildCsv` и сюда не попадают,
  // задеть может только текстовую колонку с уже отформатированной суммой
  // (например, самодельная колонка-формула `str(...)` в конструкторе отчётов).
  it('отрицательная сумма в русском формате не должна получать апостроф', () => {
    const csvSafe = need(load(), 'csvSafe')
    expect(csvSafe('-1 200,50')).toBe('-1 200,50')
  })
})

describe('buildCsv — выгрузка целиком', () => {
  it('имя гостя-формула уходит с апострофом, а сумма остаётся числом', () => {
    const mod = load()
    const res = result({ rows: [{ guestName: '=1+1', due: -5 }] })
    const cells = csvLines(mod, res)[1].split(';')

    expect(cells[0]).toContain("'=1+1")
    expect(cells[1]).toBe('-5')  // числовая колонка не портится нейтрализацией
  })

  it('минус перед текстом обезврежен и в текстовой колонке', () => {
    const mod = load()
    const res = result({ rows: [{ guestName: '-cmd|x', due: 0 }] })
    expect(csvLines(mod, res)[1].split(';')[0]).toContain("'-cmd|x")
  })

  it('BOM в начале файла сохранён — иначе кириллица в Excel превратится в кракозябры', () => {
    const mod = load()
    const text = csvText(mod, result({ rows: [{ guestName: 'Иванов', due: 1000 }] }))
    expect(text.charCodeAt(0)).toBe(0xFEFF)
  })

  it('точка с запятой внутри значения по-прежнему уводит ячейку в кавычки', () => {
    const mod = load()
    const res = result({ rows: [{ guestName: 'ТОО «Ромашка»; отдел продаж', due: 0 }] })
    expect(csvLines(mod, res)[1]).toContain('"ТОО «Ромашка»; отдел продаж"')
  })

  it('телефон в текстовой колонке не обрастает апострофом', () => {
    const mod = load()
    const res = result({
      columns: [{ key: 'guestPhone', title: 'Телефон', type: 'text' }],
      rows: [{ guestPhone: '+7 701 123-45-67' }],
    })
    expect(csvLines(mod, res)[1]).toBe('+7 701 123-45-67')
  })
})

// ─── Excel ───────────────────────────────────────────────────────────────────

describe('buildXlsx — заголовок с двоеточием и слэшем', () => {
  it('экспорт не падает, лист назван допустимым именем', async () => {
    const mod = load()
    const res = result({
      report: { id: 'debts', title: 'Долги: тест / проверка?' },
      rows: [{ guestName: 'Иванов', due: 1000 }],
    })

    const buffer = await mod.buildXlsx(res, 'Итого')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)

    const name = wb.worksheets[0].name
    expect(name).not.toMatch(FORBIDDEN)
    expect(name.length).toBeLessThanOrEqual(31)
  })

  it('длинный заголовок не роняет экспорт — имя листа обрезается', async () => {
    const mod = load()
    const res = result({ report: { id: 'x', title: 'Очень длинный заголовок отчёта про долги гостей' } })

    const buffer = await mod.buildXlsx(res, 'Итого')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)
    expect(wb.worksheets[0].name.length).toBeLessThanOrEqual(31)
  })

  it('сам заголовок в первой строке листа остаётся полным', async () => {
    const mod = load()
    const title = 'Долги: тест / проверка?'
    const buffer = await mod.buildXlsx(result({ report: { id: 'debts', title } }), 'Итого')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buffer)
    expect(String(wb.worksheets[0].getCell(1, 1).value)).toBe(title)
  })
})
