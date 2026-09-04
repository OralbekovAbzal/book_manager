import type { SetupCompletePayload } from '../../api/setup'
import { sameUsername, validateName, validatePassword, validateUsername } from './accountRules'

// Модель данных мастера первичной настройки: формы шагов, их проверка,
// сборка тела запроса и расшифровка ошибок сервера по полям.

export interface HotelForm { name: string; city: string }
export interface AdminForm { name: string; username: string; password: string; passwordConfirm: string }
export type StaffRole = 'ADMIN' | 'STAFF'
export interface StaffDraft { key: string; name: string; username: string; password: string; role: StaffRole }
export type StaffInput = Omit<StaffDraft, 'key'>

export type FieldErrors<T> = Partial<Record<keyof T, string>>

export const emptyHotel = (): HotelForm => ({ name: '', city: '' })
// Логин главного администратора по умолчанию — «admin»
export const emptyAdmin = (): AdminForm => ({ name: '', username: 'admin', password: '', passwordConfirm: '' })
export const emptyStaff = (): StaffInput => ({ name: '', username: '', password: '', role: 'STAFF' })

export const newStaffKey = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

export function validateHotel(h: HotelForm): FieldErrors<HotelForm> {
  const e: FieldErrors<HotelForm> = {}
  if (!h.name.trim()) e.name = 'Введите название отеля'
  else if (h.name.trim().length > 120) e.name = 'Слишком длинное название (до 120 символов)'
  if (h.city.trim().length > 80) e.city = 'Слишком длинное название города (до 80 символов)'
  return e
}

/** Главный администратор; логин не должен совпадать с логинами уже добавленных сотрудников. */
export function validateAdmin(a: AdminForm, staff: StaffDraft[]): FieldErrors<AdminForm> {
  const e: FieldErrors<AdminForm> = {}
  const nameErr = validateName(a.name)
  if (nameErr) e.name = nameErr

  const userErr = validateUsername(a.username)
  if (userErr) e.username = userErr
  else if (staff.some(s => sameUsername(s.username, a.username))) e.username = 'Такой логин уже есть у сотрудника'

  const passErr = validatePassword(a.password)
  if (passErr) e.password = passErr
  else if (a.password !== a.passwordConfirm) e.passwordConfirm = 'Пароли не совпадают'
  return e
}

/** Сотрудник; логин уникален среди администратора и остальных сотрудников. */
export function validateStaff(s: StaffInput, admin: AdminForm, others: StaffDraft[]): FieldErrors<StaffInput> {
  const e: FieldErrors<StaffInput> = {}
  const nameErr = validateName(s.name)
  if (nameErr) e.name = nameErr

  const userErr = validateUsername(s.username)
  if (userErr) e.username = userErr
  else if (sameUsername(s.username, admin.username)) e.username = 'Этот логин занят главным администратором'
  else if (others.some(o => sameUsername(o.username, s.username))) e.username = 'Такой логин уже добавлен'

  const passErr = validatePassword(s.password)
  if (passErr) e.password = passErr
  return e
}

export function buildPayload(h: HotelForm, a: AdminForm, staff: StaffDraft[]): SetupCompletePayload {
  const city = h.city.trim()
  return {
    hotel: { name: h.name.trim(), ...(city ? { city } : {}) },
    mainAdmin: { username: a.username.trim(), name: a.name.trim(), password: a.password },
    ...(staff.length
      ? { users: staff.map(s => ({ username: s.username.trim(), name: s.name.trim(), password: s.password, role: s.role })) }
      : {}),
  }
}

const FIELD_LABELS: Record<string, string> = {
  'hotel.name': 'Название отеля',
  'hotel.city': 'Город',
  'mainAdmin.name': 'Имя главного администратора',
  'mainAdmin.username': 'Логин главного администратора',
  'mainAdmin.password': 'Пароль главного администратора',
}

const STAFF_FIELD_LABELS: Record<string, string> = { name: 'имя', username: 'логин', password: 'пароль', role: 'роль' }

/** Понятное имя поля из details сервера: hotel.name, mainAdmin.username, users[0].password, users.0.password … */
export function describeField(field: string | undefined, staff: StaffDraft[]): string {
  if (!field) return 'Поле'
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  const m = field.match(/^users[.[](\d+)\]?\.(\w+)$/)
  if (m) {
    const idx = Number(m[1])
    const who = staff[idx]?.name || `№${idx + 1}`
    return `Сотрудник ${who} — ${STAFF_FIELD_LABELS[m[2]] ?? m[2]}`
  }
  return field
}
