import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Campaign, CampaignStatus } from '../types'
import { toast } from 'sonner'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
const H    = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: H,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? json?.detail ?? `HTTP ${res.status}`)
  return json as T
}

const TO_FRONTEND: Record<string, CampaignStatus> = {
  DRAFT:     'draft',
  ACTIVE:    'active',
  PAUSED:    'paused',
  COMPLETED: 'completed',
}

const TO_BACKEND: Record<CampaignStatus, string> = {
  draft:     'DRAFT',
  active:    'ACTIVE',
  paused:    'PAUSED',
  completed: 'COMPLETED',
}

function mapCampaign(r: any): Campaign {
  return {
    id:              String(r.id),
    name:            r.name        ?? '',
    description:     r.description ?? '',
    goal:            r.goal        ?? '',
    autopilot:       !!r.autopilot,
    status:          TO_FRONTEND[r.status] ?? 'draft',
    target_industry: '',
    target_title:    '',
    daily_limit:     r.daily_limit ?? 20,
    sequence:        [],
    leads_count:     0,
    sent_count:      0,
    reply_count:     0,
    meeting_count:   0,
    reply_rate:      0,
    created_at:      r.created_at,
    updated_at:      r.created_at,
  }
}

const campaignsKey = ['campaigns']

export function useCampaigns() {
  return useQuery({
    queryKey: campaignsKey,
    queryFn: async (): Promise<Campaign[]> => {
      const res = await api<{ data: any[] }>('GET', '/campaigns?page=1&page_size=100')
      return (res.data ?? []).map(mapCampaign)
    },
    staleTime: 30_000,
  })
}

export function useCampaign(id: string | null) {
  return useQuery({
    queryKey: ['campaigns', id],
    queryFn: async (): Promise<Campaign | null> => {
      const res = await api<{ data: any }>('GET', `/campaigns/${id}`)
      return res.data ? mapCampaign(res.data) : null
    },
    enabled: !!id,
  })
}

export function useUpdateCampaignStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: CampaignStatus }) => {
      await api('PATCH', `/campaigns/${id}`, { status: TO_BACKEND[status] ?? 'DRAFT' })
      return { id, status }
    },
    onSuccess: ({ id, status }) => {
      qc.setQueryData<Campaign[]>(campaignsKey, (old) =>
        old?.map(c => c.id === id ? { ...c, status } : c) ?? []
      )
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useDeleteCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await api('DELETE', `/campaigns/${id}`)
      return id
    },
    onSuccess: (id) => {
      qc.setQueryData<Campaign[]>(campaignsKey, (old) => (old ?? []).filter(c => c.id !== id))
      toast.success('Campaign deleted')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useCreateCampaign() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: Partial<Campaign>): Promise<Campaign> => {
      const res = await api<{ data: any }>('POST', '/campaigns', {
        name:        data.name        ?? 'New Campaign',
        description: data.description || undefined,
        goal:        data.goal || undefined,
        autopilot:   !!data.autopilot,
        daily_limit: data.daily_limit ?? 20,
      })
      return mapCampaign(res.data)
    },
    onSuccess: (c) => {
      qc.setQueryData<Campaign[]>(campaignsKey, (old) => [...(old ?? []), c])
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
