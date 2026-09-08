/**
 * Поля документа гостя — один список на весь сервер.
 *
 * Раньше список жил в bookingController рядом с местами, где документ пишут.
 * Вынесен сюда, потому что читателей у него стало двое: контроллер (пишет поля)
 * и сокет (обязан их ВЫРЕЗАТЬ). Пока список был приватным для контроллера,
 * добавить седьмое поле и забыть про рассылку было делом одной строки —
 * а обнаружилось бы это паспортом в broadcast'е на все рабочие места.
 */
const GUEST_DOC_FIELDS = [
  'guestCitizenship', 'guestDocType', 'guestDocNumber',
  'guestDocExpiry', 'guestBirthDate', 'guestSex',
]

/**
 * Копия объекта без полей документа.
 * Копия, а не delete по месту: тот же объект брони уходит в HTTP-ответ
 * запросившему (у него право на документ есть) — портить его нельзя.
 * Неглубокая: вложенные объекты (room, category) документов не несут.
 */
function stripGuestDoc(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (!GUEST_DOC_FIELDS.includes(k)) out[k] = v
  }
  return out
}

/**
 * Есть ли в объекте хоть одно поле документа.
 * `undefined` — «поле не передавали» (частичный PUT из шахматки шлёт своё
 * подмножество), а явный `null` — «документ очистили», и это тоже документ:
 * такую правку надо заметить. Та же граница, что у guestDocUpdateData
 * в bookingController.
 */
function hasGuestDoc(obj) {
  if (!obj || typeof obj !== 'object') return false
  return GUEST_DOC_FIELDS.some((f) => obj[f] !== undefined)
}

module.exports = { GUEST_DOC_FIELDS, stripGuestDoc, hasGuestDoc }
