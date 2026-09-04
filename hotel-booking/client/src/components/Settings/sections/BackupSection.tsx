import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../../../store/useAuthStore'
import { useRoomFundStore } from '../../../store/useRoomFundStore'
import { fetchCategories, createCategory } from '../../../api/categories'
import { fetchAllRooms, createRoom } from '../../../api/roomsAdmin'
import {
  fetchBackups, createBackup, restoreBackup, fetchBackupImpact, readRestoreFailure,
  type BackupImpact, type RestoreAssessment, type BackupRestoreResult,
} from '../../../api/system'
import { importRoomFund, type RoomFundImportPayload } from '../../../api/roomFund'
import type { BackupsInfo, BackupFile } from '../../../types'
import { formatApiError } from '../../Setup/accountRules'
import { SectionHeader } from './sectionUi'
import {
  MoneyImpactRow, ConsentCheckbox, formatMoney, trimApiHint,
  impactBoxStyle, impactRowStyle, impactNameStyle, impactValueStyle,
  restoreErrorBoxStyle, dangerBtnStyle, confirmBtnStyle,
} from '../../ui/restoreUi'

/**
 * Файл переноса номерного фонда.
 *
 * `roomFund` здесь остаётся, но смысл у него другой: это больше НЕ настройка
 * браузера, а выгрузка серверного справочника. Форма записей нарочно та же, в
 * какой справочник лежал в localStorage (`id` = code), — благодаря этому
 * старые файлы копий читаются без конвертации, а восстановление просто отдаёт
 * этот блок в `POST /api/room-fund/import` (идемпотентный и только добавляющий).
 * Метки броней в файл не кладём: они и раньше приезжали из БД, а при
 * восстановлении локальная копия всё равно затиралась загрузкой с сервера.
 */
interface Bundle {
  type: 'room-fund-backup'
  version: number
  exportedAt: string
  roomFund: RoomFundImportPayload
  categories: { name: string; color: string; description?: string }[]
  rooms: {
    number: string; building: string; floor: number
    features: string[]; capacity: string; categoryName: string; isActive: boolean
  }[]
}

export const BackupSection: React.FC = () => {
  // Справочник этому экрану нужен только в момент выгрузки, поэтому читаем его
  // из стора по требованию (getState), а не подписываемся на каждое изменение.
  const { ensureLoaded, load: reloadRoomFund } = useRoomFundStore()
  useEffect(() => { ensureLoaded() }, [ensureLoaded])
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)

  // ─── Экспорт ──────────────────────────────────────────────────────────────────
  const handleExport = async () => {
    setBusy(true); setStatus(null)
    try {
      // Справочник приезжает асинхронно. Успел нажать «Скачать» до загрузки —
      // дожидаемся, иначе в файл попадёт пустой блок справочников.
      if (!useRoomFundStore.getState().loaded) await reloadRoomFund()
      const { buildings, features, capacities } = useRoomFundStore.getState()
      const [cats, rooms] = await Promise.all([fetchCategories(), fetchAllRooms({})])
      const bundle: Bundle = {
        type: 'room-fund-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        // Выгружаем и скрытые записи: скрытие — это решение пользователя, а не
        // удаление, и переносить фонд без них значит потерять часть справочника.
        roomFund: {
          buildings: buildings.map(b => ({ id: b.code, name: b.name, description: b.description ?? '' })),
          features: features.map(f => ({ id: f.code, name: f.name, emoji: f.emoji ?? '' })),
          capacities: capacities.map(c => ({ id: c.code, label: c.label, value: c.value })),
        },
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

      // 1. Справочники (корпуса, особенности, вместимости) — на СЕРВЕР, а не в
      //    localStorage: они больше не настройка рабочего места. Импорт только
      //    добавляет и заполняет пустое, поэтому чужой файл не затрёт правки.
      let fundText = ''
      if (bundle.roomFund) {
        const r = await importRoomFund(bundle.roomFund)
        const added = r.buildings.created + r.features.created + r.capacities.created
        fundText = added > 0
          ? ` В справочник добавлено записей: ${added}.`
          : ' Справочник уже содержал всё из файла.'
        await reloadRoomFund()
      }

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
        text: `Восстановлено: ${created} номеров создано${skipped ? `, ${skipped} пропущено (уже существуют)` : ''}.${fundText}`,
      })
    } catch (e) {
      // Отдельно показываем ответ сервера: чаще всего это 403 «нет прав»
      // (справочник теперь общий, его правят только администраторы).
      const parsed = (e as { response?: unknown })?.response
        ? formatApiError(e, 'Не удалось восстановить номерной фонд')
        : 'Не удалось прочитать файл. Проверьте, что это копия номерного фонда.'
      setStatus({ kind: 'err', text: parsed })
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
          Только категории, номера и справочники (корпуса, особенности, вместимости) — для переноса фонда
          на другую установку. Справочники берутся с сервера и туда же возвращаются: настройкой рабочего
          места они больше не являются.
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
          Загрузит категории и номера, которых ещё нет, и дополнит справочники на сервере.
          Существующие номера (по номеру) <strong>не дублируются</strong> и не перезаписываются;
          справочник только пополняется — уже введённые названия файл не затирает.
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

// ── Всё, что нужно окну подтверждения, объявлено ДО компонента: объявленная ниже
// константа падает при горячей перезагрузке с «is not defined» (временная мёртвая
// зона). Ловили дважды.

/**
 * Имена таблиц сервер отдаёт как в схеме (`RoomCapacity`, `BookingService`) —
 * пользователю они ничего не говорят, поэтому в СВОДКЕ подписываем по-русски.
 * В готовом тексте предупреждения от сервера они остаются как есть: этот текст
 * мы не переписываем, потому что состав и цифры в нём должны в точности
 * совпадать с тем, что сервер реально сделает.
 * Таблица, которой здесь нет (появится новая), показывается своим именем —
 * лучше непонятное слово, чем молча пропавшая строка.
 */
const TABLE_RU: Record<string, string> = {
  Admin: 'Пользователи',
  Allotment: 'Квоты партнёров',
  AuditLog: 'Журнал действий',
  Booking: 'Брони',
  BookingCharge: 'Начисления',
  BookingFlag: 'Метки броней',
  BookingService: 'Услуги в бронях',
  Building: 'Корпуса',
  Category: 'Категории номеров',
  Contact: 'Справочник контактов',
  HotelSettings: 'Данные отеля',
  License: 'Лицензия',
  MealPlan: 'Планы питания',
  Partner: 'Партнёры',
  Payment: 'Платежи',
  RatePrice: 'Календарь цен',
  Release: 'Релизы квот',
  ReportDefinition: 'Отчёты',
  Room: 'Номера',
  RoomCapacity: 'Вместимости',
  RoomFeature: 'Особенности номеров',
  Service: 'Справочник услуг',
  Shift: 'Смены',
}

/** Строки «вернётся N», которые стоит показать поимённо: остальное — хвост из мелких справочников. */
const HEADLINE_TABLES = ['Booking', 'Room', 'Admin']

function tableLabel(name: string): string {
  return TABLE_RU[name] ?? name
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Текст галочки согласия — называет цену вопроса цифрами, а не «данные будут потеряны». */
function consentLabel(a: RestoreAssessment): string {
  const parts: string[] = []
  if ((a.payments?.lost ?? 0) > 0) {
    parts.push(`платежей ${a.payments!.lost} на ${formatMoney(a.payments!.lostAmount)}`)
  }
  if (a.emptiedTables.length > 0) {
    const rows = a.emptiedTables.reduce((s, t) => s + t.rows, 0)
    parts.push(`${a.emptiedTables.length} таблиц целиком (записей ${rows})`)
  }
  if (a.unknownTables.length > 0) {
    parts.push(`данные таблиц, которых нет в этой версии программы (${a.unknownTables.join(', ')})`)
  }
  return `Понимаю: будет стёрто ${parts.join(' и ')} — восстановить их будет нечем`
}

function describeRestoreResult(name: string, r: BackupRestoreResult): string {
  const rows = r.restored ?? {}
  let text = `Восстановлено из ${name}: броней ${rows.Booking ?? 0}, номеров ${rows.Room ?? 0}, `
    + `пользователей ${rows.Admin ?? 0}.`
  if (r.lostPayments > 0) {
    text += ` Стёрто платежей: ${r.lostPayments} (${formatMoney(r.lostPaymentsAmount)}).`
  }
  if (r.emptiedTables.length > 0) {
    text += ` Очищены таблицы: ${r.emptiedTables.map(tableLabel).join(', ')}.`
  }
  text += ` Копия прежнего состояния: ${r.safetyBackup}.`
  return text
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

  // ── Окно подтверждения восстановления ──────────────────────────────────────
  const [confirmFile, setConfirmFile] = useState<BackupFile | null>(null)
  const [impact, setImpact] = useState<BackupImpact | null>(null)
  const [impactLoading, setImpactLoading] = useState(false)
  const [dialogError, setDialogError] = useState('')
  /** Сводка, пришедшая вместе с отказом 409 — она свежее той, что показали до клика */
  const [refusal, setRefusal] = useState<RestoreAssessment | null>(null)
  const [agreed, setAgreed] = useState(false)
  /** Счётчик попыток: им перезапускаем запрос сводки после сбоя или отказа */
  const [impactAttempt, setImpactAttempt] = useState(0)

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

  // Последствия спрашиваем ДО подтверждения: что вернётся, сколько платежей
  // исчезнет и какие таблицы файл очистит целиком. Иначе пользователь узнаёт об
  // этом только из отказа — а по единственной копии на диске (старый формат)
  // отказ был бы тупиком: подтвердить его из интерфейса раньше было нечем.
  useEffect(() => {
    if (!confirmFile) return
    let cancelled = false
    setImpact(null); setRefusal(null); setDialogError(''); setAgreed(false); setImpactLoading(true)
    fetchBackupImpact(confirmFile.name)
      .then(res => { if (!cancelled) setImpact(res) })
      .catch(err => {
        if (cancelled) return
        setDialogError(readRestoreFailure(err, 'Не удалось получить сводку последствий').message)
      })
      .finally(() => { if (!cancelled) setImpactLoading(false) })
    return () => { cancelled = true }
  }, [confirmFile, impactAttempt])

  // Esc закрывает сначала окно подтверждения. Слушатель в фазе ПЕРЕХВАТА:
  // SettingsPanel тоже слушает Esc на document (закрыть раздел), и без перехвата
  // одно нажатие закрывало бы и окно, и весь раздел разом.
  useEffect(() => {
    if (!confirmFile) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      // Пока идёт восстановление, закрывать нечего: операция уже в базе
      if (busy === null) setConfirmFile(null)
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [confirmFile, busy])

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

  const handleRestore = async (file: BackupFile, allowDataLoss: boolean) => {
    setBusy(file.name); setStatus(null); setDialogError('')
    try {
      const r = await restoreBackup(file.name, { allowDataLoss })
      setConfirmFile(null)
      setStatus({ kind: 'ok', text: describeRestoreResult(file.name, r) })
      await load()
    } catch (e) {
      // Текст сервера объясняет причину лучше любой нашей заглушки, а сводку
      // последствий он прикладывает прямо к отказу 409 — показываем и её.
      // Окно не закрываем: закрыть его — значит потерять объяснение.
      const failure = readRestoreFailure(e, 'Не удалось восстановить копию')
      setDialogError(failure.message)
      if (failure.impact) {
        setRefusal(failure.impact)
        setAgreed(false)
      }
    } finally {
      setBusy(null)
    }
  }

  const last = info?.last ?? null
  // Сводка из отказа свежее той, что показали до клика (сосед мог принять оплату)
  const assessment: RestoreAssessment | null = refusal ?? impact
  const needsConsent = assessment?.requiresConfirmation === true
  const restoring = confirmFile !== null && busy === confirmFile.name
  const canSubmit = busy === null && !!assessment && (!needsConsent || agreed)
  // Готовый текст отказа от сервера показываем, пока не пришла ошибка посвежее
  const showWarning = needsConsent && !!impact?.warning && !dialogError

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
                <button onClick={() => setConfirmFile(f)} disabled={busy !== null} style={{ ...secondaryBtn, padding: '5px 10px', fontSize: '0.82rem' }}>
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

      {/* Кнопки восстановления у обычного администратора нет вовсе: сервер
          пускает сюда только главного (SUPER_ADMIN), и клик уводил бы в 403
          без объяснений. Поэтому объясняем словами. */}
      {!canRestore && info && info.files.length > 0 && (
        <div style={{ marginTop: 10, fontSize: '0.86rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
          Восстановление из копии доступно только главному администратору.
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

      {/* Подтверждение восстановления — тот же диалог, что у отката к снимку:
          сводка последствий, текст сервера и галочка осознанного согласия.
          Второе обычное «ОК» здесь не годится: его жмут не читая, а цена
          ошибки — вся касса. */}
      {confirmFile && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget && busy === null) setConfirmFile(null) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 600,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          }}
        >
          <div style={{
            width: '100%', maxWidth: 560, maxHeight: '86vh', overflowY: 'auto',
            background: 'var(--bg)', color: 'var(--text)', borderRadius: 12,
            border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', padding: 24,
          }}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
              <div style={{
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0,
                background: needsConsent ? 'var(--surface-2)' : 'var(--accent-bg)',
                color: needsConsent ? 'var(--s-overdue)' : '#d97706',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem',
              }}>{needsConsent ? '⚠' : '⟲'}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '1.12rem', fontWeight: 700, marginBottom: 6 }}>
                  Восстановить базу из этой копии?
                </div>
                <div style={{ fontSize: '0.92rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  Все текущие данные — брони, номера, тарифы, пользователи, справочник —
                  будут заменены содержимым файла{' '}
                  <strong style={{ color: 'var(--text)', wordBreak: 'break-all' }}>{confirmFile.name}</strong>
                  {' '}от {formatWhen(confirmFile.createdAt)}. Перед этим автоматически сохранится
                  копия текущего состояния. Если вашей учётной записи нет в копии, после
                  восстановления придётся войти под учётной записью из неё.
                </div>
              </div>
            </div>

            {impactLoading && (
              <div style={{ ...impactBoxStyle, color: 'var(--text-faint)' }}>Считаем последствия…</div>
            )}

            {impact && assessment && !impactLoading && (
              // Счётчики берём из `assessment`, а не из `impact`: после отказа 409
              // сервер прикладывает пересчитанную сводку, и она свежее показанной
              // до клика. Сводка, разошедшаяся с фактом, хуже её отсутствия.
              // Из `impact` — только «сколько вернётся»: это свойство файла.
              <div style={impactBoxStyle}>
                {HEADLINE_TABLES.map(t => (
                  <div key={t} style={impactRowStyle}>
                    <span style={impactNameStyle}>{tableLabel(t)}</span>
                    <span style={impactValueStyle}>вернётся <strong>{impact.rows[t] ?? 0}</strong></span>
                  </div>
                ))}
                <MoneyImpactRow name="Начисления" data={assessment.charges} />
                <MoneyImpactRow name="Платежи" data={assessment.payments} />
                <MoneyImpactRow name="Услуги в бронях" data={assessment.services} />

                {assessment.emptiedTables.length > 0 && (
                  <div style={{ ...impactRowStyle, alignItems: 'flex-start' }}>
                    <span style={impactNameStyle}>Файл очистит целиком</span>
                    <span style={{ ...impactValueStyle, color: 'var(--s-overdue)', fontWeight: 600 }}>
                      {assessment.emptiedTables.map(t => `${tableLabel(t.table)} (${t.rows})`).join(', ')}
                    </span>
                  </div>
                )}
                {assessment.unknownTables.length > 0 && (
                  <div style={{ ...impactRowStyle, alignItems: 'flex-start' }}>
                    <span style={impactNameStyle}>Нет в этой версии</span>
                    <span style={{ ...impactValueStyle, color: 'var(--s-overdue)', fontWeight: 600 }}>
                      {assessment.unknownTables.join(', ')} — данные из файла восстановить некуда
                    </span>
                  </div>
                )}
                {/* Про старый формат сервер пишет и сам — в тексте отказа ниже.
                    Своей строкой дублируем его только когда отказа нет. */}
                {impact.legacyFormat && !showWarning && (
                  <div style={{ fontSize: '0.82rem', color: 'var(--s-overdue)', paddingTop: 2, lineHeight: 1.45 }}>
                    Файл старого формата (версия {impact.version}): состав таблиц в нём вёлся
                    вручную, кассы и услуг броней он не хранит вовсе.
                  </div>
                )}
              </div>
            )}

            {/* Готовый текст сервера про то, что исчезнет */}
            {showWarning && impact?.warning && (
              <div style={{ ...restoreErrorBoxStyle, marginTop: 12 }}>
                <div style={{ fontWeight: 700, marginBottom: 3 }}>Так восстановление не пройдёт</div>
                {trimApiHint(impact.warning, 'allowDataLoss')}
              </div>
            )}

            {/* Текст сервера как есть — кроме фразы про поле API: её роль здесь
                играет галочка ниже, а «повторите запрос с allowDataLoss» читается
                как инструкция, которую пользователю негде выполнить. */}
            {dialogError && (
              <div style={{ ...restoreErrorBoxStyle, marginTop: 12 }}>
                {trimApiHint(dialogError, 'allowDataLoss')}
              </div>
            )}

            {needsConsent && assessment && (
              <ConsentCheckbox checked={agreed} disabled={busy !== null} onChange={setAgreed}>
                {consentLabel(assessment)}
              </ConsentCheckbox>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20, flexWrap: 'wrap' }}>
              <button onClick={() => setConfirmFile(null)} disabled={busy !== null} style={secondaryBtn}>
                Отмена
              </button>
              {/* Сводку могли не получить (сбой сети, сервер старой сборки) или она
                  успела устареть — даём пересчитать, не закрывая окно */}
              {dialogError && !impactLoading && (
                <button
                  onClick={() => { setDialogError(''); setRefusal(null); setImpactAttempt(n => n + 1) }}
                  disabled={busy !== null}
                  style={secondaryBtn}
                >
                  Проверить заново
                </button>
              )}
              <button
                onClick={() => handleRestore(confirmFile, needsConsent)}
                disabled={!canSubmit}
                style={{
                  ...(needsConsent ? dangerBtnStyle : confirmBtnStyle),
                  ...(canSubmit ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
                }}
              >
                {restoring
                  ? 'Восстановление…'
                  : needsConsent ? 'Восстановить и стереть данные' : 'Восстановить'}
              </button>
            </div>
          </div>
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
