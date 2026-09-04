import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Корень пакета server/ — от него считаются пути к тестируемым модулям. */
export const SERVER_ROOT = path.resolve(here, '..', '..')

/**
 * Загружает CommonJS-модуль сервера СВЕЖИМ экземпляром, подменяя часть его
 * зависимостей (обычно `prisma`), не трогая при этом исходный файл на диске.
 *
 * Зачем так, а не `vi.mock`:
 *  - модули сервера — CommonJS, а тесты — ESM; ручная загрузка снимает вопросы интеропа;
 *  - каждый вызов даёт НОВЫЙ экземпляр модуля, поэтому модульное состояние
 *    (кэш эффектов меток в flagEffects.js) не протекает между тестами;
 *  - `append` позволяет достать функции, которые модуль не экспортирует
 *    (чистые функции оптимизатора), не редактируя сам модуль.
 *
 * @param {string} relPath путь относительно server/, напр. 'src/utils/overlap.js'
 * @param {{stubs?: Record<string, unknown>, append?: string}} opts
 *        stubs — карта «строка из require() → подменный модуль»
 *        append — код, дописываемый в конец модуля (видит его функции и `module`)
 */
export function loadCjs(relPath, { stubs = {}, append = '' } = {}) {
  const filename = path.resolve(SERVER_ROOT, relPath)
  const dirname = path.dirname(filename)
  const source = fs.readFileSync(filename, 'utf8')
  const realRequire = createRequire(filename)

  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id]
    return realRequire(id)
  }
  req.resolve = (id) => realRequire.resolve(id)
  req.cache = realRequire.cache

  const module = { exports: {} }
  const factory = new Function('exports', 'require', 'module', '__filename', '__dirname', `${source}\n${append}\n`)
  factory(module.exports, req, module, filename, dirname)
  return module.exports
}

/** Заглушка логгера — тесты не должны писать в server/logs/. */
export const silentLogger = {
  info() {}, warn() {}, error() {}, debug() {}, verbose() {},
}
