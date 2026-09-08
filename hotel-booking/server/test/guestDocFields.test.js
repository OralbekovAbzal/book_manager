import { describe, it, expect } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * Список полей документа гостя — единственный на весь сервер (D1-005/007).
 *
 * Номер удостоверения, дата рождения и пол не нужны ни в журнале действий, ни
 * в рассылке сокета, ни в логах. Пока каждое место перечисляло эти шесть имён
 * само, седьмое поле означало бы тихую утечку там, где список забыли дополнить.
 *
 * Отсюда проверяем ровно две вещи и обе — на границах:
 *  • состав списка ТОЧНО шесть имён (лишнее имя вырежет нужные данные из
 *    рассылки, недостающее — утечёт документ);
 *  • `stripGuestDoc` отдаёт КОПИЮ. Мутируй он аргумент — вырезание для сокета
 *    испортило бы ту же бронь, которую контроллер собирается отдать в ответе,
 *    и документ пропал бы с экрана стойки.
 */

const load = () => loadCjs('src/utils/guestDocFields.js')

const FIELDS = [
  'guestCitizenship', 'guestDocType', 'guestDocNumber',
  'guestDocExpiry', 'guestBirthDate', 'guestSex',
]

const booking = () => ({
  id: 151,
  roomId: 12,
  guestName: 'Асель Каримова',
  guestPhone: '+7 701 000 00 00',
  guestCitizenship: 'KZ',
  guestDocType: 'passport',
  guestDocNumber: 'N12345678',
  guestDocExpiry: '2030-01-01',
  guestBirthDate: '1990-05-14',
  guestSex: 'F',
})

describe('GUEST_DOC_FIELDS — состав списка', () => {
  it('ровно шесть полей документа, без лишних и без пропусков', () => {
    const { GUEST_DOC_FIELDS } = load()
    expect([...GUEST_DOC_FIELDS].sort()).toEqual([...FIELDS].sort())
  })
})

describe('stripGuestDoc — вырезание документа', () => {
  it('поля документа исчезают, остальные остаются нетронутыми', () => {
    const { stripGuestDoc } = load()
    const clean = stripGuestDoc(booking())
    expect(clean).toEqual({
      id: 151, roomId: 12, guestName: 'Асель Каримова', guestPhone: '+7 701 000 00 00',
    })
  })

  it('исходный объект не мутируется — та же бронь ещё уйдёт в ответ стойке', () => {
    const { stripGuestDoc } = load()
    const src = booking()
    const clean = stripGuestDoc(src)
    expect(src.guestDocNumber).toBe('N12345678')
    expect(clean).not.toBe(src)
  })

  it('брони без документа проходят как есть', () => {
    const { stripGuestDoc } = load()
    const src = { id: 7, guestName: 'Пётр' }
    expect(stripGuestDoc(src)).toEqual({ id: 7, guestName: 'Пётр' })
  })

  it('null и не-объект возвращаются как есть, без исключения', () => {
    const { stripGuestDoc } = load()
    expect(stripGuestDoc(null)).toBeNull()
    expect(stripGuestDoc(undefined)).toBeUndefined()
    expect(stripGuestDoc('N12345678')).toBe('N12345678')
    expect(stripGuestDoc(42)).toBe(42)
  })
})

describe('hasGuestDoc — есть ли в объекте документ', () => {
  it('хотя бы одно поле документа — true', () => {
    const { hasGuestDoc } = load()
    expect(hasGuestDoc({ guestName: 'Асель', guestDocNumber: 'N1' })).toBe(true)
    expect(hasGuestDoc({ guestSex: 'F' })).toBe(true)
  })

  it('очистка документа (значение null) — тоже документ: правку надо заметить', () => {
    const { hasGuestDoc } = load()
    expect(hasGuestDoc({ guestDocNumber: null })).toBe(true)
  })

  it('ни одного поля документа — false', () => {
    const { hasGuestDoc } = load()
    expect(hasGuestDoc({ guestName: 'Асель', guestPhone: '+7 701', roomId: 12 })).toBe(false)
  })

  it('ключ есть, но значение undefined — поля не передавали, false', () => {
    const { hasGuestDoc } = load()
    expect(hasGuestDoc({ guestName: 'Асель', guestDocNumber: undefined })).toBe(false)
  })

  it('не-объект и null — false, а не исключение', () => {
    const { hasGuestDoc } = load()
    expect(hasGuestDoc(null)).toBe(false)
    expect(hasGuestDoc(undefined)).toBe(false)
    expect(hasGuestDoc('guestDocNumber')).toBe(false)
  })
})

/**
 * Где список применяется по-настоящему: широковещательная рассылка сетки.
 *
 * `booking:*` уходит ВСЕМ в комнате `bookings`, а документ попадает в payload
 * попутно — общий `BOOKING_SELECT` несёт его ради REST-ответа тому, кто бронь
 * запросил. То есть паспорт гостя рассылался на каждое рабочее место при любой
 * правке брони, включая те, где его никто не открывал.
 *
 * Вторая сторона той же проверки: контроллер ОДНИМ И ТЕМ ЖЕ объектом сначала
 * шлёт событие, а потом отвечает по REST (`emitBookingEvent({ booking })` и
 * `res.json`). Вырежи рассылка поля на месте — документ пропал бы и из ответа
 * тому, кто бронь только что сохранил.
 */
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
      '../controllers/occupancyController': { invalidateGridCache() {} },
      '../utils/snapshot': { scheduleAuto() {} },
    },
  })
  mod.initSocket({})
  return { mod, emitted }
}

describe('рассылка сокета — документ не уезжает на чужие рабочие места', () => {
  it('booking:updated несёт имя, телефон и номер комнаты, но не документ', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:updated', { booking: booking() })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ room: 'bookings', ev: 'booking:updated' })
    const sent = emitted[0].data.booking
    expect(sent.guestName).toBe('Асель Каримова')
    expect(sent.roomId).toBe(12)
    for (const f of FIELDS) expect(sent).not.toHaveProperty(f)
  })

  it('объект брони у контроллера остаётся с документом — он же уйдёт в REST-ответ', () => {
    const { mod } = loadSocket()
    const src = booking()
    mod.emitBookingEvent('booking:created', { booking: src })
    expect(src.guestDocNumber).toBe('N12345678')
    expect(src.guestSex).toBe('F')
  })

  it('бронь передали без обёртки — документ всё равно вырезан', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:updated', booking())
    expect(emitted[0].data.booking).not.toHaveProperty('guestDocNumber')
  })

  it('событие отмены (номер брони и комнаты) проходит как есть', () => {
    const { mod, emitted } = loadSocket()
    mod.emitBookingEvent('booking:cancelled', { bookingId: 151, roomId: 12 })
    expect(emitted[0].data).toEqual({ bookingId: 151, roomId: 12 })
  })
})
