import React from 'react'
import { money } from '../Payments/paymentsUi'

/**
 * Общий каркас печатных документов (подтверждение брони, счёт на оплату).
 *
 * Почему здесь НЕТ токенов темы, хотя во всём остальном интерфейсе только они:
 * это БУМАГА. Документ печатается чёрным по белому независимо от того, включена
 * ли в приложении тёмная тема — иначе счёт вышел бы из принтера белым по чёрному
 * (или, что вероятнее, пустым). Токены остаются в обвязке предпросмотра
 * (панель кнопок в `PrintPreview`), она на лист не уходит.
 *
 * Механизм печати — тот же, что у отчётов, второго не заводим: на лист уходит
 * блок `#report-print`, всё остальное прячет `@media print` в `theme.css`.
 * Поэтому документ обязан лежать в элементе с этим id (он на странице один:
 * экран отчётов в момент открытой брони не смонтирован).
 */

// ─── Формат ──────────────────────────────────────────────────────────────────

/** Знак валюты. В базе хранится код («KZT»); для тенге печатаем символ. */
export const currencySign = (code?: string | null) =>
  !code || code === 'KZT' ? '₸' : code

/** Деньги — тем же форматтером, что и касса: два формата денег разъедутся. */
export const docMoney = (n: number, code?: string | null) =>
  `${money(n)} ${currencySign(code)}`

/**
 * Даты брони — `@db.Date`, то есть UTC-полночь. Только `timeZone: 'UTC'`,
 * иначе в UTC+5 «12 июля» на бумаге станет «11 июля».
 */
export const docDate = (iso?: string | null) => {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ru-RU', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
  })
}

/** Длинная дата для «от 6 сентября 2026 г.» — момент печати, местное время. */
export const docDateLong = (d: Date) =>
  d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

/** IBAN на бланках читают группами по четыре — глазами сверять проще. */
export const formatIban = (iban?: string | null) =>
  iban ? iban.replace(/(.{4})/g, '$1 ').trim() : ''

/**
 * Реквизиты объекта — ЛОКАЛЬНОЕ описание, намеренно не импортируемое из
 * `api/hotel.ts`: тот файл принадлежит другому агенту, а печати нужен только
 * набор полей. Все поля необязательные — незаполненный реквизит не печатается
 * вовсе (не оставляя пустой строки), см. `requisiteLines`.
 */
export interface DocHotel {
  name?: string | null
  currency?: string | null
  legalName?: string | null
  bin?: string | null
  address?: string | null
  phone?: string | null
  email?: string | null
  bankName?: string | null
  iban?: string | null
  signerName?: string | null
  signerTitle?: string | null
}

/** Отбрасывает пустые значения: строка без значения на бумаге — брак, а не «пусто». */
export const requisiteLines = (
  rows: { label?: string; value?: string | null }[],
): { label?: string; value: string }[] =>
  rows
    .map(r => ({ label: r.label, value: (r.value ?? '').trim() }))
    .filter(r => r.value !== '')

// ─── Стили документа ─────────────────────────────────────────────────────────
// Размеры в пунктах, а не в rem: root у приложения 13px, и документ не должен
// зависеть от настроек интерфейса — на бумаге 10pt обязаны быть 10pt.
// Константы объявлены ДО компонентов: объявленная ниже падает при горячей
// перезагрузке («is not defined», временная мёртвая зона) — уже ловили дважды.

export const INK = '#000'
export const INK_SOFT = '#444'
export const RULE = '#999'
export const RULE_SOFT = '#ddd'

export const docTitle: React.CSSProperties = {
  fontSize: '15pt', fontWeight: 700, color: INK, margin: '0 0 2mm',
}

export const docSubTitle: React.CSSProperties = {
  fontSize: '9.5pt', color: INK_SOFT, margin: '0 0 6mm',
}

export const blockTitle: React.CSSProperties = {
  fontSize: '9pt', fontWeight: 700, color: INK, textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: '2mm',
}

/** Таблица начислений. Линии — те же, что накидывает `@media print` в theme.css,
 *  чтобы экран и бумага выглядели одинаково, а не «почти одинаково». */
export const docTable: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: '10pt', color: INK,
}

export const docTh: React.CSSProperties = {
  background: '#f1f1f1', borderBottom: `1px solid ${RULE}`,
  padding: '2mm 2.5mm', fontSize: '9pt', fontWeight: 700, textAlign: 'left',
}

export const docTd: React.CSSProperties = {
  borderBottom: `1px solid ${RULE_SOFT}`, padding: '2mm 2.5mm', verticalAlign: 'top',
}

export const docTfootTd: React.CSSProperties = {
  background: '#f1f1f1', borderTop: `1.5pt solid #666`,
  padding: '2.5mm', fontWeight: 700,
}

// ─── Кирпичики документа ─────────────────────────────────────────────────────

/** Шапка объекта: название крупно, под ним — заполненные реквизиты одной строкой. */
export const DocHeader: React.FC<{ hotel: DocHotel }> = ({ hotel }) => {
  const contacts = requisiteLines([
    { value: hotel.address },
    { value: hotel.phone ? `тел. ${hotel.phone}` : null },
    { value: hotel.email },
  ]).map(r => r.value)

  return (
    <div className="doc-block" style={{ borderBottom: `1.5pt solid ${INK}`, paddingBottom: '3mm', marginBottom: '6mm' }}>
      <div style={{ fontSize: '13pt', fontWeight: 700, color: INK }}>
        {hotel.name || 'Отель'}
      </div>
      {hotel.legalName && (
        <div style={{ fontSize: '9.5pt', color: INK_SOFT, marginTop: '1mm' }}>{hotel.legalName}</div>
      )}
      {contacts.length > 0 && (
        <div style={{ fontSize: '9.5pt', color: INK_SOFT, marginTop: '1mm' }}>
          {contacts.join(' · ')}
        </div>
      )}
    </div>
  )
}

/** Строка «подпись — значение». Двоеточие и точки-выноска, как в бланках. */
export const DocRow: React.FC<{ label: string; value: React.ReactNode; strong?: boolean }> = ({
  label, value, strong,
}) => (
  <div style={{
    display: 'flex', alignItems: 'baseline', gap: '3mm',
    fontSize: '10pt', color: INK, padding: '0.8mm 0',
  }}>
    <span style={{ color: INK_SOFT, minWidth: '45mm', flexShrink: 0 }}>{label}</span>
    <span style={{ fontWeight: strong ? 700 : 500, flex: 1 }}>{value}</span>
  </div>
)

export const DocBlock: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="doc-block" style={{ marginBottom: '6mm' }}>
    {title && <div style={blockTitle}>{title}</div>}
    {children}
  </div>
)

/**
 * Подписант. Печатается, только если реквизит заполнен — пустая линия
 * «___ / ___» на подтверждении выглядит как незаполненный бланк.
 */
export const DocSigner: React.FC<{ hotel: DocHotel }> = ({ hotel }) => {
  if (!hotel.signerName && !hotel.signerTitle) return null
  return (
    <div className="doc-block" style={{ marginTop: '10mm', display: 'flex', alignItems: 'flex-end', gap: '4mm' }}>
      <div style={{ fontSize: '10pt', color: INK }}>{hotel.signerTitle || ''}</div>
      <div style={{ flex: 1, borderBottom: `1px solid ${INK}`, minWidth: '35mm' }} />
      <div style={{ fontSize: '10pt', color: INK, whiteSpace: 'nowrap' }}>{hotel.signerName || ''}</div>
    </div>
  )
}

/** Дата печати внизу листа — по ней в стопке бумаг видно, какая версия свежее. */
export const DocPrintedAt: React.FC<{ at: Date }> = ({ at }) => (
  <div style={{ marginTop: '8mm', fontSize: '8.5pt', color: INK_SOFT }}>
    Документ сформирован {at.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })}
  </div>
)
