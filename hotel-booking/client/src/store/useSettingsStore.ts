import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'light' | 'dark'

export interface VisualSettings {
  theme: ThemeMode
  rowHeight: number       // 28–80  — высота строки сетки
  headerHeight: number    // 32–72  — высота заголовка дат
  fontSize: number        // 10–22  — размер шрифта (глобальный, применяется везде)
  blockRadius: number     // 0–20   — скругление блоков броней
  uiRadius: number        // 0–20   — скругление кнопок / полей / карточек
  showFeatureIcons: boolean
  visibleDays: number     // 7–90   — дней в сетке
  daysBeforeShift: number // 0–14   — сколько дней показывать слева ДО даты смены
  // roomColWidth удалён — вычисляется автоматически по fontSize
}

export const VISUAL_DEFAULTS: VisualSettings = {
  theme: 'light',
  rowHeight: 44,
  headerHeight: 48,
  fontSize: 13,
  blockRadius: 6,
  uiRadius: 6,
  showFeatureIcons: true,
  visibleDays: 30,
  daysBeforeShift: 3,
}

// ─── Room Fund types ───────────────────────────────────────────────────────────

export interface BuildingItem { id: string; name: string; description: string }
export interface FeatureItem { id: string; name: string; emoji: string }
export interface CapacityItem { id: string; label: string; value: number }
/**
 * Эффекты метки для алгоритма оптимизации. Алгоритм работает не с названием
 * метки, а с этими эффектами — поэтому новую метку достаточно собрать из них.
 */
export interface FlagEffects {
  bufferAfter?: number          // дней «чистого» зазора ПОСЛЕ брони (поздний выезд → 1)
  bufferBefore?: number         // дней зазора ДО брони (раннее заселение → 1)
  pin?: boolean                 // не перемещать оптимизатором (VIP, спец-условия)
  lockFloor?: boolean           // только свой этаж (нельзя менять этаж)
  requireFeature?: string       // номер обязан иметь эту особенность (тип кровати)
  bufferAfterExceptFlag?: string // зазор «после» снимается, если у следующей брони есть метка с этим code
}
export interface BookingFlagItem { id: string; label: string; effects?: FlagEffects }

export interface RoomFundConfig {
  buildings: BuildingItem[]
  features: FeatureItem[]
  capacities: CapacityItem[]
  bookingFlags: BookingFlagItem[]
}

export const ROOM_FUND_DEFAULTS: RoomFundConfig = {
  buildings: [],
  features: [
    { id: 'balcony', name: 'Балкон', emoji: '🪟' },
    { id: 'sea_view', name: 'Вид на море', emoji: '🌊' },
    { id: 'jacuzzi', name: 'Джакузи', emoji: '🛁' },
    { id: 'double_bed', name: 'Двуспальная кровать', emoji: '🛏' },
    { id: 'ac', name: 'Кондиционер', emoji: '❄️' },
    { id: 'fridge', name: 'Холодильник', emoji: '🧊' },
    { id: 'safe', name: 'Сейф', emoji: '🔒' },
  ],
  capacities: [
    { id: 'single', label: 'Одноместный', value: 1 },
    { id: 'double', label: 'Двухместный', value: 2 },
    { id: 'triple', label: 'Трёхместный', value: 3 },
    { id: 'quad', label: 'Четырёхместный', value: 4 },
  ],
  bookingFlags: [
    { id: 'early_checkout', label: 'Выезд до 17:00' },
    { id: 'late_checkout', label: 'Выезд после 17:00' },
    { id: 'debt', label: 'Долг / не оплатил' },
  ],
}

// ─── Pricing types ────────────────────────────────────────────────────────────

export interface PricingPeriod {
  id: string
  name: string
  start: string  // "MM-DD"
  end: string    // "MM-DD"
}

export interface PricingConfig {
  noMealDiscount: number
  disabledDiscountDefault: number
  periods: PricingPeriod[]
  categoryRates: Record<string, {
    adultRates: Record<string, number>
    childRates: Record<string, number>
    extraBedRates: Record<string, number>
    disabledDiscount: number
  }>
}

export const PRICING_DEFAULTS: PricingConfig = {
  noMealDiscount: 7000,
  disabledDiscountDefault: 3000,
  periods: [
    { id: 'p1', name: '15–21 июн', start: '06-15', end: '06-21' },
    { id: 'p2', name: '22 июн – 3 июл', start: '06-22', end: '07-03' },
    { id: 'p3', name: '4 июл – 9 авг', start: '07-04', end: '08-09' },
    { id: 'p4', name: '10–16 авг', start: '08-10', end: '08-16' },
    { id: 'p5', name: '17–25 авг', start: '08-17', end: '08-25' },
  ],
  categoryRates: {
    'стандарт': {
      adultRates: { p1: 15000, p2: 17000, p3: 21000, p4: 17000, p5: 15000 },
      childRates: { p1: 14000, p2: 15000, p3: 17000, p4: 15000, p5: 14000 },
      extraBedRates: {},
      disabledDiscount: 3000,
    },
    'комфорт': {
      adultRates: { p1: 16000, p2: 19000, p3: 24000, p4: 19000, p5: 16000 },
      childRates: { p1: 14000, p2: 16000, p3: 19000, p4: 16000, p5: 14000 },
      extraBedRates: { p1: 15000, p2: 15000, p3: 17000, p4: 15000, p5: 15000 },
      disabledDiscount: 3000,
    },
    'эконом': {
      adultRates: { p1: 15000, p2: 15000, p3: 16000, p4: 15000, p5: 15000 },
      childRates: { p1: 13000, p2: 13000, p3: 14000, p4: 13000, p5: 13000 },
      extraBedRates: {},
      disabledDiscount: 2000,
    },
  },
}

// ─── Optimizer settings ──────────────────────────────────────────────────────

export type CompatRule = 'strict' | 'soft' | 'ignore'
export type FloorRule  = 'ignore' | 'soft' | 'strict'

export interface OptimizerSettings {
  // Правила совместимости
  capacityRule: CompatRule
  featuresRule: CompatRule
  floorRule:    FloorRule

  // Веса штрафов (целые числа, чем больше — тем строже)
  shortGapThreshold:        number  // окно ≤ N ночей считается "коротким"
  shortGapMultiplier:       number  // во сколько раз короткие окна хуже
  emptyNightPenalty:        number  // штраф за каждую пустую ночь
  floorChangePenalty:       number  // штраф за смену этажа (если floorRule = soft)
  capacityMismatchPenalty:  number  // штраф за несовпадение вместимости (если capacityRule = soft)
  featuresMismatchPenalty:  number  // штраф за несовпадение особенностей (если featuresRule = soft)

  // Защита
  protectPaidBookings: boolean      // не двигать брони с paidAmount > 0
  protectFlaggedIds:   string[]     // ID меток — брони с такими метками не двигать
  maxMovesPerRun:      number       // 0 = без лимита
  maxDaysAhead:        number       // 0 = весь горизонт; иначе только следующие N дней

  // Алгоритм
  enableLocalSearch:      boolean
  localSearchIterations:  number    // 50 / 200 / 1000
  preferSameRoom:         boolean   // при равном выигрыше — не двигать бронь с её исходного номера
}

export const OPTIMIZER_DEFAULTS: OptimizerSettings = {
  capacityRule: 'strict',
  featuresRule: 'strict',
  floorRule:    'soft',

  shortGapThreshold:       2,
  shortGapMultiplier:      5,
  emptyNightPenalty:       1,
  floorChangePenalty:      2,
  capacityMismatchPenalty: 10,
  featuresMismatchPenalty: 5,

  protectPaidBookings: true,
  protectFlaggedIds:   [],
  maxMovesPerRun:      0,
  maxDaysAhead:        0,

  enableLocalSearch:     true,
  localSearchIterations: 200,
  preferSameRoom:        true,
}

// ─── Filter settings ──────────────────────────────────────────────────────────

export interface FilterSettings {
  showBuilding: boolean
  showCategory: boolean
  showFloor: boolean
  showCapacity: boolean
  showFeatures: boolean
  collapsedByDefault: boolean
}

export const FILTER_DEFAULTS: FilterSettings = {
  showBuilding: true,
  showCategory: true,
  showFloor: true,
  showCapacity: true,
  showFeatures: true,
  collapsedByDefault: false,
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface SettingsStore {
  visual: VisualSettings
  setVisual: <K extends keyof VisualSettings>(key: K, value: VisualSettings[K]) => void
  resetVisual: () => void

  roomFund: RoomFundConfig
  setRoomFund: (data: Partial<RoomFundConfig>) => void
  resetRoomFund: () => void

  pricing: PricingConfig
  setPricing: (data: Partial<PricingConfig>) => void
  resetPricing: () => void

  filterSettings: FilterSettings
  setFilterSetting: <K extends keyof FilterSettings>(key: K, value: FilterSettings[K]) => void
  resetFilterSettings: () => void

  optimizer: OptimizerSettings
  setOptimizer: <K extends keyof OptimizerSettings>(key: K, value: OptimizerSettings[K]) => void
  resetOptimizer: () => void

  // Скрытые метки броней (по code) — не показываются в форме брони. Сами метки не редактируются.
  hiddenFlagCodes: string[]
  toggleFlagHidden: (code: string) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      visual: VISUAL_DEFAULTS,
      setVisual: (key, value) =>
        set((s) => ({ visual: { ...s.visual, [key]: value } })),
      resetVisual: () => set({ visual: VISUAL_DEFAULTS }),

      roomFund: ROOM_FUND_DEFAULTS,
      setRoomFund: (data) =>
        set((s) => ({ roomFund: { ...s.roomFund, ...data } })),
      resetRoomFund: () => set({ roomFund: ROOM_FUND_DEFAULTS }),

      pricing: PRICING_DEFAULTS,
      setPricing: (data) =>
        set((s) => ({ pricing: { ...s.pricing, ...data } })),
      resetPricing: () => set({ pricing: PRICING_DEFAULTS }),

      filterSettings: FILTER_DEFAULTS,
      setFilterSetting: (key, value) =>
        set((s) => ({ filterSettings: { ...s.filterSettings, [key]: value } })),
      resetFilterSettings: () => set({ filterSettings: FILTER_DEFAULTS }),

      optimizer: OPTIMIZER_DEFAULTS,
      setOptimizer: (key, value) =>
        set((s) => ({ optimizer: { ...s.optimizer, [key]: value } })),
      resetOptimizer: () => set({ optimizer: OPTIMIZER_DEFAULTS }),

      hiddenFlagCodes: [],
      toggleFlagHidden: (code) =>
        set((s) => ({
          hiddenFlagCodes: s.hiddenFlagCodes.includes(code)
            ? s.hiddenFlagCodes.filter((c) => c !== code)
            : [...s.hiddenFlagCodes, code],
        })),
    }),
    {
      name: 'hotel_visual_settings',
      // Глубоко домешиваем дефолты к сохранённым настройкам, чтобы новые поля
      // (например, новые фильтры) появлялись у пользователей со старым localStorage.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsStore>
        return {
          ...current,
          ...p,
          visual:         { ...current.visual,         ...(p.visual ?? {}) },
          roomFund:       { ...current.roomFund,       ...(p.roomFund ?? {}) },
          pricing:        { ...current.pricing,        ...(p.pricing ?? {}) },
          filterSettings: { ...current.filterSettings, ...(p.filterSettings ?? {}) },
          optimizer:      { ...current.optimizer,      ...(p.optimizer ?? {}) },
        }
      },
    },
  ),
)
