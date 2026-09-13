/**
 * Стирает брони, смены, номера и категории (каскадом — и всё, что на них висит).
 *
 * Предохранитель (T13-001, аудит 2026-09-13): до этой правки скрипт брал
 * DATABASE_URL из `server/.env` — то есть РАБОЧУЮ базу разработчика — и стирал
 * её без единого вопроса, не печатая даже имени базы. Одна команда
 * `node scripts/clear.js`, набранная не в той папке (или запущенная агентом,
 * который увидел файл с таким именем), уничтожала живые данные; восстановление —
 * только из резервной копии. Теперь правила те же, что у соседнего
 * `demo-seed.js`: имя базы на экране, работа только с демо-/тестовой базой,
 * обязательное подтверждение ключом.
 *
 * Запуск:
 *   node scripts/clear.js --yes
 *   node scripts/clear.js --yes --allow-db=hotel_booking   (осознанно, на стенде)
 *
 * В поставку скрипт не входит: `scripts/**` отсечены фильтром сборки.
 */
const { PrismaClient } = require('@prisma/client')

const argv = process.argv.slice(2)
const hasFlag = (name) => argv.includes(`--${name}`)
const optValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}

/** Имя базы из строки подключения — то, что человек должен увидеть перед стиранием. */
function dbNameFromUrl(url) {
  return String(url || '').split('/').pop().split('?')[0]
}

/**
 * Можно ли стирать эту базу. Разрешено, если в имени есть «demo»/«audit»/«test»
 * либо имя названо явно: `--allow-db=<имя>`. Совпадение точное — «почти то же
 * имя» здесь означает «не та база».
 */
function isAllowed(dbName, allowDb) {
  if (/demo|audit|test/i.test(dbName)) return true
  return Boolean(dbName) && allowDb === dbName
}

async function main() {
  const dbName = dbNameFromUrl(process.env.DATABASE_URL)
  console.log(`База: ${dbName || '(DATABASE_URL не задан)'}`)

  if (!isAllowed(dbName, optValue('allow-db', ''))) {
    console.error(
      `\nБаза «${dbName}» не похожа на демо- или тестовую (в имени нет «demo»/«audit»/«test»).\n` +
      'Скрипт стирает брони, смены, номера и категории — и всё, что висит на них каскадом.\n' +
      `Если это точно не рабочая база — запусти с ключом --allow-db=${dbName}\n`,
    )
    process.exitCode = 1
    return
  }

  if (!hasFlag('yes')) {
    console.error(
      `\nБудут стёрты брони, смены, номера и категории базы «${dbName}».\n` +
      'Действие необратимо. Повтори с ключом --yes\n',
    )
    process.exitCode = 1
    return
  }

  const prisma = new PrismaClient()
  try {
    const b = await prisma.booking.deleteMany()
    const s = await prisma.shift.deleteMany()
    const r = await prisma.room.deleteMany()
    const c = await prisma.category.deleteMany()
    console.log(`Удалено: ${b.count} броней, ${s.count} смен, ${r.count} номеров, ${c.count} категорий`)
    console.log('Готово.')
  } finally {
    await prisma.$disconnect()
  }
}

// Модуль подключают тесты (`audit13-clear-guard.test.js`) — тогда ничего не запускаем.
if (require.main === module) {
  main().catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
}

module.exports = { dbNameFromUrl, isAllowed }
