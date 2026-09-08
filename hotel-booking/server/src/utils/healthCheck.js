/**
 * Живость базы для `/api/health`.
 *
 * До этого health отвечал 200 всегда — он не трогал базу вовсе. Из-за этого
 * упавший встроенный Postgres оставался незамеченным (D8-002): надзор Electron
 * видел «сервер жив», а стойка получала 503 на каждом действии.
 *
 * Таймаут обязателен: при лежащей базе pg-клиент не отвечает отказом, а висит
 * до собственного таймаута соединения, и health завис бы вместе с ним.
 */

/**
 * @param {{ $queryRaw: Function }} prisma
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<'ok'|'down'>}
 */
async function checkDb(prisma, { timeoutMs = 2000 } = {}) {
  let timer = null
  try {
    const probe = prisma.$queryRaw`SELECT 1`
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve('down'), timeoutMs)
    })
    const result = await Promise.race([probe.then(() => 'ok', () => 'down'), guard])
    return result === 'ok' ? 'ok' : 'down'
  } catch {
    return 'down'
  } finally {
    // Таймер снимаем всегда — иначе процесс не завершится, пока он не истечёт
    if (timer) clearTimeout(timer)
  }
}

module.exports = { checkDb }
