import { useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { SOCKET_URL } from '../config'
import { useGridStore } from '../store/useGridStore'
import { useAuthStore, type SessionEndReason } from '../store/useAuthStore'
import { useConnectionStore } from '../store/useConnectionStore'
import { useRealtimeStore } from '../store/useRealtimeStore'
import type { GridBooking } from '../types'

let socket: Socket | null = null

/** Текущее соединение — для подписок вне сетки (например, список отчётов). */
export function getSocket(): Socket | null {
  return socket
}

type BookingPayload = { booking?: GridBooking | null } | null | undefined

export function useSocket(token: string | null) {
  const {
    onBookingCreated, onBookingUpdated, onBookingCancelled,
    fetchToday, fetchGrid, fetchShiftDate,
  } = useGridStore()

  useEffect(() => {
    if (!token) return

    socket = io(SOCKET_URL, { auth: { token }, transports: ['websocket'] })

    // Сторы берём через getState(): подписка здесь не нужна (хук ничего не
    // рисует), а лишние зависимости эффекта пересоздавали бы соединение.
    const bump = (id: number | null) => useRealtimeStore.getState().bump(id)
    const resync = () => useRealtimeStore.getState().resync()
    const { setOnline, setOffline } = useConnectionStore.getState()

    // Первое соединение — не «переподключение»: сетку только что загрузил App,
    // второй запрос был бы холостым.
    let wasConnected = false

    // Защита от неполного payload: если брони (или её roomId) в событии нет — перезагружаем
    // сетку целиком, а не падаем с TypeError и не теряем изменение на этом рабочем месте.
    const withBooking = (handler: (b: GridBooking) => void) => (payload: BookingPayload) => {
      const booking = payload?.booking
      if (booking && booking.roomId != null) handler(booking)
      else fetchGrid()
      fetchToday()
      // Деньги в событии не приходят (и не должны: их считает сервер по строкам
      // и журналу платежей). Экраны денег перечитывают их сами по этому сигналу.
      bump(booking?.id ?? null)
    }

    socket.on('booking:created', withBooking(onBookingCreated))
    socket.on('booking:updated', withBooking(onBookingUpdated))
    socket.on('booking:checkin', withBooking(onBookingUpdated))
    socket.on('booking:checkout', withBooking(onBookingUpdated))

    // Связь восстановилась. События `booking:*`, ушедшие за время обрыва, socket.io
    // не доигрывает — их просто нет. Поэтому после КАЖДОГО переподключения сетку
    // перечитываем целиком, иначе рабочее место остаётся с картиной получаса
    // давности и продаёт занятый номер (аудит D5-003).
    //
    // `fetchShiftDate` сам зовёт `fetchGrid` (он перецентрирует диапазон на смену,
    // которая за время обрыва могла смениться на другом месте) — отдельный
    // `fetchGrid` дал бы два одинаковых запроса подряд.
    socket.on('connect', () => {
      setOnline()
      if (wasConnected) {
        fetchShiftDate()
        fetchToday()
        // Деньги на открытых экранах за время обрыва тоже могли уехать, а какой
        // именно брони — неизвестно: события за время обрыва не доигрываются.
        // Поэтому перечитывают себя ВСЕ подписанные экраны, а не только списки.
        resync()
      }
      wasConnected = true
    })

    // `io client disconnect` — это МЫ сами закрыли сокет (смена токена после
    // повторного входа, выход, размонтирование). Показывать «нет связи» на
    // собственную уборку — врать: связь есть, просто сокет пересоздаётся.
    socket.on('disconnect', (reason: string) => {
      if (reason === 'io client disconnect') return
      // Сервер сам разорвал сокет по истёкшему токену: связь есть, нужен пароль.
      // Полоса «нет связи» поверх оверлея входа врала бы (живая проверка волны 9).
      if (useAuthStore.getState().reauth) return
      setOffline()
    })

    // Отказ рукопожатия. Тексты задаёт сервер (`socket/socketManager.js`):
    //   • «Invalid token» — токен просрочен или испорчен: реконнект бессмыслен,
    //     нужен пароль. Приложение при этом не размонтируем — оверлей поверх.
    //   • «Session revoked» / «Unauthorized» — учётку отключили или вышли на
    //     другом устройстве: этому месту здесь больше делать нечего.
    //   • «Server unavailable» (база лежит) и сетевые ошибки — временные,
    //     socket.io переподключается сам, мы только показываем полосу.
    socket.on('connect_error', (err: Error) => {
      const message = err?.message ?? ''
      if (message === 'Invalid token') {
        socket?.disconnect()
        useAuthStore.getState().requireReauth('token_expired')
        return
      }
      if (message === 'Session revoked' || message === 'Unauthorized') {
        socket?.disconnect()
        useAuthStore.getState().logout('session_revoked')
        return
      }
      setOffline()
    })

    // Сервер отозвал сессию (учётку отключили, сменили пароль, вышли на другом
    // устройстве, истёк токен): сокет рвётся и обратно его не пустят. Не ждём,
    // пока в 401 упрётся первый REST-запрос — сразу на экран входа с пояснением,
    // иначе рабочее место молча «замерзает».
    //
    // `reason` типизирован как строка, а не как `SessionEndReason`: причину
    // выбирает сервер, и он может оказаться новее клиента. Текста для незнакомой
    // причины в сторе нет — `logout` подставит общий («Сессия завершена»),
    // но выкинуть на экран входа обязан в любом случае.
    //
    // Исключение — `token_expired`: истёкший токен не значит «за этим местом
    // работает не тот человек», значит только «пора ввести пароль ещё раз».
    // Сервер рвёт сокет по `exp` через секунду после истечения, то есть раньше
    // любого REST-401, — и если бы здесь стоял `logout`, форма брони пропадала
    // бы именно в том сценарии, ради которого сделан оверлей (D7-002).
    socket.on('auth:revoked', (payload?: { reason?: string }) => {
      const reason = payload?.reason ?? 'session_revoked'
      if (reason === 'token_expired') {
        useAuthStore.getState().requireReauth(reason)
        return
      }
      useAuthStore.getState().logout(reason as SessionEndReason)
    })

    socket.on('booking:cancelled', (payload: { bookingId?: number } | null | undefined) => {
      if (payload?.bookingId != null) onBookingCancelled(payload.bookingId)
      else fetchGrid()
      fetchToday()
      bump(payload?.bookingId ?? null)
    })

    // После отката снимка перезагружаем всю сетку целиком
    socket.on('snapshot:restored', () => {
      fetchGrid()
      fetchToday()
      // Откат переписывает платежи и начисления целиком — «Касса» с прежними
      // суммами показывала бы деньги, которых уже нет.
      resync()
    })

    // Смена рабочего дня на другом рабочем месте: fetchShiftDate перецентрирует
    // диапазон дат на новую смену и сам перезагружает сетку
    socket.on('shift:changed', () => {
      fetchShiftDate()
      fetchToday()
    })

    return () => {
      socket?.disconnect()
      socket = null
    }
  }, [token])
}
