import React, { useEffect, useState } from 'react'
import { useRoomFundStore } from '../../../store/useRoomFundStore'
import { useAuthStore } from '../../../store/useAuthStore'
import { createCapacity, updateCapacity, removeCapacity, type CapacityRow } from '../../../api/roomFund'
import { formatApiError } from '../../Setup/accountRules'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
  StatusNote, ReadOnlyNote, VisibilityButton, PurgeButton,
} from './sectionUi'

// Константы — ДО компонента (объявленная ниже падает при горячей перезагрузке).
const EMPTY_FORM = { label: '', value: 1 }

const guestWord = (n: number) => (n === 1 ? 'гость' : n >= 2 && n <= 4 ? 'гостя' : 'гостей')

/**
 * Заглушка, которой миграция подписала код без расшифровки: название такой
 * вместимости знал только localStorage одного ноутбука. Подсказываем, что её
 * стоит переименовать, — иначе непонятно, что это вообще такое.
 */
const isPlaceholder = (c: CapacityRow) => c.label === `Вместимость ${c.code}`

export const CapacitiesSection: React.FC = () => {
  const { capacities, loading, loaded, error: loadError, load, ensureLoaded } = useRoomFundStore()
  const { admin } = useAuthStore()
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { ensureLoaded() }, [ensureLoaded])

  const startNew = () => { setEditId('new'); setForm(EMPTY_FORM); setError('') }
  const startEdit = (c: CapacityRow) => {
    setEditId(c.id)
    setForm({ label: c.label, value: c.value })
    setError('')
  }

  const save = async () => {
    const label = form.label.trim()
    if (!label) { setError('Введите название'); return }
    if (form.value < 0 || form.value > 99) { setError('Мест — от 0 до 99'); return }
    setBusy(true); setError('')
    try {
      if (editId === 'new') {
        const created = await createCapacity({ label, value: form.value, order: capacities.length })
        setNote({ kind: 'ok', text: `Тип «${created.label}» добавлен.` })
      } else if (typeof editId === 'number') {
        // Здесь номера НЕ трогаются: они ссылаются на код вместимости, а не на
        // подпись, поэтому переименование безопасно и `renamedRooms` не бывает.
        const item = await updateCapacity(editId, { label, value: form.value })
        setNote({ kind: 'ok', text: `Тип «${item.label}» сохранён. Номера не изменились — они ссылаются на код.` })
      }
      setEditId(null)
      await load()
    } catch (e) {
      setError(formatApiError(e, 'Не удалось сохранить тип вместимости'))
    } finally {
      setBusy(false)
    }
  }

  const toggleHidden = async (c: CapacityRow) => {
    setBusy(true); setNote(null)
    try {
      if (c.isActive) {
        const r = await removeCapacity(c.id)
        setNote({
          kind: 'ok',
          text: r.usedByRooms > 0
            ? `Тип «${c.label}» скрыт. Сами номера не изменились — номеров с этой вместимостью: ${r.usedByRooms}.`
            : `Тип «${c.label}» скрыт.`,
        })
      } else {
        await updateCapacity(c.id, { isActive: true })
        setNote({ kind: 'ok', text: `Тип «${c.label}» снова в списках.` })
      }
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось изменить видимость типа') })
    } finally {
      setBusy(false)
    }
  }

  const purge = async (c: CapacityRow) => {
    if (!confirm(`Удалить тип «${c.label}» насовсем? Им не пользуется ни один номер.`)) return
    setBusy(true); setNote(null)
    try {
      await removeCapacity(c.id, true)
      setNote({ kind: 'ok', text: `Тип «${c.label}» удалён.` })
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось удалить тип вместимости') })
    } finally {
      setBusy(false)
    }
  }

  const fields = (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 12 }}>
        <div>
          <label style={labelStyle}>Название</label>
          <input
            value={form.label}
            onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
            placeholder="Например: Одноместный"
            maxLength={60}
            style={inputStyle}
            autoFocus
          />
        </div>
        <div>
          <label style={labelStyle}>Кол-во гостей</label>
          <input
            type="number" min={0} max={99}
            value={form.value}
            onChange={e => setForm(f => ({ ...f, value: Number(e.target.value) }))}
            style={inputStyle}
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
        title="Вместимость"
        subtitle="Типы вместимости номеров. Общий справочник; используется при создании и фильтрации комнат."
        action={canEdit ? <AddButton onClick={startNew} label="Добавить тип" /> : undefined}
      />

      {!canEdit && <ReadOnlyNote />}
      {note && <StatusNote kind={note.kind}>{note.text}</StatusNote>}
      {loadError && <StatusNote kind="err">{loadError}</StatusNote>}

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новый тип вместимости</div>
          {fields}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {!loaded && loading && <EmptyBox>Загрузка…</EmptyBox>}
        {loaded && capacities.length === 0 && <EmptyBox>Типы вместимости не добавлены</EmptyBox>}

        {capacities.map(c => {
          const used = c.usedByRooms ?? 0
          return (
            <div key={c.id}>
              <div style={{ ...listRow, flexWrap: 'wrap', opacity: c.isActive ? 1 : 0.62 }}>
                <div style={{
                  width: 32, height: 32, borderRadius: '50%', background: 'var(--accent-bg)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                  fontSize: '0.95rem', fontWeight: 700, color: 'var(--accent-text)',
                }} className="mono">{c.value || '?'}</div>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={itemTitle}>{c.label}</div>
                  <div style={itemSub}>
                    {c.value > 0 ? `${c.value} ${guestWord(c.value)}` : 'Мест не указано'}
                    {' · '}
                    {used > 0 ? `номеров: ${used}` : 'номеров нет'}
                  </div>
                  {isPlaceholder(c) && (
                    <div style={{ ...itemSub, color: 'var(--s-overdue)' }}>
                      Название не переносилось с рабочего места — переименуйте.
                    </div>
                  )}
                </div>
                {canEdit && (
                  <>
                    <VisibilityButton hidden={!c.isActive} onClick={() => toggleHidden(c)} disabled={busy} />
                    <button onClick={() => startEdit(c)} style={iconBtn} title="Переименовать">✎</button>
                    {used === 0 && <PurgeButton onClick={() => purge(c)} disabled={busy} />}
                  </>
                )}
              </div>
              {editId === c.id && <div style={{ ...formCard, marginTop: 6 }}>{fields}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
