import { describe, it, expect } from 'vitest'
import { loadCjs } from './helpers/loadCjs.js'

/**
 * ПД не должны попадать в логи (D1-004).
 *
 * Стойка ищет гостя по имени и телефону, и эти строки уезжают в query:
 * `/api/occupancy/grid?guestSearch=Асель`, `/api/guests/lookup?phone=+7701…`.
 * Каждая такая строка писалась в `combined.log` и в `host-debug.log` — два
 * открытых текстовых файла без ротации, которые целиком пересылают в
 * поддержку. Годовой архив персональных данных вне базы.
 *
 * Диагностическая ценность строки — в том, КАКОЙ путь и КАКИЕ фильтры звали.
 * Поэтому имена параметров остаются, значения отбрасываются.
 *
 * Главная граница здесь — «отбрасываются» должно значить «их нет в результате
 * ни в каком виде»: ни как есть, ни в процентном кодировании. Наполовину
 * вырезанное имя гостя — та же утечка, только незаметная при чтении кода.
 */

const { safeUrl } = loadCjs('src/utils/logSafe.js')

describe('safeUrl — строка запроса, пригодная для лога', () => {
  it('запрос без параметров остаётся как есть', () => {
    expect(safeUrl('/api/bookings/151')).toBe('/api/bookings/151')
  })

  it('поиск по имени гостя: остаются имена параметров, значений нет', () => {
    const url = '/api/occupancy/grid?dateFrom=2024-06-23&guestSearch=%D0%90%D1%81%D0%B5%D0%BB%D1%8C'
    expect(safeUrl(url)).toBe('/api/occupancy/grid?keys=dateFrom,guestSearch')
  })

  it('в результате нет ни имени гостя, ни его процентного кодирования, ни даты', () => {
    const url = '/api/occupancy/grid?dateFrom=2024-06-23&guestSearch=%D0%90%D1%81%D0%B5%D0%BB%D1%8C'
    const safe = safeUrl(url)
    expect(safe).not.toContain('Асель')
    expect(safe).not.toContain('%D0%90')     // «А» в UTF-8 + percent-encoding
    expect(safe).not.toContain('D0%90')
    expect(safe).not.toContain('2024-06-23')
  })

  it('телефон в открытом виде тоже не остаётся', () => {
    const safe = safeUrl('/api/guests/lookup?phone=%2B77010000000')
    expect(safe).toBe('/api/guests/lookup?keys=phone')
    expect(safe).not.toContain('7701')
  })

  it('значение со знаком «=» внутри не превращается в имя параметра', () => {
    // ?filter=status=CANCELLED — «CANCELLED» это значение, а не второй ключ
    expect(safeUrl('/api/reports/5/run?filter=status=CANCELLED')).toBe('/api/reports/5/run?keys=filter')
  })

  it('пустое значение параметра — имя всё равно видно', () => {
    expect(safeUrl('/api/occupancy/grid?guestSearch=')).toBe('/api/occupancy/grid?keys=guestSearch')
  })

  it('одинокий «?» без параметров — только путь, без хвоста «?keys=»', () => {
    expect(safeUrl('/api/bookings?')).toBe('/api/bookings')
  })

  it('порядок имён — как в запросе, он показывает, как клиент собрал строку', () => {
    expect(safeUrl('/api/x?z=1&a=2&m=3')).toBe('/api/x?keys=z,a,m')
  })

  it('не строка — пустая строка, а не «undefined» в логе', () => {
    expect(safeUrl(undefined)).toBe('')
    expect(safeUrl(null)).toBe('')
    expect(safeUrl(42)).toBe('')
    expect(safeUrl({ url: '/api/x' })).toBe('')
  })
})
