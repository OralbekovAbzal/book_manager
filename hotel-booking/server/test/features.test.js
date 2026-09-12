/**
 * Заслонка разделов, не вошедших в 1.0 (utils/features.js).
 *
 * Проверяем не «флаг равен false», а последствие для пользователя: без
 * FEATURE_PREVIEW роуты оптимизатора и снимков отвечают 404 с кодом FEATURE_OFF,
 * а с ним — пропускают запрос дальше. Модуль читает env при загрузке, поэтому
 * перед каждым сценарием он грузится заново.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../src/utils/features.js')

function loadFeatures(preview) {
  delete requireCjs.cache[MODULE_PATH]
  if (preview) process.env.FEATURE_PREVIEW = '1'
  else delete process.env.FEATURE_PREVIEW
  return requireCjs(MODULE_PATH)
}

function fakeRes() {
  const res = { statusCode: 200, body: null }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; return res }
  return res
}

afterEach(() => { delete process.env.FEATURE_PREVIEW })

describe('заслонка разделов не из 1.0', () => {
  it('без FEATURE_PREVIEW оптимизатор и откат к снимкам закрыты', () => {
    const { FEATURES } = loadFeatures(false)
    expect(FEATURES.optimizer).toBe(false)
    expect(FEATURES.snapshotRestore).toBe(false)
  })

  it('закрытый раздел отвечает 404 с кодом FEATURE_OFF и не пускает дальше', () => {
    const { requireFeature } = loadFeatures(false)
    const res = fakeRes()
    let passed = false
    requireFeature('optimizer')({}, res, () => { passed = true })
    expect(passed).toBe(false)
    expect(res.statusCode).toBe(404)
    expect(res.body.code).toBe('FEATURE_OFF')
    expect(res.body.error).toMatch(/не входит в эту версию/)
  })

  it('с FEATURE_PREVIEW=1 запрос проходит дальше без ответа', () => {
    const { requireFeature, FEATURES } = loadFeatures(true)
    expect(FEATURES.snapshotRestore).toBe(true)
    const res = fakeRes()
    let passed = false
    requireFeature('snapshotRestore')({}, res, () => { passed = true })
    expect(passed).toBe(true)
    expect(res.body).toBeNull()
  })

  it('неизвестное имя раздела — закрыто, а не открыто по умолчанию', () => {
    const { requireFeature } = loadFeatures(true)
    const res = fakeRes()
    requireFeature('чего-то-нет')({}, res, () => {})
    expect(res.statusCode).toBe(404)
  })
})
