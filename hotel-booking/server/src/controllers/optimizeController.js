const { prisma } = require('../utils/prisma')
const { getCurrentBusinessDate } = require('../utils/businessDate')
const { getFlagEffectsMap } = require('../utils/flagEffects')
const { createSnapshot } = require('../utils/snapshot')
const { emitBookingEvent } = require('../socket/socketManager')
const { BOOKING_SELECT } = require('./bookingController')
const logger = require('../utils/logger')

/**
 * Алгоритм оптимизации распределения броней.
 *
 * Все параметры конфигурируются через settings (приходит с клиента).
 * Дефолты — на случай если клиент ничего не прислал.
 */

const DEFAULT_SETTINGS = {
  capacityRule: 'strict',      // 'strict' | 'soft' | 'ignore'
  featuresRule: 'strict',      // 'strict' | 'soft' | 'ignore'
  floorRule:    'soft',        // 'ignore' | 'soft' | 'strict'

  shortGapThreshold:       2,
  shortGapMultiplier:      5,
  emptyNightPenalty:       1,
  floorChangePenalty:      2,
  capacityMismatchPenalty: 10,
  featuresMismatchPenalty: 5,

  // Штраф за каждое перемещение: ход предлагается, только если выигрыш по окнам
  // его перевешивает. Это убирает холостые перестановки и держит список коротким.
  movePenalty:         3,

  protectPaidBookings: true,
  protectFlaggedIds:   [],
  maxMovesPerRun:      0,
  maxDaysAhead:        0,

  enableLocalSearch:     true,
  localSearchIterations: 500,
  preferSameRoom:        true,
}

function mergeSettings(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_SETTINGS }
  const out = { ...DEFAULT_SETTINGS }
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (input[k] !== undefined && input[k] !== null) out[k] = input[k]
  }
  return out
}

/** Ключ "сигнатуры" номера: вместимость + отсортированный список особенностей. */
function roomSignature(room) {
  const feat = (room.features || []).slice().sort().join('|')
  return `${room.capacity || ''}::${feat}`
}

/**
 * Проверка совместимости: можно ли поместить бронь в номер согласно правилам.
 * Возвращает { allowed: bool, penalty: number }.
 */
function compatibilityCheck(room, booking, S) {
  let penalty = 0

  // ─── Жёсткие ограничения от меток брони (не зависят от настроек правил) ───
  // «Только этот этаж» — нельзя менять этаж.
  if (booking.lockFloor && booking.originalFloor != null && room.floor !== booking.originalFloor) {
    return { allowed: false, penalty: 0 }
  }
  // «Только односпальные/двуспальные» — номер обязан иметь нужную особенность.
  if (booking.requireFeature && !(room.features || []).includes(booking.requireFeature)) {
    return { allowed: false, penalty: 0 }
  }

  // Вместимость
  if (S.capacityRule !== 'ignore') {
    if ((room.capacity || '') !== (booking.originalCapacity || '')) {
      if (S.capacityRule === 'strict') return { allowed: false, penalty: 0 }
      penalty += S.capacityMismatchPenalty
    }
  }

  // Особенности
  if (S.featuresRule !== 'ignore') {
    const sig = (room.features || []).slice().sort().join('|')
    const origSig = (booking.originalFeatures || []).slice().sort().join('|')
    if (sig !== origSig) {
      if (S.featuresRule === 'strict') return { allowed: false, penalty: 0 }
      penalty += S.featuresMismatchPenalty
    }
  }

  // Этаж как жёсткое
  if (S.floorRule === 'strict') {
    if (booking.originalFloor != null && room.floor !== booking.originalFloor) {
      return { allowed: false, penalty: 0 }
    }
  }

  return { allowed: true, penalty }
}

/** Возвращает счёт раскладки: чем меньше тем лучше. */
function scoreLayout(roomBookings, roomById, S) {
  let totalGap = 0
  let shortGapWeight = 0
  let floorChanges = 0
  let compatPenalty = 0

  for (const [roomId, list] of roomBookings.entries()) {
    const room = roomById.get(roomId)
    for (let i = 1; i < list.length; i++) {
      const gap = effectiveGapDays(list[i - 1], list[i])
      if (gap > 0) {
        totalGap += gap
        if (gap <= S.shortGapThreshold) {
          // 1 ночь хуже 2-х, 2 хуже 3-х и т.д.
          shortGapWeight += (S.shortGapThreshold + 1 - gap)
        }
      }
    }
    if (room) {
      for (const b of list) {
        if (b.movable) {
          // Смена этажа
          if (S.floorRule === 'soft' && b.originalFloor != null && room.floor !== b.originalFloor) {
            floorChanges++
          }
          // Мягкие штрафы за несовместимость
          if (S.capacityRule === 'soft' && (room.capacity || '') !== (b.originalCapacity || '')) {
            compatPenalty += S.capacityMismatchPenalty
          }
          if (S.featuresRule === 'soft') {
            const sig = (room.features || []).slice().sort().join('|')
            const origSig = (b.originalFeatures || []).slice().sort().join('|')
            if (sig !== origSig) compatPenalty += S.featuresMismatchPenalty
          }
        }
      }
    }
  }

  return totalGap * S.emptyNightPenalty
       + shortGapWeight * S.shortGapMultiplier
       + floorChanges * S.floorChangePenalty
       + compatPenalty
}

function bookingsOverlap(a, b) {
  return a.checkInMs < b.checkOutMs && b.checkInMs < a.checkOutMs
}

/**
 * Требуемый «чистый» зазор (дней) между соседними бронями из-за эффектов меток:
 * буфер после первой (turnaround) и буфер до второй. Берём максимум.
 */
function requiredGap(first, second) {
  let after = first.bufferAfter || 0
  // Исключение: «выезд до 17:00» снимает зазор, если у следующей брони стоит метка-исключение
  // (заезд после 17:00). У «выезд после 17:00» exceptAfterFlag нет → зазор остаётся всегда.
  if (after && first.exceptAfterFlag && (second.flags || []).includes(first.exceptAfterFlag)) after = 0
  return Math.max(after, second.bufferBefore || 0)
}

/** Конфликт с учётом буферов: прямое пересечение ИЛИ недостаточный зазор. */
function bookingsConflict(a, b) {
  if (bookingsOverlap(a, b)) return true
  const [first, second] = a.checkOutMs <= b.checkInMs ? [a, b] : [b, a]
  const gapDays = (second.checkInMs - first.checkOutMs) / 86400_000
  return gapDays < requiredGap(first, second)
}

/**
 * «Эффективное» окно между соседями = фактический зазор минус намеренный буфер.
 * Буферные ночи (turnaround) НЕ считаются окном — их закрывать нельзя.
 */
function effectiveGapDays(prev, next) {
  const raw = Math.round((next.checkInMs - prev.checkOutMs) / 86400_000)
  if (raw <= 0) return 0
  return Math.max(0, raw - requiredGap(prev, next))
}

function canPlace(roomList, booking) {
  for (const b of roomList) if (bookingsConflict(b, booking)) return false
  return true
}

/** Greedy first-fit: сортируем по checkIn, кладём в первый совместимый номер. */
function greedyAssign(rooms, anchors, movable, S) {
  const layout = new Map()
  for (const room of rooms) layout.set(room.id, [...(anchors.get(room.id) || [])])

  const sorted = [...movable].sort((a, b) => a.checkInMs - b.checkInMs)

  for (const booking of sorted) {
    let bestRoomId = null
    let bestScore = Infinity

    for (const room of rooms) {
      const compat = compatibilityCheck(room, booking, S)
      if (!compat.allowed) continue

      const list = layout.get(room.id)
      if (!canPlace(list, booking)) continue

      // Минимальный gap до соседей
      let gap = Infinity
      for (const b of list) {
        if (b.checkOutMs <= booking.checkInMs) {
          gap = Math.min(gap, (booking.checkInMs - b.checkOutMs) / 86400_000)
        }
        if (b.checkInMs >= booking.checkOutMs) {
          gap = Math.min(gap, (b.checkInMs - booking.checkOutMs) / 86400_000)
        }
      }
      if (list.length === 0) gap = 1000 // пустой номер — последний приоритет

      let candScore = gap + compat.penalty
      // Бонус "оставить в исходном номере"
      if (S.preferSameRoom && room.id === booking.originalRoomId) candScore -= 0.5
      // Этаж (мягкое предпочтение)
      if (S.floorRule === 'soft' && room.floor === booking.originalFloor) candScore -= 0.25

      if (candScore < bestScore) {
        bestScore = candScore
        bestRoomId = room.id
      }
    }

    if (bestRoomId == null) {
      // Совместимого номера не нашлось — оставляем где был
      bestRoomId = booking.originalRoomId
    }
    layout.get(bestRoomId).push(booking)
    layout.get(bestRoomId).sort((a, b) => a.checkInMs - b.checkInMs)
  }

  return layout
}

/** Локальный поиск: парные swap movable броней между совместимыми номерами. */
function localSearchImprove(rooms, anchors, layout, roomById, S) {
  let currentScore = scoreLayout(layout, roomById, S)
  let improved = true
  let iter = 0
  const maxIter = S.localSearchIterations || 200

  while (improved && iter < maxIter) {
    improved = false
    iter++

    const positions = []
    for (const [roomId, list] of layout.entries()) {
      for (const b of list) if (b.movable) positions.push({ roomId, booking: b })
    }

    outer:
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i], b = positions[j]
        if (a.roomId === b.roomId) continue

        const roomA = roomById.get(a.roomId)
        const roomB = roomById.get(b.roomId)
        // Совместимость для свапа
        if (!compatibilityCheck(roomB, a.booking, S).allowed) continue
        if (!compatibilityCheck(roomA, b.booking, S).allowed) continue

        const listA = layout.get(a.roomId).filter(x => x !== a.booking)
        const listB = layout.get(b.roomId).filter(x => x !== b.booking)
        if (!canPlace(listA, b.booking)) continue
        if (!canPlace(listB, a.booking)) continue

        listA.push(b.booking); listA.sort((x, y) => x.checkInMs - y.checkInMs)
        listB.push(a.booking); listB.sort((x, y) => x.checkInMs - y.checkInMs)

        const newLayout = new Map(layout)
        newLayout.set(a.roomId, listA)
        newLayout.set(b.roomId, listB)
        const newScore = scoreLayout(newLayout, roomById, S)

        if (newScore < currentScore) {
          layout.set(a.roomId, listA)
          layout.set(b.roomId, listB)
          currentScore = newScore
          improved = true
          continue outer
        }
      }
    }
  }

  return layout
}

// ─── Новое ядро: улучшение от ТЕКУЩЕЙ раскладки ──────────────────────────────────
// Вместо пересборки с нуля стартуем с реальной раскладки и делаем только строго
// улучшающие ходы (перенос/обмен). Каждый ход стоит movePenalty — поэтому
// предлагаются лишь те перестановки, где выигрыш по окнам перевешивает цену хода.

const _DAY = 86400_000

/** Стоимость окон одного номера (для инкрементального дельта-счёта). */
function roomGapCost(list, S) {
  let totalGap = 0
  let shortW = 0
  for (let i = 1; i < list.length; i++) {
    const g = effectiveGapDays(list[i - 1], list[i])
    if (g > 0) {
      totalGap += g
      if (g <= S.shortGapThreshold) shortW += (S.shortGapThreshold + 1 - g)
    }
  }
  return totalGap * S.emptyNightPenalty + shortW * S.shortGapMultiplier
}

/** Стоимость размещения брони в номере: штрафы за этаж/несовместимость + штраф за сам факт перемещения. */
function placementCost(b, room, S) {
  let c = 0
  if (S.floorRule === 'soft' && b.originalFloor != null && room.floor !== b.originalFloor) {
    c += S.floorChangePenalty
  }
  if (S.capacityRule === 'soft' && (room.capacity || '') !== (b.originalCapacity || '')) {
    c += S.capacityMismatchPenalty
  }
  if (S.featuresRule === 'soft') {
    const sig = (room.features || []).slice().sort().join('|')
    const orig = (b.originalFeatures || []).slice().sort().join('|')
    if (sig !== orig) c += S.featuresMismatchPenalty
  }
  if (room.id !== b.originalRoomId) c += (S.movePenalty || 0)
  return c
}

/**
 * Hill-climbing от текущей раскладки. Операции:
 *  - перенос: переложить одну подвижную бронь в совместимый номер;
 *  - обмен: поменять две подвижные брони местами.
 * Принимаем ход только если суммарная стоимость строго падает.
 */
function improveFromCurrent(roomsByCategory, roomById, layout, S) {
  const EPS = 1e-9
  const maxIter = S.localSearchIterations || 500
  let guard = 0
  let improved = true

  while (improved && guard < maxIter) {
    improved = false
    guard++

    const positions = []
    for (const [rid, list] of layout.entries()) {
      for (const b of list) if (b.movable) positions.push({ rid, b })
    }

    // 1. ПЕРЕНОС — ищем первый улучшающий
    for (const { rid, b } of positions) {
      const room = roomById.get(rid)
      const cats = roomsByCategory.get(room.category.id) || []
      const curList = layout.get(rid)
      const curListNoB = curList.filter(x => x !== b)
      const deltaSource = roomGapCost(curListNoB, S) - roomGapCost(curList, S)
      const placeCur = placementCost(b, room, S)

      let bestDelta = -EPS
      let bestTarget = null

      for (const tr of cats) {
        if (tr.id === rid) continue
        if (!compatibilityCheck(tr, b, S).allowed) continue
        const tList = layout.get(tr.id)
        if (!canPlace(tList, b)) continue

        const newList = [...tList, b].sort((x, y) => x.checkInMs - y.checkInMs)
        const deltaTarget = roomGapCost(newList, S) - roomGapCost(tList, S)
        const deltaPlace = placementCost(b, tr, S) - placeCur
        const delta = deltaSource + deltaTarget + deltaPlace

        if (delta < bestDelta) { bestDelta = delta; bestTarget = { tr, newList } }
      }

      if (bestTarget) {
        layout.set(rid, curListNoB)
        layout.set(bestTarget.tr.id, bestTarget.newList)
        improved = true
        break // пересобрать позиции и начать заново
      }
    }
    if (improved) continue

    // 2. ОБМЕН — только если переносом улучшить не вышло
    outer:
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const A = positions[i], B = positions[j]
        if (A.rid === B.rid) continue
        const roomA = roomById.get(A.rid), roomB = roomById.get(B.rid)
        if (roomA.category.id !== roomB.category.id) continue
        if (!compatibilityCheck(roomB, A.b, S).allowed) continue
        if (!compatibilityCheck(roomA, B.b, S).allowed) continue

        const listA = layout.get(A.rid), listB = layout.get(B.rid)
        const listAno = listA.filter(x => x !== A.b)
        const listBno = listB.filter(x => x !== B.b)
        if (!canPlace(listAno, B.b)) continue
        if (!canPlace(listBno, A.b)) continue

        const newA = [...listAno, B.b].sort((x, y) => x.checkInMs - y.checkInMs)
        const newB = [...listBno, A.b].sort((x, y) => x.checkInMs - y.checkInMs)

        const delta =
          (roomGapCost(newA, S) - roomGapCost(listA, S)) +
          (roomGapCost(newB, S) - roomGapCost(listB, S)) +
          (placementCost(A.b, roomB, S) - placementCost(A.b, roomA, S)) +
          (placementCost(B.b, roomA, S) - placementCost(B.b, roomB, S))

        if (delta < -EPS) {
          layout.set(A.rid, newA)
          layout.set(B.rid, newB)
          improved = true
          break outer
        }
      }
    }
  }

  return layout
}

/**
 * Чистка результата: убирает перемещения, которые НЕ улучшают раскладку.
 * Для каждой перемещённой брони пробуем вернуть её в исходный номер; если
 * счёт от этого не ухудшается — откатываем (меньше ходов при том же качестве).
 * Это и убивает «холостые рокировки» вида 1→41 + 41→1.
 */
function minimizeMoves(layout, roomById, S) {
  let currentScore = scoreLayout(layout, roomById, S)
  let changed = true
  let guard = 0

  while (changed && guard < 2000) {
    changed = false
    guard++

    // Текущие перемещённые брони (бронь стоит не в своём исходном номере)
    const moved = []
    for (const [rid, list] of layout.entries()) {
      for (const b of list) {
        if (b.movable && b.originalRoomId !== rid) moved.push({ rid, b })
      }
    }

    for (const { rid, b } of moved) {
      const origRoomId = b.originalRoomId
      if (!roomById.has(origRoomId)) continue

      const origList = layout.get(origRoomId)
      // Вернуть можно только если в исходном номере сейчас свободно на эти даты
      if (!canPlace(origList, b)) continue

      const newCurList = layout.get(rid).filter(x => x !== b)
      const newOrigList = [...origList, b].sort((x, y) => x.checkInMs - y.checkInMs)

      const trial = new Map(layout)
      trial.set(rid, newCurList)
      trial.set(origRoomId, newOrigList)
      const newScore = scoreLayout(trial, roomById, S)

      // <= : откатываем даже при равном счёте — это меньше ходов без потери качества
      if (newScore <= currentScore) {
        layout.set(rid, newCurList)
        layout.set(origRoomId, newOrigList)
        currentScore = newScore
        changed = true
        break  // пересобрать список перемещённых и пройти заново
      }
    }
  }

  return layout
}

/** Считает метрики сетки: количество окон, короткие окна, общий простой. */
function calcMetrics(layout, S) {
  let totalGaps = 0
  let shortGaps = 0
  let lostNights = 0
  for (const list of layout.values()) {
    for (let i = 1; i < list.length; i++) {
      const gap = effectiveGapDays(list[i - 1], list[i])
      if (gap > 0) {
        totalGaps++
        lostNights += gap
        if (gap <= S.shortGapThreshold) shortGaps++
      }
    }
  }
  return { totalGaps, shortGaps, lostNights }
}

/**
 * POST /api/occupancy/optimize
 * body: { settings: OptimizerSettings }
 */
async function optimize(req, res, next) {
  try {
    const S = mergeSettings(req.body?.settings)

    // Эффекты меток брони: { code: { bufferAfter, bufferBefore, pin } }.
    // Источник истины — БД; клиент может прислать переопределение (имеет приоритет).
    const dbEffects = await getFlagEffectsMap()
    const clientEffects = (req.body?.flagEffects && typeof req.body.flagEffects === 'object')
      ? req.body.flagEffects : {}
    const flagEffects = { ...dbEffects, ...clientEffects }

    // «Сегодня» = дата рабочей смены в БД, а не дата устройства — иначе при
    // вводе исторических данных все брони считаются прошедшими и неподвижными.
    const todayUTC = await getCurrentBusinessDate()

    // Горизонт планирования
    const horizonMs = S.maxDaysAhead > 0
      ? todayUTC.getTime() + S.maxDaysAhead * 86400_000
      : Infinity

    // 1. Все активные номера
    const rooms = await prisma.room.findMany({
      where: { isActive: true },
      select: {
        id: true, number: true, building: true, floor: true,
        capacity: true, features: true,
        category: { select: { id: true, name: true } },
      },
    })

    // 2. Все актуальные брони
    const allBookings = await prisma.booking.findMany({
      where: {
        status: { notIn: ['CANCELLED', 'CHECKED_OUT'] },
        checkOut: { gt: todayUTC },
      },
      select: {
        id: true, roomId: true, guestName: true,
        checkIn: true, checkOut: true, status: true, source: true,
        flags: true, paidAmount: true,
      },
    })

    const roomsByCategory = new Map()
    for (const r of rooms) {
      if (!roomsByCategory.has(r.category.id)) roomsByCategory.set(r.category.id, [])
      roomsByCategory.get(r.category.id).push(r)
    }

    const roomById = new Map(rooms.map(r => [r.id, r]))

    const anchorsByRoom = new Map()
    const movableByCat = new Map()
    const protectedFlags = new Set(S.protectFlaggedIds || [])

    for (const b of allBookings) {
      const room = roomById.get(b.roomId)
      if (!room) continue

      // Сворачиваем эффекты всех меток брони: буферы, pin, блокировка этажа,
      // требуемая особенность номера, исключение буфера «после».
      let bufferAfter = 0, bufferBefore = 0, pinned = false
      let lockFloor = false, requireFeature = null, exceptAfterFlag = null
      for (const fId of (b.flags || [])) {
        const e = flagEffects[fId]
        if (!e) continue
        if (e.bufferAfter) bufferAfter = Math.max(bufferAfter, Number(e.bufferAfter) || 0)
        if (e.bufferBefore) bufferBefore = Math.max(bufferBefore, Number(e.bufferBefore) || 0)
        if (e.pin) pinned = true
        if (e.lockFloor) lockFloor = true
        if (e.requireFeature) requireFeature = e.requireFeature
        if (e.bufferAfterExceptFlag) exceptAfterFlag = e.bufferAfterExceptFlag
      }

      const item = {
        id: b.id,
        originalRoomId: b.roomId,
        originalFloor: room.floor,
        originalCapacity: room.capacity,
        originalFeatures: room.features,
        guestName: b.guestName,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        checkInMs: new Date(b.checkIn).getTime(),
        checkOutMs: new Date(b.checkOut).getTime(),
        status: b.status,
        source: b.source,
        flags: b.flags || [],
        bufferAfter,
        bufferBefore,
        lockFloor,
        requireFeature,
        exceptAfterFlag,
      }

      const inHorizon = item.checkInMs < horizonMs
      const hasProtectedFlag = (item.flags || []).some(f => protectedFlags.has(f))
      const isPaid = S.protectPaidBookings && (b.paidAmount || 0) > 0

      const isMovable =
        b.status === 'CONFIRMED' &&
        b.source !== 'ремонт' &&
        item.checkInMs >= todayUTC.getTime() &&
        inHorizon &&
        !hasProtectedFlag &&
        !isPaid &&
        !pinned   // метка с эффектом «не перемещать» делает бронь якорем

      item.movable = isMovable

      if (isMovable) {
        if (!movableByCat.has(room.category.id)) movableByCat.set(room.category.id, [])
        movableByCat.get(room.category.id).push(item)
      } else {
        if (!anchorsByRoom.has(b.roomId)) anchorsByRoom.set(b.roomId, [])
        anchorsByRoom.get(b.roomId).push(item)
      }
    }

    // 3. Текущая раскладка для метрик "до"
    const currentLayout = new Map()
    for (const r of rooms) currentLayout.set(r.id, [...(anchorsByRoom.get(r.id) || [])])
    for (const list of movableByCat.values()) {
      for (const b of list) currentLayout.get(b.originalRoomId).push(b)
    }
    for (const list of currentLayout.values()) list.sort((a, b) => a.checkInMs - b.checkInMs)

    const before = calcMetrics(currentLayout, S)

    // 4. Оптимизируем — СТАРТ ОТ ТЕКУЩЕЙ РАСКЛАДКИ (а не пересборка с нуля).
    //    Так лишних перестановок нет по построению: двигаем бронь, только если
    //    это строго улучшает счёт с учётом штрафа за ход.
    const proposedLayout = new Map()
    for (const [rid, list] of currentLayout.entries()) proposedLayout.set(rid, [...list])

    if (S.enableLocalSearch) {
      improveFromCurrent(roomsByCategory, roomById, proposedLayout, S)
    }

    // Подстраховка: убрать любые ходы, не улучшающие раскладку (почти всегда no-op)
    minimizeMoves(proposedLayout, roomById, S)

    const after = calcMetrics(proposedLayout, S)

    // 5. Diff + маржинальный вклад каждого хода (на сколько вырастут окна, если
    //    именно этот ход НЕ делать — при остальных применённых). Аннотация для UI,
    //    раскладку не меняет.
    let moves = []
    for (const [rid, list] of proposedLayout.entries()) {
      for (const b of list) {
        if (b.movable && b.originalRoomId !== rid) {
          const fromRoom = roomById.get(b.originalRoomId)
          const toRoom = roomById.get(rid)

          let gapsClosed = null
          let shortGapsClosed = null
          let nightsClosed = null
          let partOfChain = false

          const origList = proposedLayout.get(b.originalRoomId)
          if (origList && canPlace(origList, b)) {
            // Можно вернуть бронь в исходный номер — меряем разницу
            const trial = new Map(proposedLayout)
            trial.set(rid, list.filter(x => x !== b))
            trial.set(b.originalRoomId, [...origList, b].sort((x, y) => x.checkInMs - y.checkInMs))
            const tm = calcMetrics(trial, S)
            gapsClosed = tm.totalGaps - after.totalGaps
            shortGapsClosed = tm.shortGaps - after.shortGaps
            nightsClosed = tm.lostNights - after.lostNights
          } else {
            // Возврат заблокирован чужой бронью → ход в связке (парный обмен/цепочка)
            partOfChain = true
          }

          moves.push({
            bookingId: b.id,
            guestName: b.guestName,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            from: {
              roomId: fromRoom.id, roomNumber: fromRoom.number,
              building: fromRoom.building, floor: fromRoom.floor,
            },
            to: {
              roomId: toRoom.id, roomNumber: toRoom.number,
              building: toRoom.building, floor: toRoom.floor,
            },
            categoryName: fromRoom.category.name,
            gapsClosed,
            shortGapsClosed,
            nightsClosed,
            partOfChain,
          })
        }
      }
    }

    moves.sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn))

    // Лимит перемещений (берём первые N — отсортированы по дате)
    if (S.maxMovesPerRun > 0 && moves.length > S.maxMovesPerRun) {
      moves = moves.slice(0, S.maxMovesPerRun)
    }

    res.json({
      before,
      after,
      improvement: {
        gapsReduced: before.totalGaps - after.totalGaps,
        shortGapsReduced: before.shortGaps - after.shortGaps,
        nightsReclaimed: before.lostNights - after.lostNights,
      },
      moves,
      totalMoves: moves.length,
      settingsUsed: S,
    })
  } catch (err) {
    next(err)
  }
}

/**
 * POST /api/occupancy/optimize/apply
 * body: { moves: [{ bookingId, toRoomId }, ...] }
 *
 * Все ходы применяются одной транзакцией с ОТЛОЖЕННОЙ проверкой booking_no_overlap:
 * обмен броней A↔B по одной даёт временное пересечение, которое неотложенное
 * ограничение отклоняло на первом же UPDATE (любой план → 409). С
 * SET CONSTRAINTS ... DEFERRED БД проверяет итоговую раскладку один раз на COMMIT.
 */
async function applyOptimization(req, res, next) {
  try {
    const { moves } = req.body || {}

    // а) Валидация тела: непустой массив { bookingId, toRoomId } с целыми id
    if (!Array.isArray(moves) || moves.length === 0) {
      return res.status(400).json({ error: 'Нет ходов для применения: moves должен быть непустым массивом' })
    }
    const parsed = []
    const seen = new Set()
    for (const m of moves) {
      const bookingId = Number(m?.bookingId)
      const toRoomId = Number(m?.toRoomId)
      if (!Number.isInteger(bookingId) || bookingId <= 0 || !Number.isInteger(toRoomId) || toRoomId <= 0) {
        return res.status(400).json({ error: 'Каждый ход должен содержать целые bookingId и toRoomId' })
      }
      if (seen.has(bookingId)) {
        return res.status(400).json({ error: `Бронь #${bookingId} указана в плане дважды` })
      }
      seen.add(bookingId)
      parsed.push({ bookingId, toRoomId })
    }
    const bookingIds = parsed.map(m => m.bookingId)

    // б) Актуальность плана ДО записи — сетка могла измениться после расчёта
    //    (те же условия подвижности, что и в optimize(), плюс состояние целевого номера)
    const todayUTC = await getCurrentBusinessDate()
    const [bookings, rooms] = await Promise.all([
      prisma.booking.findMany({
        where: { id: { in: bookingIds } },
        select: {
          id: true, guestName: true, status: true, source: true, checkIn: true, roomId: true,
          room: { select: { categoryId: true } },
        },
      }),
      prisma.room.findMany({
        where: { id: { in: parsed.map(m => m.toRoomId) } },
        select: { id: true, number: true, isActive: true, categoryId: true },
      }),
    ])
    const bookingById = new Map(bookings.map(b => [b.id, b]))
    const roomById = new Map(rooms.map(r => [r.id, r]))

    const stale = []
    for (const { bookingId, toRoomId } of parsed) {
      const b = bookingById.get(bookingId)
      if (!b) { stale.push({ bookingId, reason: 'бронь не найдена' }); continue }
      const room = roomById.get(toRoomId)
      let reason = null
      if (b.status !== 'CONFIRMED') reason = `статус брони изменился (${b.status})`
      else if (b.source === 'ремонт') reason = 'ремонтный блок нельзя перемещать'
      else if (b.checkIn.getTime() < todayUTC.getTime()) reason = 'дата заезда уже прошла'
      else if (b.roomId === toRoomId) reason = 'бронь уже в целевом номере'
      else if (!room) reason = 'целевой номер не найден'
      else if (!room.isActive) reason = `номер №${room.number} деактивирован`
      else if (room.categoryId !== b.room.categoryId) reason = `номер №${room.number} другой категории`
      if (reason) stale.push({ bookingId, guestName: b.guestName, reason })
    }
    if (stale.length > 0) {
      const brief = stale.length === 1
        ? `${stale[0].guestName ? `«${stale[0].guestName}» — ` : ''}${stale[0].reason}`
        : `${stale.length} из ${parsed.length} ходов больше неактуальны`
      return res.status(409).json({ error: `План устарел: ${brief}. Пересчитайте.`, stale })
    }

    // в) Защитный снимок — точка отката, если результат не понравится
    try {
      await createSnapshot({ kind: 'safety', label: 'Перед применением оптимизатора', createdById: req.admin.id })
    } catch (err) {
      logger.error('Snapshot before optimizer apply failed:', err.message)
    }

    // г) Все ходы одной транзакцией; booking_no_overlap проверяется один раз на COMMIT
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET CONSTRAINTS booking_no_overlap DEFERRED')
      for (const { bookingId, toRoomId } of parsed) {
        await tx.booking.update({ where: { id: bookingId }, data: { roomId: toRoomId } })
      }
    }, { timeout: 30_000 })

    // д) Сброс кэша сетки и рассылка изменений остальным рабочим местам
    const { invalidateGridCache } = require('./occupancyController')
    invalidateGridCache()

    const updated = await prisma.booking.findMany({
      where: { id: { in: bookingIds } },
      select: BOOKING_SELECT,
    })
    for (const booking of updated) {
      try { emitBookingEvent('booking:updated', { booking }) } catch { /* сокет не инициализирован — не критично */ }
    }

    // е) Ответ — как раньше
    res.json({ applied: parsed.length })
  } catch (err) {
    next(err)
  }
}

module.exports = { optimize, applyOptimization }
