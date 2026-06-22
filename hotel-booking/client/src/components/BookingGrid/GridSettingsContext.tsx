import React, { createContext, useContext } from 'react'
import { useSettingsStore } from '../../store/useSettingsStore'

export interface GridConstants {
  DAY_WIDTH: number
  ROW_HEIGHT: number
  ROOM_COL_WIDTH: number
  HEADER_HEIGHT: number
  BLOCK_PADDING: number
  BLOCK_RADIUS: number
  FONT_SIZE: number
  SHOW_FEATURE_ICONS: boolean
}

// Базовые значения из дизайн-хендоффа (GRID в buildGrid.ts) — 1:1 с демо.
// DAY_WIDTH ниже — это МИНИМУМ; реальная ширина дня растягивается, чтобы
// видимые дни (visibleDays) точно заполняли контейнер без хвоста и без обрезки.
const MIN_DAY_WIDTH = 46

const DEFAULT: GridConstants = {
  DAY_WIDTH: MIN_DAY_WIDTH,
  ROW_HEIGHT: 44,
  ROOM_COL_WIDTH: 208,
  HEADER_HEIGHT: 48,
  BLOCK_PADDING: 2,
  BLOCK_RADIUS: 6,
  FONT_SIZE: 13,
  SHOW_FEATURE_ICONS: true,
}

const GridSettingsContext = createContext<GridConstants>(DEFAULT)

interface Props {
  children: React.ReactNode
  /** Реальная ширина контейнера сетки в px (учитывает sidebar фильтра) */
  containerWidth: number
}

export const GridSettingsProvider: React.FC<Props> = ({ children, containerWidth }) => {
  const { visual } = useSettingsStore()
  // Колонка «Номер» фиксирована под демо; ширина дня растягивается так, чтобы
  // ровно visibleDays дней заполнили контейнер без пустого хвоста и без обрезки
  // (но не уже MIN_DAY_WIDTH — тогда появляется горизонтальный скролл).
  const availableWidth = Math.max(0, containerWidth - DEFAULT.ROOM_COL_WIDTH)
  const fitWidth = Math.floor(availableWidth / Math.max(1, visual.visibleDays))
  const DAY_WIDTH = Math.max(MIN_DAY_WIDTH, fitWidth)

  const value: GridConstants = {
    DAY_WIDTH,
    ROOM_COL_WIDTH:     DEFAULT.ROOM_COL_WIDTH,
    BLOCK_PADDING:      DEFAULT.BLOCK_PADDING,
    ROW_HEIGHT:         visual.rowHeight,
    HEADER_HEIGHT:      visual.headerHeight,
    BLOCK_RADIUS:       visual.blockRadius,
    FONT_SIZE:          visual.fontSize,
    SHOW_FEATURE_ICONS: visual.showFeatureIcons,
  }

  return (
    <GridSettingsContext.Provider value={value}>
      {children}
    </GridSettingsContext.Provider>
  )
}

export const useGridSettings = (): GridConstants => useContext(GridSettingsContext)
