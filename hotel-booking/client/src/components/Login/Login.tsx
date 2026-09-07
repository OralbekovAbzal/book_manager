import React, { useState } from 'react'
import { useAuthStore } from '../../store/useAuthStore'
import { IS_ELECTRON } from '../../config'

interface Props {
  /** Текст баннера над формой — например, «Сервер недоступен» при старте приложения. */
  serverError?: string
}

export const Login: React.FC<Props> = ({ serverError }) => {
  const { login, notice } = useAuthStore()
  // Состояние сервера важнее пояснения о завершённой сессии
  const banner = serverError || notice
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // «Настройки системы» (только Electron): режим хост/клиент, порт, папки данных.
  // Доступ по паролю сисадмина; проверяет его main-процесс Electron, а не сервер.
  const [sysOpen, setSysOpen] = useState(false)
  const [sysPassword, setSysPassword] = useState('')
  const [sysError, setSysError] = useState('')
  const [sysBusy, setSysBusy] = useState(false)

  const openSystemSettings = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!window.appConfig) return
    setSysError('')
    setSysBusy(true)
    try {
      const res = await window.appConfig.openSystemSettings(sysPassword)
      if (res.ok) { setSysOpen(false); setSysPassword('') }
      else setSysError(res.error || 'Неверный пароль сисадмина')
    } catch {
      setSysError('Не удалось открыть настройки системы')
    } finally {
      setSysBusy(false)
    }
  }

  const closeSystemSettings = () => { setSysOpen(false); setSysPassword(''); setSysError('') }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await login(username, password)
    } catch (err) {
      setError(describeLoginError(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--surface)',
      color: 'var(--text)',
    }}>
      <div style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '40px 36px',
        width: 360,
        boxShadow: 'var(--shadow-md)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🏨</div>
          <h1 style={{ margin: 0, fontSize: '1.54rem', fontWeight: 700, color: 'var(--text)' }}>
            Система бронирования
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: '1rem', color: 'var(--text-faint)' }}>
            Войдите в аккаунт
          </p>
        </div>

        {/* Баннер: состояние сервера (передаёт App при старте) или почему сессия закончилась */}
        {banner && (
          <div style={{
            padding: '9px 12px',
            marginBottom: 14,
            background: 'rgba(211,162,92,0.14)',
            border: '1px solid var(--s-out)',
            color: 'var(--text)',
            borderRadius: 6,
            fontSize: '0.92rem',
            lineHeight: 1.45,
          }}>
            {banner}
          </div>
        )}

        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Логин</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              style={inputStyle}
              placeholder="admin"
            />
          </div>
          <div>
            <label style={labelStyle}>Пароль</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              style={inputStyle}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div style={{
              padding: '8px 12px',
              background: 'rgba(204,107,107,0.10)',
              color: 'var(--s-overdue)',
              borderRadius: 6,
              fontSize: '1rem',
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '10px',
              background: loading ? 'var(--border-strong)' : 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontSize: '1.08rem',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              marginTop: 4,
            }}
          >
            {loading ? 'Вход...' : 'Войти'}
          </button>
        </form>

        {/* Системные настройки — только в Electron; сотрудникам отеля не нужны */}
        {IS_ELECTRON && (
          <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
            {!sysOpen ? (
              <div style={{ textAlign: 'center' }}>
                <button type="button" onClick={() => setSysOpen(true)} style={linkBtnStyle}>
                  Настройки системы
                </button>
              </div>
            ) : (
              <form onSubmit={openSystemSettings} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <label style={labelStyle}>Пароль сисадмина</label>
                  <input
                    type="password"
                    value={sysPassword}
                    onChange={(e) => setSysPassword(e.target.value)}
                    autoComplete="off"
                    autoFocus
                    style={inputStyle}
                    placeholder="••••••••"
                  />
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)', marginTop: 5, lineHeight: 1.45 }}>
                    Подключение, порт и папки данных. Для сотрудников отеля этот раздел не нужен
                  </div>
                </div>
                {sysError && (
                  <div style={{
                    padding: '6px 10px',
                    background: 'rgba(204,107,107,0.10)',
                    color: 'var(--s-overdue)',
                    borderRadius: 6,
                    fontSize: '0.92rem',
                  }}>
                    {sysError}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" onClick={closeSystemSettings} style={secondaryBtnStyle}>Отмена</button>
                  <button
                    type="submit"
                    disabled={sysBusy || !sysPassword}
                    style={{ ...primaryBtnStyle, opacity: sysBusy || !sysPassword ? 0.6 : 1 }}
                  >
                    {sysBusy ? 'Проверка…' : 'Открыть'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Текст ошибки входа: сообщение сервера как есть (401 «Неверный логин или пароль»,
 * 503 «Сервер временно недоступен…»), отдельно — нет ответа вовсе и 429 от rate-limit.
 */
function describeLoginError(e: unknown): string {
  const err = e as { response?: { status?: number; data?: { error?: string } } } | undefined
  if (!err?.response) {
    return 'Сервер недоступен. Проверьте, что сервер запущен, и адрес подключения в настройках системы'
  }
  const serverMsg = err.response.data?.error
  if (err.response.status === 429) return serverMsg || 'Слишком много попыток входа, подождите'
  return serverMsg || 'Неверный логин или пароль'
}

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

// Кнопки блока «Настройки системы»
const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
  fontSize: '0.9rem', color: 'var(--text-faint)', textDecoration: 'underline',
}

const primaryBtnStyle: React.CSSProperties = {
  height: 34, padding: '0 16px', background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 8, fontSize: '0.92rem', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
}

const secondaryBtnStyle: React.CSSProperties = {
  height: 34, padding: '0 14px', background: 'var(--bg)', border: '1px solid var(--border)',
  borderRadius: 8, fontSize: '0.92rem', cursor: 'pointer', color: 'var(--text)', fontFamily: 'inherit',
}
