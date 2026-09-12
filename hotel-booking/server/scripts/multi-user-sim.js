#!/usr/bin/env node
/**
 * Симуляция нескольких рабочих мест на живом сервере Roomline PMS.
 *
 * Зачем: перед продажами проверить, что несколько сотрудников, работающих
 * одновременно, не ломают друг другу данные — нет двойных броней на один номер,
 * деньги сходятся, замок версии срабатывает, события realtime доходят до всех
 * рабочих мест, сервер не отвечает 500.
 *
 * Запускать ТОЛЬКО на стенде (упакованная сборка в изоляции, клон, демо-база):
 * скрипт создаёт и меняет брони и платежи.
 *
 *   node scripts/multi-user-sim.js --base=http://127.0.0.1:4790 \
 *     --users=aigerim:Demo2026!,erlan:Demo2026!,madina:Demo2026! \
 *     --workstations=4 --seconds=120 [--origin=file://] [--json=out.json]
 *
 * Каждое рабочее место: вход, сокет (как окно Electron — Origin: file://),
 * цикл случайных действий стойки: новая бронь, правка (в том числе заведомо
 * устаревшей версией → ожидаем 409 BOOKING_STALE), заезд/выезд, платёж,
 * возврат, отмена, чтение сетки/кассы/отчётов. В конце — инварианты.
 */

const path = require('path')

function loadSocketClient() {
  try { return require('socket.io-client') } catch { /* нет в server/ */ }
  return require(path.join(__dirname, '..', '..', 'client', 'node_modules', 'socket.io-client'))
}
const { io } = loadSocketClient()

// ─── Параметры ───────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/)
  return m ? [m[1], m[2] ?? '1'] : [a, '1']
}))
const BASE = (args.base || 'http://127.0.0.1:4790').replace(/\/$/, '')
const USERS = (args.users || 'aigerim:Demo2026!').split(',').map((s) => { const [username, password] = s.split(':'); return { username, password } })
const N = Math.max(1, Number(args.workstations || USERS.length))
const SECONDS = Math.max(10, Number(args.seconds || 90))
const ORIGIN = args.origin || 'file://'
const SEED = Number(args.seed || 1)

// Детерминированный генератор — прогон можно повторить с тем же --seed
let rngState = SEED >>> 0 || 1
const rnd = () => { rngState = (rngState * 1664525 + 1013904223) >>> 0; return rngState / 4294967296 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (isoDate, n) => { const d = new Date(isoDate + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d) }

const FIRST = ['Асель', 'Тимур', 'Дина', 'Ерлан', 'Ольга', 'Санжар', 'Мадина', 'Алексей', 'Жанна', 'Арман', 'Наталья', 'Данияр']
const LAST = ['Бекенова', 'Каримов', 'Оспанова', 'Сериков', 'Ким', 'Ахметов', 'Досжанова', 'Петров', 'Нурланова', 'Смирнов']
const guestName = () => `${pick(FIRST)} ${pick(LAST)}`
const phone = () => `+7 7${Math.floor(rnd() * 90 + 10)} ${String(Math.floor(rnd() * 1000)).padStart(3, '0')} ${String(Math.floor(rnd() * 100)).padStart(2, '0')} ${String(Math.floor(rnd() * 100)).padStart(2, '0')}`

// ─── HTTP ────────────────────────────────────────────────────────────────────
const stats = {
  requests: 0, byStatus: {}, errors5xx: [], slow: [], durations: [],
  created: 0, updated: 0, stale409: 0, overlap409: 0, checkins: 0, checkouts: 0, payments: 0, refunds: 0, cancels: 0,
  reads: 0, reports: 0, other4xx: {},
}
async function api(ws, method, p, body) {
  const t0 = Date.now()
  let r, text
  try {
    r = await fetch(BASE + '/api' + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(ws.token ? { Authorization: 'Bearer ' + ws.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    text = await r.text()
  } catch (e) {
    stats.requests++
    stats.byStatus.network = (stats.byStatus.network || 0) + 1
    stats.errors5xx.push({ ws: ws.name, method, path: p, status: 'network', error: e.message })
    return { status: 0, json: null }
  }
  const ms = Date.now() - t0
  stats.requests++
  stats.durations.push(ms)
  stats.byStatus[r.status] = (stats.byStatus[r.status] || 0) + 1
  if (ms > 2000) stats.slow.push({ ws: ws.name, method, path: p, ms })
  let json = null
  try { json = JSON.parse(text) } catch { json = text }
  if (r.status === 429) { stats.rateLimited = (stats.rateLimited || 0) + 1; await sleep(5000) } // лимит 500 запросов/мин с одного IP (app.js): все места симуляции идут с одного адреса
  if (r.status >= 500) stats.errors5xx.push({ ws: ws.name, method, path: p, status: r.status, body: String(text).slice(0, 300) })
  return { status: r.status, json }
}
const unwrap = (j) => (j && typeof j === 'object' && 'data' in j ? j.data : j)

// ─── Рабочее место ───────────────────────────────────────────────────────────
async function openWorkstation(i) {
  const u = USERS[i % USERS.length]
  const ws = { name: `WS${i + 1}/${u.username}`, user: u, token: null, events: {}, seenCreated: new Set(), socketErrors: [], known: [] }
  const login = await api(ws, 'POST', '/auth/login', { username: u.username, password: u.password })
  if (login.status !== 200) throw new Error(`${ws.name}: вход не удался (${login.status}) ${JSON.stringify(login.json).slice(0, 200)}`)
  ws.token = login.json.token
  ws.socket = io(BASE, { auth: { token: ws.token }, transports: ['websocket'], extraHeaders: { Origin: ORIGIN } })
  await new Promise((res, rej) => {
    ws.socket.on('connect', res)
    ws.socket.on('connect_error', (e) => rej(new Error(`${ws.name}: сокет не подключился — ${e.message}`)))
    setTimeout(() => rej(new Error(`${ws.name}: сокет — таймаут`)), 10000)
  })
  for (const ev of ['booking:created', 'booking:updated', 'booking:cancelled', 'booking:checkin', 'booking:checkout', 'shift:changed', 'reports:changed', 'auth:revoked']) {
    ws.socket.on(ev, (p) => {
      ws.events[ev] = (ws.events[ev] || 0) + 1
      if (ev === 'booking:created' && p?.booking?.id) ws.seenCreated.add(p.booking.id)
      if (ev === 'auth:revoked') ws.socketErrors.push('auth:revoked ' + JSON.stringify(p))
    })
  }
  ws.socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') ws.socketErrors.push('disconnect ' + reason) })
  return ws
}

// ─── Общее состояние стенда ──────────────────────────────────────────────────
const shared = { rooms: [], today: null, allCreated: new Map() /* id → { by, roomId, checkIn, checkOut } */ }

async function loadContext(ws) {
  const rooms = unwrap((await api(ws, 'GET', '/rooms?isActive=true')).json)
  shared.rooms = (Array.isArray(rooms) ? rooms : []).filter((r) => r.isActive !== false)
  const shift = unwrap((await api(ws, 'GET', '/shifts/current')).json)
  shared.today = shift?.date ? String(shift.date).slice(0, 10) : iso(new Date())
  if (!shared.rooms.length) throw new Error('на стенде нет активных номеров — сначала засев')
}

// ─── Действия ────────────────────────────────────────────────────────────────
async function actCreate(ws) {
  const room = pick(shared.rooms)
  // каждая пятая бронь — «с улицы», на сегодня: без них заезд/выезд в симуляции не случаются
  const start = rnd() < 0.2 ? shared.today : addDays(shared.today, Math.floor(rnd() * 40))
  const nights = 1 + Math.floor(rnd() * 5)
  const r = await api(ws, 'POST', '/bookings', {
    roomId: room.id, guestName: guestName(), guestPhone: phone(),
    checkIn: start, checkOut: addDays(start, nights), source: pick(['стойка', 'телефон', 'онлайн']),
    notes: rnd() < 0.3 ? 'Симуляция: несколько рабочих мест' : undefined,
  })
  if (r.status === 201 || r.status === 200) {
    const b = unwrap(r.json)
    if (b?.id) { stats.created++; shared.allCreated.set(b.id, { by: ws.name, roomId: room.id, checkIn: start, checkOut: addDays(start, nights) }); ws.known.push(b.id) }
  } else if (r.status === 409 || r.status === 400) {
    stats.overlap409++ // занято/пересечение/квота — штатный отказ
  } else if (r.status < 500) {
    stats.other4xx[r.status] = (stats.other4xx[r.status] || 0) + 1
  }
}

async function actUpdate(ws, { stale = false } = {}) {
  const ids = [...shared.allCreated.keys()]
  if (!ids.length) return actCreate(ws)
  const id = pick(ids)
  const cur = unwrap((await api(ws, 'GET', `/bookings/${id}`)).json)
  if (!cur?.id || !['CONFIRMED', 'CHECKED_IN'].includes(cur.status)) return
  const expected = stale ? new Date(new Date(cur.updatedAt).getTime() - 60000).toISOString() : cur.updatedAt
  const r = await api(ws, 'PUT', `/bookings/${id}`, { notes: `правка ${ws.name} ${new Date().toISOString().slice(11, 19)}`, expectedUpdatedAt: expected })
  if (r.status === 200) stats.updated++
  else if (r.status === 409 && r.json?.code === 'BOOKING_STALE') stats.stale409++
  else if (r.status === 409) stats.overlap409++
  else if (r.status < 500) stats.other4xx[r.status] = (stats.other4xx[r.status] || 0) + 1
  if (stale && r.status !== 409) stats.staleMissed = (stats.staleMissed || 0) + 1
}

async function actCheckIn(ws) {
  const cands = [...shared.allCreated.entries()].filter(([, b]) => b.checkIn <= shared.today)
  if (!cands.length) return
  const [id] = pick(cands)
  const r = await api(ws, 'PATCH', `/bookings/${id}/checkin`)
  stats.checkinStatuses = stats.checkinStatuses || {}; stats.checkinStatuses[r.status] = (stats.checkinStatuses[r.status] || 0) + 1
  if (r.status === 200) stats.checkins++
}

async function actCheckOut(ws) {
  const ids = [...shared.allCreated.keys()]
  if (!ids.length) return
  const id = pick(ids)
  const cur = unwrap((await api(ws, 'GET', `/bookings/${id}`)).json)
  if (cur?.status !== 'CHECKED_IN') return
  const r = await api(ws, 'PATCH', `/bookings/${id}/checkout`)
  if (r.status === 200) stats.checkouts++
}

async function actPayment(ws) {
  const ids = [...shared.allCreated.keys()]
  if (!ids.length) return
  const id = pick(ids)
  const cur = unwrap((await api(ws, 'GET', `/bookings/${id}`)).json)
  if (!cur?.id || ['CANCELLED', 'NO_SHOW'].includes(cur.status)) return
  const amount = Math.max(500, Math.round((rnd() * 20000) / 100) * 100)
  const r = await api(ws, 'POST', '/payments', { bookingId: id, amount, method: pick(['cash', 'card', 'transfer']), comment: 'симуляция' })
  if (r.status === 201 || r.status === 200) stats.payments++
  else if (r.status < 500) stats.other4xx[r.status] = (stats.other4xx[r.status] || 0) + 1
}

async function actRefund(ws) {
  const ids = [...shared.allCreated.keys()]
  if (!ids.length) return
  const id = pick(ids)
  const list = unwrap((await api(ws, 'GET', `/payments/booking/${id}`)).json)
  const p = (list?.payments || []).find((x) => x.kind === 'payment' && !x.voidedAt)
  if (!p) return
  const r = await api(ws, 'POST', `/payments/${p.id}/refund`, { amount: Math.min(p.amount, 500), method: p.method, comment: 'возврат (симуляция)' })
  if (r.status === 201 || r.status === 200) stats.refunds++
  else if (r.status < 500) stats.other4xx[r.status] = (stats.other4xx[r.status] || 0) + 1
}

async function actCancel(ws) {
  const own = ws.known.filter((id) => shared.allCreated.has(id))
  if (!own.length) return
  const id = pick(own)
  const r = await api(ws, 'DELETE', `/bookings/${id}`, { reason: 'гость отказался (симуляция)' })
  if (r.status === 200) { stats.cancels++; shared.allCreated.delete(id) }
}

async function actRead(ws) {
  const from = addDays(shared.today, -3)
  const what = pick(['grid', 'today', 'debts', 'shift', 'booking'])
  if (what === 'grid') await api(ws, 'GET', `/occupancy/grid?dateFrom=${from}&dateTo=${addDays(from, 30)}`)
  else if (what === 'today') await api(ws, 'GET', '/occupancy/today')
  else if (what === 'debts') await api(ws, 'GET', '/payments/debts')
  else if (what === 'shift') await api(ws, 'GET', '/payments/shift/current/summary')
  else { const ids = [...shared.allCreated.keys()]; if (ids.length) await api(ws, 'GET', `/bookings/${pick(ids)}`) }
  stats.reads++
}

let reportIds = null
async function actReport(ws) {
  if (!reportIds) {
    const list = unwrap((await api(ws, 'GET', '/reports')).json)
    reportIds = (Array.isArray(list) ? list : list?.reports || []).map((r) => r.id).slice(0, 4)
  }
  if (!reportIds.length) return
  const r = await api(ws, 'POST', `/reports/${pick(reportIds)}/run`, { params: {} })
  if (r.status === 200) stats.reports++
}

const ACTIONS = [
  [actCreate, 22], [actUpdate, 14], [(ws) => actUpdate(ws, { stale: true }), 4], [actCheckIn, 8], [actCheckOut, 6],
  [actPayment, 14], [actRefund, 3], [actCancel, 4], [actRead, 20], [actReport, 5],
]
const TOTAL_W = ACTIONS.reduce((s, [, w]) => s + w, 0)
function pickAction() {
  let x = rnd() * TOTAL_W
  for (const [fn, w] of ACTIONS) { if ((x -= w) <= 0) return fn }
  return actRead
}

async function runWorkstation(ws, deadline) {
  while (Date.now() < deadline) {
    try { await pickAction()(ws) } catch (e) { stats.errors5xx.push({ ws: ws.name, error: 'exception: ' + e.message }) }
    await sleep(300 + rnd() * 700) // человек не стреляет запросами быстрее; 4 места с одного IP укладываются в лимит 500/мин
  }
}

// ─── Целевые гонки ───────────────────────────────────────────────────────────
async function withoutRateLimit(fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fn()
    const statuses = Array.isArray(r.statuses) ? r.statuses : []
    if (!statuses.includes(429)) return r
    await sleep(15000)
  }
  return { pass: false, reason: 'лимит запросов (429) не отпустил' }
}

async function raceSameRoom(wsA, wsB) {
  // до 5 попыток: даты могут оказаться заняты у обоих (409/409) — это не результат гонки
  let last = null
  for (let attempt = 0; attempt < 5; attempt++) {
    last = await raceSameRoomOnce(wsA, wsB)
    if (last.pass || last.statuses.includes(429) || last.statuses.some((s) => s >= 500)) return last
    if (!(last.statuses[0] === 409 && last.statuses[1] === 409)) return last
  }
  return { ...last, pass: false, reason: 'все попытки — оба 409 (даты заняты), гонку проверить не удалось' }
}

async function raceSameRoomOnce(wsA, wsB) {
  const room = pick(shared.rooms)
  const start = addDays(shared.today, 60 + Math.floor(rnd() * 120))
  const body = (name) => ({ roomId: room.id, guestName: name, checkIn: start, checkOut: addDays(start, 2), source: 'стойка' })
  const [a, b] = await Promise.all([api(wsA, 'POST', '/bookings', body('Гонка А')), api(wsB, 'POST', '/bookings', body('Гонка Б'))])
  const ok = [a, b].filter((r) => r.status === 201 || r.status === 200)
  const rejected = [a, b].filter((r) => r.status === 409 || r.status === 400)
  for (const r of ok) { const bk = unwrap(r.json); if (bk?.id) shared.allCreated.set(bk.id, { by: 'race', roomId: room.id, checkIn: start, checkOut: addDays(start, 2) }) }
  return { room: room.number, statuses: [a.status, b.status], pass: ok.length === 1 && rejected.length === 1 }
}

async function raceStaleEdit(wsA, wsB) {
  let bk = null, room = null, start = null, c = null
  for (let attempt = 0; attempt < 8 && !bk; attempt++) {
    room = pick(shared.rooms); start = addDays(shared.today, 100 + Math.floor(rnd() * 60))
    c = await api(wsA, 'POST', '/bookings', { roomId: room.id, guestName: 'Замок версии', checkIn: start, checkOut: addDays(start, 1), source: 'стойка' })
    if (c.status === 429) return { statuses: [429], pass: false }
    bk = unwrap(c.json); if (!bk?.id) bk = null
  }
  if (!bk) return { pass: false, reason: 'бронь для гонки не создана: ' + c.status }
  shared.allCreated.set(bk.id, { by: 'race', roomId: room.id, checkIn: start, checkOut: addDays(start, 1) })
  const v1 = bk.updatedAt
  const first = await api(wsA, 'PUT', `/bookings/${bk.id}`, { notes: 'правка А', expectedUpdatedAt: v1 })
  const second = await api(wsB, 'PUT', `/bookings/${bk.id}`, { notes: 'правка Б по старой версии', expectedUpdatedAt: v1 })
  return { statuses: [first.status, second.status], code: second.json?.code, pass: first.status === 200 && second.status === 409 && second.json?.code === 'BOOKING_STALE' }
}

// ─── Инварианты ──────────────────────────────────────────────────────────────
async function checkInvariants(ws) {
  const problems = []
  // 1. Пересечения по сетке: активные брони одного номера не должны пересекаться
  const from = addDays(shared.today, -10)
  const grid = unwrap((await api(ws, 'GET', `/occupancy/grid?dateFrom=${from}&dateTo=${addDays(from, 120)}`)).json)
  let roomsChecked = 0, bookingsChecked = 0
  for (const cat of grid?.categories || []) {
    for (const room of cat.rooms) {
      roomsChecked++
      const bs = room.bookings.filter((b) => !['CANCELLED', 'NO_SHOW'].includes(b.status)).sort((a, b) => a.checkIn < b.checkIn ? -1 : 1)
      bookingsChecked += bs.length
      for (let i = 1; i < bs.length; i++) {
        if (bs[i].checkIn < bs[i - 1].checkOut) problems.push(`пересечение в номере ${room.number}: #${bs[i - 1].id} (${bs[i - 1].checkIn}–${bs[i - 1].checkOut}) и #${bs[i].id} (${bs[i].checkIn}–${bs[i].checkOut})`)
      }
    }
  }
  // 2. Деньги: кэш paidAmount = платежи − возвраты (без аннулированных)
  const sample = [...shared.allCreated.keys()].slice(-60)
  let moneyChecked = 0
  for (const id of sample) {
    const b = unwrap((await api(ws, 'GET', `/bookings/${id}`)).json)
    const list = unwrap((await api(ws, 'GET', `/payments/booking/${id}`)).json)
    if (!b?.id || !list) continue
    const sum = (list.payments || []).filter((p) => !p.voidedAt).reduce((s, p) => s + (p.kind === 'refund' ? -p.amount : p.amount), 0)
    moneyChecked++
    if (Math.abs(sum - Number(b.paidAmount ?? 0)) > 0.01) problems.push(`деньги #${id}: paidAmount=${b.paidAmount}, по журналу платежей=${sum}`)
  }
  return { problems, roomsChecked, bookingsChecked, moneyChecked }
}

// ─── Главная ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Стенд ${BASE}; рабочих мест: ${N}; длительность: ${SECONDS} с; seed ${SEED}`)
  const health = await fetch(BASE + '/api/health').then((r) => r.status).catch(() => 0)
  if (health !== 200) throw new Error(`/api/health → ${health}`)
  const wss = []
  for (let i = 0; i < N; i++) wss.push(await openWorkstation(i))
  await loadContext(wss[0])
  console.log(`номеров: ${shared.rooms.length}, рабочая дата: ${shared.today}`)

  const t0 = Date.now()
  const deadline = t0 + SECONDS * 1000
  await Promise.all(wss.map((ws) => runWorkstation(ws, deadline)))
  const elapsed = (Date.now() - t0) / 1000

  const races = { sameRoom: [], stale: [] }
  await sleep(3000)
  for (let i = 0; i < 5; i++) races.sameRoom.push(await withoutRateLimit(() => raceSameRoom(wss[0], wss[1 % N])))
  for (let i = 0; i < 3; i++) races.stale.push(await withoutRateLimit(() => raceStaleEdit(wss[0], wss[1 % N])))

  await sleep(1500) // дать событиям долететь
  const inv = await checkInvariants(wss[0])

  // Realtime: каждое место должно увидеть чужие брони
  const realtime = wss.map((ws) => {
    const others = [...shared.allCreated.entries()].filter(([, b]) => b.by !== ws.name && b.by !== 'race').map(([id]) => id)
    const seen = others.filter((id) => ws.seenCreated.has(id)).length
    return { ws: ws.name, othersCreated: others.length, seen, events: ws.events, socketErrors: ws.socketErrors }
  })

  const durations = stats.durations.slice().sort((a, b) => a - b)
  const pct = (p) => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * p))] : 0
  const summary = {
    base: BASE, workstations: N, seconds: Math.round(elapsed), requests: stats.requests, rps: +(stats.requests / elapsed).toFixed(1),
    latencyMs: { p50: pct(0.5), p95: pct(0.95), max: durations[durations.length - 1] || 0 },
    rateLimited429: stats.rateLimited || 0,
    byStatus: stats.byStatus, actions: {
      created: stats.created, updated: stats.updated, stale409: stats.stale409, staleMissed: stats.staleMissed || 0, overlapOrRule409: stats.overlap409,
      checkins: stats.checkins, checkinStatuses: stats.checkinStatuses || {}, checkouts: stats.checkouts, payments: stats.payments, refunds: stats.refunds, cancels: stats.cancels, reads: stats.reads, reports: stats.reports, other4xx: stats.other4xx,
    },
    errors5xx: stats.errors5xx, slow: stats.slow.slice(0, 20), races, invariants: inv, realtime,
  }
  const realtimeOk = realtime.every((r) => r.othersCreated === 0 || r.seen / r.othersCreated >= 0.95)
  summary.verdict = {
    no5xx: stats.errors5xx.length === 0,
    noOverlaps: !inv.problems.some((p) => p.startsWith('пересечение')),
    moneyConsistent: !inv.problems.some((p) => p.startsWith('деньги')),
    raceSameRoom: races.sameRoom.every((r) => r.pass),
    staleLock: races.stale.every((r) => r.pass) && (stats.staleMissed || 0) === 0,
    realtime: realtimeOk,
    socketsStable: realtime.every((r) => r.socketErrors.length === 0),
  }
  summary.pass = Object.values(summary.verdict).every(Boolean)

  console.log(JSON.stringify(summary, null, 2))
  if (args.json) require('fs').writeFileSync(args.json, JSON.stringify(summary, null, 2))
  for (const ws of wss) ws.socket.disconnect()
  console.log(summary.pass ? '\nИТОГ: все инварианты выполнены' : '\nИТОГ: есть нарушения — см. verdict/invariants/errors5xx')
  process.exit(summary.pass ? 0 : 2)
}

main().catch((e) => { console.error('Симуляция прервана:', e.message); process.exit(1) })
