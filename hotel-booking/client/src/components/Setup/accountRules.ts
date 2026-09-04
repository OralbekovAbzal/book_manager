import type { AdminRole, ApiFieldError } from '../../types'

// Правила для учётных записей — одни и те же в мастере первичной настройки
// и в разделе «Настройки → Пользователи». Сервер проверяет то же самое.

export const USERNAME_MIN = 3
export const USERNAME_MAX = 30
export const PASSWORD_MIN = 10
/** bcrypt считает только первые 72 байта — всё, что длиннее, молча отбрасывается. */
export const PASSWORD_MAX = 72

const USERNAME_RE = /^[A-Za-z0-9._-]+$/
const HAS_LETTER = /\p{L}/u
const HAS_DIGIT = /\p{Nd}/u

/** Подсказка под полем «Пароль» — один текст на все формы. */
export const PASSWORD_HINT = `Не менее ${PASSWORD_MIN} символов, буквы и цифры`

export const ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Главный администратор',
  ADMIN: 'Администратор',
  STAFF: 'Сотрудник',
}

/** Текст ошибки или пустая строка, если логин корректен. */
export function validateUsername(value: string): string {
  const v = value.trim()
  if (!v) return 'Введите логин'
  if (v.length < USERNAME_MIN || v.length > USERNAME_MAX) return `Логин — от ${USERNAME_MIN} до ${USERNAME_MAX} символов`
  if (!USERNAME_RE.test(v)) return 'Логин: латинские буквы, цифры и символы . _ -'
  return ''
}

/**
 * Проверка НОВОГО пароля. Применяется только там, где пароль ЗАДАЁТСЯ
 * (мастер первого запуска, создание пользователя, сброс пароля, смена пароля),
 * и никогда на экране входа: иначе владелец со старым коротким паролем
 * не сможет войти в свою же систему.
 *
 * Зеркало на сервере: server/src/utils/passwordPolicy.js — тексты совпадают
 * дословно, правку делать в обоих файлах.
 */
export function validatePassword(value: string): string {
  if (!value) return 'Введите пароль'   // на сервере тот же случай — «Пароль обязателен»
  const problems = passwordProblems(value)
  return problems.length ? `Пароль не подходит: ${problems.join('; ')}` : ''
}

/** Список претензий к паролю — перечисляем ИМЕННО то, что не так. */
export function passwordProblems(value: string): string[] {
  if (!value) return ['введите пароль']

  const problems: string[] = []
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

export function validateName(value: string): string {
  if (!value.trim()) return 'Введите имя'
  return ''
}

/** Логины сравниваем без учёта регистра — так их обычно и вводят при входе. */
export function sameUsername(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export interface ParsedApiError {
  message: string
  details: ApiFieldError[]
  /** HTTP-статус; null — ответа не было (сеть, сервер не запущен). */
  status: number | null
}

/**
 * Разбор ошибки axios в человекочитаемый вид. Сервер отвечает { error, details? }
 * либо (rate-limit) строкой; без ответа — сервер недоступен.
 */
export function parseApiError(e: unknown, fallback = 'Ошибка запроса'): ParsedApiError {
  const err = e as { response?: { status?: number; data?: unknown } } | undefined
  if (!err?.response) return { message: 'Сервер недоступен', details: [], status: null }

  const status = err.response.status ?? null
  const data = err.response.data
  if (typeof data === 'string' && data.trim()) return { message: data, details: [], status }

  const body = (data ?? {}) as { error?: unknown; message?: unknown; details?: unknown }
  const message =
    typeof body.error === 'string' ? body.error
    : typeof body.message === 'string' ? body.message
    : fallback
  const details = Array.isArray(body.details)
    ? (body.details as unknown[]).filter(
        (d): d is ApiFieldError => !!d && typeof d === 'object' && typeof (d as ApiFieldError).message === 'string',
      )
    : []
  return { message, details, status }
}

/** Одной строкой: сообщение + детали по полям (для простых форм). */
export function formatApiError(e: unknown, fallback = 'Ошибка запроса'): string {
  const { message, details } = parseApiError(e, fallback)
  if (!details.length) return message
  return `${message}: ${details.map(d => d.message).join('; ')}`
}
