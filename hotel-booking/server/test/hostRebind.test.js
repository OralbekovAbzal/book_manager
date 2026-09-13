import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * Перепривязка рабочего места к хосту — `electron/lib/hostRebind.js`.
 *
 * Что это чинит. 13.09.2026 рабочее место после смены Wi-Fi не нашло хост само:
 * широковещание в новой сети не прошло, и человеку за стойкой пришлось искать
 * того, кто знает пароль сисадмина. Отсюда три вещи, которые здесь проверяются:
 *
 *  • адреса по ИМЕНИ компьютера хоста — второй путь мимо широковещания
 *    (`hostNameCandidates`): IP меняет DHCP, имя машины — нет;
 *  • признак «сеть сменилась» (`localIpv4s` + `addressSetChanged`) — по нему
 *    поиск начинается сразу, а не после отказов опроса;
 *  • решение по ответам «кто здесь» (`decideWhoRebind`) — единственное место,
 *    где рабочее место соглашается переехать на хост с ДРУГОЙ личностью.
 *    Ошибка здесь стоит либо «программа не находит свой хост никогда», либо
 *    «рабочее место ушло на чужой сервер и понесло туда пароли стойки».
 *
 * Модуль не требует `electron` — грузится обычным require, как lib/discovery.js.
 */

const requireCjs = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.resolve(here, '../../electron/lib/hostRebind.js')

const {
  normalizeComputer, sameComputer, portOfUrl, hostNameCandidates,
  localIpv4s, addressSetChanged, decideWhoRebind, rebindMessage,
} = requireCjs(MODULE_PATH)

/** Интерфейсы в формате os.networkInterfaces(). */
function ifaces(map) {
  const out = {}
  for (const [name, list] of Object.entries(map)) {
    out[name] = list.map((x) => (typeof x === 'string'
      ? { family: 'IPv4', internal: false, address: x, netmask: '255.255.255.0' }
      : x))
  }
  return out
}

// ─── Кандидаты по имени компьютера ───────────────────────────────────────────

describe('hostNameCandidates — адреса по имени компьютера хоста', () => {
  it('даёт имя и имя.local с портом текущего адреса', () => {
    // Порт задаёт сисадмин на хосте, и при переезде между сетями он не меняется —
    // меняется IP. Поэтому порт берём из сохранённого адреса, а не из воздуха.
    expect(hostNameCandidates({ computer: 'NB-HOST', serverUrl: 'http://192.168.1.50:4780' }))
      .toEqual(['http://NB-HOST:4780', 'http://NB-HOST.local:4780'])
  })

  it('адрес без порта — это порт 80, а не «порта нет»', () => {
    expect(hostNameCandidates({ computer: 'nb', serverUrl: 'http://192.168.1.50' }))
      .toEqual(['http://nb:80', 'http://nb.local:80'])
  })

  it('доменное имя вторым вариантом не обрастает', () => {
    // nb-host.local.local не резолвится нигде.
    expect(hostNameCandidates({ computer: 'nb-host.local', serverUrl: 'http://10.0.0.5:4780' }))
      .toEqual(['http://nb-host.local:4780'])
    expect(hostNameCandidates({ computer: 'nb.corp.kz', serverUrl: 'http://10.0.0.5:4780' }))
      .toEqual(['http://nb.corp.kz:4780'])
  })

  it('текущий адрес в кандидаты не попадает', () => {
    // Сторож только что убедился, что там не отвечают, — второй такой же запрос
    // это просто ещё четыре секунды тишины для человека за стойкой.
    expect(hostNameCandidates({ computer: 'NB-HOST', serverUrl: 'http://nb-host:4780' }))
      .toEqual(['http://NB-HOST.local:4780'])
  })

  it('имени нет — кандидатов нет (рабочее место прежней настройки)', () => {
    // Настроенные до 13.09.2026 рабочие места имени хоста не знают; для них всё
    // работает как раньше — по широковещанию.
    expect(hostNameCandidates({ computer: '', serverUrl: 'http://10.0.0.5:4780' })).toEqual([])
    expect(hostNameCandidates({ serverUrl: 'http://10.0.0.5:4780' })).toEqual([])
    expect(hostNameCandidates({ computer: null, serverUrl: 'http://10.0.0.5:4780' })).toEqual([])
  })

  it('адреса нет — кандидатов нет: порт брать неоткуда', () => {
    expect(hostNameCandidates({ computer: 'nb', serverUrl: '' })).toEqual([])
    expect(hostNameCandidates({ computer: 'nb' })).toEqual([])
  })

  it.each([
    ['пробел внутри', 'NB HOST'],
    ['слэш', 'nb/host'],
    ['двоеточие с портом', 'nb:9999'],
    ['@ в имени', 'nb@evil'],
    ['начинается с дефиса', '-nb'],
    ['кириллица', 'ноутбук'],
    ['перевод строки', 'nb\nhost'],
  ])('не имя компьютера (%s) — в адрес не подставляем', (_name, computer) => {
    // Имя приезжает из сети (health хоста) и идёт прямо в URL. Всё, что не
    // похоже на имя машины, — это попытка подсунуть свой адрес или порт.
    expect(hostNameCandidates({ computer, serverUrl: 'http://10.0.0.5:4780' })).toEqual([])
  })

  it('пробелы по краям имени срезаются, а не ломают адрес', () => {
    expect(hostNameCandidates({ computer: '  NB-HOST  ', serverUrl: 'http://10.0.0.5:4780' }))
      .toEqual(['http://NB-HOST:4780', 'http://NB-HOST.local:4780'])
  })

  it('порт не из диапазона — кандидатов нет', () => {
    expect(hostNameCandidates({ computer: 'nb', serverUrl: 'http://10.0.0.5:99999' })).toEqual([])
  })
})

describe('portOfUrl', () => {
  it.each([
    ['http://10.0.0.5:4780', 4780],
    ['10.0.0.5:4780', 4780],
    ['http://10.0.0.5', 80],
    ['https://10.0.0.5', 443],
    ['http://10.0.0.5:4780/', 4780],
    ['', null],
  ])('%s → %s', (url, port) => {
    expect(portOfUrl(url)).toBe(port)
  })
})

// ─── Имя компьютера: та же машина или нет ────────────────────────────────────

describe('sameComputer — то же имя компьютера', () => {
  it('регистр не важен: Windows его не различает', () => {
    expect(sameComputer('NB-HOST', 'nb-host')).toBe(true)
    expect(sameComputer('Nb-Host', 'NB-HOST')).toBe(true)
  })

  it('короткое имя и его mDNS-форма — одна машина', () => {
    expect(sameComputer('nb-host', 'nb-host.local')).toBe(true)
    expect(sameComputer('nb-host.local', 'NB-HOST')).toBe(true)
  })

  it('хвостовая точка абсолютного DNS-имени не мешает', () => {
    expect(sameComputer('nb-host.', 'nb-host')).toBe(true)
  })

  it('разные домены при одинаковой первой метке — РАЗНЫЕ машины', () => {
    // Иначе nb-host.evil выдал бы себя за nb-host.corp.
    expect(sameComputer('nb-host.corp', 'nb-host.evil')).toBe(false)
  })

  it('пустое имя не совпадает ни с чем, включая пустое', () => {
    expect(sameComputer('', '')).toBe(false)
    expect(sameComputer('nb', '')).toBe(false)
    expect(sameComputer(null, undefined)).toBe(false)
  })

  it('normalizeComputer не падает на чём угодно', () => {
    expect(normalizeComputer(undefined)).toBe('')
    expect(normalizeComputer(42)).toBe('42')
    expect(normalizeComputer('  NB.  ')).toBe('nb')
  })
})

// ─── Смена сети ──────────────────────────────────────────────────────────────

describe('localIpv4s + addressSetChanged — сеть сменилась', () => {
  it('берёт внешние IPv4 и сортирует их', () => {
    const list = localIpv4s(ifaces({
      'Wi-Fi': ['192.168.1.7'],
      Ethernet: ['10.0.0.4'],
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      'Wi-Fi 6': [{ family: 'IPv6', internal: false, address: 'fe80::1' }],
    }))

    expect(list).toEqual(['10.0.0.4', '192.168.1.7'])
  })

  it('family числом (Node 18+) читается так же, как строкой', () => {
    expect(localIpv4s(ifaces({ 'Wi-Fi': [{ family: 4, internal: false, address: '192.168.1.7' }] })))
      .toEqual(['192.168.1.7'])
  })

  it('порядок интерфейсов не считается сменой сети', () => {
    // os.networkInterfaces() порядок не гарантирует; без сортировки сторож
    // устраивал бы поиск на ровном месте каждые 15 секунд.
    const a = localIpv4s(ifaces({ 'Wi-Fi': ['192.168.1.7'], Eth: ['10.0.0.4'] }))
    const b = localIpv4s(ifaces({ Eth: ['10.0.0.4'], 'Wi-Fi': ['192.168.1.7'] }))

    expect(addressSetChanged(a, b)).toBe(false)
  })

  it('другой адрес того же интерфейса — смена сети', () => {
    expect(addressSetChanged(['192.168.1.7'], ['192.168.8.11'])).toBe(true)
  })

  it('адрес пропал (кабель выдернули) — тоже смена', () => {
    expect(addressSetChanged(['192.168.1.7', '10.0.0.4'], ['10.0.0.4'])).toBe(true)
    expect(addressSetChanged(['192.168.1.7'], [])).toBe(true)
  })

  it('первое измерение сменой не считается', () => {
    // Иначе программа начинала бы поиск хоста при каждом запуске.
    expect(addressSetChanged(null, ['192.168.1.7'])).toBe(false)
    expect(addressSetChanged(undefined, [])).toBe(false)
  })

  it('пустые интерфейсы не роняют', () => {
    expect(localIpv4s(null)).toEqual([])
    expect(localIpv4s({ 'Wi-Fi': null })).toEqual([])
    expect(localIpv4s({ 'Wi-Fi': [null] })).toEqual([])
  })
})

// ─── Решение по ответам «кто здесь» ──────────────────────────────────────────

const HOST_A = { id: 'aaa', computer: 'NB-HOST', url: 'http://192.168.8.11:4780' }
const HOST_B = { id: 'bbb', computer: 'NB-SECOND', url: 'http://192.168.8.12:4780' }

describe('decideWhoRebind — хост с тем же именем, но новой личностью', () => {
  it('ровно один хост и имя совпало — перепривязка', () => {
    // Программу на хосте переустановили (или развернули копию на другом
    // ноутбуке): пара ключей новая, по личности он не отзовётся уже никогда.
    const d = decideWhoRebind({ hosts: [HOST_A], hostComputer: 'nb-host' })

    expect(d.action).toBe('move')
    expect(d.host).toBe(HOST_A)
  })

  it('имя не совпало — не переезжаем, но называем, кого нашли', () => {
    const d = decideWhoRebind({ hosts: [HOST_B], hostComputer: 'NB-HOST' })

    expect(d.action).toBe('mismatch')
    expect(d.host).toBe(HOST_B)
  })

  it('в сети два хоста — не переезжаем даже при совпавшем имени', () => {
    // У первого клиента две базы отдыха одного владельца в одной сети. Угадывать,
    // чья стойка перед нами, нельзя.
    const d = decideWhoRebind({ hosts: [HOST_A, HOST_B], hostComputer: 'NB-HOST' })

    expect(d.action).toBe('ambiguous')
    expect(d.ids.sort()).toEqual(['aaa', 'bbb'])
  })

  it('один хост с двумя сетевыми картами — это один хост, а не два', () => {
    const second = { ...HOST_A, url: 'http://10.0.0.4:4780' }

    const d = decideWhoRebind({ hosts: [HOST_A, second], hostComputer: 'NB-HOST' })

    expect(d.action).toBe('move')
    expect(d.candidates).toEqual([HOST_A, second])
  })

  it('имя хоста не записано — решать нечем', () => {
    // Рабочее место прежней настройки: имени не знает, и «единственный хост в
    // сети» для него не повод куда-то ехать.
    expect(decideWhoRebind({ hosts: [HOST_A], hostComputer: '' }).action).toBe('none')
    expect(decideWhoRebind({ hosts: [HOST_A] }).action).toBe('none')
  })

  it('никто не ответил — none', () => {
    expect(decideWhoRebind({ hosts: [], hostComputer: 'NB-HOST' }).action).toBe('none')
    expect(decideWhoRebind({ hostComputer: 'NB-HOST' }).action).toBe('none')
    expect(decideWhoRebind().action).toBe('none')
  })

  it('мусор вместо ответов отбрасывается до решения', () => {
    const d = decideWhoRebind({
      hosts: [null, { id: 'aaa' }, { url: 'http://10.0.0.4:4780' }, HOST_A],
      hostComputer: 'NB-HOST',
    })

    expect(d.action).toBe('move')
    expect(d.host).toBe(HOST_A)
  })

  it('у решения всегда есть причина — её пишут в лог', () => {
    // По логу должно быть понятно, ПОЧЕМУ не перепривязались: это первое, что
    // спросят при звонке «программа не нашла хост».
    for (const d of [
      decideWhoRebind({ hosts: [HOST_A], hostComputer: 'nb-host' }),
      decideWhoRebind({ hosts: [HOST_B], hostComputer: 'NB-HOST' }),
      decideWhoRebind({ hosts: [HOST_A, HOST_B], hostComputer: 'NB-HOST' }),
      decideWhoRebind({ hosts: [], hostComputer: 'NB-HOST' }),
    ]) {
      expect(typeof d.reason).toBe('string')
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })
})

// ─── Текст для человека ──────────────────────────────────────────────────────

describe('rebindMessage — что видит человек у полосы «нет связи»', () => {
  it('нашли — адрес и обещание перезапуска', () => {
    const m = rebindMessage({ ok: true, url: 'http://192.168.8.11:4780' })

    expect(m.ok).toBe(true)
    expect(m.message).toContain('http://192.168.8.11:4780')
    expect(m.message).toContain('перезапускаю')
  })

  it('не нашли — что проверить руками, а не код ошибки', () => {
    const m = rebindMessage({ ok: false, reason: 'not-found' })

    expect(m.ok).toBe(false)
    expect(m.message).toContain('одной сети')
    expect(m.message).toContain('гостевая')
  })

  it('чужая установка — названа машина и сказано, к кому идти', () => {
    const m = rebindMessage({ ok: false, reason: 'other-install', computer: 'NB-SECOND' })

    expect(m.ok).toBe(false)
    expect(m.message).toContain('NB-SECOND')
    expect(m.message).toContain('сисадмин')
  })

  it('прежний адрес снова отвечает — так и говорим, а не «не найден»', () => {
    // Кнопку часто жмут в ту секунду, когда связь уже вернулась, а полоса ещё
    // висит. «Не найден» в этот момент — враньё, и человек звонит зря.
    const m = rebindMessage({ ok: false, reason: 'already-here' })

    expect(m.ok).toBe(false)
    expect(m.message).toContain('прежнему адресу')
  })

  it('на хосте кнопке делать нечего', () => {
    expect(rebindMessage({ ok: false, reason: 'not-client' }).message).toContain('хост')
  })

  it('ok без адреса — это не удача (иначе полоса врала бы)', () => {
    expect(rebindMessage({ ok: true }).ok).toBe(false)
    expect(rebindMessage({}).ok).toBe(false)
    expect(rebindMessage().ok).toBe(false)
  })
})
