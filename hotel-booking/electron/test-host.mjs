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
function log(...a) { console.log('•', ...a) }

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
    // КРИТИЧНО: UTF8, иначе кириллица в именах гостей ломается (по умолчанию
    // initdb на Windows берёт WIN1251). locale=C — сортировка по байтам (нам ок).
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
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
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })
  const body = await res.json()
  log(`login: HTTP ${res.status}, token=${body.token ? body.token.slice(0, 12) + '…' : 'НЕТ'}`)

  if (health.status === 'ok' && res.status === 200 && body.token) {
    console.log('\n✅ ВСЁ РАБОТАЕТ: встроенный Postgres + сервер + Prisma + логин.')
  } else {
    console.log('\n❌ Что-то не так — см. вывод выше.')
  }
}

main()
  .catch(e => { console.error('\n❌ ОШИБКА:', e); })
  .finally(async () => {
    try { srv?.kill() } catch {}
    try { await pg?.stop() } catch {}
    setTimeout(() => process.exit(0), 1000)
  })
