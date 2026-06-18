import { useEffect } from 'react'
import { io, Socket } from 'socket.io-client'
import { useGridStore } from '../store/useGridStore'
import type { GridBooking } from '../types'

let socket: Socket | null = null

export function useSocket(token: string | null) {
  const { onBookingCreated, onBookingUpdated, onBookingCancelled, fetchToday, fetchGrid } = useGridStore()

  useEffect(() => {
    if (!token) return

    socket = io('/', { auth: { token }, transports: ['websocket'] })

    socket.on('booking:created', ({ booking }: { booking: GridBooking }) => {
      onBookingCreated(booking)
      fetchToday()
    })

    socket.on('booking:updated', ({ booking }: { booking: GridBooking }) => {
      onBookingUpdated(booking)
      fetchToday()
    })

    socket.on('booking:cancelled', ({ bookingId }: { bookingId: number }) => {
      onBookingCancelled(bookingId)
      fetchToday()
    })

    socket.on('booking:checkin', ({ booking }: { booking: GridBooking }) => {
      onBookingUpdated(booking)
      fetchToday()
    })

    socket.on('booking:checkout', ({ booking }: { booking: GridBooking }) => {
      onBookingUpdated(booking)
      fetchToday()
    })

    // После отката снимка перезагружаем всю сетку целиком
    socket.on('snapshot:restored', () => {
      fetchGrid()
      fetchToday()
    })

    return () => {
      socket?.disconnect()
      socket = null
    }
  }, [token])
}
