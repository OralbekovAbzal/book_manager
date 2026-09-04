import React, { useEffect, useState } from 'react'
import {
  fetchServices, createService, updateService, deleteService,
  fetchMealPlans, createMealPlan, updateMealPlan, deleteMealPlan, createServiceDefaults,
} from '../../api/services'
import type { MealPlan, Service, ServiceKind, ServiceUnit } from '../../types'
import { inputStyle, labelStyle, errorStyle, primaryBtn, secondaryBtn, formTitle } from '../Settings/sections/sectionUi'

/**
 * Питание и дополнительные услуги.
 *
 * Питание здесь — НЕ флаг брони, а обычные услуги (завтрак, обед, ужин по отдельности).
 * Поэтому «только завтрак» или «завтрак + ужин» выражаются без правок кода, а
 * «Полный пансион» / «Полупансион» — просто пресеты, включающие набор услуг.
 */

interface Props {
  kind: ServiceKind
  onToast: (msg: string) => void
}

const UNIT_LABELS: Record<ServiceUnit, string> = {
  per_person_night: 'за человека в сутки',
  per_night: 'за сутки (за номер)',
  per_person: 'за человека, разово',
  per_booking: 'разово за бронь',
}

const UNIT_HINTS: Record<ServiceUnit, string> = {
  per_person_night: 'Питание, аренда снаряжения — умножается на гостей и на ночи.',
  per_night: 'Парковка, сейф — умножается только на ночи.',
  per_person: 'Трансфер, экскурсия — умножается только на гостей.',
  per_booking: 'Поздний выезд, уборка — начисляется один раз.',
}

/**
 * Ноль — это НЕ «бесплатно», а незаполненный тариф: генератор начислений
 * (`server/src/utils/charges.js`) строку с нулевой ценой не создаёт вовсе.
 * Обед и ужин приходят из засева именно нулевыми — цены у каждого отеля свои.
 */
const hasPrice = (s: Service) => s.price > 0
/** Ни взрослой цены, ни детской — в брони такая услуга не добавит ничего. */
const isUnpriced = (s: Service) => !hasPrice(s) && !(s.childPrice != null && s.childPrice > 0)

interface FormState {
  name: string
  price: string
  childPrice: string
  unit: ServiceUnit
  includedByDefault: boolean
  isActive: boolean
}

const emptyForm = (kind: ServiceKind): FormState => ({
  name: '',
  price: '',
  childPrice: '',
  unit: kind === 'meal' ? 'per_person_night' : 'per_booking',
  includedByDefault: false,
  isActive: true,
})

export const ServicesTab: React.FC<Props> = ({ kind, onToast }) => {
  const [services, setServices] = useState<Service[]>([])
  const [plans, setPlans] = useState<MealPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm(kind))
  const [error, setError] = useState('')
  const [planEditId, setPlanEditId] = useState<number | 'new' | null>(null)
  const [planName, setPlanName] = useState('')
  const [planCodes, setPlanCodes] = useState<string[]>([])

  const load = () => {
    setLoading(true)
    Promise.all([fetchServices(kind), kind === 'meal' ? fetchMealPlans() : Promise.resolve([])])
      .then(([s, p]) => { setServices(s); setPlans(p as MealPlan[]) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [kind])

  // ─── Услуги ─────────────────────────────────────────────────────────────────
  const startEdit = (s?: Service) => {
    if (s) {
      setEditId(s.id)
      setForm({
        name: s.name,
        price: String(s.price),
        childPrice: s.childPrice != null ? String(s.childPrice) : '',
        unit: s.unit,
        includedByDefault: s.includedByDefault,
        isActive: s.isActive,
      })
    } else {
      setEditId('new')
      setForm(emptyForm(kind))
    }
    setError('')
  }

  const save = async () => {
    if (!form.name.trim()) { setError('Введите название'); return }
    const payload = {
      name: form.name,
      price: form.price === '' ? 0 : Number(form.price),
      // Пусто = «как у взрослых», поэтому именно null, а не 0.
      childPrice: form.childPrice === '' ? null : Number(form.childPrice),
      unit: form.unit,
      kind,
      includedByDefault: form.includedByDefault,
      isActive: form.isActive,
    }
    try {
      if (editId === 'new') await createService(payload)
      else if (typeof editId === 'number') await updateService(editId, payload)
      setEditId(null)
      load()
      onToast('Сохранено')
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } }
      setError(err?.response?.data?.error ?? 'Ошибка сохранения')
    }
  }

  const remove = async (s: Service) => {
    if (!confirm(`Удалить «${s.name}»?`)) return
    try { await deleteService(s.id); load(); onToast('Удалено') }
    catch { onToast('Не удалось удалить') }
  }

  // ─── Пресеты пансиона ───────────────────────────────────────────────────────
  const startPlan = (p?: MealPlan) => {
    if (p) { setPlanEditId(p.id); setPlanName(p.name); setPlanCodes([...p.serviceCodes]) }
    else { setPlanEditId('new'); setPlanName(''); setPlanCodes([]) }
  }

  const savePlan = async () => {
    if (!planName.trim()) { onToast('Введите название пресета'); return }
    try {
      if (planEditId === 'new') await createMealPlan({ name: planName, serviceCodes: planCodes })
      else if (typeof planEditId === 'number') await updateMealPlan(planEditId, { name: planName, serviceCodes: planCodes })
      setPlanEditId(null)
      load()
      onToast('Пресет сохранён')
    } catch { onToast('Не удалось сохранить пресет') }
  }

  const removePlan = async (p: MealPlan) => {
    if (!confirm(`Удалить пресет «${p.name}»?`)) return
    try { await deleteMealPlan(p.id); load(); onToast('Пресет удалён') }
    catch { onToast('Не удалось удалить') }
  }

  const makeDefaults = async () => {
    try { await createServiceDefaults(); load(); onToast('Стандартный набор создан') }
    catch { onToast('Не удалось создать набор') }
  }

  // Выключенные не считаем: их в брони и так не выбрать.
  const unpricedNames = services.filter(s => s.isActive && isUnpriced(s)).map(s => s.name)

  if (loading) {
    return <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-faint)' }}>Загрузка…</div>
  }

  return (
    <div style={{ maxWidth: 900, display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Список услуг */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>
            {kind === 'meal' ? 'Питание' : 'Дополнительные услуги'}
          </span>
          <span style={{ flex: 1 }} />
          {kind === 'meal' && services.length === 0 && (
            <button onClick={makeDefaults} style={secondaryBtn}>Создать стандартный набор</button>
          )}
          <button onClick={() => startEdit()} style={primaryBtn}>
            {kind === 'meal' ? 'Добавить приём пищи' : 'Добавить услугу'}
          </button>
        </div>

        {services.length === 0 ? (
          <div style={{
            padding: 20, border: '1px dashed var(--border)', borderRadius: 10,
            color: 'var(--text-faint)', fontSize: '0.88rem', textAlign: 'center',
          }}>
            {kind === 'meal'
              ? 'Питание не заведено. Нажмите «Создать стандартный набор» — появятся завтрак, обед, ужин и пресеты пансиона, останется проставить цены.'
              : 'Услуг пока нет. Добавьте трансфер, парковку, поздний выезд — всё, за что берёте отдельно.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {services.map(s => (
              <div key={s.id} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                background: 'var(--surface)', borderRadius: 10,
                border: `1px solid ${editId === s.id ? 'var(--accent)' : 'var(--border-subtle)'}`,
                opacity: s.isActive ? 1 : 0.55,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '0.92rem', fontWeight: 600 }}>
                    {s.name}
                    {!s.isActive && <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · выключено</span>}
                    {s.includedByDefault && (
                      <span style={{
                        marginLeft: 7, fontSize: '0.7rem', fontWeight: 600, padding: '2px 6px',
                        borderRadius: 5, background: 'var(--accent-bg)', color: 'var(--accent-text)',
                      }}>в тарифе</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.79rem', color: 'var(--text-faint)', marginTop: 2 }}>
                    {UNIT_LABELS[s.unit]}
                  </div>
                </div>

                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Ноль — это не «бесплатно», а незаполненный тариф: такая услуга
                      в брони ничего не добавит к сумме. Пишем это словами, иначе
                      «0 ₸» выглядит как осознанная цена. */}
                  <div style={{
                    fontSize: '0.9rem', fontWeight: 600,
                    color: hasPrice(s) ? 'var(--text)' : 'var(--s-out)',
                  }}>
                    {hasPrice(s) ? `${s.price.toLocaleString('ru-RU')} ₸` : 'цена не задана'}
                  </div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>
                    {s.childPrice != null ? `дети ${s.childPrice.toLocaleString('ru-RU')} ₸` : 'дети как взрослые'}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={() => startEdit(s)} style={secondaryBtn}>Изменить</button>
                  <button onClick={() => remove(s)} style={{ ...secondaryBtn, color: 'var(--s-overdue)' }}>Удалить</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Услуга без цены выглядит рабочей, но к сумме брони не добавляет ничего:
            администратор включает «Полный пансион», итог не меняется — и непонятно
            почему. Говорим об этом здесь, где цену и задают. */}
        {unpricedNames.length > 0 && (
          <div style={{
            marginTop: 10, padding: '9px 12px', borderRadius: 9,
            border: '1px solid var(--border-subtle)', background: 'var(--surface-2)',
            fontSize: '0.82rem', color: 'var(--text-muted)', lineHeight: 1.45,
          }}>
            Цена не задана: {unpricedNames.join(', ')}. В брони такие позиции к сумме
            ничего не добавляют — откройте «Изменить» и проставьте цену.
          </div>
        )}
      </div>

      {/* Пресеты пансиона — только для питания */}
      {kind === 'meal' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>Пресеты пансиона</span>
            <span style={{ flex: 1 }} />
            <button onClick={() => startPlan()} style={secondaryBtn}>Добавить пресет</button>
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)', marginBottom: 12, maxWidth: 620 }}>
            Пресет — это кнопка в брони, которая включает сразу набор приёмов пищи.
            Убрать из брони обед или ужин по отдельности можно и без пресета.
          </div>

          {plans.length === 0 ? (
            <div style={{
              padding: 16, border: '1px dashed var(--border)', borderRadius: 10,
              color: 'var(--text-faint)', fontSize: '0.86rem', textAlign: 'center',
            }}>Пресетов нет.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {plans.map(p => (
                <div key={p.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px',
                  background: 'var(--surface)', borderRadius: 10,
                  border: `1px solid ${planEditId === p.id ? 'var(--accent)' : 'var(--border-subtle)'}`,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: 2 }}>
                      {p.serviceCodes.length === 0
                        ? 'ничего не включено'
                        : p.serviceCodes
                            .map(c => services.find(s => s.code === c)?.name ?? c)
                            .join(' + ')}
                    </div>
                  </div>
                  <button onClick={() => startPlan(p)} style={secondaryBtn}>Изменить</button>
                  <button onClick={() => removePlan(p)} style={{ ...secondaryBtn, color: 'var(--s-overdue)' }}>Удалить</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Форма услуги */}
      {editId !== null && (
        <Modal
          title={editId === 'new'
            ? (kind === 'meal' ? 'Новый приём пищи' : 'Новая услуга')
            : 'Изменение услуги'}
          onClose={() => setEditId(null)}
          onSave={save}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Название">
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder={kind === 'meal' ? 'Завтрак' : 'Трансфер из аэропорта'} style={inputStyle} autoFocus />
            </Field>
            <Field label="Как начисляется">
              <select value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value as ServiceUnit })} style={inputStyle}>
                {(Object.keys(UNIT_LABELS) as ServiceUnit[]).map(u => (
                  <option key={u} value={u}>{UNIT_LABELS[u]}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', marginTop: -6 }}>
            {UNIT_HINTS[form.unit]}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Цена, ₸">
              <input value={form.price} onChange={e => setForm({ ...form, price: e.target.value })}
                placeholder="0" style={inputStyle} />
            </Field>
            <Field label="Детская цена, ₸">
              <input value={form.childPrice} onChange={e => setForm({ ...form, childPrice: e.target.value })}
                placeholder="как у взрослых" style={inputStyle} />
            </Field>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.86rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.includedByDefault}
              onChange={e => setForm({ ...form, includedByDefault: e.target.checked })} />
            Включать в новую бронь автоматически
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.86rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={form.isActive}
              onChange={e => setForm({ ...form, isActive: e.target.checked })} />
            Доступна для добавления в бронь
          </label>

          {error && <div style={errorStyle}>{error}</div>}
        </Modal>
      )}

      {/* Форма пресета */}
      {planEditId !== null && (
        <Modal
          title={planEditId === 'new' ? 'Новый пресет' : 'Изменение пресета'}
          onClose={() => setPlanEditId(null)}
          onSave={savePlan}
        >
          <Field label="Название">
            <input value={planName} onChange={e => setPlanName(e.target.value)}
              placeholder="Полупансион" style={inputStyle} autoFocus />
          </Field>
          <Field label="Что включено">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {services.length === 0 && (
                <span style={{ fontSize: '0.84rem', color: 'var(--text-faint)' }}>
                  Сначала заведите приёмы пищи.
                </span>
              )}
              {services.map(s => {
                const on = planCodes.includes(s.code)
                return (
                  <button
                    key={s.code}
                    type="button"
                    onClick={() => setPlanCodes(cs => on ? cs.filter(c => c !== s.code) : [...cs, s.code])}
                    style={{
                      height: 30, padding: '0 12px', borderRadius: 7, cursor: 'pointer',
                      fontFamily: 'inherit', fontSize: '0.85rem', fontWeight: on ? 600 : 500,
                      background: on ? 'var(--accent-bg)' : 'var(--surface-2)',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-subtle)'}`,
                      color: on ? 'var(--accent-text)' : 'var(--text-muted)',
                    }}
                  >{s.name}</button>
                )
              })}
            </div>
          </Field>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)' }}>
            Пустой набор — это «Без питания», такой пресет тоже имеет смысл.
          </div>
        </Modal>
      )}
    </div>
  )
}

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <label style={labelStyle}>{label}</label>
    {children}
  </div>
)

const Modal: React.FC<{
  title: string
  onClose: () => void
  onSave: () => void
  children: React.ReactNode
}> = ({ title, onClose, onSave, children }) => {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', h, true)
    return () => document.removeEventListener('keydown', h, true)
  }, [onClose])

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 600,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div style={{
        background: 'var(--bg)', borderRadius: 14, width: '100%', maxWidth: 560,
        maxHeight: 'calc(100vh - 96px)', display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ ...formTitle, fontSize: '1rem' }}>{title}</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {children}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px', borderTop: '1px solid var(--border-subtle)' }}>
          <button onClick={onClose} style={secondaryBtn}>Отмена</button>
          <button onClick={onSave} style={primaryBtn}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}
