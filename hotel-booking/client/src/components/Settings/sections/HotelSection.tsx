import React, { useEffect, useState } from 'react'
import { fetchHotel, updateHotel, REQUISITE_FIELDS } from '../../../api/hotel'
import type { HotelRequisites, RequisiteField } from '../../../api/hotel'
import { useAuthStore } from '../../../store/useAuthStore'
import { formatApiError, parseApiError } from '../../Setup/accountRules'
import { SectionHeader, formCard, formTitle, inputStyle, labelStyle, errorStyle, primaryBtn } from './sectionUi'

// ─── Константы объявлены ДО компонента ────────────────────────────────────────
// Объявленная ниже константа падает при горячей перезагрузке с «is not defined»
// (временная мёртвая зона) — на этом уже спотыкались дважды.

/** Значения реквизитов в форме — всегда строки: `null` с сервера показываем пустым полем. */
type RequisiteForm = Record<RequisiteField, string>

/** Пустая форма собирается из списка полей, чтобы новый реквизит не забыть здесь. */
const EMPTY_REQUISITES = Object.fromEntries(
  REQUISITE_FIELDS.map(f => [f, '']),
) as RequisiteForm

interface RequisiteMeta {
  field: RequisiteField
  label: string
  placeholder?: string
  /** Подсказка под полем — только там, где формат неочевиден. */
  hint?: string
  /**
   * Ограничение ввода. Совпадает с серверным пределом, кроме БИН и IBAN:
   * их копируют с бланка группами («123 456 789 012», «KZ86 8562 …»), и лимит
   * по числу ЗНАЧАЩИХ символов обрезал бы верный номер прямо при вставке.
   * Пробелы сервер уберёт сам.
   */
  maxLength: number
  /**
   * Ширина в строке: поля лежат в одном `flex-wrap`, поэтому пары складываются
   * сами. Значения подобраны так, чтобы на узком окне (≈800px, где под контент
   * настроек остаётся ~500px) поля разъезжались по одному в строку, а не жались.
   */
  basis: string
}

/** Порядок — тот же, что в шапке печатного документа. */
const REQUISITES: RequisiteMeta[] = [
  {
    field: 'legalName',
    label: 'Юридическое имя',
    placeholder: 'ИП Оралбеков А.',
    hint: 'Как в договоре: ИП Оралбеков А. / ТОО «…»',
    maxLength: 200,
    basis: '100%',
  },
  { field: 'bin', label: 'БИН / ИИН', placeholder: '12 цифр', maxLength: 20, basis: '220px' },
  { field: 'address', label: 'Адрес', placeholder: 'Город, улица, дом', maxLength: 300, basis: '320px' },
  { field: 'phone', label: 'Телефон', placeholder: '+7 (7212) 55-55-55', maxLength: 60, basis: '220px' },
  { field: 'email', label: 'Почта', placeholder: 'info@example.kz', maxLength: 120, basis: '260px' },
  { field: 'bankName', label: 'Банк', placeholder: 'АО «Народный Банк Казахстана»', maxLength: 200, basis: '260px' },
  { field: 'iban', label: 'IBAN', placeholder: 'KZ86 8562 0000 0032 7523', maxLength: 44, basis: '300px' },
  { field: 'signerName', label: 'Подписант', placeholder: 'Оралбеков А. Б.', maxLength: 120, basis: '240px' },
  { field: 'signerTitle', label: 'Должность подписанта', placeholder: 'Директор', maxLength: 80, basis: '240px' },
]

/** `null` с сервера → пустое поле формы; ключи берём из общего списка. */
function readRequisites(hotel: Partial<HotelRequisites>): RequisiteForm {
  const next = { ...EMPTY_REQUISITES }
  for (const f of REQUISITE_FIELDS) next[f] = hotel[f] ?? ''
  return next
}

const hintStyle: React.CSSProperties = {
  fontSize: '0.76rem', color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.4,
}

const fieldErrorStyle: React.CSSProperties = {
  fontSize: '0.76rem', color: 'var(--s-overdue)', marginTop: 4, lineHeight: 1.4,
}

const noteStyle: React.CSSProperties = {
  margin: '4px 0 0', fontSize: '0.82rem', color: 'var(--text-faint)', lineHeight: 1.45,
}

// Настройки → Отель: название, город и реквизиты для печатных документов.
// Видят все роли, изменяют SUPER_ADMIN и ADMIN (сервер проверяет роль тоже).
// После сохранения название обновляется в шапке.
export const HotelSection: React.FC = () => {
  const { admin, setHotelName } = useAuthStore()
  const canEdit = admin?.role === 'SUPER_ADMIN' || admin?.role === 'ADMIN'

  const [form, setForm] = useState({ name: '', city: '' })
  const [req, setReq] = useState<RequisiteForm>(EMPTY_REQUISITES)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** Ошибки из `details` ответа 400 — каждая под своим полем. */
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RequisiteField, string>>>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    fetchHotel()
      .then(h => {
        setForm({ name: h.name ?? '', city: h.city ?? '' })
        setReq(readRequisites(h))
      })
      .catch(e => setError(formatApiError(e, 'Не удалось загрузить данные отеля')))
      .finally(() => setLoading(false))
  }, [])

  // Короткое «Сохранено», само исчезает
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])

  const setReqField = (field: RequisiteField, value: string) => {
    setReq(prev => ({ ...prev, [field]: value }))
    // Красная подпись под полем должна исчезать, как только его начали править:
    // иначе она висит до следующего сохранения и выглядит как новая ошибка.
    setFieldErrors(prev => (prev[field] ? { ...prev, [field]: undefined } : prev))
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название отеля'); return }
    setSaving(true)
    setError('')
    setFieldErrors({})
    try {
      // Пустое поле шлём как null — это «реквизит не заполнен», и сервер его
      // сотрёт. Отдельного «не трогать» у формы нет: она показывает все поля.
      const requisites = {} as Record<RequisiteField, string | null>
      for (const f of REQUISITE_FIELDS) requisites[f] = req[f].trim() || null

      const h = await updateHotel({
        name: form.name.trim(),
        city: form.city.trim() || null,
        ...requisites,
      })
      setForm({ name: h.name ?? '', city: h.city ?? '' })
      // Показываем то, что сохранилось: сервер сам чистит БИН и IBAN
      // (пробелы, дефисы, регистр), и поле должно показать канонический вид.
      setReq(readRequisites(h))
      setHotelName(h.name || null)
      setSaved(true)
    } catch (e) {
      const { message, details } = parseApiError(e, 'Ошибка сохранения')
      const byField: Partial<Record<RequisiteField, string>> = {}
      const other: string[] = []
      for (const d of details) {
        const f = d.field as RequisiteField
        if (REQUISITE_FIELDS.includes(f) && !byField[f]) byField[f] = d.message
        else other.push(d.message)   // поле не наше (или дубль) — не терять текст
      }
      setFieldErrors(byField)
      setError(other.length ? `${message}: ${other.join('; ')}` : message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <SectionHeader
        title="Отель"
        subtitle="Название показывается в шапке программы и в меню разделов."
      />

      {loading ? (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--text-faint)' }}>Загрузка…</div>
      ) : (
        <div style={formCard}>
          <div>
            <label style={labelStyle}>Название отеля</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              disabled={!canEdit}
              maxLength={120}
              placeholder="Например: Гранд Алатау"
              style={{ ...inputStyle, opacity: canEdit ? 1 : 0.7 }}
            />
          </div>
          <div>
            <label style={labelStyle}>Город</label>
            <input
              value={form.city}
              onChange={e => setForm(f => ({ ...f, city: e.target.value }))}
              disabled={!canEdit}
              maxLength={80}
              placeholder="Необязательно"
              style={{ ...inputStyle, opacity: canEdit ? 1 : 0.7 }}
            />
          </div>

          {/* ─── Реквизиты для документов ─────────────────────────────────── */}
          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, marginTop: 2 }}>
            <div style={formTitle}>Реквизиты для документов</div>
            <p style={noteStyle}>
              Печатаются в шапке счёта и подтверждения брони; пустые просто не печатаются.
            </p>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {REQUISITES.map(meta => {
              const fieldError = fieldErrors[meta.field]
              return (
                <div key={meta.field} style={{ flex: `1 1 ${meta.basis}`, minWidth: 0 }}>
                  <label style={labelStyle}>{meta.label}</label>
                  <input
                    value={req[meta.field]}
                    onChange={e => setReqField(meta.field, e.target.value)}
                    disabled={!canEdit}
                    maxLength={meta.maxLength}
                    placeholder={meta.placeholder}
                    style={{
                      ...inputStyle,
                      opacity: canEdit ? 1 : 0.7,
                      // Рамка ошибки — токеном, иначе в тёмной теме будет пятно.
                      borderColor: fieldError ? 'var(--s-overdue)' : 'var(--border)',
                    }}
                  />
                  {fieldError
                    ? <div style={fieldErrorStyle}>{fieldError}</div>
                    : meta.hint && <div style={hintStyle}>{meta.hint}</div>}
                </div>
              )
            })}
          </div>

          {error && <div style={errorStyle}>{error}</div>}

          {canEdit ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
              {saved && <span style={{ fontSize: '0.85rem', color: 'var(--s-in)' }}>Сохранено</span>}
              <button onClick={save} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.7 : 1 }}>
                {saving ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>
              Только просмотр: изменять данные отеля может администратор или главный администратор.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
