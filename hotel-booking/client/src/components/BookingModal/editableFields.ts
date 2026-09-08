import type { Booking } from '../../types'
import { linksFromBooking, linksKey } from './serviceLines'

/**
 * ЧТО ФОРМА БРОНИ СЧИТАЕТ «СВОИМ» — и как понять, тронул ли эти поля кто-то другой.
 *
 * Зачем этот файл вообще есть. Бронь меняет не только форма: приём оплаты,
 * возврат, правка строк начислений — всё это на сервере трогает `updatedAt` той
 * же брони. Замок версии (`expectedUpdatedAt`) об этом не знает и честно отвечает
 * 409 «изменена на другом рабочем месте» на собственную оплату администратора,
 * принятую двумя минутами раньше в этой же форме. Отличить своё событие от
 * чужого по содержимому сокета нельзя — автора в нём нет; раньше здесь стояло
 * окно «3 секунды после своей операции», и оно ловило только совсем быстрое эхо.
 *
 * Поэтому форма при любом изменении брони ТИХО перечитывает её и сравнивает со
 * снимком, который показала пользователю. Сравниваются ровно те поля, которые
 * форма редактирует и отправляет в PUT: если изменились только деньги —
 * предупреждать не о чем, версию можно молча обновить. Изменилось хоть одно
 * «своё» поле — жёлтая полоса и отказ сохранять, пока форму не перечитают.
 *
 * Список полей = тело PUT из `submitValues` (BookingModal.tsx). Чего здесь
 * намеренно НЕТ:
 *   - `totalAmount` / `prepaidAmount` / `paidAmount` — форма их не отправляет с
 *     волны 5a: итог считает сервер по строкам, «оплачено» — журнал платежей;
 *   - `partnerId` — форма партнёра не выбирает (квота = предупреждение);
 *   - `allotmentOverride`, `shiftId`, `accountBookingId` — служебные, не поля ввода.
 * `status` в списке ЕСТЬ, хотя в PUT не уходит: он решает, можно ли бронь вообще
 * править (у отменённой и выехавшей форма только для чтения). Сосед, оформивший
 * выезд или отмену, обязан быть замечен.
 *
 * Все константы и функции объявлены ДО использования: объявленная ниже падает
 * при горячей перезагрузке с «is not defined» (грабля проекта, ловили дважды).
 */

// ── Документ гостя ──────────────────────────────────────────────────────────
// Живёт здесь, а не в форме: это тоже «поля, которые форма правит и отправляет»,
// и сравнение обязано нормализовать их ровно так же, как это делает ввод.

export interface DocFields {
  guestCitizenship: string
  guestDocType: string
  guestDocNumber: string
  guestDocExpiry: string
  guestBirthDate: string
  guestSex: string
}

export const EMPTY_DOC: DocFields = {
  guestCitizenship: '', guestDocType: '', guestDocNumber: '',
  guestDocExpiry: '', guestBirthDate: '', guestSex: '',
}

/**
 * Бронь → поля формы. Даты РЕЖЕМ строкой: `guestDocExpiry` и `guestBirthDate` —
 * это `@db.Date`, и сервер отдаёт их полным ISO ('1988-11-30T00:00:00.000Z').
 * Разбор в местную зону сдвинул бы день рождения на 29 ноября (грабля проекта).
 */
export const docFromBooking = (b: Partial<Booking>): DocFields => ({
  guestCitizenship: b.guestCitizenship ?? '',
  guestDocType: b.guestDocType ?? '',
  guestDocNumber: b.guestDocNumber ?? '',
  guestDocExpiry: (b.guestDocExpiry ?? '').slice(0, 10),
  guestBirthDate: (b.guestBirthDate ?? '').slice(0, 10),
  guestSex: b.guestSex ?? '',
})

const num = (v: number | null | undefined) => Number(v ?? 0)

/** Одно сравниваемое поле: подпись для человека и «отпечаток» значения строкой. */
interface EditableField {
  /** Как поле называется на экране — попадает в отчёт `changedEditableFields`. */
  label: string
  of: (b: Booking) => string
}

/**
 * Отпечатки берём строками, а не сравниваем объекты: набор услуг и метки
 * приходят в произвольном порядке, и перестановка не должна выглядеть правкой.
 */
const EDITABLE_FIELDS: EditableField[] = [
  { label: 'номер',    of: b => String(b.roomId) },
  { label: 'гость',    of: b => (b.guestName ?? '').trim() },
  { label: 'телефон',  of: b => (b.guestPhone ?? '').trim() },
  // Даты — `@db.Date`, сервер отдаёт их полным ISO. Сравниваем день, как и форма.
  { label: 'заезд',    of: b => (b.checkIn ?? '').slice(0, 10) },
  { label: 'выезд',    of: b => (b.checkOut ?? '').slice(0, 10) },
  { label: 'источник', of: b => b.source ?? '' },
  { label: 'заметка',  of: b => b.notes ?? '' },
  // Гости: форма показывает ТРИ счётчика, а в базе их шесть (старое деление
  // «с питанием / без питания»). Складываем так же, как `applyCalcFields`, —
  // иначе перекладывание из колонки в колонку читалось бы как правка состава.
  {
    label: 'гости',
    of: b => [
      num(b.adultsWithMeals) + num(b.adultsNoMeals),
      num(b.childrenWithMeals) + num(b.childrenNoMeals),
      num(b.extraBedsWithMeals) + num(b.extraBedsNoMeals),
    ].join('/'),
  },
  { label: 'льготные',   of: b => `${num(b.disabledAdults)}/${num(b.disabledChildren)}` },
  { label: 'скидка',     of: b => String(num(b.discountPercent)) },
  // Умолчание то же, что в форме: 50 %.
  { label: 'предоплата', of: b => String(b.prepaymentPercent ?? 50) },
  { label: 'метки',      of: b => [...(b.flags ?? [])].sort().join('|') },
  // Питание и услуги: тот же ключ, которым форма отличает «набор изменился».
  { label: 'питание и услуги', of: b => linksKey(linksFromBooking(b.services)) },
  {
    label: 'документ',
    of: b => {
      const d = docFromBooking(b)
      return (Object.keys(EMPTY_DOC) as (keyof DocFields)[]).map(k => d[k]).join('|')
    },
  },
  // Фактические заезд/выезд форма правит и отправляет (а кнопки «Заезд»/«Выезд»
  // на соседнем месте их проставляют) — значит, это тоже её поле.
  {
    label: 'фактическое время',
    of: b => `${b.actualCheckInAt ?? ''}|${b.actualCheckOutAt ?? ''}`,
  },
  // Не уходит в PUT, но решает, можно ли править бронь вообще, — см. шапку файла.
  { label: 'статус', of: b => b.status },
]

/**
 * Какие «свои» поля разошлись между снимком формы и свежей бронью с сервера.
 * Возвращает подписи изменившихся полей — пустой массив означает «изменились
 * только деньги и прочее, что форма не редактирует».
 */
export function changedEditableFields(snapshot: Booking, fresh: Booking): string[] {
  return EDITABLE_FIELDS
    .filter(f => f.of(snapshot) !== f.of(fresh))
    .map(f => f.label)
}

/** Короткий ответ на единственный вопрос формы: «под руками что-то уехало?» */
export function editableFieldsChanged(snapshot: Booking, fresh: Booking): boolean {
  return EDITABLE_FIELDS.some(f => f.of(snapshot) !== f.of(fresh))
}
