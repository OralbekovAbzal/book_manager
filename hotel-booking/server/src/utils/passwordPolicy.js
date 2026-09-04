// Единственный источник правды по паролям на сервере.
// Правило применяется ТОЛЬКО при ЗАДАНИИ пароля (смена, создание пользователя,
// сброс пароля, мастер первого запуска) и НИКОГДА при входе — иначе владелец
// со старым коротким паролем не сможет войти в свою же систему.
//
// Зеркало на клиенте: client/src/components/Setup/accountRules.ts
// (тексты ошибок совпадают дословно — правку делать в обоих файлах).

const PASSWORD_MIN = 10
// bcrypt использует только первые 72 байта; всё, что длиннее, молча отбрасывается.
const PASSWORD_MAX = 72

const HAS_LETTER = /\p{L}/u
const HAS_DIGIT = /\p{Nd}/u

/** Список претензий к паролю (пустой — пароль подходит). */
function passwordProblems(value) {
  if (typeof value !== 'string' || value.length === 0) return ['пароль обязателен']

  const problems = []
  if (value.length < PASSWORD_MIN) {
    problems.push(`нужно не менее ${PASSWORD_MIN} символов (сейчас ${value.length})`)
  } else if (value.length > PASSWORD_MAX) {
    problems.push(`не более ${PASSWORD_MAX} символов (сейчас ${value.length})`)
  }
  if (!HAS_LETTER.test(value)) problems.push('нет ни одной буквы')
  if (!HAS_DIGIT.test(value)) problems.push('нет ни одной цифры')
  if (value.trim() !== value) problems.push('пробелы в начале или в конце')
  return problems
}

/**
 * Текст ошибки или пустая строка. Перечисляет ИМЕННО то, что не так,
 * чтобы пользователь не гадал, чего от него хотят.
 */
function passwordError(value) {
  if (typeof value !== 'string' || value.length === 0) return 'Пароль обязателен'
  const problems = passwordProblems(value)
  return problems.length ? `Пароль не подходит: ${problems.join('; ')}` : ''
}

/**
 * Правило express-validator для любого поля с новым паролем.
 * Используется в routes/auth.js, routes/users.js и routes/setup.js.
 */
function passwordRule(body, field) {
  return body(field)
    .isString().withMessage('Пароль обязателен').bail()
    .custom((value) => {
      const err = passwordError(value)
      if (err) throw new Error(err)
      return true
    })
}

module.exports = { PASSWORD_MIN, PASSWORD_MAX, passwordProblems, passwordError, passwordRule }
