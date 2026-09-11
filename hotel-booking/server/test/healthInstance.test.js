import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { loadCjs, silentLogger } from './helpers/loadCjs.js'

/**
 * `GET /api/health` — тело ответа (`utils/healthBody.js`).
 *
 * У этого ответа трое читателей, и каждому нужно своё:
 *  • надзор Electron ждёт `res.ok` перед тем, как показать окно;
 *  • «Проверить связь» на рабочем месте должна честно сказать «база лежит»;
 *  • сторож адреса хоста подтверждает по нему, что нашёл СВОЙ хост: шлёт
 *    одноразовый `nonce` и сверяет подпись с запомненным публичным ключом.
 *
 * Третий пункт — это последний рубеж перед переездом рабочего места на новый
 * адрес. Ошибка здесь стоит либо «программа потеряла хост навсегда» (подпись не
 * сходится), либо «рабочее место переехало на чужой ноутбук» (подпись сходится
 * там, где не должна).
 *
 * Строка подписи — `${id}|${nonce}` — повторена в `electron/main.js`
 * (`verifyHealthSignature`). Разъедутся они — сторож перестанет переезжать
 * вообще, и заметит это только тот, у кого сменился роутер.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

const identityMod = loadCjs('src/utils/instanceIdentity.js', { stubs: { './logger': silentLogger } })
const { buildHealthBody, NONCE_RE } = loadCjs('src/utils/healthBody.js', {
  stubs: { './instanceIdentity': identityMod },
})

function makeIdentity() {
  const gen = identityMod.generateIdentity()
  return { id: gen.instanceId, publicKey: gen.instancePublicKey, privateKey: gen.instancePrivateKey }
}

const NONCE = 'a3f19c0d5b7e4812a3f19c0d5b7e4812'

/** Ровно та проверка, которую делает сторож в `electron/main.js`. */
function verifyAsClient(instance, { nonce, publicKey, id }) {
  if (!instance || !instance.sig) return false
  if (instance.id !== id) return false
  return crypto.verify(null, Buffer.from(`${id}|${nonce}`, 'utf8'),
    publicKey, Buffer.from(String(instance.sig), 'base64url'))
}

// ─── Старое поведение health ─────────────────────────────────────────────────

describe('buildHealthBody — статус базы', () => {
  it('живая база — status ok', () => {
    const body = buildHealthBody({ db: 'ok' })

    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(Date.parse(body.timestamp)).not.toBeNaN()
  })

  it('лежащая база — degraded, как и до появления личности', () => {
    // Надзор Electron и клиентская «Проверить связь» читают именно эти два поля;
    // добавление блока instance не имело права их сдвинуть.
    const body = buildHealthBody({ db: 'down', identity: makeIdentity(), nonce: NONCE })

    expect(body.status).toBe('degraded')
    expect(body.db).toBe('down')
  })

  it('у лежащей базы личность всё равно объявляется', () => {
    // Иначе именно в аварии рабочее место решило бы, что подключилось не туда,
    // и «потеряло» хост — вместо того чтобы показать «хосту плохо с базой».
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'down', identity: idn, nonce: NONCE })

    expect(body.instance.id).toBe(idn.id)
    expect(verifyAsClient(body.instance, { nonce: NONCE, publicKey: idn.publicKey, id: idn.id })).toBe(true)
  })
})

// ─── Блок instance ───────────────────────────────────────────────────────────

describe('buildHealthBody — блок instance', () => {
  it('личности нет — блока нет вовсе, а не пустой объект', () => {
    // Пустой объект клиент записал бы себе как «личность хоста — ничто»,
    // и дальше не узнал бы свой хост никогда.
    const body = buildHealthBody({ db: 'ok', identity: null })

    expect(body).not.toHaveProperty('instance')
    expect(Object.keys(body).sort()).toEqual(['db', 'status', 'timestamp'])
  })

  it('без nonce отдаются только id и публичный ключ — подписывать нечего', () => {
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: idn })

    expect(body.instance).toEqual({ id: idn.id, publicKey: idn.publicKey })
    expect(body.instance).not.toHaveProperty('sig')
  })

  it('приватный ключ не уходит ни при каких аргументах', () => {
    const idn = makeIdentity()

    for (const nonce of [undefined, NONCE, 'мусор']) {
      const body = buildHealthBody({ db: 'ok', identity: idn, nonce })
      expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
    }
  })

  it('с валидным nonce подпись сходится у клиента', () => {
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: idn, nonce: NONCE })

    expect(verifyAsClient(body.instance, { nonce: NONCE, publicKey: idn.publicKey, id: idn.id })).toBe(true)
  })

  it('подпись под чужой nonce не подходит — записанный ответ не проиграть заново', () => {
    // Ровно это и защищает от «сосед по сети переслал старый ответ хоста».
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: idn, nonce: NONCE })

    expect(verifyAsClient(body.instance, { nonce: 'b3f19c0d5b7e4812a3f19c0d5b7e4812', publicKey: idn.publicKey, id: idn.id }))
      .toBe(false)
  })

  it('чужой хост со своей парой ключей проверку не проходит', () => {
    const mine = makeIdentity()
    const stranger = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: stranger, nonce: NONCE })

    expect(verifyAsClient(body.instance, { nonce: NONCE, publicKey: mine.publicKey, id: mine.id })).toBe(false)
  })

  it('каждый запрос получает свою подпись', () => {
    const idn = makeIdentity()
    const other = 'ffffffffffffffffffffffffffffffff'

    const a = buildHealthBody({ db: 'ok', identity: idn, nonce: NONCE })
    const b = buildHealthBody({ db: 'ok', identity: idn, nonce: other })

    expect(a.instance.sig).not.toBe(b.instance.sig)
  })
})

// ─── Кривой nonce ────────────────────────────────────────────────────────────

describe('buildHealthBody — кривой nonce это не ошибка', () => {
  it.each([
    ['слишком короткий', 'a3f19c0d'],
    ['слишком длинный', 'a'.repeat(33)],
    ['верхний регистр', 'A3F19C0D5B7E4812A3F19C0D5B7E4812'],
    ['не hex', 'zzz19c0d5b7e4812a3f19c0d5b7e4812'],
    ['пустая строка', ''],
    ['с пробелом', ' a3f19c0d5b7e4812a3f19c0d5b7e481'],
  ])('%s — ответ без подписи, но живой', (_name, nonce) => {
    // Health зовут надзор и мониторинг: уронить им проверку живости из-за
    // кривого параметра нельзя, 400 здесь дороже отсутствующей подписи.
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: idn, nonce })

    expect(body.status).toBe('ok')
    expect(body.instance).toEqual({ id: idn.id, publicKey: idn.publicKey })
  })

  it('nonce пришёл массивом (?nonce=a&nonce=b) — не падаем и не подписываем', () => {
    // Express отдаёт повторённый параметр массивом; String(массив) дал бы
    // подпись под строкой, которую выбрал чужой.
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: idn, nonce: [NONCE, NONCE] })

    expect(body.instance).not.toHaveProperty('sig')
  })

  it('nonce объектом (?nonce[x]=1) — то же самое', () => {
    const idn = makeIdentity()

    expect(() => buildHealthBody({ db: 'ok', identity: idn, nonce: { x: '1' } })).not.toThrow()
    expect(buildHealthBody({ db: 'ok', identity: idn, nonce: { x: '1' } }).instance).not.toHaveProperty('sig')
  })

  it('личность без приватного ключа не роняет health — просто без подписи', () => {
    const idn = makeIdentity()

    const body = buildHealthBody({ db: 'ok', identity: { id: idn.id, publicKey: idn.publicKey }, nonce: NONCE })

    expect(body.instance).not.toHaveProperty('sig')
    expect(body.status).toBe('ok')
  })

  it('вызов совсем без аргументов не падает', () => {
    expect(() => buildHealthBody()).not.toThrow()
    expect(buildHealthBody().status).toBe('degraded')
  })
})

describe('NONCE_RE — один формат на обе стороны', () => {
  it('принимает ровно 32 шестнадцатеричные цифры в нижнем регистре', () => {
    expect(NONCE_RE.test(NONCE)).toBe(true)
    expect(NONCE_RE.test(crypto.randomBytes(16).toString('hex'))).toBe(true)   // так его делает клиент
    expect(NONCE_RE.test(crypto.randomBytes(15).toString('hex'))).toBe(false)
  })

  it('это тот же формат, что у ответчика поиска хоста', () => {
    // Два разных регулярных выражения для одного nonce рано или поздно разъедутся.
    const udp = loadCjs('src/discovery/udpResponder.js', {
      stubs: { '../utils/instanceIdentity': identityMod },
    })
    expect(udp.NONCE_RE.source).toBe(NONCE_RE.source)
  })

  it('nonce, который делает рабочее место, сервер признаёт и подписывает', () => {
    // Самый дорогой способ разъехаться: клиент шлёт nonce в своём формате,
    // сервер молча отвечает без подписи — и сторож НИКОГДА не переезжает на
    // новый адрес хоста, потому что проверить его нечем.
    const { makeNonce } = requireCjs(path.resolve(here, '../../electron/lib/discovery.js'))
    const idn = makeIdentity()

    for (let i = 0; i < 20; i++) {
      const nonce = makeNonce()
      const body = buildHealthBody({ db: 'ok', identity: idn, nonce })
      expect(verifyAsClient(body.instance, { nonce, publicKey: idn.publicKey, id: idn.id }), nonce).toBe(true)
    }
  })
})
