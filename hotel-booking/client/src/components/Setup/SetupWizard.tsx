import React, { useState } from 'react'
import { useAuthStore } from '../../store/useAuthStore'
import { completeSetup, SETUP_DONE_CODE } from '../../api/setup'
import { parseApiError, type ParsedApiError } from './accountRules'
import {
  type AdminForm, type FieldErrors, type HotelForm, type StaffDraft,
  buildPayload, emptyAdmin, emptyHotel, validateAdmin, validateHotel,
} from './setupModel'
import { StepHotel } from './StepHotel'
import { StepAdmin } from './StepAdmin'
import { StepUsers } from './StepUsers'
import { StepReview } from './StepReview'
import { StepRestore } from './StepRestore'
import { STEP_TITLES, StepHeading, Stepper, wizardPrimary, wizardSecondary } from './setupUi'

/**
 * Отказ «настройка уже выполнена»: сервер отвечает 409 с кодом `SETUP_DONE`,
 * когда отметки `setupCompletedAt` нет, а настоящие учётные записи в базе уже
 * есть (двое прошли мастер одновременно; отметка восстановилась из копии).
 *
 * Смотрим ИМЕННО на код, а не на статус: 409 отдаёт ещё и `P2002` из
 * errorHandler — гонка по занятому логину. Там мастер запрещать нельзя, надо
 * вернуть человека в форму и дать поменять логин, поэтому «любой 409» здесь
 * означал бы тупик вместо исправимой ошибки.
 *
 * Объявлено ДО компонента намеренно: объявление ниже падало бы при горячей
 * перезагрузке с «is not defined» (временная мёртвая зона), уже ловились дважды.
 */
function isSetupAlreadyDone(err: ParsedApiError): boolean {
  return err.code === SETUP_DONE_CODE
}

interface Props {
  /**
   * Вызывается, когда мастер закончен целиком: после `POST /setup/complete`,
   * установки сессии И шага переноса данных (его можно пропустить).
   */
  onComplete?: () => void
}

/**
 * Мастер первичной настройки. Показывается вместо экрана входа, пока в базе
 * нет ни одной учётной записи (GET /api/setup/status → needsSetup: true).
 * Шаги: отель → главный администратор → сотрудники (необязательно) → проверка.
 * По завершении сервер возвращает токен — входим сразу, без отдельного логина.
 */
export const SetupWizard: React.FC<Props> = ({ onComplete }) => {
  const { setSession, setHotelName } = useAuthStore()

  const [step, setStep] = useState(0)
  const [hotel, setHotel] = useState<HotelForm>(emptyHotel())
  const [admin, setAdmin] = useState<AdminForm>(emptyAdmin())
  const [staff, setStaff] = useState<StaffDraft[]>([])
  const [hotelErrors, setHotelErrors] = useState<FieldErrors<HotelForm>>({})
  const [adminErrors, setAdminErrors] = useState<FieldErrors<AdminForm>>({})
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<ParsedApiError | null>(null)
  /**
   * Настройка сохранена, дальше — предложение перенести данные с прошлого
   * компьютера. Отдельная фаза, а не пятый шаг: назад к формам отсюда нельзя
   * (учётная запись уже создана), и в нумерации шагов такому шагу не место.
   *
   * `done-elsewhere` — тупик мастера: сервер ответил 409, настройку выполнили
   * на другом рабочем месте. Сессии нет и не будет (авто-вход не случился),
   * единственный выход отсюда — экран входа.
   */
  const [phase, setPhase] = useState<'form' | 'restore' | 'done-elsewhere'>('form')

  const last = STEP_TITLES.length - 1

  const patchHotel = (p: Partial<HotelForm>) => { setHotel(h => ({ ...h, ...p })); setHotelErrors({}) }
  const patchAdmin = (p: Partial<AdminForm>) => { setAdmin(a => ({ ...a, ...p })); setAdminErrors({}) }

  // Проверяем только текущий шаг — остальные проверим при переходе на них и перед отправкой.
  const next = () => {
    if (step === 0) {
      const errs = validateHotel(hotel)
      if (Object.keys(errs).length) { setHotelErrors(errs); return }
    }
    if (step === 1) {
      const errs = validateAdmin(admin, staff)
      if (Object.keys(errs).length) { setAdminErrors(errs); return }
    }
    setServerError(null)
    setStep(s => Math.min(last, s + 1))
  }
  const back = () => setStep(s => Math.max(0, s - 1))

  const submit = async () => {
    // Финальная проверка всех шагов: логин администратора могли поменять уже после добавления сотрудников.
    const he = validateHotel(hotel)
    if (Object.keys(he).length) { setHotelErrors(he); setStep(0); return }
    const ae = validateAdmin(admin, staff)
    if (Object.keys(ae).length) { setAdminErrors(ae); setStep(1); return }

    setSubmitting(true)
    setServerError(null)
    try {
      const res = await completeSetup(buildPayload(hotel, admin, staff))
      setHotelName(hotel.name.trim())
      // Сессия нужна прямо сейчас: загрузка файла копии и восстановление идут
      // под токеном главного администратора. App шахматку пока не покажет —
      // мастер остаётся на экране, пока не закончится шаг переноса.
      setSession(res.token, res.admin)
      setPhase('restore')
    } catch (e) {
      const err = parseApiError(e, 'Не удалось завершить настройку')
      // Настройку успели выполнить в другом месте: показывать ошибку под формой
      // бессмысленно — повторное нажатие «Завершить» даст тот же 409. Уводим в
      // тупиковую фазу, откуда есть только вход. Сессии здесь нет (авто-вход не
      // состоялся), поэтому попадаем именно на экран входа, а не в шахматку.
      if (isSetupAlreadyDone(err)) setPhase('done-elsewhere')
      else setServerError(err)
    } finally {
      setSubmitting(false)
    }
  }

  const onFormSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting) return
    if (step === last) submit()
    else next()
  }

  const body = (
    <>
      {step === 0 && <StepHotel value={hotel} errors={hotelErrors} onChange={patchHotel} />}
      {step === 1 && <StepAdmin value={admin} errors={adminErrors} onChange={patchAdmin} />}
      {step === 2 && (
        <StepUsers
          staff={staff}
          admin={admin}
          onAdd={item => setStaff(list => [...list, item])}
          onRemove={key => setStaff(list => list.filter(s => s.key !== key))}
        />
      )}
      {step === 3 && <StepReview hotel={hotel} admin={admin} staff={staff} error={serverError} />}
    </>
  )

  const nextLabel =
    step === last ? (submitting ? 'Сохраняем…' : 'Завершить настройку')
    : step === 2 && staff.length === 0 ? 'Пропустить'
    : 'Далее'

  // На шаге «Сотрудники» своя форма добавления, поэтому «Далее» там — обычная кнопка,
  // а не submit обёртки (вложенные формы недопустимы).
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 28, gap: 10 }}>
      <button
        type="button"
        onClick={back}
        disabled={step === 0 || submitting}
        style={{ ...wizardSecondary, visibility: step === 0 ? 'hidden' : 'visible' }}
      >
        Назад
      </button>
      <button
        type={step === 2 ? 'button' : 'submit'}
        onClick={step === 2 ? next : undefined}
        disabled={submitting}
        style={{ ...wizardPrimary, opacity: submitting ? 0.7 : 1, cursor: submitting ? 'progress' : 'pointer' }}
      >
        {nextLabel}
      </button>
    </div>
  )

  return (
    // #root не скроллится (overflow hidden), поэтому прокрутка — на этой обёртке;
    // margin: auto у карточки центрирует её, когда она помещается, и не режет верх, когда нет.
    <div style={{
      height: '100vh', overflowY: 'auto', display: 'flex', padding: 24,
      background: 'var(--surface)', color: 'var(--text)',
    }}>
      <div style={{
        width: 640, maxWidth: '100%', margin: 'auto',
        background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 14,
        boxShadow: 'var(--shadow-md)', padding: '32px 36px 28px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8, background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '1.1rem',
          }}>H</div>
          <div style={{ lineHeight: 1.2 }}>
            <div style={{ fontWeight: 600, fontSize: '1rem' }}>Hotel Booking</div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>Первичная настройка</div>
          </div>
        </div>

        {phase === 'done-elsewhere' ? (
          <AlreadyDone onGoToLogin={() => onComplete?.()} />
        ) : phase === 'restore' ? (
          <StepRestore onDone={() => onComplete?.()} />
        ) : (
          <>
            <Stepper step={step} />
            {step === 2
              ? <div>{body}{footer}</div>
              : <form onSubmit={onFormSubmit} noValidate>{body}{footer}</form>}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Мастер закончился ничем: пока его заполняли, настройку выполнили на другом
 * рабочем месте. Введённые здесь отель и учётная запись не сохранены и уже не
 * будут — сообщаем об этом прямо, чтобы администратор не искал свой логин.
 *
 * Кнопка одна и ведёт ко входу: других осмысленных действий в этом состоянии нет.
 */
const AlreadyDone: React.FC<{ onGoToLogin: () => void }> = ({ onGoToLogin }) => (
  <>
    <StepHeading
      title="Настройка уже выполнена"
      text="Настройка уже выполнена на другом рабочем месте — войдите со своей учётной записью."
    />
    <div style={{
      padding: '12px 14px', borderRadius: 10, fontSize: '0.88rem', lineHeight: 1.5,
      background: 'var(--surface)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)',
    }}>
      Отель и учётные записи, введённые в этом мастере, не сохранены. Данные системы
      завела другая машина — войдите логином и паролем, которые задали там.
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 28 }}>
      <button type="button" onClick={onGoToLogin} style={wizardPrimary}>
        Перейти ко входу
      </button>
    </div>
  </>
)
