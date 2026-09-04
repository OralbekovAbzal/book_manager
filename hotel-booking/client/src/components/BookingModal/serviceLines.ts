import type { BookingServiceLink, Service } from '../../types'
import type { BreakdownLine } from '../../utils/calculator'

/**
 * Питание и услуги брони на стороне формы: состояние трёх блоков и предпросмотр
 * их стоимости.
 *
 * Это ПРЕДПРОСМОТР. Деньги считает сервер — `server/src/utils/charges.js` по строкам
 * `BookingService`. Правила единиц начисления продублированы здесь один в один;
 * правишь там — правь и тут, иначе форма покажет одно, а в бронь запишется другое.
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

/**
 * Предпросмотр стоимости услуг. Те же правила, что в генераторе начислений:
 * `childPrice === null` означает «считать по взрослой цене», нулевая цена строки
 * не порождает (ноль — это не цена, а незаполненный тариф).
 */
export function servicePreviewLines(
  links: ServiceLink[],
  servicesById: Map<number, Service>,
  nights: number,
): BreakdownLine[] {
  if (nights <= 0) return []
  const lines: BreakdownLine[] = []

  for (const link of links) {
    const s = servicesById.get(link.serviceId)
    if (!s || !s.isActive) continue

    const kind: 'meal' | 'extra' = s.kind === 'meal' ? 'meal' : 'extra'
    const adults = Math.max(0, link.adults || 0)
    const children = Math.max(0, link.children || 0)
    const times = Math.max(0, link.quantity ?? 1)
    const splitChildren = s.childPrice != null && children > 0
    const adultHeads = splitChildren ? adults : adults + children

    const push = (label: string, qty: number, unit: number) => {
      if (qty <= 0 || !unit || unit <= 0) return
      lines.push({ label, nights, amount: Math.round(qty * unit), kind, quantity: qty, unitPrice: unit })
    }

    const childLabel = `${s.name} (дети)`
    switch (s.unit) {
      case 'per_person_night':
        push(s.name, adultHeads * nights, s.price)
        if (splitChildren) push(childLabel, children * nights, s.childPrice!)
        break
      case 'per_night':
        push(s.name, times * nights, s.price)
        break
      case 'per_person':
        push(s.name, adultHeads, s.price)
        if (splitChildren) push(childLabel, children, s.childPrice!)
        break
      case 'per_booking':
      default:
        push(s.name, times, s.price)
        break
    }
  }

  return lines
}
