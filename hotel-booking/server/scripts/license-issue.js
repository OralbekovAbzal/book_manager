#!/usr/bin/env node
/**
 * Выпуск лицензионных ключей Roomline PMS — инструмент РАЗРАБОТЧИКА.
 *
 * Папка scripts/ исключена из сборки Electron (electron/package.json → filter),
 * поэтому к клиенту этот файл не уезжает. Приватного ключа в репозитории нет и
 * быть не должно — он лежит в OneDrive, чтобы пережить переустановку системы:
 * без него новые ключи выпускать НЕЧЕМ, перевыпустить пару = перевыпустить все
 * ключи всем клиентам.
 *
 * Вся арифметика — в server/src/utils/license.js (issueLicense). Здесь только
 * разбор аргументов и файлы: позже этот же issueLicense позовёт первый экран
 * отдельного приложения «для себя», и логика не должна раздваиваться.
 *
 * Использование:
 *   node scripts/license-issue.js --keygen
 *   node scripts/license-issue.js --hotel "База отдыха «Туран»" --rooms 45 --until 2027-09-06
 *   … --out "C:\путь\Туран.key.txt"      сохранить ключ в файл
 *   … --check "ROOMLINE-…"               проверить готовый ключ этой сборкой
 *                                        (ключи QONAQ-… прежнего образца тоже принимаются)
 */

const fs = require('fs')
const path = require('path')
const {
  issueLicense,
  generateKeyPair,
  parseLicenseKey,
  isIsoDate,
  formatRu,
} = require('../src/utils/license')

// Куда кладём приватный ключ. OneDrive — сознательно: единственная копия на
// локальном диске умрёт вместе с диском.
// Прежние имена переменных (QONAQ_*) читаются как запасные: переименование продукта
// не повод искать, почему у разработчика перестал находиться приватный ключ.
// Имя самого файла .pem НЕ меняем — это существующий файл, а не текст для человека.
const KEYS_DIR =
  process.env.ROOMLINE_LICENSE_KEYS_DIR ||
  process.env.QONAQ_LICENSE_KEYS_DIR ||
  path.join('C:', 'Users', 'abzal', 'OneDrive', 'Desktop', 'Roomline — документы', '03 Ключи')
const PRIVATE_KEY_PATH =
  process.env.ROOMLINE_LICENSE_PRIVATE_KEY ||
  process.env.QONAQ_LICENSE_PRIVATE_KEY ||
  path.join(KEYS_DIR, 'qonaq-license-private.pem')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const name = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[name] = true
    } else {
      out[name] = next
      i++
    }
  }
  return out
}

function die(msg) {
  console.error(`\n  ОШИБКА: ${msg}\n`)
  process.exit(1)
}

function usage() {
  console.log(`
  Выпуск лицензионных ключей Roomline PMS

    node scripts/license-issue.js --keygen
        Создаёт пару ключей ОДИН РАЗ. Приватный → ${PRIVATE_KEY_PATH}
        Публичный печатает — его нужно вставить в server/src/utils/license.js.

    node scripts/license-issue.js --hotel "Название" --rooms 45 --until 2027-09-06
        Выпускает ключ. Необязательно: --issued 2026-09-06, --id <свой-id>,
        --out "путь\\к\\файлу.txt"

    node scripts/license-issue.js --check "ROOMLINE-…"
        Проверяет ключ публичным ключом ЭТОЙ сборки (что вставлен верный).
`)
}

function keygen() {
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    die(
      `приватный ключ уже существует:\n  ${PRIVATE_KEY_PATH}\n\n` +
        '  Перезаписывать нельзя: новая пара обесценит ВСЕ уже выпущенные ключи.\n' +
        '  Если пара действительно нужна новая — уберите файл руками и осознанно.',
    )
  }

  const { publicKeyPem, privateKeyPem } = generateKeyPair()
  fs.mkdirSync(KEYS_DIR, { recursive: true })
  fs.writeFileSync(PRIVATE_KEY_PATH, privateKeyPem, { encoding: 'utf8', mode: 0o600 })

  console.log(`
  Пара ключей создана.

  Приватный ключ сохранён:
    ${PRIVATE_KEY_PATH}
  Никому не показывать, в репозиторий не класть, из OneDrive не удалять.

  Публичный ключ — вставьте его в server/src/utils/license.js
  (константа PUBLIC_KEY_PEM), заменив то, что там сейчас:

${publicKeyPem.trimEnd()}
`)
}

function issue(args) {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    die(`приватного ключа нет:\n  ${PRIVATE_KEY_PATH}\n\n  Сначала: node scripts/license-issue.js --keygen`)
  }
  const hotel = typeof args.hotel === 'string' ? args.hotel : ''
  if (!hotel.trim()) die('нужен --hotel "Название объекта"')

  const rooms = Number(args.rooms)
  if (!Number.isInteger(rooms) || rooms < 1) die('нужен --rooms <целое число больше нуля>')

  const until = args.until
  if (!isIsoDate(until)) die('нужен --until ГГГГ-ММ-ДД (дата окончания обслуживания)')

  if (args.issued !== undefined && !isIsoDate(args.issued)) die('--issued должен быть ГГГГ-ММ-ДД')

  const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8')
  const { key, payload } = issueLicense(privateKeyPem, {
    hotel,
    rooms,
    maintenanceUntil: until,
    issuedAt: typeof args.issued === 'string' ? args.issued : undefined,
    id: typeof args.id === 'string' ? args.id : undefined,
  })

  // Немедленная самопроверка: ключ обязан проходить ту же проверку, что и в
  // программе. Если публичный ключ в license.js не от этой пары — узнать об этом
  // надо здесь, а не по телефону от клиента.
  const check = parseLicenseKey(key)
  if (!check.valid) {
    die(
      `выпущенный ключ не проходит проверку («${check.message}»).\n` +
        '  Скорее всего, PUBLIC_KEY_PEM в server/src/utils/license.js не от этой пары.',
    )
  }

  console.log(`
  Объект:        ${payload.hotel}
  Номеров:       ${payload.rooms}
  Выпущен:       ${formatRu(payload.issuedAt)}
  Обслуживание:  до ${formatRu(payload.maintenanceUntil)}
  Идентификатор: ${payload.id}

  Ключ:

${key}
`)

  if (typeof args.out === 'string') {
    const outPath = path.resolve(args.out)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    const text = [
      `Roomline PMS — лицензионный ключ`,
      `Объект:        ${payload.hotel}`,
      `Номеров:       ${payload.rooms}`,
      `Выпущен:       ${formatRu(payload.issuedAt)}`,
      `Обслуживание:  до ${formatRu(payload.maintenanceUntil)}`,
      `Идентификатор: ${payload.id}`,
      ``,
      key,
      ``,
    ].join('\r\n')
    fs.writeFileSync(outPath, text, 'utf8')
    console.log(`  Сохранено: ${outPath}\n`)
  }
}

function check(args) {
  const res = parseLicenseKey(String(args.check))
  if (!res.valid) die(`ключ не принят — ${res.message}`)
  const p = res.payload
  console.log(`
  Ключ верный.
  Объект:        ${p.hotel}
  Номеров:       ${p.rooms}
  Выпущен:       ${formatRu(p.issuedAt)}
  Обслуживание:  до ${formatRu(p.maintenanceUntil)}
  Идентификатор: ${p.id}
`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h || process.argv.length <= 2) return usage()
  if (args.keygen) return keygen()
  if (typeof args.check === 'string') return check(args)
  return issue(args)
}

main()
