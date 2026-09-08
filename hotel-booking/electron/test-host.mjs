// Dev-проверка связки: встроенный Postgres + схема + реальный сервер (Prisma).
// Запуск:  cd electron && node test-host.mjs
import EmbeddedPostgres from 'embedded-postgres'
import { readFileSync } from 'fs'
import { spawn } from 'child_process'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(os.tmpdir(), 'hb-test-pg-' + Date.now())
const PORT = 3099
const PW = 'localdevpass'
const DB_URL = `postgresql://postgres:${PW}@127.0.0.1:5433/hotel_booking`

let pg, srv
let failures = 0
function log(...a) { console.log('•', ...a) }
// Проверка с отметкой: любая ✗ доводит выход до кода 1, чтобы прогон нельзя
// было принять за удачный, пробежав вывод глазами.
function check(ok, okText, failText) {
  if (ok) { console.log('  ✓', okText); return true }
  failures++
  console.log('  ✗', failText || okText)
  return false
}

// Prisma CLI напрямую по build/index.js — как в main.js (node_modules/.bin в сборку не попадает)
function runPrisma(args) {
  const serverDir = path.resolve(__dirname, '..', 'server')
  const cli = path.join(serverDir, 'node_modules', 'prisma', 'build', 'index.js')
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, ...args, '--schema=prisma/schema.prisma'], {
      cwd: serverDir,
      env: { ...process.env, DATABASE_URL: DB_URL, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    })
    p.stdout.on('data', (d) => process.stdout.write('  [prisma] ' + d))
    p.stderr.on('data', (d) => process.stderr.write('  [prisma-err] ' + d))
    p.on('error', reject)
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`prisma ${args.join(' ')} → код ${c}`))))
  })
}

async function main() {
  pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: PW,
    port: 5433, persistent: false, onLog: () => {}, onError: () => {},
    // КРИТИЧНО: те же флаги, что в main.js. UTF8 — иначе кириллица в именах
    // гостей ломается (initdb на Windows по умолчанию берёт WIN1251).
    // Встроенная локаль C.UTF-8 вместо прежней libc C — иначе ILIKE не
    // сворачивает регистр кириллицы и «асель» не находит «Асель» (D8-001).
    initdbFlags: [
      '--encoding=UTF8',
      '--locale-provider=builtin',
      '--builtin-locale=C.UTF-8',
      '--locale=C',
    ],
  })

  log('initdb...');          await pg.initialise()
  log('start postgres...');  await pg.start()
  log('create database...'); await pg.createDatabase('hotel_booking')

  // Схема — только миграциями Prisma (init.sql больше нет). Ровно тот же вызов,
  // что делает main.js при старте хоста.
  log('prisma migrate deploy...')
  await runPrisma(['migrate', 'deploy'])

  const client = pg.getPgClient('hotel_booking')
  await client.connect()
  log('apply seed.sql...')
  await client.query(readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8'))

  const admins = (await client.query('SELECT count(*)::int AS n FROM "Admin"')).rows[0].n
  const cats   = (await client.query('SELECT count(*)::int AS n FROM "Category"')).rows[0].n
  // проверим, что constraint реально создан
  const con = (await client.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'booking_no_overlap'`)).rowCount
  // таблицы платежей и начислений — по ним сходятся деньги
  const pay = (await client.query(`SELECT to_regclass('public."Payment"') IS NOT NULL AS ok`)).rows[0].ok
  const migs = (await client.query('SELECT migration_name FROM _prisma_migrations ORDER BY started_at')).rows
  log(`данные: admins=${admins}, categories=${cats}, constraint booking_no_overlap=${con ? 'ЕСТЬ' : 'НЕТ!'}`)
  log(`схема: Payment=${pay ? 'ЕСТЬ' : 'НЕТ!'}, миграций применено ${migs.length}: ${migs.map(m => m.migration_name).join(', ')}`)

  // ─── Локаль и коллация (D8-001) ────────────────────────────────────────────
  // Ради этого блока волна и делалась: под прежней libc-локалью C поиск гостя
  // по кириллице в упакованной программе был чувствителен к регистру.
  const loc = (await client.query(
    `SELECT datlocprovider, datcollate FROM pg_database WHERE datname = 'hotel_booking'`)).rows[0] || {}
  check(loc.datlocprovider === 'b',
    `провайдер локали базы = builtin (datlocprovider='b', datcollate='${loc.datcollate}')`,
    `провайдер локали базы '${loc.datlocprovider}', ожидался 'b' (builtin) — initdb-флаги не применились`)

  const ilike = (await client.query(`SELECT ('Асель' COLLATE pg_c_utf8) ILIKE 'асель' AS ok`)).rows[0].ok
  check(ilike === true,
    'ILIKE по кириллице не зависит от регистра под pg_c_utf8',
    'ILIKE по кириллице ЧУВСТВИТЕЛЕН к регистру — «асель» не найдёт «Асель»')

  // Коллация самой колонки: её выставляет миграция коллации (отдельный агент).
  // Пока миграции нет — это не провал теста, а сообщение.
  const col = (await client.query(
    `SELECT attcollation::regcollation AS coll FROM pg_attribute
      WHERE attrelid = '"Booking"'::regclass AND attname = 'guestName'`)).rows[0]
  const collName = col ? String(col.coll) : '(колонки нет)'
  if (collName === 'pg_c_utf8') {
    check(true, 'Booking.guestName с коллацией pg_c_utf8')
  } else {
    log(`ℹ  Booking.guestName: коллация ${collName} — миграции коллации ещё нет в папке миграций`)
  }

  await client.end()

  log('запускаю сервер с встроенной базой...')
  const serverDir = path.resolve(__dirname, '..', 'server')
  // process.execPath, а не 'node': так же, как Prisma выше и как main.js в сборке.
  // 2026-09-05 тест молча падал на этом месте — spawn('node') не запускался,
  // а обработчика 'error' не было, поэтому вывода не было вовсе.
  srv = spawn(process.execPath, ['server.js'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), HOST: '127.0.0.1',
           JWT_SECRET: 'dev-test-secret-not-for-prod', NODE_ENV: 'production' },
  })
  srv.on('error', (e) => log('SPAWN ERROR:', e.message))
  srv.on('exit', (c, s) => { if (c !== null && c !== 0) log(`сервер завершился с кодом ${c}${s ? ' / ' + s : ''}`) })
  srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d))
  srv.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d))

  // Готовность ждём опросом, а не фиксированной паузой: на медленной машине
  // первый старт Prisma дольше 4 с, и тест падал бы на ровном месте.
  let health = null
  for (const t0 = Date.now(); Date.now() - t0 < 40000; ) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) { health = await r.json(); break } } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  if (!health) throw new Error('сервер не ответил на /api/health за 40 с — см. [srv]/[srv-err] выше')
  log('health:', JSON.stringify(health))

  const res = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })
  const body = await res.json()
  log(`login: HTTP ${res.status}, token=${body.token ? body.token.slice(0, 12) + '…' : 'НЕТ'}`)

  check(health.status === 'ok' && health.db === 'ok',
    `health отвечает ok и видит базу (db=${health.db})`,
    `health вернул ${JSON.stringify(health)}`)
  check(res.status === 200 && !!body.token, 'вход admin/admin выдал токен',
    `вход вернул HTTP ${res.status} без токена`)

  if (failures === 0) {
    console.log('\n✅ ВСЁ РАБОТАЕТ: встроенный Postgres + сервер + Prisma + логин + локаль C.UTF-8.')
  } else {
    console.log(`\n❌ Проверок не прошло: ${failures} — см. ✗ выше.`)
  }
}

main()
  .catch(e => { failures++; console.error('\n❌ ОШИБКА:', e); })
  .finally(async () => {
    try { srv?.kill() } catch {}
    try { await pg?.stop() } catch {}
    setTimeout(() => process.exit(failures ? 1 : 0), 1000)
  })
