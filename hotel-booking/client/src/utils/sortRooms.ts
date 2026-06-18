// Натуральная сортировка номеров: корпус → этаж → номер.
// «numeric: true» сравнивает числовые фрагменты как числа, поэтому
// «2/3Х» идёт раньше «10/5Х», а не наоборот (как при строковом сравнении).

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Натуральное сравнение двух строк (учитывает все числовые и буквенные части). */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a ?? '', b ?? '')
}

interface RoomLike {
  building: string
  floor: number
  number: string
}

/** Компаратор номеров: сначала корпус, потом этаж, потом сам номер — все натурально. */
export function compareRooms(a: RoomLike, b: RoomLike): number {
  if (a.building !== b.building) return naturalCompare(a.building, b.building)
  if (a.floor !== b.floor) return a.floor - b.floor
  return naturalCompare(a.number, b.number)
}
