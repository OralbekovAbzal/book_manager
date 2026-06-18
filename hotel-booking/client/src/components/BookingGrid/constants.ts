export const ROOM_COL_WIDTH = 192  // px — ширина колонки с номером
export const DAY_WIDTH       = 44   // px — ширина одного дня
export const ROW_HEIGHT      = 44   // px — высота строки номера
export const CAT_ROW_HEIGHT  = 32   // px — высота строки категории
export const HEADER_HEIGHT   = 48   // px — высота шапки с датами
export const BLOCK_PADDING   = 2    // px — зазор между блоками

// Hotel PMS-style палитра (Mews/Cloudbeds-inspired)
// Средне-насыщенные цвета — не пастель, не кричаще
export const STATUS_COLORS = {
  confirmed:   '#5B8DEF',  // мягкий синий — подтверждённая бронь
  checkedIn:   '#22C55E',  // зелёный — гости в номере
  checkedOut:  '#F59E0B',  // янтарный — выехали
  overdue:     '#EF4444',  // красный — просрочено
  maintenance: '#94A3B8',  // нейтральный серый — ремонт
  noShow:      '#CBD5E1',  // светло-серый — не приехал
} as const
