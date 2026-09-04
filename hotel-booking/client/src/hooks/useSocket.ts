import { useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { SOCKET_URL } from '../config'
import { useGridStore } from '../store/useGridStore'
import { useAuthStore } from '../store/useAuthStore'
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

    // Защита от неполного payload: если брони (или её roomId) в событии нет — перезагружаем
    // сетку целиком, а не падаем с TypeError и не теряем изменение на этом рабочем месте.
    const withBooking = (handler: (b: GridBooking) => void) => (payload: BookingPayload) => {
      const booking = payload?.booking
      if (booking && booking.roomId != null) handler(booking)
      else fetchGrid()
      fetchToday()
    }

    socket.on('booking:created', withBooking(onBookingCreated))
    socket.on('booking:updated', withBooking(onBookingUpdated))
    socket.on('booking:checkin', withBooking(onBookingUpdated))
    socket.on('booking:checkout', withBooking(onBookingUpdated))

    // Учётную запись отключили: сервер рвёт сокет и больше не пустит его обратно
    // (handshake проверяет isActive). Не ждём, пока в 401 упрётся первый REST-запрос —
    // сразу выходим на экран входа, иначе рабочее место молча «замерзает».
    socket.on('auth:revoked', () => {
      useAuthStore.getState().logout()
    })

    socket.on('booking:cancelled', (payload: { bookingId?: number } | null | undefined) => {
      if (payload?.bookingId != null) onBookingCancelled(payload.bookingId)
      else fetchGrid()
      fetchToday()
    })

    // После отката снимка перезагружаем всю сетку целиком
    socket.on('snapshot:restored', () => {
      fetchGrid()
      fetchToday()
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
