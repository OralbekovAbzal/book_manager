import React, { useEffect, useState } from 'react'
import { useAuthStore } from '../../store/useAuthStore'

/**
 * Повторный вход ПОВЕРХ работающего приложения.
 *
 * Раньше 401 посреди работы стирал токен и перезагружал страницу: заполненная
 * форма брони с именем гостя, документом и услугами исчезала молча (аудит
 * D7-002), а на экране входа не было даже пояснения. Теперь приложение под
 * оверлеем не размонтируется — после ввода пароля пользователь возвращается
 * ровно туда, где его прервали, со всем введённым.
 *
 * Поэтому это оверлей, а не раздел: сессия — не место, а состояние. Логин не
 * спрашиваем: он известен (`admin` намеренно не обнуляется при 401), а гадать,
 * кто сейчас за стойкой, незачем — сменить человека можно кнопкой «Выйти».
 */

// ── Константы объявлены ДО компонента: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

/**
 * Выше всего в программе: под оверлеем остаются и модалки брони (до 800), и
 * меню шахматки (10000). Оверлей их перекрывает целиком — пока сессии нет,
 * ни одно действие всё равно не пройдёт.
 */
const OVERLAY_Z = 20000

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '0.92rem',
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '1.08rem',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'inherit',
  background: 'var(--bg)',
  color: 'var(--text)',
}

const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.9rem', color: 'var(--text-faint)', textDecoration: 'underline',
}

/** Текст ошибки входа: сообщение сервера как есть, отдельно — «сервер не ответил». */
function describeError(e: unknown): string {
  const err = e as { response?: { status?: number; data?: { error?: string } } } | undefined
  if (!err?.response) {
    return 'Сервер недоступен. Проверьте, что сервер запущен, и адрес подключения в настройках системы'
  }
  const serverMsg = err.response.data?.error
  if (err.response.status === 429) return serverMsg || 'Слишком много попыток входа, подождите'
  return serverMsg || 'Неверный пароль'
}

export const ReauthOverlay: React.FC = () => {
  const reauth = useAuthStore((s) => s.reauth)
  const reauthLogin = useAuthStore((s) => s.reauthLogin)
  const logout = useAuthStore((s) => s.logout)

  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Escape гасим на погружении: форма брони и просмотр брони слушают его на
  // document и закрылись бы вместе с несохранённым вводом — ровно тем, ради
  // сохранения которого этот оверлей и сделан.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation()
    }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [])

  if (!reauth) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await reauthLogin(password)
      setPassword('')
    } catch (err) {
      setError(describeError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: OVERLAY_Z,
      background: 'rgba(0,0,0,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px', overflowY: 'auto',
    }}>
      <div style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '28px 30px',
        width: '100%',
        maxWidth: 380,
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--text)',
      }}>
        <h2 style={{ margin: 0, fontSize: '1.16rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
          Сессия истекла — войдите заново
        </h2>
        <p style={{ margin: '8px 0 0', fontSize: '0.88rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
          Всё введённое сохранено: после входа вы вернётесь на то же место.
        </p>

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 18 }}>
          <div>
            <label style={labelStyle}>Логин</label>
            {/* Только чтение: меняет пользователя не этот оверлей, а «Выйти» ниже */}
            <input
              type="text"
              value={reauth.username}
              readOnly
              tabIndex={-1}
              style={{ ...inputStyle, background: 'var(--surface)', color: 'var(--text-muted)' }}
            />
          </div>
          <div>
            <label style={labelStyle}>Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              required
              style={inputStyle}
              placeholder="••••••••"
            />
            {error && (
              <div style={{
                marginTop: 8,
                padding: '8px 12px',
                background: 'rgba(204,107,107,0.10)',
                color: 'var(--s-overdue)',
                borderRadius: 6,
                fontSize: '0.9rem',
              }}>
                {error}
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '10px',
              background: loading ? 'var(--border-strong)' : 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: '1.02rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: 2,
            }}
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        <div style={{ textAlign: 'center', marginTop: 16 }}>
          {/* Не `onClick={logout}`: событие клика ушло бы в параметр `reason`.
              Причина здесь известна — сессию завершил не пользователь. */}
          <button type="button" onClick={() => logout('token_expired')} style={linkBtnStyle}>
            Выйти из программы
          </button>
        </div>
      </div>
    </div>
  )
}
