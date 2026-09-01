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

  const client = pg.getPgClient('hotel_booking')
  await client.connect()
  log('apply init.sql...')
  await client.query(readFileSync(path.join(__dirname, 'db', 'init.sql'), 'utf8'))
  log('apply seed.sql...')
  await client.query(readFileSync(path.join(__dirname, 'db', 'seed.sql'), 'utf8'))

  const admins = (await client.query('SELECT count(*)::int AS n FROM "Admin"')).rows[0].n
  const cats   = (await client.query('SELECT count(*)::int AS n FROM "Category"')).rows[0].n
  // проверим, что constraint реально создан
  const con = (await client.query(
    `SELECT conname FROM pg_constraint WHERE conname = 'booking_no_overlap'`)).rowCount
  log(`данные: admins=${admins}, categories=${cats}, constraint booking_no_overlap=${con ? 'ЕСТЬ' : 'НЕТ!'}`)
  await client.end()

  log('запускаю сервер с встроенной базой...')
  const serverDir = path.resolve(__dirname, '..', 'server')
  srv = spawn('node', ['server.js'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), HOST: '127.0.0.1',
           JWT_SECRET: 'dev-test-secret-not-for-prod', NODE_ENV: 'production' },
  })
  srv.stdout.on('data', d => process.stdout.write('  [srv] ' + d))
  srv.stderr.on('data', d => process.stderr.write('  [srv-err] ' + d))

  await new Promise(r => setTimeout(r, 4000))

  const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(r => r.json())
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
