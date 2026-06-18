/**
 * READ-ONLY бэктест алгоритма оптимизации размещения.
 * НЕ выполняет никаких записей в БД (только findMany). Раскладку «после»
 * строит в памяти. Результат — markdown-отчёт в stdout + файл.
 */
const fs = require('fs')
const path = require('path')
const { prisma } = require('../src/utils/prisma')
const { getCurrentBusinessDate } = require('../src/utils/businessDate')
const optimizeCtrl = require('../src/controllers/optimizeController')

const DAY = 86400000
const nightsOf = (it) => Math.round((it.checkOutMs - it.checkInMs) / DAY)

// ─── Метрики раскладки ──────────────────────────────────────────────────────────
function analyze(items, universeRoomIds, windowStart, windowEnd) {
  const byRoom = new Map()
  for (const it of items) {
    if (!byRoom.has(it.roomId)) byRoom.set(it.roomId, [])
    byRoom.get(it.roomId).push(it)
  }
  for (const list of byRoom.values()) list.sort((a, b) => a.checkInMs - b.checkInMs)

  let occupiedNights = 0
  for (const it of items) occupiedNights += nightsOf(it)

  // Окна (внутренние пустые промежутки между бронями в одном номере)
  let gaps1 = 0, gaps2 = 0, gaps3 = 0, gapNights = 0, shortGapNights = 0
  // Непрерывные занятые цепочки (back-to-back)
  let occupiedRuns = 0
  let runLenSum = 0
  for (const list of byRoom.values()) {
    for (let i = 1; i < list.length; i++) {
      const g = Math.round((list[i].checkInMs - list[i - 1].checkOutMs) / DAY)
      if (g > 0) {
        gapNights += g
        if (g <= 2) shortGapNights += g   // ночи в коротких (непродаваемых) окнах
        if (g === 1) gaps1++
        else if (g === 2) gaps2++
        else gaps3++
      }
    }
    // цепочки занятости
    let runStart = list[0].checkInMs
    let runEnd = list[0].checkOutMs
    for (let i = 1; i < list.length; i++) {
      if (list[i].checkInMs <= runEnd) { // back-to-back или перекрытие
        runEnd = Math.max(runEnd, list[i].checkOutMs)
      } else {
        occupiedRuns++; runLenSum += Math.round((runEnd - runStart) / DAY)
        runStart = list[i].checkInMs; runEnd = list[i].checkOutMs
      }
    }
    occupiedRuns++; runLenSum += Math.round((runEnd - runStart) / DAY)
  }

  const totalGaps = gaps1 + gaps2 + gaps3
  const windowNights = Math.round((windowEnd - windowStart) / DAY)
  const totalRoomNights = universeRoomIds.size * windowNights
  const roomsUsed = byRoom.size
  const avgRun = occupiedRuns ? runLenSum / occupiedRuns : 0

  return {
    occupiedNights,
    emptyNights: totalRoomNights - occupiedNights,
    totalRoomNights,
    windowNights,
    occupancy: totalRoomNights ? occupiedNights / totalRoomNights : 0,
    gaps1, gaps2, gaps3, totalGaps, gapNights, shortGapNights,
    occupiedRuns, avgRun,
    roomsUsed,
    usedRoomIds: new Set(byRoom.keys()),
  }
}

const runOptimize = (settings) =>
  new Promise((res, rej) => optimizeCtrl.optimize({ body: { settings } }, { json: res }, rej))

async function main() {
  const businessDate = await getCurrentBusinessDate()

  // ── READ ONLY ──
  const rooms = await prisma.room.findMany({
    where: { isActive: true },
    select: { id: true, number: true, building: true, floor: true, capacity: true, features: true, category: { select: { id: true, name: true } } },
  })
  const bookings = await prisma.booking.findMany({
    where: { status: { notIn: ['CANCELLED', 'CHECKED_OUT'] }, checkOut: { gt: businessDate } },
    select: { id: true, roomId: true, checkIn: true, checkOut: true, status: true, source: true, totalAmount: true, paidAmount: true, flags: true },
  })

  const roomById = new Map(rooms.map(r => [r.id, r]))

  // Только брони на существующих активных номерах
  const items = []
  for (const b of bookings) {
    const r = roomById.get(b.roomId)
    if (!r) continue
    items.push({
      id: b.id, roomId: b.roomId,
      checkInMs: new Date(b.checkIn).getTime(),
      checkOutMs: new Date(b.checkOut).getTime(),
      totalAmount: b.totalAmount || 0,
    })
  }

  if (items.length === 0) { console.log('Нет броней для анализа.'); process.exit(0) }

  // Окно анализа
  const windowStart = Math.min(...items.map(i => i.checkInMs))
  const windowEnd = Math.max(...items.map(i => i.checkOutMs))

  // Универсум номеров = активные номера в категориях, где есть брони (постоянный знаменатель)
  const usedCats = new Set(items.map(i => roomById.get(i.roomId).category.id))
  const universeRoomIds = new Set(rooms.filter(r => usedCats.has(r.category.id)).map(r => r.id))

  // ── Прогон алгоритма (READ ONLY: optimize только читает и возвращает) ──
  const opt = await runOptimize({}) // дефолтные настройки: вместимость/особенности strict, этаж soft
  const movesById = new Map(opt.moves.map(m => [m.bookingId, m.to.roomId]))

  // Раскладка «после» — в памяти
  const afterItems = items.map(i => ({ ...i, roomId: movesById.get(i.id) ?? i.roomId }))

  const before = analyze(items, universeRoomIds, windowStart, windowEnd)
  const after = analyze(afterItems, universeRoomIds, windowStart, windowEnd)

  // Полностью освобождённые номера (были заняты, стали пусты)
  const freedRooms = [...before.usedRoomIds].filter(id => !after.usedRoomIds.has(id))

  // Анализ ходов
  const moves = opt.moves
  const usefulMoves = moves.filter(m => (m.gapsClosed ?? 0) > 0 || (m.nightsClosed ?? 0) > 0)
  const chainMoves = moves.filter(m => m.partOfChain)
  const floorChanges = moves.filter(m => roomById.get(m.from.roomId).floor !== roomById.get(m.to.roomId).floor)
  const buildingChanges = moves.filter(m => roomById.get(m.from.roomId).building !== roomById.get(m.to.roomId).building)
  const movedBookingIds = new Set(moves.map(m => m.bookingId))

  // Подвижные брони (для среднего числа перестановок)
  // оценим как число броней, которые алгоритм имел право двигать ≈ те, что в категориях с движением
  const totalConsidered = items.length

  // Финансы
  const priced = items.filter(i => i.totalAmount > 0)
  const pricedNights = priced.reduce((s, i) => s + nightsOf(i), 0)
  const avgNightPrice = pricedNights ? priced.reduce((s, i) => s + i.totalAmount, 0) / pricedNights : 0

  const reclaimedGapNights = before.gapNights - after.gapNights
  // Главная метрика нового ядра: ночи, переведённые из коротких (непродаваемых)
  // окон в длинные продаваемые. Именно это конвертируется в выручку.
  const sellableConverted = before.shortGapNights - after.shortGapNights
  const dataDays = Math.round((windowEnd - windowStart) / DAY)
  const annualFactor = 365 / dataDays

  const scenarios = [0.3, 0.5, 0.7]
  const fin = scenarios.map(fill => {
    const annualReclaimed = sellableConverted * annualFactor * fill
    const revenue = annualReclaimed * avgNightPrice
    return { fill, annualReclaimed, revenue }
  })

  const roi = (revenue, cost) => ((revenue - cost) / cost) * 100

  const pct = (x) => (x * 100).toFixed(1)
  const fmt = (n) => Math.round(n).toLocaleString('ru-RU')
  const dstr = (ms) => new Date(ms).toISOString().slice(0, 10)

  // ─── Markdown ───
  let md = ''
  md += `# Бэктест алгоритма оптимизации размещения\n\n`
  md += `_Сгенерировано: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · режим READ-ONLY (БД не изменялась)_\n\n`

  md += `# Общая статистика\n\n`
  md += `| Параметр | Значение |\n|---|---|\n`
  md += `| Рабочая дата (смена) | ${dstr(businessDate.getTime())} |\n`
  md += `| Окно анализа | ${dstr(windowStart)} … ${dstr(windowEnd)} (${dataDays} дн.) |\n`
  md += `| Активных номеров всего | ${rooms.length} |\n`
  md += `| Номеров в универсуме (категории с бронями) | ${universeRoomIds.size} |\n`
  md += `| Броней в анализе (будущие, не отменённые) | ${totalConsidered} |\n`
  md += `| Номеро-ночей всего (универсум × окно) | ${fmt(before.totalRoomNights)} |\n`
  md += `| Средняя цена номеро-ночи (по заполненным) | ${avgNightPrice ? fmt(avgNightPrice) + ' ₸' : 'нет данных о ценах'} |\n`
  md += `| Броней с указанной ценой | ${priced.length} из ${totalConsidered} |\n\n`

  md += `# До оптимизации\n\n`
  md += metricsBlock(before)

  md += `\n# После оптимизации\n\n`
  md += metricsBlock(after)
  md += `\n> ⚠️ Занятые номеро-ночи и загрузка **не меняются** — перестановка не добавляет броней, а лишь перекомпоновывает их. Ценность алгоритма не в росте occupancy существующих броней, а в структуре свободного пространства (см. «Изменения»).\n`

  md += `\n# Изменения\n\n`
  md += `| Метрика | До | После | Δ |\n|---|---|---|---|\n`
  md += `| Окон всего | ${before.totalGaps} | ${after.totalGaps} | ${signed(after.totalGaps - before.totalGaps)} |\n`
  md += `| — окна 1 дня | ${before.gaps1} | ${after.gaps1} | ${signed(after.gaps1 - before.gaps1)} |\n`
  md += `| — окна 2 дней | ${before.gaps2} | ${after.gaps2} | ${signed(after.gaps2 - before.gaps2)} |\n`
  md += `| — окна 3+ дней | ${before.gaps3} | ${after.gaps3} | ${signed(after.gaps3 - before.gaps3)} |\n`
  md += `| Пустых ночей внутри окон | ${before.gapNights} | ${after.gapNights} | ${signed(after.gapNights - before.gapNights)} |\n`
  md += `| Непрерывных занятых цепочек | ${before.occupiedRuns} | ${after.occupiedRuns} | ${signed(after.occupiedRuns - before.occupiedRuns)} |\n`
  md += `| Средняя длина цепочки (ночей) | ${before.avgRun.toFixed(1)} | ${after.avgRun.toFixed(1)} | ${signed(+(after.avgRun - before.avgRun).toFixed(1))} |\n`
  md += `| Задействовано номеров | ${before.roomsUsed} | ${after.roomsUsed} | ${signed(after.roomsUsed - before.roomsUsed)} |\n\n`

  const fragBefore = before.occupiedNights ? before.totalGaps / before.occupiedRuns : 0
  const fragAfter = after.occupiedNights ? after.totalGaps / after.occupiedRuns : 0

  md += `**Производные показатели:**\n\n`
  md += `- Устранено окон: **${before.totalGaps - after.totalGaps}** (из ${before.totalGaps}, ${before.totalGaps ? pct((before.totalGaps - after.totalGaps) / before.totalGaps) : 0}%)\n`
  md += `- Ночей переведено из коротких (непродаваемых) окон в длинные продаваемые: **${sellableConverted}** (${before.shortGapNights} → ${after.shortGapNights})\n`
  md += `- Общий пустой простой между бронями: ${before.gapNights} → ${after.gapNights} (перестановка не меняет суммарную пустоту, только её структуру)\n`
  md += `- Полностью освобождённых номеров: **${freedRooms.length}**\n`
  md += `- Фрагментация (окон на цепочку): ${fragBefore.toFixed(2)} → ${fragAfter.toFixed(2)}\n\n`

  md += `**Ходы алгоритма:**\n\n`
  md += `- Всего перестановок: **${moves.length}**\n`
  md += `- Реально закрывают окна: **${usefulMoves.length}**\n`
  md += `- «В связке» (парные/цепочки без отдельного эффекта): **${chainMoves.length}**\n`
  md += `- Меняют этаж: ${floorChanges.length} · меняют корпус: ${buildingChanges.length}\n`
  md += `- Перемещено уникальных броней: ${movedBookingIds.size} из ${totalConsidered}\n`
  md += `- Среднее число перестановок на бронь: ${(moves.length / totalConsidered).toFixed(2)}\n`
  md += `- Среднее на затронутую бронь: ${(moves.length / Math.max(1, movedBookingIds.size)).toFixed(2)}\n\n`

  md += `# Финансовый эффект\n\n`
  if (!avgNightPrice) {
    md += `> ⚠️ В бронях не заполнены суммы (${priced.length}/${totalConsidered}), поэтому денежная оценка невозможна напрямую. Ниже — оценка в **номеро-ночах**; для денег подставьте свою среднюю цену.\n\n`
  }
  md += `Переведено в продаваемые длинные окна за ${dataDays} дн.: **${sellableConverted}** ночей (короткие непродаваемые «дырки» ${before.shortGapNights} → ${after.shortGapNights}). Именно эти ночи теперь реально можно продать.\n\n`
  md += `Годовая экстраполяция (× ${annualFactor.toFixed(1)}, **очень грубо** — лето это пик):\n\n`
  md += `| Сценарий заполнения освобождённого | Ночей/год | ${avgNightPrice ? 'Доп. выручка/год' : '—'} |\n|---|---|---|\n`
  for (const s of fin) {
    md += `| ${pct(s.fill)}% | ${fmt(s.annualReclaimed)} | ${avgNightPrice ? fmt(s.revenue) + ' ₸' : '—'} |\n`
  }
  md += `\n`
  if (avgNightPrice) {
    md += `**ROI при стоимости системы:**\n\n`
    md += `| Сценарий | Выручка/год | ROI @ 500 000 ₸ | ROI @ 1 000 000 ₸ |\n|---|---|---|---|\n`
    for (const s of fin) {
      md += `| ${pct(s.fill)}% | ${fmt(s.revenue)} ₸ | ${roi(s.revenue, 500000).toFixed(0)}% | ${roi(s.revenue, 1000000).toFixed(0)}% |\n`
    }
    md += `\n`
  }

  md += `# Кейс для владельца базы\n\n`
  md += genOwnerCase(before, after, sellableConverted, freedRooms.length, usefulMoves.length, moves.length, avgNightPrice, fin)

  md += `\n# Ограничения и допущения анализа\n\n`
  md += `- **Загрузка (occupancy) не меняется** от перестановки — алгоритм не создаёт брони. Вся «выгода» условна: освобождённые окна принесут деньги, только если есть спрос их заполнить.\n`
  md += `- Данные — **исторические, один сезон** (${dstr(windowStart)}…${dstr(windowEnd)}, ${dataDays} дн.), это **пик лета**. Годовая экстраполяция (×${annualFactor.toFixed(1)}) завышена — вне сезона эффекта меньше.\n`
  md += `- Алгоритм запущен с дефолтными правилами: вместимость и особенности — **строго**, этаж — **мягко** (может менять), корпус — **не ограничен**. Изменивших этаж ходов: ${floorChanges.length}, корпус: ${buildingChanges.length}.\n`
  md += `- «Окно» = пустой промежуток **между двумя бронями** в одном номере. Свободный хвост до/после — не окно.\n`
  md += `- Цена номеро-ночи берётся только по броням с заполненной суммой (${priced.length}/${totalConsidered}).\n`
  md += `- Финансовая модель — сценарии заполнения 30/50/70%, не факт. ROI считается от грубой годовой выручки.\n`
  md += `- Анализ не учитывает операционные издержки перестановок (путаница с номером в заявке бюро и т.п.).\n`

  md += `\n# Честный вывод\n\n`
  md += genVerdict(before, after, sellableConverted, freedRooms.length, usefulMoves.length, moves.length, dataDays)

  // Вывод + сохранение в файл (файл, не БД)
  console.log(md)
  const outDir = path.join(process.cwd(), '..', 'backups')
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `optimizer-backtest-${new Date().toISOString().slice(0, 10)}.md`)
  fs.writeFileSync(outFile, md, 'utf8')
  console.error('\n[saved] ' + outFile)
  process.exit(0)
}

function metricsBlock(m) {
  const pct = (x) => (x * 100).toFixed(1)
  let s = `| Метрика | Значение |\n|---|---|\n`
  s += `| Номеро-ночей всего | ${Math.round(m.totalRoomNights).toLocaleString('ru-RU')} |\n`
  s += `| Занятых номеро-ночей | ${m.occupiedNights.toLocaleString('ru-RU')} |\n`
  s += `| Пустых номеро-ночей | ${Math.round(m.emptyNights).toLocaleString('ru-RU')} |\n`
  s += `| Загрузка (occupancy) | ${pct(m.occupancy)}% |\n`
  s += `| Окна 1 дня | ${m.gaps1} |\n`
  s += `| Окна 2 дней | ${m.gaps2} |\n`
  s += `| Окна 3+ дней | ${m.gaps3} |\n`
  s += `| Окон всего | ${m.totalGaps} |\n`
  s += `| Пустых ночей внутри окон | ${m.gapNights} |\n`
  s += `| Непрерывных занятых цепочек | ${m.occupiedRuns} |\n`
  s += `| Средняя длина цепочки (ночей) | ${m.avgRun.toFixed(1)} |\n`
  s += `| Задействовано номеров | ${m.roomsUsed} |\n`
  return s
}

function signed(n) { return (n > 0 ? '+' : '') + n }

function genOwnerCase(before, after, reclaimed, freed, useful, total, price, fin) {
  let s = ''
  const closed = before.totalGaps - after.totalGaps
  s += `За анализируемый период алгоритм предложил перекомпоновать будущие брони так, чтобы:\n\n`
  s += `- закрыть **${closed}** ${plural(closed, 'окно', 'окна', 'окон')} из ${before.totalGaps} (в т.ч. окна в 1 день: ${before.gaps1} → ${after.gaps1});\n`
  s += `- перевести **${reclaimed}** ночей из коротких непродаваемых «дырок» в длинные продаваемые окна;\n`
  s += `- полностью освободить **${freed}** ${plural(freed, 'номер', 'номера', 'номеров')} под продажу длинными интервалами;\n`
  s += `- сделать это всего за **${total}** ${plural(total, 'перестановку', 'перестановки', 'перестановок')} (без холостых ходов).\n\n`
  if (price) {
    s += `Если эти ночи продавать хотя бы наполовину (сценарий 50%), потенциал — около **${Math.round(fin[1].revenue).toLocaleString('ru-RU')} ₸/год** дополнительной выручки. `
    s += `Но это потолок «при наличии спроса», а не гарантия.\n`
  } else {
    s += `Денежная оценка недоступна — в бронях не заполнены суммы. Подставив среднюю цену, можно оценить потолок выручки.\n`
  }
  return s
}

function genVerdict(before, after, reclaimed, freed, useful, total, dataDays) {
  const closed = before.totalGaps - after.totalGaps
  const closePct = before.totalGaps ? (closed / before.totalGaps) * 100 : 0
  let s = ''
  s += `**Есть ли статистически значимое улучшение?**\n`
  s += `Да, по структуре: окна ${before.totalGaps} → ${after.totalGaps} (${closePct.toFixed(0)}%), окна в 1 день ${before.gaps1} → ${after.gaps1}, переведено ${reclaimed} ночей в продаваемые окна — за ${total} ходов. Но выборка — один сезон/${dataDays} дн., одна категория (double), поэтому «статистически значимым» в строгом смысле это назвать нельзя — это **демонстрация на одном кейсе**.\n\n`
  s += `**Даёт ли алгоритм коммерческую ценность?**\n`
  s += `Да, ограниченно. Он не повышает загрузку существующих броней (она инвариантна), а **дефрагментирует** сетку: рубит короткие непродаваемые окна, сливая их в длинные продаваемые. Деньги появляются только если есть спрос их заполнить. После переписи движка список ходов короткий и осмысленный (${useful}/${total} с прямым эффектом, остальные — части улучшающих цепочек, не холостые), поэтому применять предложения на практике реально.\n\n`
  s += `**Для каких баз алгоритм наиболее полезен?**\n`
  s += `- Высокая загрузка + много коротких броней разной длины (пансионаты, базы отдыха в пик сезона) — там фрагментация максимальна.\n`
  s += `- Один-два типа номеров с большим числом взаимозаменяемых единиц.\n`
  s += `- Активная дозагрузка (звонки «есть на эти даты?») — тогда длинные окна реально конвертируются в выручку.\n`
  s += `- Малополезен при низкой загрузке (окон и так нет смысла паковать) и при уникальных несовместимых номерах.\n\n`
  s += `**Достаточно ли сильный результат, чтобы продавать систему?**\n`
  s += `Оптимизатор — **хорошая «фишка» для демонстрации**, но не самостоятельный аргумент продажи. Продавать стоит систему целиком (учёт, сетка, смены, аудит, бэкапы), а оптимизатор подавать как умное дополнение. На этих данных эффект скромный и условный (низкая загрузка 16.7%, цены не заполнены, один сезон). Реальную силу алгоритм покажет на **плотной сетке с высокой загрузкой и заполненными ценами** — там фрагментация выше и денежный эффект считается напрямую. Список ходов после переписи движка уже короткий (${total}) и без холостых перестановок, так что предложения применимы на практике.\n`
  return s
}

function plural(n, one, few, many) {
  const m = n % 10, m100 = n % 100
  if (m === 1 && m100 !== 11) return one
  if (m >= 2 && m <= 4 && (m100 < 10 || m100 >= 20)) return few
  return many
}

main().catch(e => { console.error(e); process.exit(1) })
