import { useQuery } from '@tanstack/react-query'
import type { DashboardStats, FunnelData, TimeSeriesPoint, CampaignPerformance, Activity } from '../types'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
const H    = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: H })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
  return json as T
}

// Shared trends query — both useSentTrend and useRepliesTrend share this cache entry
const TRENDS_KEY = ['analytics-trends']

export function useDashboardStats() {
  return useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async (): Promise<DashboardStats> => {
      const res = await api<{ data: any }>('/analytics/stats')
      const d = res.data ?? {}
      return {
        total_leads:      d.total_leads      ?? 0,
        active_campaigns: d.active_campaigns ?? 0,
        replies_received: d.replies_received ?? 0,
        hot_leads:        d.connections_accepted ?? 0,
        meetings_booked:  d.converted_leads  ?? 0,
        conversion_rate:  d.acceptance_rate  ?? 0,
      }
    },
    staleTime: 60_000,
  })
}

export function useFunnel() {
  return useQuery({
    queryKey: ['funnel'],
    queryFn: async (): Promise<FunnelData[]> => {
      const res = await api<{ data: FunnelData[] }>('/analytics/funnel')
      return res.data ?? []
    },
    staleTime: 60_000,
  })
}

export function useRepliesTrend() {
  return useQuery({
    queryKey: TRENDS_KEY,
    queryFn: async () => api<{ data: { sent: TimeSeriesPoint[]; replies: TimeSeriesPoint[] } }>('/analytics/trends'),
    staleTime: 60_000,
    select: (res) => res.data?.replies ?? [],
  })
}

export function useSentTrend() {
  return useQuery({
    queryKey: TRENDS_KEY,
    queryFn: async () => api<{ data: { sent: TimeSeriesPoint[]; replies: TimeSeriesPoint[] } }>('/analytics/trends'),
    staleTime: 60_000,
    select: (res) => res.data?.sent ?? [],
  })
}

export function useCampaignPerformance() {
  return useQuery({
    queryKey: ['campaign-performance'],
    queryFn: async (): Promise<CampaignPerformance[]> => {
      const res = await api<{ data: any[] }>('/campaigns?page=1&page_size=50')
      return (res.data ?? []).map((c: any) => ({
        name:       c.name ?? '',
        sent:       0,
        replies:    0,
        meetings:   0,
        reply_rate: 0,
      }))
    },
    staleTime: 60_000,
  })
}

export function useActivities() {
  return useQuery({
    queryKey: ['activities'],
    queryFn: async (): Promise<Activity[]> => {
      const res = await api<{ data: any[] }>('/analytics/activity')
      return (res.data ?? []).map((a: any) => ({
        id:          a.id,
        type:        a.type,
        title:       a.title,
        description: a.description,
        lead:        a.lead_name
          ? { id: '', name: a.lead_name, company: a.lead_company ?? '', avatar: undefined }
          : undefined,
        created_at:  a.created_at,
      }))
    },
    staleTime: 30_000,
  })
}
