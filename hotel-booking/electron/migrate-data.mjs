// Разовый перенос данных из старой базы (localhost:5432) во встроенную базу
// хоста (userData/pgdata, порт 5433). Сохраняет ID и связи.
// Запуск:  cd electron && node migrate-data.mjs
import EmbeddedPostgres from 'embedded-postgres'
import pg from 'pg'
import { readFileSync } from 'fs'
import path from 'path'

const { Client } = pg
const UD = path.join(process.env.APPDATA, 'hotel-booking-desktop')
const cfg = JSON.parse(readFileSync(path.join(UD, 'config.json'), 'utf8'))

// Порядок: родители раньше детей (внешние ключи).
const ORDER = [
  'Category', 'Admin', 'Partner', 'BookingFlag', 'License', 'BackupLog',
  'Room', 'Shift', 'Snapshot', 'Allotment', 'Booking', 'Release',
]

const SOURCE = {
  host: '127.0.0.1', port: 5432, user: 'postgres',
  password: 'password', database: 'hotel_booking',
}

async function copyTable(src, dst, table) {
  const { rows } = await src.query(`SELECT * FROM "${table}" ORDER BY 1`)
  if (rows.length === 0) return 0
  const cols = Object.keys(rows[0])
  const colList = cols.map((c) => `"${c}"`).join(', ')
  for (const row of rows) {
    const ph = cols.map((_, i) => `$${i + 1}`).join(', ')
    const vals = cols.map((c) => row[c])
    await dst.query(`INSERT INTO "${table}" (${colList}) VALUES (${ph})`, vals)
  }
  // Сдвигаем счётчик автоинкремента, чтобы новые записи не конфликтовали по id.
  await dst.query(
    `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'),
       GREATEST((SELECT COALESCE(MAX(id), 0) FROM "${table}"), 1))`
  ).catch(() => {}) // у некоторых таблиц может не быть serial id
  return rows.length
}

async function main() {
  const epg = new EmbeddedPostgres({
    databaseDir: path.join(UD, 'pgdata'),
    user: 'postgres', password: cfg.dbPassword, port: 5433,
    persistent: true, onLog: () => {}, onError: () => {},
  })
  console.log('• Запускаю встроенную базу (5433)…')
  await epg.start()

  const src = new Client(SOURCE)
  const dst = epg.getPgClient('hotel_booking')
  await src.connect()
  await dst.connect()

  console.log('• Очищаю целевые таблицы (seed-данные)…')
  await dst.query(`TRUNCATE ${ORDER.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`)

  console.log('• Переношу данные:')
  let total = 0
  for (const table of ORDER) {
    const n = await copyTable(src, dst, table)
    if (n > 0) console.log(`    ${table}: ${n}`)
    total += n
  }

  // Контроль
  const check = async (t) => (await dst.query(`SELECT count(*)::int n FROM "${t}"`)).rows[0].n
  console.log('\n• Проверка целевой базы:')
  console.log(`    Room=${await check('Room')}  Booking=${await check('Booking')}  Snapshot=${await check('Snapshot')}  Admin=${await check('Admin')}`)

  await src.end()
  await dst.end()
  await epg.stop()
  console.log(`\n✅ Перенесено строк всего: ${total}. Встроенная база остановлена.`)
}

main().catch(async (e) => {
  console.error('\n❌ ОШИБКА миграции:', e.message)
  console.error(e.stack)
  process.exit(1)
})
