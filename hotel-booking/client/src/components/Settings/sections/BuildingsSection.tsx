import React, { useEffect, useState } from 'react'
import { useRoomFundStore } from '../../../store/useRoomFundStore'
import { useAuthStore } from '../../../store/useAuthStore'
import { createBuilding, updateBuilding, removeBuilding, type BuildingRow } from '../../../api/roomFund'
import { formatApiError } from '../../Setup/accountRules'
import {
  SectionHeader, AddButton, EmptyBox, iconBtn, listRow, itemTitle, itemSub,
  formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn,
  StatusNote, ReadOnlyNote, VisibilityButton, PurgeButton,
} from './sectionUi'

// Объявлено ДО компонента: константа ниже по файлу падает при горячей
// перезагрузке («is not defined» — временная мёртвая зона).
const EMPTY_FORM = { name: '', description: '' }

export const BuildingsSection: React.FC = () => {
  const { buildings, loading, loaded, error: loadError, load, ensureLoaded } = useRoomFundStore()
  const { admin } = useAuthStore()
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [error, setError] = useState('')
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { ensureLoaded() }, [ensureLoaded])

  const startNew = () => { setEditId('new'); setForm(EMPTY_FORM); setError('') }
  const startEdit = (b: BuildingRow) => {
    setEditId(b.id)
    setForm({ name: b.name, description: b.description ?? '' })
    setError('')
  }

  const save = async () => {
    const name = form.name.trim()
    if (!name) { setError('Введите название корпуса'); return }
    setBusy(true); setError('')
    try {
      if (editId === 'new') {
        const created = await createBuilding({ name, description: form.description.trim(), order: buildings.length })
        setNote({ kind: 'ok', text: `Корпус «${created.name}» добавлен.` })
      } else if (typeof editId === 'number') {
        // Переименование корпуса переписывает и сами номера — сервер делает это
        // в одной транзакции и возвращает, сколько задето. Молчать об этом нельзя.
        const { item, renamedRooms } = await updateBuilding(editId, { name, description: form.description.trim() })
        setNote({
          kind: 'ok',
          text: renamedRooms > 0
            ? `Корпус переименован в «${item.name}». Обновлено номеров: ${renamedRooms}.`
            : `Корпус «${item.name}» сохранён.`,
        })
      }
      setEditId(null)
      await load()
    } catch (e) {
      setError(formatApiError(e, 'Не удалось сохранить корпус'))
    } finally {
      setBusy(false)
    }
  }

  const toggleHidden = async (b: BuildingRow) => {
    setBusy(true); setNote(null)
    try {
      if (b.isActive) {
        const r = await removeBuilding(b.id)
        setNote({
          kind: 'ok',
          text: r.usedByRooms > 0
            ? `Корпус «${b.name}» скрыт из списков. Сами номера не изменились — номеров с этим корпусом: ${r.usedByRooms}.`
            : `Корпус «${b.name}» скрыт из списков.`,
        })
      } else {
        await updateBuilding(b.id, { isActive: true })
        setNote({ kind: 'ok', text: `Корпус «${b.name}» снова в списках.` })
      }
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось изменить видимость корпуса') })
    } finally {
      setBusy(false)
    }
  }

  const purge = async (b: BuildingRow) => {
    if (!confirm(`Удалить корпус «${b.name}» насовсем? Им не пользуется ни один номер.`)) return
    setBusy(true); setNote(null)
    try {
      await removeBuilding(b.id, true)
      setNote({ kind: 'ok', text: `Корпус «${b.name}» удалён.` })
      await load()
    } catch (e) {
      setNote({ kind: 'err', text: formatApiError(e, 'Не удалось удалить корпус') })
    } finally {
      setBusy(false)
    }
  }

  const fields = (
    <>
      <div>
        <label style={labelStyle}>Название</label>
        <input
          value={form.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
          placeholder="Например: Корпус А"
          maxLength={60}
          style={inputStyle}
          autoFocus
        />
      </div>
      <div>
        <label style={labelStyle}>Описание</label>
        <input
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="Необязательно"
          maxLength={200}
          style={inputStyle}
        />
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
        title="Корпуса"
        subtitle="Список корпусов отеля. Общий для всех рабочих мест; используется при создании номеров."
        action={canEdit ? <AddButton onClick={startNew} label="Добавить корпус" /> : undefined}
      />

      {!canEdit && <ReadOnlyNote />}
      {note && <StatusNote kind={note.kind}>{note.text}</StatusNote>}
      {loadError && <StatusNote kind="err">{loadError}</StatusNote>}

      {editId === 'new' && (
        <div style={formCard}>
          <div style={formTitle}>Новый корпус</div>
          {fields}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {!loaded && loading && <EmptyBox>Загрузка…</EmptyBox>}
        {loaded && buildings.length === 0 && <EmptyBox>Корпуса не добавлены</EmptyBox>}

        {buildings.map(b => {
          const used = b.usedByRooms ?? 0
          return (
            <div key={b.id}>
              <div style={{ ...listRow, flexWrap: 'wrap', opacity: b.isActive ? 1 : 0.62 }}>
                <div style={{ flex: 1, minWidth: 150 }}>
                  <div style={itemTitle}>{b.name}</div>
                  <div style={itemSub}>
                    {used > 0 ? `Номеров с этим корпусом: ${used}` : 'Номеров нет'}
                    {b.description ? ` · ${b.description}` : ''}
                  </div>
                </div>
                {canEdit && (
                  <>
                    <VisibilityButton hidden={!b.isActive} onClick={() => toggleHidden(b)} disabled={busy} />
                    <button onClick={() => startEdit(b)} style={iconBtn} title="Переименовать">✎</button>
                    {used === 0 && <PurgeButton onClick={() => purge(b)} disabled={busy} />}
                  </>
                )}
              </div>
              {editId === b.id && (
                <div style={{ ...formCard, marginTop: 6 }}>
                  {/* Предупреждение до нажатия: правка названия тронет и номера. */}
                  {used > 0 && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>
                      Переименование обновит и сами номера. Номеров с этим корпусом: {used}.
                    </div>
                  )}
                  {fields}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
