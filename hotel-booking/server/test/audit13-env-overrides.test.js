/**
 * S13-011 (аудит 2026-09-13): служебные переменные окружения не должны работать
 * у клиента.
 *
 * `electron/main.js` собирает окружение сервера как `{ ...process.env, … }` —
 * то есть наследует всё окружение Windows. Переменная уровня пользователя
 * ставится обычным `setx`, без прав администратора, и подхватывается при
 * следующем запуске программы. Через это снимались пробный период, гейт
 * обслуживания и заслонка 1.0 (вместе с откатом всей базы к снимку).
 *
 * Граница — `NODE_ENV`: упакованный сервер стартует с `production`
 * (`electron/main.js`, env для дочернего процесса), разработка и тесты — нет.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

const saved = process.env.NODE_ENV

afterEach(() => {
  if (saved === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = saved
  delete process.env.ROOMLINE_TRIAL_DAYS
  delete process.env.ROOMLINE_BUILD_DATE
  delete process.env.QONAQ_BUILD_DATE
  delete process.env.FEATURE_PREVIEW
})

/** Загружает модуль так, как его увидит сервер при заданном NODE_ENV. */
function asEnv(env, relPath, opts) {
  process.env.NODE_ENV = env
  return loadCjs(relPath, opts)
}

describe('ROOMLINE_TRIAL_DAYS', () => {
  const trial = (env) => asEnv(env, 'src/utils/trial.js', {
    stubs: { './prisma': { prisma: {} }, './logger': silentLogger },
  })

  it('в разработке по-прежнему меняет длину пробного периода', () => {
    process.env.ROOMLINE_TRIAL_DAYS = '3650'
    expect(trial('test').evaluateTrial(new Date('2026-01-01T00:00:00Z')).days).toBe(3650)
  })

  it('в упакованной программе не читается — срок остаётся 14 дней', () => {
    process.env.ROOMLINE_TRIAL_DAYS = '3650'
    expect(trial('production').evaluateTrial(new Date('2026-01-01T00:00:00Z')).days).toBe(14)
  })

  it('«ROOMLINE_TRIAL_DAYS=0» тоже не закрывает программу у клиента', () => {
    process.env.ROOMLINE_TRIAL_DAYS = '0'
    const lib = trial('production')
    const state = lib.evaluateTrial(new Date(), new Date())
    expect(state.days).toBe(14)
    expect(state.expired).toBe(false)
  })
})

describe('ROOMLINE_BUILD_DATE / QONAQ_BUILD_DATE', () => {
  const license = (env) => asEnv(env, 'src/utils/license.js', {
    stubs: { './prisma': { prisma: {} }, './logger': silentLogger },
    append: 'module.exports.getBuildDate = getBuildDate',
  })

  it('в разработке переменная перебивает штамп сборки', () => {
    process.env.ROOMLINE_BUILD_DATE = '2028-01-31'
    expect(license('test').getBuildDate()).toBe('2028-01-31')
  })

  it('в упакованной программе дату сборки подменить нельзя', () => {
    process.env.ROOMLINE_BUILD_DATE = '2028-01-31'
    expect(license('production').getBuildDate()).not.toBe('2028-01-31')
  })

  it('прежнее имя QONAQ_BUILD_DATE закрыто так же', () => {
    process.env.QONAQ_BUILD_DATE = '2029-03-04'
    expect(license('production').getBuildDate()).not.toBe('2029-03-04')
  })
})

describe('FEATURE_PREVIEW', () => {
  const features = (env) => asEnv(env, 'src/utils/features.js')

  it('в разработке открывает оптимизатор и откат к снимкам', () => {
    process.env.FEATURE_PREVIEW = '1'
    const f = features('test').FEATURES
    expect(f.optimizer).toBe(true)
    expect(f.snapshotRestore).toBe(true)
  })

  it('у клиента откат к снимкам остаётся закрытым', () => {
    process.env.FEATURE_PREVIEW = '1'
    const lib = features('production')
    expect(lib.FEATURES.snapshotRestore).toBe(false)
    expect(lib.FEATURES.optimizer).toBe(false)

    // И заслонка на роуте продолжает отвечать 404, а не пропускать запрос
    let passed = false
    const res = { status: () => res, json: () => res }
    lib.requireFeature('snapshotRestore')({}, res, () => { passed = true })
    expect(passed).toBe(false)
  })
})
