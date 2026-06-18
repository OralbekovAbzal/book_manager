const router = require('express').Router()
const { authenticate, requireRole } = require('../middleware/auth')
const { prisma } = require('../utils/prisma')

router.get('/status', authenticate, async (_req, res, next) => {
  try {
    const license = await prisma.license.findUnique({ where: { id: 1 } })
    if (!license) {
      return res.json({ active: false, message: 'Лицензия не активирована' })
    }
    const expired = new Date() > license.expiresAt
    res.json({
      active: license.isActive && !expired,
      expiresAt: license.expiresAt,
      expired,
    })
  } catch (err) {
    next(err)
  }
})

router.post('/activate', authenticate, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { key, hardwareId } = req.body
    if (!key || !hardwareId) {
      return res.status(400).json({ error: 'Ключ и Hardware ID обязательны' })
    }
    // Верификация ключа на сервере лицензий
    const response = await fetch(`${process.env.LICENSE_SERVER_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, hardwareId }),
    })
    if (!response.ok) {
      return res.status(400).json({ error: 'Недействительный ключ лицензии' })
    }
    const { expiresAt } = await response.json()
    await prisma.license.upsert({
      where: { id: 1 },
      create: { id: 1, key, hardwareId, expiresAt: new Date(expiresAt), isActive: true },
      update: { key, hardwareId, expiresAt: new Date(expiresAt), isActive: true },
    })
    res.json({ message: 'Лицензия активирована', expiresAt })
  } catch (err) {
    next(err)
  }
})

module.exports = router
