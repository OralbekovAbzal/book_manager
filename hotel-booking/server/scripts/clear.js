const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const b = await prisma.booking.deleteMany()
  const s = await prisma.shift.deleteMany()
  const r = await prisma.room.deleteMany()
  const c = await prisma.category.deleteMany()
  console.log(`Удалено: ${b.count} броней, ${s.count} смен, ${r.count} номеров, ${c.count} категорий`)
}

main()
  .then(() => console.log('Готово.'))
  .catch(console.error)
  .finally(() => prisma.$disconnect())
