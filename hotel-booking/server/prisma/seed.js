const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

const CATEGORIES = [
  { name: 'Люкс', color: '#D4A8E1', description: 'Люкс апартаменты' },
  { name: 'Полулюкс', color: '#B5D4F4', description: 'Улучшенный номер' },
  { name: 'Стандарт', color: '#C0DD97', description: 'Стандартный номер' },
  { name: 'Эконом', color: '#FAC775', description: 'Эконом класс' },
]

const BUILDINGS = ['А', 'Б']
const FLOORS = [1, 2, 3, 4, 5]

async function main() {
  console.log('Seeding database...')

  // Категории
  const categories = {}
  for (const cat of CATEGORIES) {
    const c = await prisma.category.upsert({
      where: { name: cat.name },
      create: cat,
      update: cat,
    })
    categories[cat.name] = c
    console.log(`Category: ${cat.name}`)
  }

  // 200 номеров: 2 корпуса × 5 этажей × 20 номеров
  const categoryKeys = Object.keys(categories)
  let roomNumber = 100
  let created = 0

  for (const building of BUILDINGS) {
    for (const floor of FLOORS) {
      for (let n = 1; n <= 20; n++) {
        const num = `${building}${floor}${String(n).padStart(2, '0')}`
        const categoryName = categoryKeys[Math.floor(Math.random() * categoryKeys.length)]
        const features = []
        if (Math.random() > 0.5) features.push('балкон')
        if (Math.random() > 0.7) features.push('вид на море')
        if (Math.random() > 0.5) features.push('двуспальная кровать')
        if (Math.random() > 0.8) features.push('джакузи')

        await prisma.room.upsert({
          where: { number: num },
          create: {
            number: num,
            building,
            floor,
            features,
            categoryId: categories[categoryName].id,
          },
          update: {},
        })
        created++
      }
    }
  }
  console.log(`Rooms created: ${created}`)

  // Super admin
  const hash = await bcrypt.hash('admin', 12)
  await prisma.admin.upsert({
    where: { username: 'admin' },
    create: { username: 'admin', password: hash, name: 'Главный администратор', role: 'SUPER_ADMIN' },
    update: {},
  })
  console.log('Super admin created: admin / admin')

  console.log('Seed complete!')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
