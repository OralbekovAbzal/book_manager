import React from 'react'

/**
 * Подтверждение продажи номера из квоты партнёра (ответ сервера 409
 * `code: 'ALLOTMENT_CONFLICT'`).
 *
 * Квота — не глухой запрет: отель вправе продать выделенный номер, но это должно
 * быть решением администратора, а не молчаливым обходом. Поэтому вместо красной
 * ошибки показываем вопрос и повторяем запрос с `allowAllotmentOverride: true`.
 *
 * Почему отдельный компонент: то же самое требуется и в форме брони, и в окне
 * переезда. Две копии разъехались бы по тексту и виду при первой же правке —
 * а пользователь должен узнавать это окно, откуда бы оно ни пришло.
 *
 * Верстается `position: absolute; inset: 0` — накрывает ТОЛЬКО родительскую
 * модалку, а не весь экран. Для `position: fixed` это и не сработало бы: у окна
 * переезда на контейнере стоит `transform`, а он делает родителя containing block
 * для fixed-детей (та самая ловушка из NOTES.md).
 */

interface Props {
  /** Текст причины от сервера (`data.error`) — какой партнёр и на какие даты */
  message: string
  /** Идёт повторный запрос: блокируем кнопку, чтобы не отправить дважды */
  busy?: boolean
  /** Надпись на кнопке подтверждения: действия в брони и в переезде разные */
  confirmLabel: string
  /** Она же во время запроса */
  busyLabel: string
  onCancel: () => void
  onConfirm: () => void
}

// Константы — ДО компонента: объявленная ниже падает при горячей перезагрузке
// с «is not defined» (временная мёртвая зона).
const overlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg)', borderRadius: 14, padding: '28px 26px', maxWidth: 440, width: '90%',
  boxShadow: '0 20px 60px rgba(0,0,0,0.25)', display: 'flex', flexDirection: 'column', gap: 18,
  // Окно переезда ниже формы брони — на коротком экране карточка должна
  // прокручиваться внутри него, а не обрезаться его `overflow: hidden`.
  maxHeight: '100%', overflowY: 'auto', boxSizing: 'border-box',
}

const cancelBtnStyle: React.CSSProperties = {
  padding: '8px 16px',
  background: 'none',
  border: '1px solid var(--border)',
  borderRadius: 'var(--ui-radius)',
  fontSize: 'inherit',
  cursor: 'pointer',
  color: 'var(--text)',
  fontFamily: 'inherit',
}

export const AllotmentConfirm: React.FC<Props> = ({
  message, busy = false, confirmLabel, busyLabel, onCancel, onConfirm,
}) => (
  <div style={overlayStyle}>
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Плашка под эмодзи намеренно светло-янтарная в обеих темах: это фон
            иконки, а не поверхность интерфейса — на тёмном фоне читается так же. */}
        <div style={{
          width: 44, height: 44, borderRadius: 12, background: '#fef3c7', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.6rem',
        }}>🤝</div>
        <div>
          <div style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text)', marginBottom: 2 }}>
            Номер выделен партнёру
          </div>
          <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Требуется подтверждение</div>
        </div>
      </div>

      <div style={{
        background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px',
        fontSize: '0.95rem', color: 'var(--text)', lineHeight: 1.5,
      }}>
        {message}
      </div>

      <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Если продать этот номер, партнёр приедет к занятому номеру. Подтвердите,
        только если это согласовано.
      </div>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={cancelBtnStyle}>
          Отмена
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          style={{
            padding: '9px 20px', background: '#d97706', color: '#fff', border: 'none',
            borderRadius: 8, fontSize: '1rem', fontWeight: 600, fontFamily: 'inherit',
            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </div>
  </div>
)
