import React from 'react'
import type { FieldErrors, HotelForm } from './setupModel'
import { Field, StepHeading, wizardInput } from './setupUi'

interface Props {
  value: HotelForm
  errors: FieldErrors<HotelForm>
  onChange: (patch: Partial<HotelForm>) => void
}

// Шаг 1 — отель: название (обязательно) и город (по желанию).
export const StepHotel: React.FC<Props> = ({ value, errors, onChange }) => (
  <>
    <StepHeading
      title="Отель"
      text="Название показывается в шапке программы и в меню. Город — для справки, его можно не указывать."
    />
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field label="Название отеля" error={errors.name}>
        <input
          value={value.name}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="Например: Гранд Алатау"
          style={wizardInput}
          maxLength={120}
          autoFocus
        />
      </Field>
      <Field label="Город" error={errors.city} hint="Необязательно">
        <input
          value={value.city}
          onChange={e => onChange({ city: e.target.value })}
          placeholder="Алматы"
          style={wizardInput}
          maxLength={80}
        />
      </Field>
    </div>
  </>
)
