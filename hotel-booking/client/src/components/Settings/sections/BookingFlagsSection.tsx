import React, { useEffect } from 'react'
import { useSettingsStore, FlagEffects } from '../../../store/useSettingsStore'
import { fetchBookingFlags } from '../../../api/bookingFlags'
import { SectionHeader, EmptyBox } from './sectionUi'

function effectsSummary(e?: FlagEffects): string {
  if (!e) return 'Только визуальная отметка'
  const parts: string[] = []
  if (e.pin) parts.push('только этот номер')
  if (e.lockFloor) parts.push('только свой этаж')
  if (e.requireFeature) parts.push(`только: ${e.requireFeature}`)
  if (e.bufferAfter) parts.push(`буфер после ${e.bufferAfter} дн.${e.bufferAfterExceptFlag ? ' (кроме позднего заезда)' : ''}`)
  if (e.bufferBefore) parts.push(`буфер до ${e.bufferBefore} дн.`)
  return parts.join(' · ') || 'Только визуальная отметка'
}

export const BookingFlagsSection: React.FC = () => {
  const { roomFund, setRoomFund, hiddenFlagCodes, toggleFlagHidden } = useSettingsStore()
  const flags = roomFund.bookingFlags ?? []

  // Метки — готовая библиотека из БД, понимаемая алгоритмом. Здесь не редактируются.
  useEffect(() => {
    fetchBookingFlags().then(bookingFlags => setRoomFund({ bookingFlags })).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Метки броней"
        subtitle="Готовая библиотека меток, которые понимает алгоритм. Выберите, какие показывать в форме брони."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {flags.length === 0 && <EmptyBox>Метки не загружены</EmptyBox>}

        {flags.map(f => {
          const visible = !hiddenFlagCodes.includes(f.id)
          return (
            <div key={f.id} style={{
              display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
              background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border-subtle)',
              opacity: visible ? 1 : 0.6,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)' }}>{f.label}</div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: 2 }}>
                  {effectsSummary(f.effects)}
                </div>
              </div>

              {/* Тоггл видимости в форме брони */}
              <button
                type="button"
                onClick={() => toggleFlagHidden(f.id)}
                title={visible ? 'Скрыть из формы брони' : 'Показывать в форме брони'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 12px',
                  borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.8rem', fontWeight: 500,
                  border: `1px solid ${visible ? 'var(--accent)' : 'var(--border)'}`,
                  background: visible ? 'var(--accent-bg)' : 'transparent',
                  color: visible ? 'var(--accent-text)' : 'var(--text-faint)',
                }}
              >
                {visible ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 7 10 7a13 13 0 0 1-2.3 3M6.6 6.6A13 13 0 0 0 2 11s3.5 7 10 7a10 10 0 0 0 3.4-.6M2 2l20 20" />
                  </svg>
                )}
                {visible ? 'Видна' : 'Скрыта'}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
