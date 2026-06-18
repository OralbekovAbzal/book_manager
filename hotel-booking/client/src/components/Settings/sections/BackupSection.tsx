import React, { useRef, useState } from 'react'
import { useSettingsStore } from '../../../store/useSettingsStore'
import { fetchCategories, createCategory } from '../../../api/categories'
import { fetchAllRooms, createRoom } from '../../../api/roomsAdmin'
import type { RoomFundConfig } from '../../../store/useSettingsStore'

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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 600 }}>
      <header>
        <div style={{ fontSize: '1.38rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em' }}>
          Резервная копия фонда
        </div>
        <div style={{ fontSize: '1rem', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
          Сохраните весь номерной фонд в один файл: категории, номера, корпуса, этажи,
          особенности, вместимость и метки. В случае чего — восстановите за пару секунд,
          не вводя всё заново.
        </div>
      </header>

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
          padding: '10px 14px', borderRadius: 8, fontSize: '0.95rem', lineHeight: 1.5,
          background: status.kind === 'ok' ? '#ecfdf5' : '#fef2f2',
          color: status.kind === 'ok' ? '#047857' : '#dc2626',
          border: `1px solid ${status.kind === 'ok' ? '#a7f3d0' : '#fecaca'}`,
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
