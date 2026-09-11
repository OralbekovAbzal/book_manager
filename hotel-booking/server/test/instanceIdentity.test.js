import { describe, it, expect, afterEach, vi } from 'vitest'
import crypto from 'node:crypto'
import { loadCjs } from './helpers/loadCjs.js'
import { createFakePrisma } from './helpers/fakePrisma.js'

/**
 * Личность установки (`utils/instanceIdentity.js`) — то, по чему рабочее место
 * узнаёт СВОЙ хост в локальной сети.
 *
 * Чем оплачивается ошибка:
 *  • две личности у одной базы — половина рабочих мест ищет хост с id, которого
 *    больше нет, и «программа перестала видеть сервер» у части стойки;
 *  • личность, не пережившая восстановление копии, — то же самое, но сразу у
 *    всех и ровно в тот день, когда старый ноутбук умер;
 *  • утёкший приватный ключ — любой ноутбук в сети может выдать себя за хост,
 *    и рабочие места понесут ему пароли.
 *
 * Поэтому тесты бьют не в «функция что-то вернула», а в четыре стыка: первый
 * старт на пустой базе, гонка двух процессов за одну строку настроек, лежащая
 * база и подмена строки после восстановления копии.
 */

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

/** Свежий экземпляр модуля: кэш личности модульный, между тестами не делится. */
function load() {
  const logger = makeLogger()
  const mod = loadCjs('src/utils/instanceIdentity.js', { stubs: { './logger': logger } })
  return { ...mod, logger }
}

/** Строка HotelSettings после миграции 20260911190910: три поля есть, пустые. */
function settingsRow(over = {}) {
  return {
    id: 1,
    name: 'Туран',
    instanceId: null,
    instancePublicKey: null,
    instancePrivateKey: null,
    ...over,
  }
}

/** Чужая (уже записанная кем-то) личность — в виде колонок базы. */
function foreignIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    instanceId: crypto.randomUUID(),
    instancePublicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    instancePrivateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

const DB_DOWN = "Can't reach database server"
const writes = (calls) => calls.filter((c) => ['create', 'update', 'updateMany', 'upsert'].includes(c.op))

afterEach(() => { vi.useRealTimers() })

// ─── Генерация ───────────────────────────────────────────────────────────────

describe('generateIdentity — пара ключей установки', () => {
  it('две установки никогда не получают одинаковый id', () => {
    const { generateIdentity } = load()

    const a = generateIdentity()
    const b = generateIdentity()

    expect(a.instanceId).not.toBe(b.instanceId)
    expect(a.instancePrivateKey).not.toBe(b.instancePrivateKey)
    expect(a.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('ключи кладутся в базу в PEM — их читает crypto без разбора формата', () => {
    const { generateIdentity } = load()

    const idn = generateIdentity()

    expect(idn.instancePublicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/)
    expect(idn.instancePrivateKey).toMatch(/^-----BEGIN PRIVATE KEY-----/)
    const sig = crypto.sign(null, Buffer.from('проверка'), idn.instancePrivateKey)
    expect(crypto.verify(null, Buffer.from('проверка'), idn.instancePublicKey, sig)).toBe(true)
  })
})

// ─── Первый старт ────────────────────────────────────────────────────────────

describe('ensureIdentity — первый старт', () => {
  it('на пустой базе заводит строку настроек вместе с личностью', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [] })
    const { ensureIdentity } = load()

    const idn = await ensureIdentity(prisma)

    expect(idn.id).toBeTruthy()
    expect(idn.privateKey).toMatch(/BEGIN PRIVATE KEY/)
    const created = calls.find((c) => c.op === 'create')
    expect(created.args.data.id).toBe(1)
    expect(prisma.hotelSettings.rows[0]).toMatchObject({ id: 1, instanceId: idn.id })
  })

  it('строка настроек уже есть (её создал мастер) — личность дописывается, название остаётся', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow({ name: 'Дорожник' })] })
    const { ensureIdentity } = load()

    const idn = await ensureIdentity(prisma)

    expect(prisma.hotelSettings.rows[0].name).toBe('Дорожник')
    expect(prisma.hotelSettings.rows[0].instanceId).toBe(idn.id)
  })

  it('запись идёт условно — «только если личности ещё нет»', async () => {
    // То самое условие, которое не даёт второму процессу затереть чужую личность.
    // Потеряется оно — и две копии программы на одном ноутбуке будут по очереди
    // менять id установки, а рабочие места — терять хост после каждого перезапуска.
    const { prisma, calls } = createFakePrisma({ hotelSettings: [settingsRow()] })
    const { ensureIdentity } = load()

    await ensureIdentity(prisma)

    const upd = calls.find((c) => c.op === 'updateMany')
    expect(upd.args.where).toEqual({ id: 1, instanceId: null })
  })

  it('второй запуск программы берёт ту же личность и в базу не пишет', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [settingsRow()] })
    const first = await load().ensureIdentity(prisma)

    calls.length = 0
    const second = await load().ensureIdentity(prisma)   // как после перезапуска сервера

    expect(second.id).toBe(first.id)
    expect(writes(calls)).toHaveLength(0)
  })

  it('id без ключей (битая строка) сам не чинится, но в журнале остаётся предупреждение', async () => {
    // Осознанное ограничение: дописать ключи к чужому id нельзя — подписи по ним
    // не сойдутся у рабочих мест. Молча жить без личности тоже нельзя: поиск
    // хоста в сети не работает, и человек должен узнать об этом из журнала.
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow({ instanceId: 'осиротевший-id' })] })
    const { ensureIdentity, logger } = load()

    const idn = await ensureIdentity(prisma)

    expect(idn).toBeNull()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/поиск хоста/i)
  })
})

// ─── Гонка двух процессов ────────────────────────────────────────────────────

describe('ensureIdentity — гонка за одну строку настроек', () => {
  it('проигравший гонку берёт чужую личность, а свою не навязывает', async () => {
    // Надзор Electron поднимает сервер через секунду после падения, и старый
    // процесс в этот момент может быть ещё жив. Две личности у одной базы
    // недопустимы — побеждает тот, кто записал первым.
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow()] })
    const winner = foreignIdentity()
    const mine = []
    prisma.hotelSettings.updateMany = async (args) => {
      mine.push(args.data)
      Object.assign(prisma.hotelSettings.rows[0], winner)   // соседний процесс успел раньше
      return { count: 0 }
    }
    const { ensureIdentity, logger } = load()

    const idn = await ensureIdentity(prisma)

    expect(idn.id).toBe(winner.instanceId)
    expect(idn.id).not.toBe(mine[0].instanceId)
    expect(prisma.hotelSettings.rows[0].instanceId).toBe(winner.instanceId)
    expect(logger.info).toHaveBeenCalled()
  })

  it('P2002 при создании строки — перечитываем и работаем с тем, что записал сосед', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [] })
    const winner = foreignIdentity()
    prisma.hotelSettings.create = async () => {
      prisma.hotelSettings.rows.push({ id: 1, name: 'Туран', ...winner })
      const e = new Error('Unique constraint failed on the fields: (id)')
      e.code = 'P2002'
      throw e
    }
    const { ensureIdentity } = load()

    const idn = await ensureIdentity(prisma)

    expect(idn.id).toBe(winner.instanceId)
  })

  it('строку создал сосед, но без личности — дописываем её сами', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [] })
    prisma.hotelSettings.create = async () => {
      prisma.hotelSettings.rows.push(settingsRow())      // так делает мастер первого запуска
      const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e
    }
    const { ensureIdentity } = load()

    const idn = await ensureIdentity(prisma)

    expect(idn).not.toBeNull()
    expect(prisma.hotelSettings.rows[0].instanceId).toBe(idn.id)
  })

  it('ошибка базы, не похожая на гонку, не проглатывается', async () => {
    // Иначе «нет места на диске» превратилось бы в тихий старт без личности.
    const { prisma } = createFakePrisma({ hotelSettings: [] })
    prisma.hotelSettings.create = async () => {
      const e = new Error('database is not accepting commands'); e.code = 'P2010'; throw e
    }
    const { ensureIdentity } = load()

    await expect(ensureIdentity(prisma)).rejects.toThrow(/not accepting/)
  })
})

// ─── Кэш и лежащая база ──────────────────────────────────────────────────────

describe('getIdentity — кэш на 30 секунд', () => {
  it('в пределах окна в базу не ходит — health зовут раз в секунду', async () => {
    const { prisma, calls } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { getIdentity } = load()

    const a = await getIdentity(prisma)
    calls.length = 0
    const b = await getIdentity(prisma)

    expect(b).toEqual(a)
    expect(calls).toHaveLength(0)
  })

  it('после восстановления копии хост объявляет новую личность — не позже чем через TTL', async () => {
    // Перенос на новый ноутбук: в строке настроек оказалась ЧУЖАЯ (правильная)
    // личность из копии, процесс сервера тот же. Без этого рабочие места не
    // нашли бы хост до перезапуска программы.
    vi.useFakeTimers()
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { getIdentity, CACHE_TTL_MS } = load()

    const before = await getIdentity(prisma)
    const restored = foreignIdentity()
    Object.assign(prisma.hotelSettings.rows[0], restored)

    vi.advanceTimersByTime(CACHE_TTL_MS - 1)
    expect((await getIdentity(prisma)).id).toBe(before.id)      // окно ещё не вышло

    vi.advanceTimersByTime(2)
    expect((await getIdentity(prisma)).id).toBe(restored.instanceId)
  })

  it('лежащая база отдаёт последнюю известную личность, а не ошибку', async () => {
    // Health и объявление хоста нужны ровно тогда, когда база лежит: только так
    // рабочее место отличит «хост не отвечает» от «хост жив, но ему плохо».
    vi.useFakeTimers()
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { getIdentity, CACHE_TTL_MS } = load()
    const known = await getIdentity(prisma)

    prisma.hotelSettings.findUnique = async () => { throw new Error(DB_DOWN) }
    vi.advanceTimersByTime(CACHE_TTL_MS + 1)

    expect(await getIdentity(prisma)).toEqual(known)
  })

  it('база лежала с самого начала — null, а не исключение', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [] })
    prisma.hotelSettings.findUnique = async () => { throw new Error(DB_DOWN) }
    const { getIdentity } = load()

    await expect(getIdentity(prisma)).resolves.toBeNull()
  })

  it('окно считается от попытки, а не от удачи: лежащая база не получает запрос на каждый health', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [] })
    const hits = vi.fn(async () => { throw new Error(DB_DOWN) })
    prisma.hotelSettings.findUnique = hits
    const { getIdentity } = load()

    for (let i = 0; i < 5; i++) await getIdentity(prisma)

    expect(hits).toHaveBeenCalledTimes(1)
  })

  it('свежая база отвечает «личности нет» — старую в этот момент не выдаём', async () => {
    vi.useFakeTimers()
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { getIdentity, CACHE_TTL_MS } = load()
    await getIdentity(prisma)

    Object.assign(prisma.hotelSettings.rows[0], settingsRow())   // базу подменили пустой
    vi.advanceTimersByTime(CACHE_TTL_MS + 1)

    expect(await getIdentity(prisma)).toBeNull()
  })

  it('resetIdentityCache стирает и значение, и время — иначе тесты делили бы личность', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const mod = load()
    await mod.getIdentity(prisma)

    mod.resetIdentityCache()
    prisma.hotelSettings.findUnique = async () => { throw new Error(DB_DOWN) }

    expect(await mod.getIdentity(prisma)).toBeNull()
  })
})

// ─── Что уходит наружу ───────────────────────────────────────────────────────

describe('publicIdentity и signChallenge', () => {
  it('наружу уходят только id и публичный ключ', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { ensureIdentity, publicIdentity } = load()
    const idn = await ensureIdentity(prisma)

    const pub = publicIdentity(idn)

    expect(Object.keys(pub).sort()).toEqual(['id', 'publicKey'])
    expect(JSON.stringify(pub)).not.toContain('PRIVATE')
  })

  it('без личности наружу не уходит даже пустой объект', () => {
    const { publicIdentity } = load()
    expect(publicIdentity(null)).toBeNull()
  })

  it('подпись вызова проверяется публичным ключом установки', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { ensureIdentity, signChallenge } = load()
    const idn = await ensureIdentity(prisma)
    const challenge = `${idn.id}|4780|${'a'.repeat(32)}`

    const sig = signChallenge(idn, challenge)

    expect(crypto.verify(null, Buffer.from(challenge, 'utf8'), idn.publicKey, Buffer.from(sig, 'base64url')))
      .toBe(true)
  })

  it('подпись привязана к строке вызова — под чужой nonce она не подходит', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { ensureIdentity, signChallenge } = load()
    const idn = await ensureIdentity(prisma)

    const sig = signChallenge(idn, `${idn.id}|4780|${'a'.repeat(32)}`)

    // Записанный ответ нельзя проиграть заново: nonce даёт клиент, и он другой.
    expect(crypto.verify(null, Buffer.from(`${idn.id}|4780|${'b'.repeat(32)}`, 'utf8'),
      idn.publicKey, Buffer.from(sig, 'base64url'))).toBe(false)
  })

  it('чужим ключом наша подпись не проверяется', async () => {
    const { prisma } = createFakePrisma({ hotelSettings: [settingsRow(foreignIdentity())] })
    const { ensureIdentity, signChallenge } = load()
    const idn = await ensureIdentity(prisma)
    const other = foreignIdentity()
    const challenge = `${idn.id}|4780|${'a'.repeat(32)}`

    const sig = signChallenge(idn, challenge)

    expect(crypto.verify(null, Buffer.from(challenge, 'utf8'), other.instancePublicKey,
      Buffer.from(sig, 'base64url'))).toBe(false)
  })

  it('без личности подписи нет — и это не исключение', () => {
    const { signChallenge } = load()
    expect(signChallenge(null, 'что угодно')).toBeNull()
  })

  it('битый приватный ключ не роняет ответ и не попадает в журнал', async () => {
    // Текст ошибки crypto умеет пересказывать разбираемые данные — ключ в лог уйти не должен.
    const { signChallenge, logger } = load()
    const broken = '-----BEGIN PRIVATE KEY-----\nмусор\n-----END PRIVATE KEY-----'

    const sig = signChallenge({ id: 'x', privateKey: broken }, 'x|1|n')

    expect(sig).toBeNull()
    expect(logger.warn).toHaveBeenCalled()
    expect(String(logger.warn.mock.calls[0][0])).not.toContain('BEGIN PRIVATE KEY')
  })
})
