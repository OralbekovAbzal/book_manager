import React, { useEffect, useState } from 'react'
import { APP_VERSION, IS_ELECTRON, type UpdateStatus } from '../../../config'
import { SectionHeader, formCard, primaryBtn, secondaryBtn } from './sectionUi'

// Настройки → О программе: версия и обновления. Сами обновления живут в Electron
// (electron-updater, IPC update:* в main.js); в браузере раздел только информационный.

function describeStatus(s: UpdateStatus | null): string {
  if (!s) return 'Нажмите «Проверить обновления», чтобы узнать, есть ли новая версия.'
  switch (s.state) {
    case 'checking':      return 'Проверка обновлений…'
    case 'available':     return `Доступна версия ${s.version ?? ''}`.trim()
    case 'not-available': return 'Установлена последняя версия'
    case 'downloading':   return `Загрузка обновления… ${s.percent ?? 0}%`
    case 'downloaded':    return `Версия ${s.version ?? ''} загружена — можно установить`.replace('  ', ' ')
    case 'error':         return `Ошибка: ${s.error ?? 'не удалось проверить обновления'}`
    case 'unavailable':   return s.error ?? 'Обновления недоступны'
    default:              return ''
  }
}

export const AboutSection: React.FC = () => {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState(false)

  // Тихая проверка (через 30 с после старта и раз в сутки) тоже шлёт статусы сюда
  useEffect(() => {
    const unsubscribe = window.appConfig?.onUpdateStatus?.(s => setStatus(s))
    return () => { unsubscribe?.() }
  }, [])

  const check = async () => {
    const fn = window.appConfig?.checkForUpdates
    if (!fn) return
    setBusy(true)
    setStatus({ state: 'checking' })
    try {
      const r = await fn()
      if (!r.ok) setStatus({ state: r.state ?? 'error', error: r.error })
      else setStatus({ state: r.state ?? 'not-available', version: r.version })
    } catch (e) {
      setStatus({ state: 'error', error: (e as Error)?.message })
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    const fn = window.appConfig?.downloadUpdate
    if (!fn) return
    setBusy(true)
    setStatus(s => ({ state: 'downloading', percent: 0, version: s?.version }))
    try {
      const r = await fn()
      if (!r.ok) setStatus({ state: 'error', error: r.error })
      // Успех придёт событием 'downloaded' через onUpdateStatus
    } finally {
      setBusy(false)
    }
  }

  const install = async () => {
    const fn = window.appConfig?.installUpdate
    if (!fn) return
    if (!window.confirm('Установить обновление и перезапустить программу? Несохранённые формы будут закрыты.')) return
    const r = await fn()
    if (!r.ok) setStatus({ state: 'error', error: r.error })
  }

  const version = IS_ELECTRON ? (APP_VERSION || '—') : 'dev'
  const isError = status?.state === 'error' || status?.state === 'unavailable'

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionHeader title="О программе" subtitle="Версия приложения и обновления." />

      <div style={formCard}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: '1.08rem', fontWeight: 700 }}>Roomline PMS</span>
          <span className="mono" style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>версия {version}</span>
        </div>
        <div style={{ fontSize: '0.86rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
          Roomline PMS — система бронирования отеля: шахматка, брони, тарифы, касса, отчёты, справочник.
        </div>
      </div>

      <div style={formCard}>
        <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Обновления</div>
        {!IS_ELECTRON ? (
          <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Обновления доступны в установленной версии программы.
          </div>
        ) : (
          <>
            <div style={{
              fontSize: '0.9rem', lineHeight: 1.5,
              color: isError ? 'var(--s-overdue)' : 'var(--text-muted)',
            }}>
              {describeStatus(status)}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={check} disabled={busy || status?.state === 'downloading'} style={secondaryBtn}>
                Проверить обновления
              </button>
              {status?.state === 'available' && (
                <button onClick={download} disabled={busy} style={primaryBtn}>
                  Скачать
                </button>
              )}
              {status?.state === 'downloaded' && (
                <button onClick={install} style={primaryBtn}>
                  Установить и перезапустить
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
