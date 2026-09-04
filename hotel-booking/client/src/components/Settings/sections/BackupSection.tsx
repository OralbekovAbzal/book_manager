import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { useAuthStore } from '../../../store/useAuthStore'
import { fetchCategories, createCategory } from '../../../api/categories'
import { fetchAllRooms, createRoom } from '../../../api/roomsAdmin'
import { fetchBackups, createBackup, restoreBackup } from '../../../api/system'
import type { RoomFundConfig } from '../../../store/useSettingsStore'
import type { BackupsInfo } from '../../../types'
import { formatApiError } from '../../Setup/accountRules'
import { SectionHeader } from './sectionUi'

interface Bundle {
  type: 'room-fund-backup'
  version: number
  exportedAt: string
  roomFund: RoomFundConfig
  categories: { name: string; color: string; description?: string }[]
  rooms: {
    number: string; building: string; floor: number
    features: string[]; capacity: string; categoryName: string; isActive: boolean
  }[]
}

export const BackupSection: React.FC = () => {
  const { roomFund, setRoomFund } = useSettingsStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  // ─── Экспорт ──────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    setBusy(true); setStatus(null)
    try {
      const [cats, rooms] = await Promise.all([fetchCategories(), fetchAllRooms({})])
      const bundle: Bundle = {
        type: 'room-fund-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        roomFund,
        categories: cats.map(c => ({ name: c.name, color: c.color, description: c.description })),
        rooms: rooms.map(r => ({
          number: r.number,
          building: r.building,
          floor: r.floor,
          features: r.features ?? [],
          capacity: r.capacity ?? '',
          categoryName: r.category.name,
          isActive: r.isActive,
        })),
      }
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().slice(0, 10)
      a.href = url
      a.download = `номерной-фонд-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setStatus({ kind: 'ok', text: `Сохранено: ${cats.length} категорий, ${rooms.length} номеров + справочники.` })
    } catch {
      setStatus({ kind: 'err', text: 'Не удалось создать резервную копию.' })
    } finally {
      setBusy(false)
    }
  }

  // ─── Импорт ───────────────────────────────────────────────────────────────────
  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) { setPendingFile(f); setStatus(null) }
    e.target.value = ''  // позволяем выбрать тот же файл повторно
  }

  const runImport = async () => {
    if (!pendingFile) return
    setBusy(true); setStatus(null)
    try {
      const bundle = JSON.parse(await pendingFile.text()) as Bundle
      if (!bundle || !Array.isArray(bundle.categories) || !Array.isArray(bundle.rooms)) {
        throw new Error('bad format')
      }

      // 1. Справочники (корпуса, особенности, вместимость, метки) → в настройки браузера
      if (bundle.roomFund) setRoomFund(bundle.roomFund)

      // 2. Категории — создаём недостающие (по имени), строим карту имя→id
      const existingCats = await fetchCategories()
      const nameToId = new Map(existingCats.map(c => [c.name, c.id]))
      for (const c of bundle.categories) {
        if (!nameToId.has(c.name)) {
          const created = await createCategory({ name: c.name, color: c.color, description: c.description })
          nameToId.set(c.name, created.id)
        }
      }

      // 3. Номера — создаём недостающие (по номеру)
      const existingRooms = await fetchAllRooms({})
      const existingNumbers = new Set(existingRooms.map(r => r.number.toUpperCase()))
      let created = 0, skipped = 0
      for (const r of bundle.rooms) {
        const categoryId = nameToId.get(r.categoryName)
        if (!categoryId) { skipped++; continue }
        if (existingNumbers.has(String(r.number).toUpperCase())) { skipped++; continue }
        await createRoom({
          number: r.number, categoryId,
          building: r.building, floor: r.floor,
          features: r.features ?? [], capacity: r.capacity ?? '',
        })
        existingNumbers.add(String(r.number).toUpperCase())
        created++
      }

      setPendingFile(null)
      setStatus({
        kind: 'ok',
        text: `Восстановлено: ${created} номеров создано${skipped ? `, ${skipped} пропущено (уже существуют)` : ''}. Справочники обновлены.`,
      })
    } catch {
      setStatus({ kind: 'err', text: 'Не удалось прочитать файл. Проверьте, что это копия номерного фонда.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SectionHeader
        title="Резервные копии"
        subtitle="Копии базы данных на сервере и файл номерного фонда для переноса между установками."
      />

      {/* Копии базы данных — сервер, вся база целиком */}
      <DbBackups />

      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: '1.08rem', fontWeight: 700 }}>Номерной фонд отдельным файлом</div>
        <div style={{ fontSize: '0.86rem', color: 'var(--text-faint)', marginTop: 4 }}>
          Только категории, номера, корпуса, особенности и метки — для переноса фонда на другую установку.
        </div>
      </div>

      {/* Экспорт */}
      <div style={cardStyle}>
        <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 4 }}>Скачать копию</div>
        <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          Создаст файл <code>номерной-фонд-ГГГГ-ММ-ДД.json</code> со всеми данными фонда.
          Храните его в надёжном месте (облако, флешка).
        </div>
        <button onClick={handleExport} disabled={busy} style={primaryBtn}>
          ⬇ Скачать резервную копию
        </button>
      </div>

      {/* Импорт */}
      <div style={cardStyle}>
        <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 4 }}>Восстановить из файла</div>
        <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 }}>
          Загрузит категории и номера, которых ещё нет, и обновит справочники.
          Существующие номера (по номеру) <strong>не дублируются</strong> и не перезаписываются.
        </div>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={onFilePicked} style={{ display: 'none' }} />
        {!pendingFile ? (
          <button onClick={() => fileRef.current?.click()} disabled={busy} style={secondaryBtn}>
            📂 Выбрать файл копии…
          </button>
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8,
          }}>
            <span style={{ fontSize: '0.95rem', flex: 1, minWidth: 0, wordBreak: 'break-all' }}>
              📄 {pendingFile.name}
            </span>
            <button onClick={runImport} disabled={busy} style={primaryBtn}>
              {busy ? 'Восстановление…' : 'Восстановить'}
            </button>
            <button onClick={() => setPendingFile(null)} disabled={busy} style={secondaryBtn}>
              Отмена
            </button>
          </div>
        )}
      </div>

      {status && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5,
          background: status.kind === 'ok' ? 'var(--accent-bg)' : 'var(--surface-2)',
          color: status.kind === 'ok' ? 'var(--s-in)' : 'var(--s-overdue)',
          border: `1px solid ${status.kind === 'ok' ? 'var(--s-in)' : 'var(--s-overdue)'}`,
        }}>
          {status.text}
        </div>
      )}
    </div>
  )
}

// ─── Копии базы данных ─────────────────────────────────────────────────────────
// Сервер пишет JSON-дамп всех таблиц (ночью в 03:00 и по кнопке) в свою папку копий.
// Смотреть и создавать могут SUPER_ADMIN и ADMIN, восстанавливать — только SUPER_ADMIN.

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Текст ошибки API; HTML-страницу (404 от сервера без этого маршрута) не показываем
function apiMessage(e: unknown, fallback: string): string {
  const text = formatApiError(e, fallback)
  return /<\/?[a-z!]/i.test(text) ? fallback : text
}

const DbBackups: React.FC = () => {
  const { admin } = useAuthStore()
  const canView = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'
  const canRestore = admin?.role === 'SUPER_ADMIN'

  const [info, setInfo] = useState<BackupsInfo | null>(null)
  const [loading, setLoading] = useState(true)
  // 'create' — идёт создание копии; имя файла — идёт восстановление из него
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setInfo(await fetchBackups())
    } catch (e) {
      setStatus({ kind: 'err', text: apiMessage(e,'Не удалось загрузить список копий') })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (canView) load()
    else setLoading(false)
  }, [canView, load])

  if (!canView) {
    return (
      <div style={cardStyle}>
        <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 4 }}>Резервные копии базы</div>
        <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)' }}>Доступно администраторам.</div>
      </div>
    )
  }

  const handleCreate = async () => {
    setBusy('create'); setStatus(null)
    try {
      const r = await createBackup()
      setStatus({ kind: 'ok', text: `Копия создана: ${r.filename} (${formatSize(r.size)}).` })
      await load()
    } catch (e) {
      setStatus({ kind: 'err', text: apiMessage(e,'Не удалось создать копию') })
    } finally {
      setBusy(null)
    }
  }

  const handleRestore = async (name: string) => {
    const ok = window.confirm(
      `Восстановить базу из файла ${name}?\n\n` +
      'Восстановление заменит ВСЕ текущие данные (брони, номера, пользователи, настройки) ' +
      'содержимым этого файла. Перед этим будет автоматически сделана копия текущего состояния.\n\n' +
      'Если вашей учётной записи нет в копии, после восстановления потребуется войти ' +
      'под учётной записью из копии.',
    )
    if (!ok) return
    setBusy(name); setStatus(null)
    try {
      const r = await restoreBackup(name)
      setStatus({
        kind: 'ok',
        text: `Восстановлено из ${name}: броней ${r.restored.Booking ?? 0}, номеров ${r.restored.Room ?? 0}, ` +
          `пользователей ${r.restored.Admin ?? 0}. Копия прежнего состояния: ${r.safetyBackup}.`,
      })
      await load()
    } catch (e) {
      setStatus({ kind: 'err', text: apiMessage(e,'Не удалось восстановить копию') })
    } finally {
      setBusy(null)
    }
  }

  const last = info?.last ?? null

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: '1.08rem', fontWeight: 700, marginBottom: 4 }}>Резервные копии базы</div>
          <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Вся база целиком: брони, номера, тарифы, пользователи, справочник. Ночная копия — автоматически в 03:00.
          </div>
        </div>
        <button onClick={handleCreate} disabled={busy !== null} style={primaryBtn}>
          {busy === 'create' ? 'Создание…' : 'Сделать копию сейчас'}
        </button>
      </div>

      {/* Последняя копия: когда и удалась ли */}
      <div style={{
        marginTop: 12, padding: '8px 12px', borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5,
        background: 'var(--surface-2)',
        color: !last ? 'var(--text-faint)' : last.success ? 'var(--s-in)' : 'var(--s-overdue)',
      }}>
        {loading && !info ? 'Загрузка…'
          : !last ? 'Копий ещё не было.'
          : last.success
            ? `Последняя копия: ${formatDateTime(last.createdAt)} — успешно, ${formatSize(last.size)}.`
            : `Последняя попытка: ${formatDateTime(last.createdAt)} — ошибка${last.error ? `: ${last.error}` : ''}.`}
      </div>

      {/* Файлы копий на сервере */}
      {info && info.files.length > 0 && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {info.files.map(f => (
            <div key={f.name} style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px',
              borderRadius: 8, border: '1px solid var(--border-subtle)', background: 'var(--bg)',
            }}>
              <span className="mono" style={{ flex: 1, minWidth: 0, fontSize: '0.85rem', wordBreak: 'break-all' }}>{f.name}</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{formatDateTime(f.createdAt)}</span>
              <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)', whiteSpace: 'nowrap', minWidth: 52, textAlign: 'right' }}>{formatSize(f.size)}</span>
              {canRestore && (
                <button onClick={() => handleRestore(f.name)} disabled={busy !== null} style={{ ...secondaryBtn, padding: '5px 10px', fontSize: '0.82rem' }}>
                  {busy === f.name ? 'Восстановление…' : 'Восстановить'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {info && info.files.length === 0 && !loading && (
        <div style={{ marginTop: 10, fontSize: '0.86rem', color: 'var(--text-faint)' }}>
          В папке копий пока нет файлов.
        </div>
      )}

      {status && (
        <div style={{
          marginTop: 12, padding: '10px 14px', borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5,
          background: status.kind === 'ok' ? 'var(--accent-bg)' : 'var(--surface-2)',
          color: status.kind === 'ok' ? 'var(--s-in)' : 'var(--s-overdue)',
          border: `1px solid ${status.kind === 'ok' ? 'var(--s-in)' : 'var(--s-overdue)'}`,
        }}>
          {status.text}
        </div>
      )}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  padding: 16, background: 'var(--surface)',
  border: '1px solid var(--border)', borderRadius: 10,
}
const primaryBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--ui-radius)', fontSize: 'inherit', fontWeight: 600, cursor: 'pointer',
}
const secondaryBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'transparent', border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)', fontSize: 'inherit', cursor: 'pointer', color: 'var(--text)',
}
