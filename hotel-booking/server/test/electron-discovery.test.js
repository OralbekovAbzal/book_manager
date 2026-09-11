import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Клиентская половина поиска хоста — `electron/lib/discovery.js`.
 *
 * Её зовёт сторож адреса на рабочем месте, и по её ответу программа
 * ПЕРЕЕЗЖАЕТ на другой адрес и перезапускается. Цена ошибки прямая: приняли
 * поддельный ответ — рабочее место ушло на чужой сервер и понесло туда логин с
 * паролем; не приняли настоящий — «нет связи с сервером» до прихода сисадмина.
 *
 * Отдельно проверяется, куда вообще летит широковещание: одного
 * `255.255.255.255` мало (Windows шлёт его в один интерфейс по таблице
 * маршрутизации), а лишний адрес в списке — это запрос в чужую сеть.
 *
 * Модуль не требует `electron` — грузится обычным require, как lib/disk.js.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/discovery.js')

function loadDiscovery() {
  delete requireCjs.cache[MODULE_PATH]
  return requireCjs(MODULE_PATH)
}

const {
  MAX_DATAGRAM, NONCE_RE, makeNonce, encodeQuery, parseReply,
  signedString, verifyReply, isPrivateAddress, broadcastTargets, findHosts,
} = loadDiscovery()

const NONCE = 'a3f19c0d5b7e4812a3f19c0d5b7e4812'

/** Настоящий подписанный ответ хоста — как его собирает сервер. */
function hostReply({ id = crypto.randomUUID(), port = 4780, nonce = NONCE, hotel = 'Туран', keys = null } = {}) {
  const pair = keys || crypto.generateKeyPairSync('ed25519')
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const sig = crypto.sign(null, Buffer.from(`${id}|${port}|${nonce}`, 'utf8'), pair.privateKey).toString('base64url')
  const reply = { roomline: 1, t: 'host', id, computer: 'RECEPTION', port, version: '1.0.0', nonce, sig, hotel }
  return { reply, publicKey, pair, buf: Buffer.from(JSON.stringify(reply), 'utf8') }
}

const ni = (over) => ({ family: 'IPv4', internal: false, ...over })

// ─── Куда летит широковещание ────────────────────────────────────────────────

describe('broadcastTargets — адреса запроса', () => {
  it('обычный ноутбук с Wi-Fi и кабелем: свой broadcast у каждой сети', () => {
    const targets = broadcastTargets({
      'Ethernet': [ni({ address: '192.168.1.7', netmask: '255.255.255.0' })],
      'Wi-Fi': [ni({ address: '10.5.3.44', netmask: '255.255.0.0' })],
    })

    expect(targets).toEqual(['255.255.255.255', '192.168.1.255', '10.5.255.255'])
  })

  it('255.255.255.255 в списке всегда — даже когда интерфейсов не видно', () => {
    // Без него на машине, где перечисление интерфейсов подвело, поиск не ушёл бы никуда.
    expect(broadcastTargets({})).toEqual(['255.255.255.255'])
    expect(broadcastTargets(null)).toEqual(['255.255.255.255'])
    expect(broadcastTargets({ 'Ethernet': [] })).toEqual(['255.255.255.255'])
  })

  it('loopback и IPv6 пропускаются — хост там не стоит', () => {
    const targets = broadcastTargets({
      'Loopback': [ni({ address: '127.0.0.1', netmask: '255.0.0.0', internal: true })],
      'Wi-Fi': [
        ni({ family: 'IPv6', address: 'fe80::1c2d', netmask: 'ffff:ffff:ffff:ffff::' }),
        ni({ address: '192.168.0.15', netmask: '255.255.255.0' }),
      ],
    })

    expect(targets).toEqual(['255.255.255.255', '192.168.0.255'])
  })

  it('интерфейс без маски пропускается, а не даёт кривой адрес', () => {
    // Так выглядят некоторые виртуальные адаптеры (VPN, Hyper-V).
    const targets = broadcastTargets({
      'VPN': [ni({ address: '172.20.0.4' })],
      'Ethernet': [ni({ address: '192.168.1.7', netmask: '255.255.255.0' })],
    })

    expect(targets).toEqual(['255.255.255.255', '192.168.1.255'])
  })

  it('два адреса одной сети не дают дубля — один запрос, один ответ', () => {
    const targets = broadcastTargets({
      'Ethernet': [ni({ address: '192.168.1.7', netmask: '255.255.255.0' })],
      'Ethernet 2': [ni({ address: '192.168.1.40', netmask: '255.255.255.0' })],
    })

    expect(targets).toEqual(['255.255.255.255', '192.168.1.255'])
  })

  it('битая маска не превращается в NaN-адрес', () => {
    const targets = broadcastTargets({
      'Странный': [ni({ address: '192.168.1.7', netmask: 'ерунда' })],
      'Короткий': [ni({ address: '192.168', netmask: '255.255.255.0' })],
    })

    expect(targets).toEqual(['255.255.255.255'])
  })

  it('сеть /16 и /8 считаются правильно', () => {
    const targets = broadcastTargets({
      'A': [ni({ address: '10.0.0.5', netmask: '255.0.0.0' })],
      'B': [ni({ address: '172.16.4.9', netmask: '255.255.0.0' })],
    })

    expect(targets).toEqual(['255.255.255.255', '10.255.255.255', '172.16.255.255'])
  })

  it('family числом (старые сборки Node) тоже понимается', () => {
    const targets = broadcastTargets({ 'Ethernet': [ni({ family: 4, address: '192.168.5.2', netmask: '255.255.255.0' })] })

    expect(targets).toContain('192.168.5.255')
  })
})

// ─── Проверка подписи ────────────────────────────────────────────────────────

describe('verifyReply — что мешает подделать хост', () => {
  it('настоящий ответ своего хоста проходит', () => {
    const { reply, publicKey } = hostReply()

    expect(verifyReply(reply, { nonce: NONCE, publicKey, id: reply.id })).toBe(true)
  })

  it('подменённый порт ломает подпись — на чужой порт рабочее место не уведут', () => {
    // Порт входит в подписываемую строку ровно за этим: иначе сосед по сети
    // переслал бы настоящий ответ, поменяв порт на свой поддельный сервер.
    const { reply, publicKey } = hostReply({ port: 4780 })

    reply.port = 4781

    expect(verifyReply(reply, { nonce: NONCE, publicKey, id: reply.id })).toBe(false)
  })

  it('чужой id отбрасывается до всякой криптографии', () => {
    const { reply, publicKey } = hostReply()

    expect(verifyReply(reply, { nonce: NONCE, publicKey, id: 'наш-собственный-id' })).toBe(false)
  })

  it('ответ, подписанный другой парой ключей, не проходит', () => {
    const mine = hostReply()
    const stranger = hostReply({ id: mine.reply.id })   // тот же id, свой ключ

    expect(verifyReply(stranger.reply, { nonce: NONCE, publicKey: mine.publicKey, id: mine.reply.id })).toBe(false)
  })

  it('ответ на чужой запрос (другой nonce) не годится — записанный не проиграть', () => {
    const { reply, publicKey } = hostReply({ nonce: 'b'.repeat(32) })

    expect(verifyReply(reply, { nonce: NONCE, publicKey, id: reply.id })).toBe(false)
  })

  it('ответ без подписи и с мусором вместо подписи — просто «нет», без падения', () => {
    const { reply, publicKey } = hostReply()

    expect(verifyReply({ ...reply, sig: '' }, { nonce: NONCE, publicKey, id: reply.id })).toBe(false)
    expect(verifyReply({ ...reply, sig: 'не-подпись' }, { nonce: NONCE, publicKey, id: reply.id })).toBe(false)
    expect(verifyReply(reply, { nonce: NONCE, publicKey: 'битый ключ', id: reply.id })).toBe(false)
    expect(verifyReply(null, { nonce: NONCE, publicKey, id: reply.id })).toBe(false)
    expect(verifyReply(reply, { nonce: NONCE, publicKey: null })).toBe(false)
  })

  it('подписываемая строка — `id|port|nonce`, и она одна на обе половины', () => {
    expect(signedString({ id: 'A', port: 4780, nonce: NONCE })).toBe(`A|4780|${NONCE}`)
  })
})

// ─── Разбор ответа ───────────────────────────────────────────────────────────

describe('parseReply — чужой мусор на широковещательном порту', () => {
  it('датаграмма длиннее 512 байт не разбирается', () => {
    const { reply } = hostReply({ hotel: 'Б'.repeat(300) })
    const fat = Buffer.from(JSON.stringify(reply), 'utf8')

    expect(fat.length).toBeGreaterThan(MAX_DATAGRAM)
    expect(parseReply(fat)).toBeNull()
  })

  it('ровно 512 байт ещё разбирается — граница не сдвинута', () => {
    const { reply } = hostReply({ hotel: '' })
    const base = Buffer.from(JSON.stringify(reply), 'utf8').length
    const padded = { ...reply, hotel: 'x'.repeat(MAX_DATAGRAM - base) }
    const buf = Buffer.from(JSON.stringify(padded), 'utf8')

    expect(buf.length).toBe(MAX_DATAGRAM)
    expect(parseReply(buf)).not.toBeNull()
  })

  it.each([
    ['не JSON', Buffer.from('привет', 'utf8')],
    ['пусто', Buffer.alloc(0)],
    ['массив', Buffer.from('[1,2]', 'utf8')],
    ['чужой протокол', Buffer.from(JSON.stringify({ roomline: 2, t: 'host', id: 'a', nonce: NONCE, port: 1 }))],
    ['не ответ хоста', Buffer.from(JSON.stringify({ roomline: 1, t: 'who', id: 'a', nonce: NONCE, port: 1 }))],
    ['без id', Buffer.from(JSON.stringify({ roomline: 1, t: 'host', nonce: NONCE, port: 1 }))],
    ['кривой nonce', Buffer.from(JSON.stringify({ roomline: 1, t: 'host', id: 'a', nonce: 'ZZ', port: 1 }))],
    ['порт 0', Buffer.from(JSON.stringify({ roomline: 1, t: 'host', id: 'a', nonce: NONCE, port: 0 }))],
    ['порт за пределами', Buffer.from(JSON.stringify({ roomline: 1, t: 'host', id: 'a', nonce: NONCE, port: 70000 }))],
    ['порт строкой-мусором', Buffer.from(JSON.stringify({ roomline: 1, t: 'host', id: 'a', nonce: NONCE, port: 'нет' }))],
  ])('%s — null', (_name, buf) => {
    expect(parseReply(buf)).toBeNull()
  })

  it('отсутствующие необязательные поля становятся пустыми строками, а не undefined', () => {
    const buf = Buffer.from(JSON.stringify({ roomline: 1, t: 'host', id: 'a', nonce: NONCE, port: 4780 }))

    expect(parseReply(buf)).toMatchObject({ computer: '', hotel: '', version: '', sig: '' })
  })
})

// ─── Мелочи протокола ────────────────────────────────────────────────────────

describe('nonce и запрос', () => {
  it('nonce — 32 шестнадцатеричные цифры и каждый раз новый', () => {
    const a = makeNonce()
    const b = makeNonce()

    expect(NONCE_RE.test(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('«кто здесь» уходит без id, «где мой хост» — с id', () => {
    expect(JSON.parse(encodeQuery({ t: 'who', nonce: NONCE }).toString()))
      .toEqual({ roomline: 1, t: 'who', nonce: NONCE })
    expect(JSON.parse(encodeQuery({ t: 'find', id: 'X', nonce: NONCE }).toString()))
      .toEqual({ roomline: 1, t: 'find', id: 'X', nonce: NONCE })
  })

  it('запрос укладывается в датаграмму с большим запасом', () => {
    expect(encodeQuery({ t: 'find', id: crypto.randomUUID(), nonce: makeNonce() }).length)
      .toBeLessThan(MAX_DATAGRAM)
  })
})

describe('isPrivateAddress — ответу из интернета не подчиняемся', () => {
  it.each(['10.0.0.5', '172.16.0.1', '172.31.0.1', '192.168.1.7', '169.254.1.1', '127.0.0.1',
    '::ffff:192.168.1.7', '::FFFF:10.0.0.1'])('%s — своя сеть', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true)
  })

  it.each(['8.8.8.8', '172.15.255.255', '172.32.0.1', '192.169.0.1', '1.1.1.1', '', null, undefined,
    'fe80::1', '256.1.1.1'])('%s — чужая сеть', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false)
  })
})

// ─── Поиск, когда никто не отвечает ──────────────────────────────────────────

describe('findHosts — поиск не роняет программу', () => {
  it('никто не ответил — пустой список, а не ошибка', async () => {
    const hosts = await findHosts({ port: 59999, targets: ['127.0.0.1'], timeoutMs: 120 })

    expect(hosts).toEqual([])
  })

  it('сокет не создался (нет прав, нет сети) — тоже пустой список', async () => {
    const dgram = { createSocket() { throw new Error('EPERM') } }

    await expect(findHosts({ port: 4781, targets: ['127.0.0.1'], timeoutMs: 50, dgram })).resolves.toEqual([])
  })

  it('ошибка сокета во время поиска отдаёт то, что успели собрать', async () => {
    const handlers = {}
    const dgram = {
      createSocket: () => ({
        on(ev, fn) { handlers[ev] = fn },
        bind(_p, cb) { setTimeout(() => { cb(); handlers.error?.(new Error('ENETDOWN')) }, 0) },
        setBroadcast() {},
        send() {},
        close() {},
      }),
    }

    await expect(findHosts({ port: 4781, targets: ['127.0.0.1'], timeoutMs: 5000, dgram })).resolves.toEqual([])
  })
})
