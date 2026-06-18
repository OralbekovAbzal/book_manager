import api from './client'

export type SnapshotKind = 'auto' | 'shift' | 'manual' | 'safety'

export interface Snapshot {
  id: number
  kind: SnapshotKind
  label: string
  bookingCount: number
  createdAt: string
  createdBy?: { id: number; name: string } | null
}

export async function fetchSnapshots(): Promise<Snapshot[]> {
  const { data } = await api.get('/snapshots')
  return data.data
}

export async function createSnapshot(label?: string): Promise<Snapshot> {
  const { data } = await api.post('/snapshots', { label })
  return data.data
}

export async function restoreSnapshot(id: number): Promise<{ restored: number; skipped: number }> {
  const { data } = await api.post(`/snapshots/${id}/restore`)
  return data.data
}

export async function deleteSnapshot(id: number): Promise<void> {
  await api.delete(`/snapshots/${id}`)
}
