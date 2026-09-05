import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IS_ELECTRON } from '../../config'

/**
 * Предпросмотр печатного документа: лист A4 поверх приложения плюс панель
 * «Печать / Сохранить PDF / Закрыть».
 *
 * Второго механизма печати не заводим — используем тот же, что у отчётов:
 * на лист уходит блок `#report-print`, всё остальное прячет `@media print`
 * в `theme.css`. Поэтому лист здесь и получает этот id: он на странице один
 * (экран отчётов при открытой брони не смонтирован).
 *
 * PDF в Electron печатает ТО ЖЕ окно через `printToPDF` — бумага и PDF
 * совпадают, потому что это один и тот же DOM с теми же стилями. В браузере
 * такого моста нет: там PDF выбирается принтером в окне печати.
 */

// Константы — ДО компонента: объявленная ниже падает при горячей перезагрузке
// с «is not defined» (временная мёртвая зона). На этом уже спотыкались дважды.

/**
 * Стили печати документа. Живут здесь, а не в `theme.css`, по двум причинам:
 * они нужны только пока открыт предпросмотр, и `@page` здесь ПЕРЕОПРЕДЕЛЯЕТ
 * альбомную ориентацию отчётов — при равной специфичности побеждает правило,
 * объявленное позже, а этот <style> монтируется в body, то есть после
 * стилей из <head>. Закрыли предпросмотр — вернулась печать отчётов.
 */
const PRINT_CSS = `
@media print {
  /* Отчёты печатаются альбомно (@page в theme.css), документ — книжно. */
  @page { size: A4 portrait; margin: 12mm; }

  /* display:contents убирает КОРОБКУ оверлея, оставляя лист: без этого
     #report-print позиционировался бы внутри position:fixed родителя и на
     бумаге обрезался бы по высоте экрана. Так лист попадает в поток body и
     подчиняется тому же правилу theme.css, что и таблица отчёта. */
  .print-overlay { display: contents !important; }
  .print-toolbar { display: none !important; }

  /* Инлайновые размеры листа нужны только экрану: на бумаге поля задаёт @page. */
  #report-print {
    width: 100% !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    background: #fff !important;
    color: #000 !important;
  }
  /* theme.css ужимает таблицы отчёта до 8.5pt — документу это не нужно. */
  #report-print .doc-table { font-size: 10pt; }
  #report-print .doc-block { break-inside: avoid; page-break-inside: avoid; }
  #report-print tr { page-break-inside: avoid; }
  #report-print thead { display: table-header-group; }
}
/* Окно уже 900px: лист в натуральную величину не влезает, ужимаем — иначе
   появляется горизонтальная прокрутка и кнопки уезжают за край. */
@media screen and (max-width: 900px) {
  .print-page { zoom: 0.86; }
}
`

const overlayStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 800,
  background: 'rgba(0,0,0,0.55)', overflow: 'auto',
  padding: '0 0 32px',
}

const toolbarStyle: React.CSSProperties = {
  position: 'sticky', top: 0, zIndex: 1,
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
  padding: '10px 16px', background: 'var(--bg)', color: 'var(--text)',
  borderBottom: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)',
}

const pageStyle: React.CSSProperties = {
  width: '210mm', minHeight: '297mm', margin: '20px auto', padding: '12mm',
  background: '#fff', color: '#000',
  fontFamily: '"Segoe UI", Arial, "Helvetica Neue", sans-serif',
  fontSize: '10pt', lineHeight: 1.4,
  boxShadow: '0 10px 40px rgba(0,0,0,0.35)', borderRadius: 2,
}

const btnStyle: React.CSSProperties = {
  padding: '7px 16px', background: 'transparent', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 'var(--ui-radius)',
  fontFamily: 'inherit', fontSize: '0.86rem', fontWeight: 600, cursor: 'pointer',
}

const primaryBtnStyle: React.CSSProperties = {
  ...btnStyle, background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)',
}

interface Props {
  /** Подпись в панели — что именно сейчас на листе. */
  title: string
  /** Имя файла для «Сохранить PDF» (без расширения). */
  fileName: string
  onClose: () => void
  children: React.ReactNode
}

export const PrintPreview: React.FC<Props> = ({ title, fileName, onClose, children }) => {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  /**
   * Esc закрывает ТОЛЬКО предпросмотр. Окно просмотра брони под ним слушает
   * Escape на document (и подписалось раньше нас — значит его обработчик
   * сработал бы первым и закрыл бы заодно бронь). Поэтому слушаем в фазе
   * ПЕРЕХВАТА и гасим событие: до всплытия к чужому обработчику оно не дойдёт.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [onClose])

  const handlePdf = async () => {
    const bridge = window.appConfig?.saveReportPdf
    if (!bridge) return
    setBusy(true)
    setNote('')
    try {
      // landscape: false — документ книжный, в отличие от отчёта.
      const res = await bridge({ fileName: `${fileName}.pdf`, landscape: false })
      if (res.ok) setNote('PDF сохранён')
      else if (!res.canceled) setNote(res.error || 'Не удалось сохранить PDF')
    } catch {
      setNote('Не удалось сохранить PDF')
    } finally {
      setBusy(false)
    }
  }

  // Портал в body: предпросмотр не должен зависеть от раскладки окна брони,
  // а на печати оверлею нужно исчезнуть как коробке (display:contents выше).
  return createPortal(
    <div
      className="print-overlay"
      style={overlayStyle}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <style>{PRINT_CSS}</style>

      <div className="print-toolbar" style={toolbarStyle}>
        <span style={{ fontSize: '0.92rem', fontWeight: 600, marginRight: 'auto' }}>{title}</span>
        {note && <span style={{ fontSize: '0.82rem', color: 'var(--text-faint)' }}>{note}</span>}
        <button style={primaryBtnStyle} onClick={() => window.print()}>Печать</button>
        {IS_ELECTRON && (
          <button style={btnStyle} onClick={handlePdf} disabled={busy}>
            {busy ? 'Сохранение…' : 'Сохранить PDF'}
          </button>
        )}
        <button style={btnStyle} onClick={onClose}>Закрыть</button>
      </div>

      <div id="report-print" className="print-page" style={pageStyle}>
        {children}
      </div>
    </div>,
    document.body,
  )
}
