import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Форма payload'а socket-события: две правки в одном месте (`normalizeBookingPayload`).
 *
 * Одна старая — «бронь без обёртки и без `roomId` терялась на втором рабочем
 * месте», вторая новая — «документ гостя вырезать из рассылки» (D1-005). Они
 * идут подряд и обе переписывают объект, поэтому их легко поссорить: вырезание
 * стоит ПОСЛЕ выведения `roomId`, и стоит переставить строки местами — либо
 * документ уедет в сеть, либо бронь приедет без номера комнаты.
 *
 * `guestDocFields.test.js` проверяет каждую из них по отдельности. Здесь —
 * их пересечение и края: бронь без обёртки, у которой номер комнаты известен
 * только через вложенный `room`.
 */

const FIELDS = ['guestCitizenship', 'guestDocType', 'guestDocNumber', 'guestDocExpiry', 'guestBirthDate', 'guestSex']

function loadSocket() {
  const emitted = []
  class FakeServer {
    use() {}
    on() {}
    to(room) { return { emit: (ev, data) => emitted.push({ room, ev, data }) } }
  }
  const mod = loadCjs('src/socket/socketManager.js', {
    stubs: {
      'socket.io': { Server: FakeServer },
      '../utils/prisma': { prisma: {} },
      '../utils/logger': silentLogger,
      '../utils/corsOrigin': { corsOrigin: '*' },
      '../controllers/occupancyController': { invalidateGridCache() {} },
      '../utils/snapshot': { scheduleAuto() {} },
    },
  })
  mod.initSocket({})
  return { mod, emitted }
}

const bookingWithDoc = (over = {}) => ({
  id: 151,
  guestName: 'Асель Каримова',
  guestPhone: '+77011234567',
  guestDocNumber: 'N12345678',
  guestBirthDate: '1990-03-14',
  guestSex: 'F',
  guestCitizenship: 'KZ',
  guestDocType: 'passport',
  guestDocExpiry: '2030-01-01',
  status: 'CONFIRMED',
  ...over,
})

describe('payload socket-события — обёртка, номер комнаты и документ вместе', () => {
  it('бронь без обёртки, номер комнаты только внутри room: выведен roomId И вырезан документ', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:updated', bookingWithDoc({ room: { id: 12, number: '12' } }))

    const sent = emitted[0].data.booking
    expect(sent.roomId).toBe(12)
    expect(sent.guestName).toBe('Асель Каримова')
    for (const f of FIELDS) expect(sent).not.toHaveProperty(f)
  })

  it('свой roomId у брони важнее вложенного room.id — подмены номера при рассылке нет', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:updated', { booking: bookingWithDoc({ roomId: 12, room: { id: 99 } }) })
    expect(emitted[0].data.booking.roomId).toBe(12)
  })

  it('соседние ключи payload остаются на месте', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:updated', { booking: bookingWithDoc({ roomId: 12 }), reason: 'move' })
    expect(emitted[0].data.reason).toBe('move')
    expect(emitted[0].data.booking).not.toHaveProperty('guestDocNumber')
  })

  it('исходная бронь не мутируется даже когда payload переписан дважды', () => {
    const { mod } = loadSocket()
    const src = bookingWithDoc({ room: { id: 12 } })
    mod.emitBookingEvent('booking:created', src)
    expect(src.roomId).toBeUndefined()          // выведение roomId сделало копию
    expect(src.guestDocNumber).toBe('N12345678') // и вырезание тоже
  })

  it('событие отмены (bookingId + roomId) остаётся собой — обёртку ему не навязывают', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:cancelled', { bookingId: 151, roomId: 12 })
    expect(emitted[0].data).toEqual({ bookingId: 151, roomId: 12 })
    expect(emitted[0].data).not.toHaveProperty('booking')
  })

  it('выезд с пустой бронью (номер не нашёлся) не роняет рассылку', () => {
    const { mod, emitted } = loadSocket()
    expect(() => mod.emitBookingEvent('booking:cancelled', { bookingId: 151, roomId: undefined })).not.toThrow()
    expect(emitted[0].data).toEqual({ bookingId: 151, roomId: undefined })
  })

  it('смена рабочего дня рассылает только дату — там персональных данных нет по построению', () => {
    const { mod, emitted } = loadSocket()
    mod.emitShiftChanged({ id: 7, date: '2026-09-08', createdById: 1, note: 'служебное' })
    expect(emitted[0]).toEqual({ room: 'bookings', ev: 'shift:changed', data: { shift: { id: 7, date: '2026-09-08' } } })
  })
})
