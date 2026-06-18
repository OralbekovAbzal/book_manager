import api from './client'

export interface Shift {
  id: number
  /** ISO date string e.g. "2026-05-20T00:00:00.000Z" */
  date: string
  createdBy: { id: number; name: string }
  _count?: { bookings: number }
  createdAt: string
}

export interface OverdueCheckout {
  id: number
  guestName: string
  checkOut: string
  room: { number: string; building: string }
}

/** Thrown by advanceToNextDay when guests haven't checked out */
export class OverdueCheckoutError extends Error {
  overdueCheckouts: OverdueCheckout[]
  constructor(checkouts: OverdueCheckout[]) {
    super('Есть номера с просроченным выездом')
    this.name = 'OverdueCheckoutError'
    this.overdueCheckouts = checkouts
  }
}

export async function fetchShifts(): Promise<Shift[]> {
  const { data } = await api.get('/shifts')
  return data.data
}

export async function fetchCurrentShift(): Promise<Shift> {
  const { data } = await api.get('/shifts/current')
  return data.data
}

export async function advanceToNextDay(): Promise<Shift> {
  try {
    const { data } = await api.post('/shifts/next-day')
    return data.data
  } catch (err: unknown) {
    const axiosErr = err as { response?: { status?: number; data?: { overdueCheckouts?: OverdueCheckout[] } } }
    if (axiosErr.response?.status === 409 && axiosErr.response.data?.overdueCheckouts?.length) {
      throw new OverdueCheckoutError(axiosErr.response.data.overdueCheckouts)
    }
    throw err
  }
}
