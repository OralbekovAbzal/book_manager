/**
 * Замок версии брони («не затирай чужую правку»).
 *
 * Аудит D5-004: две стойки открыли одну бронь; пока А правила заметку, Б включила
 * питание и метку. Сохранение А уходило целиком (`services`, `flags`, счётчики) и
 * молча стирало правку Б — последний записавший выигрывал, и никто не узнавал.
 *
 * Решение — не блокировки, а сверка версии: клиент возвращает `updatedAt`, который
 * пришёл ему в ответе, и если бронь с тех пор изменилась — 409 с текущей броней,
 * чтобы форма показала расхождение, а не молча перезаписала.
 *
 * Поле необязательное: старый клиент и служебные вызовы его не шлют — им сохранение
 * работает как раньше. Замок нельзя навязать, не сломав всё, что зовёт PUT.
 */

/**
 * @param {string|Date|null|undefined} expectedUpdatedAt что клиент считает актуальной версией
 * @param {Date} existingUpdatedAt что записано в базе сейчас
 * @returns {boolean} true — бронь изменилась под руками, сохранять нельзя
 */
function isStale(expectedUpdatedAt, existingUpdatedAt) {
  // Не прислали — замка нет: это «сохраняй как раньше», а не «версия нулевая».
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null || expectedUpdatedAt === '') return false

  const expected = expectedUpdatedAt instanceof Date ? expectedUpdatedAt : new Date(expectedUpdatedAt)
  // Мусор вместо даты — считаем устаревшим. Замок обязан отказывать при
  // непонятном значении: пропустить сомнительное сохранение хуже, чем переспросить.
  if (Number.isNaN(expected.getTime())) return true

  const actual = existingUpdatedAt instanceof Date ? existingUpdatedAt : new Date(existingUpdatedAt)
  if (!actual || Number.isNaN(actual.getTime())) return true

  // Сравнение точное, до миллисекунды: Prisma DateTime хранит мс, клиент шлёт
  // обратно ISO из нашего же ответа. Допуск здесь означал бы «правку в ту же
  // секунду не замечаем» — а именно такие правки и сталкиваются.
  return expected.getTime() !== actual.getTime()
}

module.exports = { isStale }
