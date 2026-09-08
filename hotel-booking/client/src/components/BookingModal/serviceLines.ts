import type { BookingServiceLink, Service } from '../../types'

/**
 * Питание и услуги брони на стороне формы: состояние трёх блоков.
 *
 * Денег здесь НЕТ. Стоимость услуг считает сервер и присылает готовыми строками
 * в предпросмотре (`POST /bookings/preview`). Своя копия правил начисления жила
 * здесь до волны 5a и расходилась с сервером (аудит D7-009): «Полный пансион» на
 * экране и в базе давал разные суммы. Осталось состояние галочек и число едоков —
 * это ввод формы, а не расчёт.
 */

/** Одна подключённая услуга в состоянии формы. */
export interface ServiceLink {
  serviceId: number
  /** Сколько взрослых пользуется услугой (для per_person / per_person_night) */
  adults: number
  children: number
  /** Сколько раз (для per_night / per_booking) */
  quantity: number
  /**
   * Число едоков задано руками. Пока false — оно едет за счётчиками гостей:
   * добавил третьего взрослого, а завтрак остался на двоих — это не «уменьшили
   * питание», это забыли его поправить, и такой счёт потом не сходится.
   */
  custom: boolean
}

/** Услуга считается «по головам», а не по количеству раз. */
export function isPerPerson(unit: string): boolean {
  return unit === 'per_person' || unit === 'per_person_night'
}

/** Полный состав гостей — им по умолчанию и начисляется услуга. */
export interface GuestTotals {
  adults: number
  children: number
  extraBeds: number
}

/**
 * Сколько человек по умолчанию пользуется услугой: все гости.
 * Доп. место — такой же едок, как взрослый (и по взрослой цене): в старом
 * калькуляторе оно тоже шло отдельным слагаемым, а не частью счётчика взрослых.
 */
export function defaultHeads(guests: GuestTotals): { adults: number; children: number } {
  return { adults: guests.adults + guests.extraBeds, children: guests.children }
}

export function newLink(serviceId: number, guests: GuestTotals): ServiceLink {
  const heads = defaultHeads(guests)
  return { serviceId, adults: heads.adults, children: heads.children, quantity: 1, custom: false }
}

/** Строки брони с сервера → состояние формы. Всё, что пришло, считаем заданным руками. */
export function linksFromBooking(services: BookingServiceLink[] | undefined): ServiceLink[] {
  return (services ?? []).map(s => ({
    serviceId: s.serviceId,
    adults: s.adults ?? 0,
    children: s.children ?? 0,
    quantity: s.quantity ?? 1,
    custom: true,
  }))
}

/** Что подставить в НОВУЮ бронь: услуги с «включено в тариф» на всех гостей. */
export function defaultLinks(services: Service[], guests: GuestTotals): ServiceLink[] {
  return services
    .filter(s => s.isActive && s.includedByDefault)
    .map(s => newLink(s.id, guests))
}

/**
 * Ключ набора услуг: изменилось ли питание с момента загрузки брони.
 * Порядок строк не значим — сортируем, иначе перестановка выглядела бы изменением.
 */
export function linksKey(links: ServiceLink[]): string {
  return [...links]
    .sort((a, b) => a.serviceId - b.serviceId)
    .map(l => `${l.serviceId}:${l.adults}:${l.children}:${l.quantity}`)
    .join('|')
}

/** Наружу, на сервер, уезжает только то, что он понимает — без служебного `custom`. */
export function linksToPayload(links: ServiceLink[]) {
  return links.map(l => ({
    serviceId: l.serviceId,
    adults: Math.max(0, Math.round(l.adults || 0)),
    children: Math.max(0, Math.round(l.children || 0)),
    quantity: Math.max(0, l.quantity || 0),
  }))
}

/**
 * Пересчитывает число едоков у строк, которых администратор не трогал руками.
 * Возвращает тот же массив, если менять нечего — иначе useEffect зациклится.
 */
export function syncLinksWithGuests(
  links: ServiceLink[],
  servicesById: Map<number, Service>,
  guests: GuestTotals,
): ServiceLink[] {
  const heads = defaultHeads(guests)
  let changed = false
  const next = links.map(l => {
    const svc = servicesById.get(l.serviceId)
    if (l.custom || !svc || !isPerPerson(svc.unit)) return l
    if (l.adults === heads.adults && l.children === heads.children) return l
    changed = true
    return { ...l, adults: heads.adults, children: heads.children }
  })
  return changed ? next : links
}
