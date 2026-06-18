const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')
const { createBackup } = require('../utils/backup')

router.use(authenticate)

router.get('/status', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`
    res.json({ server: 'ok', db: 'ok', timestamp: new Date().toISOString() })
  } catch (err) {
    next(err)
  }
})

router.post('/backup', requireRole('SUPER_ADMIN', 'ADMIN'), async (_req, res, next) => {
  try {
    const result = await createBackup()
    res.json(result)
  } catch (err) {
    next(err)
  }
})

module.exports = router
