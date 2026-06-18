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

const MIN_DAY_WIDTH = 24

const DEFAULT: GridConstants = {
  DAY_WIDTH: 44,
  ROW_HEIGHT: 44,
  ROOM_COL_WIDTH: 192,
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

  // Ширина колонки «Номер» вычисляется автоматически по размеру шрифта.
  // При fontSize=13 (стандарт) ≈ 143px, при fontSize=11 (компактный) ≈ 121px
  const ROOM_COL_WIDTH = Math.max(104, Math.round(visual.fontSize * 11))

  // DAY_WIDTH вычисляется по реальной ширине контейнера, а не window.innerWidth
  const availableWidth = Math.max(0, containerWidth - ROOM_COL_WIDTH)
  const computedDayWidth = Math.max(
    MIN_DAY_WIDTH,
    Math.floor(availableWidth / Math.max(1, visual.visibleDays))
  )

  const value: GridConstants = {
    DAY_WIDTH:          computedDayWidth,
    ROW_HEIGHT:         visual.rowHeight,
    ROOM_COL_WIDTH:     ROOM_COL_WIDTH,
    HEADER_HEIGHT:      visual.headerHeight,
    BLOCK_PADDING:      2,
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
