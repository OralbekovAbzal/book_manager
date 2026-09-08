import React, { useState } from 'react'
import { useAuthStore } from '../../store/useAuthStore'
import {
  pickBackupFile, uploadBackup, restoreBackup, readRestoreFailure,
  type RestoreAssessment, type BackupRestoreResult,
} from '../../api/system'
import {
  MoneyImpactRow, ConsentCheckbox, formatMoney, trimApiHint, restoreConsentLabel,
  impactBoxStyle, impactRowStyle, impactNameStyle, impactValueStyle,
  restoreErrorBoxStyle, dangerBtnStyle,
} from '../ui/restoreUi'
import { StepHeading, wizardPrimary, wizardSecondary } from './setupUi'

/**
 * Последний шаг мастера первого запуска: перенос данных с прошлого компьютера.
 *
 * Почему он ПОСЛЕ создания учётной записи, а не до. Загрузка файла и
 * восстановление — операции главного администратора (`POST /system/backup/*`
 * требует SUPER_ADMIN), а до `setup/complete` в базе нет вообще никого. Поэтому
 * сначала настройка, потом предложение восстановиться — и созданная только что
 * учётная запись честно заменяется учётными записями из копии.
 *
 * Диалог согласия — тот же, что в разделе «Резервная копия» (`ui/restoreUi.tsx`):
 * второго разговора о потере денег в программе быть не должно.
 */

// ── Константы объявлены ДО компонента: объявленная ниже падает при горячей
// перезагрузке с «is not defined» (временная мёртвая зона). Ловили дважды.

interface Props {
  /** Закончить мастер: показать приложение (или экран входа, если сессию сбросили). */
  onDone: () => void
}

/** Файл, уже принятый сервером: имя в папке копий + сводка последствий. */
interface Accepted {
  /** Как файл назывался на флешке — это имя узнаёт пользователь */
  sourceName: string
  /** Как сервер назвал его у себя — с этим именем идёт восстановление */
  fileName: string
  impact: RestoreAssessment
}

const noteStyle: React.CSSProperties = {
  fontSize: '0.86rem', color: 'var(--text-faint)', lineHeight: 1.5,
}

export const StepRestore: React.FC<Props> = ({ onDone }) => {
  const logout = useAuthStore(s => s.logout)

  const [accepted, setAccepted] = useState<Accepted | null>(null)
  const [result, setResult] = useState<BackupRestoreResult | null>(null)
  const [busy, setBusy] = useState<'' | 'upload' | 'restore'>('')
  const [error, setError] = useState('')
  const [agreed, setAgreed] = useState(false)

  const choose = async () => {
    setError('')
    let picked: Awaited<ReturnType<typeof pickBackupFile>> = null
    try {
      picked = await pickBackupFile()
    } catch {
      setError('Не удалось прочитать файл. Попробуйте выбрать другой.')
      return
    }
    if (!picked) return  // диалог закрыли — это не ошибка

    setBusy('upload')
    try {
      const res = await uploadBackup(picked.content, picked.name)
      setAccepted({ sourceName: picked.name, fileName: res.fileName, impact: res.impact })
      setAgreed(false)
    } catch (e) {
      // Текст сервера объясняет причину лучше нашей заглушки: «это не файл копии
      // Qonaq», «файл повреждён», «слишком большой».
      setError(readRestoreFailure(e, 'Сервер не принял этот файл').message)
      setAccepted(null)
    } finally {
      setBusy('')
    }
  }

  const restore = async () => {
    if (!accepted) return
    setBusy('restore'); setError('')
    try {
      const r = await restoreBackup(accepted.fileName, { allowDataLoss: agreed })
      setResult(r)
      // Сессию гасим сразу, не дожидаясь кнопки: учётных записей из этой базы
      // больше нет, и любой следующий запрос (в том числе сокет) получил бы 401,
      // а интерцептор перезагрузил бы окно прямо поверх этого экрана.
      logout('restored')
    } catch (e) {
      const failure = readRestoreFailure(e, 'Не удалось восстановить данные из копии')
      setError(failure.message)
      if (failure.impact) {
        setAccepted(a => (a ? { ...a, impact: failure.impact! } : a))
        setAgreed(false)
      }
    } finally {
      setBusy('')
    }
  }

  // ── Готово ────────────────────────────────────────────────────────────────
  if (result) {
    return (
      <div>
        <StepHeading
          title="Данные восстановлены"
          text="Войдите своей прежней учётной записью — той, которой пользовались на прошлом компьютере."
        />
        <div style={impactBoxStyle}>
          <div style={impactRowStyle}>
            <span style={impactNameStyle}>Брони</span>
            <span style={impactValueStyle}><strong>{result.restored?.Booking ?? 0}</strong></span>
          </div>
          <div style={impactRowStyle}>
            <span style={impactNameStyle}>Номера</span>
            <span style={impactValueStyle}><strong>{result.restored?.Room ?? 0}</strong></span>
          </div>
          <div style={impactRowStyle}>
            <span style={impactNameStyle}>Пользователи</span>
            <span style={impactValueStyle}><strong>{result.restored?.Admin ?? 0}</strong></span>
          </div>
          {result.lostPayments > 0 && (
            <div style={{ ...impactRowStyle, color: 'var(--s-overdue)' }}>
              <span style={impactNameStyle}>Стёрто платежей</span>
              <span style={impactValueStyle}>
                {result.lostPayments} ({formatMoney(result.lostPaymentsAmount)})
              </span>
            </div>
          )}
        </div>
        <div style={{ ...noteStyle, marginTop: 14 }}>
          Учётная запись, которую вы только что создали, заменена учётными записями из копии:
          в базе теперь те же пользователи и пароли, что были на прошлом компьютере.
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 28 }}>
          <button type="button" onClick={onDone} style={wizardPrimary}>
            Перейти ко входу
          </button>
        </div>
      </div>
    )
  }

  // ── Файл принят: сводка и подтверждение ───────────────────────────────────
  if (accepted) {
    const a = accepted.impact
    const needsConsent = a.requiresConfirmation === true
    const canSubmit = busy === '' && (!needsConsent || agreed)
    return (
      <div>
        <StepHeading
          title="Проверьте, что вернётся"
          text={`Файл принят: ${accepted.sourceName}. Восстановление заменит всё, что сейчас есть в базе, содержимым копии.`}
        />
        <div style={impactBoxStyle}>
          <MoneyImpactRow name="Начисления" data={a.charges} />
          <MoneyImpactRow name="Платежи" data={a.payments} />
          <MoneyImpactRow name="Услуги в бронях" data={a.services} />
          {a.emptiedTables.length > 0 && (
            <div style={{ ...impactRowStyle, alignItems: 'flex-start' }}>
              <span style={impactNameStyle}>Файл очистит целиком</span>
              <span style={{ ...impactValueStyle, color: 'var(--s-overdue)', fontWeight: 600 }}>
                {a.emptiedTables.map(t => `${t.table} (${t.rows})`).join(', ')}
              </span>
            </div>
          )}
          {a.unknownTables.length > 0 && (
            <div style={{ ...impactRowStyle, alignItems: 'flex-start' }}>
              <span style={impactNameStyle}>Нет в этой версии</span>
              <span style={{ ...impactValueStyle, color: 'var(--s-overdue)', fontWeight: 600 }}>
                {a.unknownTables.join(', ')} — данные из файла восстановить некуда
              </span>
            </div>
          )}
          {a.legacyFormat && (
            <div style={{ fontSize: '0.82rem', color: 'var(--s-overdue)', paddingTop: 2, lineHeight: 1.45 }}>
              Файл старого формата (версия {a.version}): кассы и услуг броней он не хранит вовсе.
            </div>
          )}
          {/* На свежей установке терять нечего — так и говорим, иначе пустая
              сводка читается как «сводку не посчитали». */}
          {!needsConsent && (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)', lineHeight: 1.45 }}>
              База сейчас пустая — терять нечего, восстановление просто перенесёт данные из копии.
            </div>
          )}
        </div>

        {error && (
          <div style={{ ...restoreErrorBoxStyle, marginTop: 12 }}>
            {trimApiHint(error, 'allowDataLoss')}
          </div>
        )}

        {needsConsent && (
          <ConsentCheckbox checked={agreed} disabled={busy !== ''} onChange={setAgreed}>
            {restoreConsentLabel(a)}
          </ConsentCheckbox>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 28, flexWrap: 'wrap' }}>
          <button type="button" onClick={choose} disabled={busy !== ''} style={wizardSecondary}>
            Выбрать другой файл
          </button>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={onDone} disabled={busy !== ''} style={wizardSecondary}>
              Пропустить
            </button>
            <button
              type="button"
              onClick={restore}
              disabled={!canSubmit}
              style={{
                ...dangerBtnStyle, height: 40, padding: '0 22px', fontSize: '0.9rem',
                ...(canSubmit ? {} : { opacity: 0.5, cursor: 'not-allowed' }),
              }}
            >
              {busy === 'restore' ? 'Восстановление…' : 'Восстановить'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Начало: выбрать файл или пропустить ───────────────────────────────────
  return (
    <div>
      <StepHeading
        title="Перенос данных с прошлого компьютера"
        text="Если у вас есть файл резервной копии Qonaq (обычно на флешке, backup_*.json), выберите его — брони, касса и настройки восстановятся."
      />
      <div style={noteStyle}>
        Ничего переносить не нужно, если это первая установка: пропустите шаг и начните с чистой базы.
        Вернуться к переносу можно позже — «Настройки → Резервная копия».
      </div>

      {error && (
        <div style={{ ...restoreErrorBoxStyle, marginTop: 14 }}>{error}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 28, flexWrap: 'wrap' }}>
        <button type="button" onClick={onDone} disabled={busy !== ''} style={wizardSecondary}>
          Пропустить — начать с чистой базы
        </button>
        <button type="button" onClick={choose} disabled={busy !== ''} style={wizardPrimary}>
          {busy === 'upload' ? 'Проверяем файл…' : 'Выбрать файл копии…'}
        </button>
      </div>
    </div>
  )
}
