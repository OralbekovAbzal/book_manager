import React, { useEffect, useState, useCallback } from 'react'
import {
  fetchSnapshots, createSnapshot, restoreSnapshot, deleteSnapshot,
  type Snapshot, type SnapshotKind,
} from '../../api/snapshots'
import { useGridStore } from '../../store/useGridStore'

interface Props {
  open: boolean
  onClose: () => void
}

const KIND_META: Record<SnapshotKind, { label: string; icon: string; color: string }> = {
  shift:  { label: 'Старт смены',  icon: '🔄', color: '#6366f1' },
  manual: { label: 'Вручную',      icon: '📌', color: '#0891b2' },
  auto:   { label: 'Авто',         icon: '•',  color: '#9ca3af' },
  safety: { label: 'Перед откатом', icon: '🛟', color: '#d97706' },
}

function formatWhen(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export const SnapshotsModal: React.FC<Props> = ({ open, onClose }) => {
  const { fetchGrid, fetchToday } = useGridStore()
  const [snapshots, setSnapshots] = useState<Snapshot[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmTarget, setConfirmTarget] = useState<Snapshot | null>(null)
  const [toast, setToast] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSnapshots(await fetchSnapshots())
    } catch {
      setError('Не удалось загрузить список снимков')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (open) load() }, [open, load])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose, busy])

  if (!open) return null

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3000)
  }

  const handleManual = async () => {
    setBusy(true); setError('')
    try {
      await createSnapshot('Ручной снимок')
      await load()
      showToast('Снимок создан')
    } catch {
      setError('Не удалось создать снимок')
    } finally { setBusy(false) }
  }

  const handleRestore = async (snap: Snapshot) => {
    setBusy(true); setError('')
    try {
      const res = await restoreSnapshot(snap.id)
      setConfirmTarget(null)
      await Promise.all([fetchGrid(), fetchToday()])
      await load()
      showToast(`Восстановлено броней: ${res.restored}${res.skipped ? `, пропущено: ${res.skipped}` : ''}`)
    } catch {
      setError('Не удалось восстановить снимок')
    } finally { setBusy(false) }
  }

  const handleDelete = async (snap: Snapshot) => {
    setBusy(true); setError('')
    try {
      await deleteSnapshot(snap.id)
      await load()
    } catch {
      setError('Не удалось удалить снимок')
    } finally { setBusy(false) }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        zIndex: 450, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: '90vw', maxWidth: 640, height: '85vh',
        background: 'var(--bg)', color: 'var(--text)',
        borderRadius: 14, border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '18px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>История и откат</div>
            <div style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginTop: 2 }}>
              Точки восстановления состояния броней
            </div>
          </div>
          <button onClick={onClose} disabled={busy} style={closeBtnStyle}>✕</button>
        </div>

        {/* Toolbar */}
        <div style={{
          padding: '12px 22px', borderBottom: '1px solid var(--border-subtle)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <button onClick={handleManual} disabled={busy} style={primaryBtnStyle}>
            📌 Создать снимок сейчас
          </button>
          <button onClick={load} disabled={busy} style={secondaryBtnStyle}>Обновить</button>
          {toast && (
            <span style={{ marginLeft: 'auto', fontSize: '0.9rem', color: '#059669', fontWeight: 600 }}>
              {toast}
            </span>
          )}
        </div>

        {error && (
          <div style={{ padding: '10px 22px', background: '#fef2f2', color: '#dc2626', fontSize: '0.9rem' }}>
            {error}
          </div>
        )}

        {/* List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 22px' }}>
          {loading ? (
            <div style={{ color: 'var(--text-faint)', padding: 20 }}>Загрузка…</div>
          ) : snapshots.length === 0 ? (
            <div style={{ color: 'var(--text-faint)', textAlign: 'center', padding: 40 }}>
              Снимков пока нет. Они создаются автоматически при изменении броней и в начале смены.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {snapshots.map(s => {
                const meta = KIND_META[s.kind]
                return (
                  <div key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '11px 14px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                  }}>
                    <span title={meta.label} style={{
                      width: 30, height: 30, flexShrink: 0, borderRadius: 8,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: `${meta.color}22`, color: meta.color, fontSize: '1rem',
                    }}>{meta.icon}</span>

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.98rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', marginTop: 1 }}>
                        {formatWhen(s.createdAt)} · {s.bookingCount} броней
                        <span style={{ color: meta.color, fontWeight: 600 }}> · {meta.label}</span>
                      </div>
                    </div>

                    <button onClick={() => setConfirmTarget(s)} disabled={busy} style={restoreBtnStyle}>
                      Восстановить
                    </button>
                    <button onClick={() => handleDelete(s)} disabled={busy} title="Удалить снимок" style={trashBtnStyle}>
                      🗑
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Confirm restore */}
      {confirmTarget && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setConfirmTarget(null) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
            zIndex: 460, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <div style={{
            width: '90vw', maxWidth: 440, background: 'var(--bg)', color: 'var(--text)',
            borderRadius: 12, border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', padding: 24,
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: '#fffbeb', color: '#d97706',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem',
              }}>⟲</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '1.12rem', fontWeight: 700, marginBottom: 6 }}>
                  Откатить к этому снимку?
                </div>
                <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Все текущие брони будут заменены состоянием из снимка{' '}
                  <strong style={{ color: 'var(--text)' }}>«{confirmTarget.label}»</strong>{' '}
                  ({confirmTarget.bookingCount} броней).
                  Перед откатом автоматически сохранится снимок текущего состояния, так что действие можно отменить.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 22 }}>
              <button onClick={() => setConfirmTarget(null)} disabled={busy} style={secondaryBtnStyle}>
                Отмена
              </button>
              <button onClick={() => handleRestore(confirmTarget)} disabled={busy} style={confirmRestoreBtnStyle}>
                {busy ? 'Восстановление…' : 'Восстановить'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer',
  fontSize: '1.3rem', color: 'var(--text-faint)', lineHeight: 1, padding: '0 4px',
}
const primaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const secondaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}
const restoreBtnStyle: React.CSSProperties = {
  padding: '6px 12px', background: 'var(--accent-bg)', color: 'var(--accent-text)',
  border: '1px solid var(--accent)', borderRadius: 'var(--ui-radius)',
  fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', flexShrink: 0,
}
const trashBtnStyle: React.CSSProperties = {
  padding: '6px 9px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: '0.9rem', cursor: 'pointer', flexShrink: 0,
}
const confirmRestoreBtnStyle: React.CSSProperties = {
  padding: '8px 18px', background: '#d97706', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
