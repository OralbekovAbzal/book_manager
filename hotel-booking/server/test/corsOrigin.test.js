import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * CORS в этом проекте — не граница безопасности (ею служит JWT в заголовке),
 * а фильтр «свой/чужой» для десктопа и локальной сети. Поэтому тут проверяется
 * ровно одно: локальные адреса рабочих мест проходят, посторонний сайт — нет.
 *
 * Отдельный случай — IPv6-петля: на Windows браузер и Vite нередко резолвят
 * `localhost` в `[::1]`, и до правки D7-001 такой Origin отвергался.
 */

// Модуль читает CLIENT_ORIGIN один раз при загрузке — грузим свежий экземпляр.
function load() {
  return loadCjs('src/utils/corsOrigin.js')
}

/** Обёртка над колбэковым API: true — разрешено, false — отказ. */
function allows(origin) {
  const { corsOrigin } = load()
  let allowed = null
  corsOrigin(origin, (err, ok) => { allowed = err ? false : ok })
  return allowed
}

describe('corsOrigin', () => {
  it('IPv6-петля [::1] разрешена — это тот же localhost', () => {
    expect(allows('http://[::1]:5173')).toBe(true)
  })

  it('localhost на нестандартном порту разрешён (клон на 5175)', () => {
    expect(allows('http://localhost:5175')).toBe(true)
  })

  it('адрес рабочего места в локальной сети разрешён', () => {
    expect(allows('http://192.168.1.5:3001')).toBe(true)
  })

  it('127.0.0.1 разрешён', () => {
    expect(allows('http://127.0.0.1:3011')).toBe(true)
  })

  it('посторонний сайт получает отказ', () => {
    expect(allows('http://evil.example')).toBe(false)
  })

  it('запрос без Origin разрешён — упакованный Electron шлёт file:// без него', () => {
    expect(allows(undefined)).toBe(true)
  })

  it('локальный префикс в чужом домене не проходит — хост закрыт границей', () => {
    expect(allows('http://localhost.evil.example')).toBe(false)
    expect(allows('http://10.evil.example')).toBe(false)
    expect(allows('http://192.168.1.5.evil.example')).toBe(false)
    expect(allows('http://192.168.1.5:5175')).toBe(true)
    expect(allows('http://10.0.0.7')).toBe(true)
  })
})
