import React, { useEffect, useState } from 'react'
import { useRoomFundStore } from '../../../store/useRoomFundStore'
import { useAuthStore } from '../../../store/useAuthStore'
import { createFeature, updateFeature, removeFeature, type FeatureRow } from '../../../api/roomFund'
import { formatApiError } from '../../Setup/accountRules'
import {
  SectionHeader, AddButton, EmptyBox, formCard, formTitle,
  inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
  StatusNote, ReadOnlyNote, VisibilityButton,
} from './sectionUi'

// Константы — ДО компонента: объявленная ниже падает при горячей перезагрузке
// («is not defined», временная мёртвая зона).
const EMPTY_FORM = { name: '', emoji: '' }
const FALLBACK_EMOJI = '✦'

const chipIconBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.8rem',
  color: 'var(--text-faint)', padding: '1px 2px', borderRadius: 3, lineHeight: 1,
}

export const FeaturesSection: React.FC = () => {
  const { features, loading, loaded, error: loadError, load, ensureLoaded } = useRoomFundStore()
  const { admin } = useAuthStore()
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { ensureLoaded() }, [ensureLoaded])

  const startNew = () => { setEditId('new'); setForm(EMPTY_FORM); setError('') }
  const startEdit = (f: FeatureRow) => {
    setEditId(f.id)
    setForm({ name: f.name, emoji: f.emoji ?? '' })
    setError('')
  }

  const save = async () => {
    const name = form.name.trim()
    if (!name) { setError('Введите название'); return }
    const emoji = form.emoji.trim() || FALLBACK_EMOJI
    setBusy(true); setError('')
    try {
      if (editId === 'new') {
        const created = await createFeature({ name, emoji, order: features.length })
        setNote({ kind: 'ok', text: `Особенность «${created.name}» добавлена.` })
      } else if (typeof editId === 'number') {
        // Особенность лежит в номере НАЗВАНИЕМ, поэтому переименование сервер
        // делает вместе с номерами и возвращает, сколько задето.
        const { item, renamedRooms } = await updateFeature(editId, { name, emoji })
        setNote({
          kind: 'ok',
          text: renamedRooms > 0
            ? `Особенность переименована в «${item.name}». Обновлено номеров: ${renamedRooms}.`
            : `Особенность «${item.name}» сохранена.`,
        })
      }
      setEditId(null)
      await load()
    } catch (e) {
      setError(formatApiError(e, 'Не удалось сохранить особенность'))
    } finally {
      setBusy(false)
    }
  }

  const toggleHidden = async (f: FeatureRow) => {
    setBusy(true); setNote(null)
    try {
      if (f.isActive) {
        const r = await removeFeature(f.id)
        setNote({
          kind: 'ok',
          text: r.usedByRooms > 0
            ? `Особенность «${f.name}» скрыта. Сами номера не изменились — номеров с этой особенностью: ${r.usedByRooms}.`
            : `Особенность «${f.name}» скрыта.`,
        })
      } else {
        await updateFeature(f.id, { isActive: true })
        setNote({ kind: 'ok', text: `Особенность «${f.name}» снова в списках.` })
      }
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось изменить видимость особенности') })
    } finally {
      setBusy(false)
    }
  }

  const purge = async (f: FeatureRow) => {
    if (!confirm(`Удалить особенность «${f.name}» насовсем? Ею не пользуется ни один номер.`)) return
    setBusy(true); setNote(null)
    try {
      await removeFeature(f.id, true)
      setNote({ kind: 'ok', text: `Особенность «${f.name}» удалена.` })
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось удалить особенность') })
    } finally {
      setBusy(false)
    }
  }

  const editing = typeof editId === 'number' ? features.find(f => f.id === editId) : null
  const editingUsed = editing?.usedByRooms ?? 0

  const fields = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: 12 }}>
        <div>
          <label style={labelStyle}>Эмодзи</label>
          <input
            value={form.emoji}
            onChange={e => setForm(f => ({ ...f, emoji: e.target.value }))}
            placeholder={FALLBACK_EMOJI}
            maxLength={4}
            style={{ ...inputStyle, textAlign: 'center', fontSize: '1.2rem' }}
          />
        </div>
        <div>
          <label style={labelStyle}>Название</label>
          <input
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="Например: Балкон"
            maxLength={60}
            style={inputStyle}
            autoFocus
          />
        </div>
      </div>
      {error && <div style={errorStyle}>{error}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={() => setEditId(null)} style={secondaryBtn} disabled={busy}>Отмена</button>
        <button onClick={save} style={primaryBtn} disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить'}</button>
      </div>
    </>
  )

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Особенности"
        subtitle="Удобства номеров. Общий справочник; отображается при выборе характеристик комнаты."
        action={canEdit ? <AddButton onClick={startNew} label="Добавить особенность" /> : undefined}
      />

      {!canEdit && <ReadOnlyNote />}
      {note && <StatusNote kind={note.kind}>{note.text}</StatusNote>}
      {loadError && <StatusNote kind="err">{loadError}</StatusNote>}

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новая особенность</div>
          {fields}
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {!loaded && loading && <EmptyBox>Загрузка…</EmptyBox>}
        {loaded && features.length === 0 && <EmptyBox>Особенности не добавлены</EmptyBox>}

        {features.map(f => {
          const used = f.usedByRooms ?? 0
          return (
            <div key={f.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 12px',
              background: 'var(--surface)', borderRadius: 20, border: '1px solid var(--border-subtle)',
              opacity: f.isActive ? 1 : 0.62,
            }}>
              <span style={{ fontSize: '1.1rem' }}>{f.emoji ?? FALLBACK_EMOJI}</span>
              <span style={{ fontSize: '0.88rem', color: 'var(--text)', fontWeight: 500 }}>{f.name}</span>
              <span
                style={{ fontSize: '0.75rem', color: 'var(--text-faint)' }}
                title={used > 0 ? `Номеров с этой особенностью: ${used}` : 'Ни у одного номера не стоит'}
              >{used}</span>
              {canEdit && (
                <>
                  <VisibilityButton hidden={!f.isActive} onClick={() => toggleHidden(f)} disabled={busy} compact />
                  <button onClick={() => startEdit(f)} style={chipIconBtn} title="Переименовать">✎</button>
                  {used === 0 && (
                    <button
                      onClick={() => purge(f)}
                      disabled={busy}
                      style={{ ...chipIconBtn, color: 'var(--s-overdue)' }}
                      title="Удалить насовсем — этой особенности нет ни у одного номера"
                    >✕</button>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      {/* Форма правки — отдельным блоком под списком: чипы стоят в ряд,
          вставлять карточку внутрь ряда некуда. */}
      {editing && (
        <div style={{ ...formCard, marginTop: 12 }}>
          <div style={formTitle}>Редактировать особенность</div>
          {editingUsed > 0 && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
              Переименование обновит и сами номера. Номеров с этой особенностью: {editingUsed}.
            </div>
          )}
          {fields}
        </div>
      )}
    </div>
  )
}
