#!/usr/bin/env node
/**
 * Штампует дату выпуска сборки в server/package.json → поле `buildDate`.
 *
 * Зачем: гейт обслуживания сравнивает «до какого числа оплачено обслуживание»
 * с «когда выпущена эта версия». Дата выпуска обязана быть свойством СБОРКИ, а не
 * сегодняшним числом на машине клиента — иначе у отеля, который просто не
 * обновлялся, программа однажды утром сама себя заблокировала бы.
 *
 * Вызывается из npm run build:electron (корневой package.json) перед упаковкой,
 * так что в установщик уезжает уже проштампованный package.json.
 * Читает эту дату server/src/utils/license.js → getBuildDate().
 *
 *   node scripts/stamp-build-date.js            # сегодня
 *   node scripts/stamp-build-date.js 2026-09-06 # явная дата
 */

const fs = require('fs')
const path = require('path')

const PKG = path.join(__dirname, '..', 'package.json')

/**
 * Не только форма, но и существование даты: '2027-13-99' проходит по маске
 * ГГГГ-ММ-ДД, а Date его молча превратит в другое число. Такой штамп
 * getBuildDate() потом отбросит как мусор — и гейт обслуживания тихо
 * перестанет работать во всех сборках.
 */
function isRealDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

const arg = process.argv[2]
if (arg !== undefined && !isRealDate(arg)) {
  console.error(`stamp-build-date: «${arg}» — не дата. Нужен формат ГГГГ-ММ-ДД.`)
  process.exit(1)
}
// Локальный календарный день, а не toISOString(): сборка вечером 6-го числа
// в UTC+5 получила бы штамп «5-е». Дата выпуска должна совпадать с той, что
// человек напишет в накладной. (Те же грабли, что todayUTC() в businessDate.js.)
function today() {
  const n = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`
}

const date = arg || today()

const raw = fs.readFileSync(PKG, 'utf8')
const pkg = JSON.parse(raw)
pkg.buildDate = date

// Отступ и перевод строки как у npm — чтобы файл не «менялся» целиком в diff'е.
const indent = /\n(\s+)"/.exec(raw)?.[1] ?? '  '
fs.writeFileSync(PKG, `${JSON.stringify(pkg, null, indent)}\n`, 'utf8')

console.log(`stamp-build-date: server/package.json → buildDate=${date}`)
