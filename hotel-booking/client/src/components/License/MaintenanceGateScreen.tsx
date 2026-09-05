import React from 'react'
import { useAuthStore } from '../../store/useAuthStore'
import { useLicenseStore } from '../../store/useLicenseStore'
import { LicenseKeyForm, formatIsoRu } from './licenseUi'

/**
 * Экран блокировки: сервер закрыт гейтом обслуживания и отвечает 402 на всё,
 * кроме входа и лицензии. Показывается ВМЕСТО приложения — это не раздел
 * (`section`) и не модалка: под гейтом приложения нет вообще, и рисовать шапку
 * с меню разделов, которые все до одного получат 402, было бы обманом.
 *
 * Порядок в App такой: сначала гейт, потом заставка/мастер/вход. До входа
 * показывается обычный экран входа с текстом сервера в баннере — ключ примет
 * только SUPER_ADMIN (POST /api/license), значит сперва нужно войти.
 *
 * Выход работает: `logout()` чисто клиентский, на сервер не ходит, — иначе из-под
 * гейта нельзя было бы сменить пользователя на главного администратора.
 */

const cardStyle: React.CSSProperties = {
  width: 460, maxWidth: '92vw',
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12,
  padding: '32px 30px', boxShadow: 'var(--shadow-md)',
  display: 'flex', flexDirection: 'column', gap: 16,
}

const factRow: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', gap: 14,
  padding: '6px 0', fontSize: '0.86rem',
}

export const MaintenanceGateScreen: React.FC = () => {
  const block = useLicenseStore(s => s.block)
  const admin = useAuthStore(s => s.admin)
  const logout = useAuthStore(s => s.logout)
  if (!block) return null

  const canEdit = admin?.role === 'SUPER_ADMIN'

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, background: 'var(--surface)', color: 'var(--text)', overflowY: 'auto',
    }}>
      <div style={cardStyle}>
        <div>
          <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 10 }}>🔑</div>
          <h1 style={{ margin: 0, fontSize: '1.32rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
            Обслуживание закончилось
          </h1>
        </div>

        {/* Текст сервера как есть — он один и тот же в логах и на экране */}
        <div style={{ fontSize: '0.92rem', lineHeight: 1.55, color: 'var(--text-muted)' }}>
          {block.message}
        </div>

        <div style={{ borderTop: '1px solid var(--border-subtle)', borderBottom: '1px solid var(--border-subtle)', padding: '4px 0' }}>
          <div style={factRow}>
            <span style={{ color: 'var(--text-faint)' }}>Обслуживание оплачено до</span>
            <span>{formatIsoRu(block.maintenanceUntil)}</span>
          </div>
          <div style={factRow}>
            <span style={{ color: 'var(--text-faint)' }}>Эта версия выпущена</span>
            <span>{formatIsoRu(block.buildDate)}</span>
          </div>
        </div>

        <LicenseKeyForm canEdit={canEdit} autoFocus={canEdit} />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingTop: 4, borderTop: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
            {admin ? `${admin.name} · вход выполнен` : ''}
          </span>
          <button
            type="button"
            onClick={logout}
            style={{
              height: 32, padding: '0 14px', background: 'transparent', border: '1px solid var(--border)',
              borderRadius: 8, fontSize: '0.84rem', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Выйти
          </button>
        </div>
      </div>
    </div>
  )
}
