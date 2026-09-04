import React, { useEffect, useState } from 'react'
import { ctl } from './ui'

/**
 * Поля, которые пишут в определение только по blur/Enter.
 * Списки («a, b, c») и опции («значение | подпись») нельзя разбирать на каждую
 * букву: ввод «a, » тут же схлопывался бы в «a», и курсор прыгал бы.
 */

export const DeferredText: React.FC<{
  value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; style?: React.CSSProperties
}> = ({ value, onCommit, placeholder, mono, style }) => {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  const commit = () => { if (text !== value) onCommit(text) }
  return (
    <input
      value={text}
      placeholder={placeholder}
      className={mono ? 'mono' : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
      style={{ ...ctl, width: '100%', ...style }}
    />
  )
}

export const DeferredArea: React.FC<{
  value: string; onCommit: (v: string) => void; placeholder?: string; rows?: number
}> = ({ value, onCommit, placeholder, rows = 4 }) => {
  const [text, setText] = useState(value)
  useEffect(() => { setText(value) }, [value])
  return (
    <textarea
      value={text}
      rows={rows}
      placeholder={placeholder}
      className="mono"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { if (text !== value) onCommit(text) }}
      style={{ ...ctl, height: 'auto', padding: '6px 8px', width: '100%', resize: 'vertical', lineHeight: 1.4, fontSize: '0.76rem' }}
    />
  )
}
