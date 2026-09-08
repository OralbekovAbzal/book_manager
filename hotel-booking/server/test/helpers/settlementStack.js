/**
 * Стенд «Расчёт с гостем» (шаг 5a-2): настоящий `settlementController` поверх стенда
 * волны 5a (`bookingStack.js`).
 *
 * Смысл тот же: живой сервер и Postgres в тестах не участвуют, но `fakePrisma`
 * честно вычисляет `where`, поэтому проверяется ЗАПРОС, который строит контроллер.
 *
 * Настоящими берутся `bookingController`, `paymentController`, `utils/charges.js`
 * и `utils/bookingMoney.js` — расчёт с гостем обязан делать ТЕ ЖЕ действия, а не их
 * копию, и подмена их заглушками проверяла бы ровно ничего. Подменены только
 * сокет, смена и рабочая дата.
 *
 * Событий сокета `settlementController` шлёт два («действие» + `booking:updated`),
 * и оба обязаны лечь в тот же массив `emitted`, что события контроллера броней:
 * порядок между ними — часть контракта.
 */
import { loadCjs, silentLogger } from './loadCjs.js'
import { makeStack, BUSINESS_DATE } from './bookingStack.js'

export * from './bookingStack.js'

export function makeSettlementStack(opts = {}) {
  const st = makeStack(opts)
  const businessDate = opts.businessDate ?? BUSINESS_DATE

  const errorHandler = loadCjs('src/middleware/errorHandler.js', {
    stubs: { '../utils/logger': silentLogger },
  })
  const bookingMoney = loadCjs('src/utils/bookingMoney.js', {
    stubs: { './prisma': { prisma: st.prisma } },
  })

  const settlement = loadCjs('src/controllers/settlementController.js', {
    stubs: {
      '../utils/prisma': { prisma: st.prisma },
      '../utils/charges': st.charges,
      '../utils/bookingMoney': bookingMoney,
      '../middleware/errorHandler': errorHandler,
      '../socket/socketManager': {
        emitBookingEvent: (event, payload) => st.emitted.push({ event, payload }),
      },
      '../utils/businessDate': {
        getCurrentBusinessDate: async () => businessDate,
        getCurrentShift: async () => ({ id: 1, date: businessDate }),
        ensureCurrentShift: async () => ({ id: 1, date: businessDate }),
      },
      // Отмена и выезд в расчёте — те же функции контроллера броней, что и у кнопок
      // «Отменить» / «Выезд»: стенд подсовывает уже собранный на этой же базе экземпляр.
      './bookingController': st.ctrl,
      './paymentController': st.payCtrl,
    },
  })

  return { ...st, settlement }
}

/** Операции записи в фейковой базе — ими проверяется «предпросмотр ничего не пишет». */
const WRITE_OPS = new Set(['create', 'createMany', 'update', 'updateMany', 'delete', 'deleteMany'])

export function writeOps(calls, from = 0) {
  return calls.slice(from).filter((c) => WRITE_OPS.has(c.op)).map((c) => `${c.model}.${c.op}`)
}

/** Слепок всех таблиц стенда — сравнением проверяется «база не тронута». */
export function dbSnapshot(prisma) {
  return JSON.stringify({
    booking: prisma.booking.rows,
    charge: prisma.bookingCharge.rows,
    payment: prisma.payment.rows,
  })
}
