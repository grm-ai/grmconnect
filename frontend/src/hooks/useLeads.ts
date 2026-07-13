import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Lead, LeadStatus, ConnectionStatus } from '../types'
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

// Backend status → frontend status
const TO_FRONTEND: Record<string, LeadStatus> = {
  PENDING:   'new',
  ACTIVE:    'warm',
  CONTACTED: 'contacted',
  REPLIED:   'replied',
  CONVERTED: 'hot',
  ARCHIVED:  'cold',
}

// Frontend status → backend status
const TO_BACKEND: Record<string, string> = {
  new:            'PENDING',
  warm:           'ACTIVE',
  contacted:      'CONTACTED',
  replied:        'REPLIED',
  hot:            'CONVERTED',
  cold:           'ARCHIVED',
  meeting_booked: 'CONVERTED',
}

function mapLead(r: any): Lead {
  return {
    id:                String(r.id),
    name:              r.name              ?? '',
    title:             r.title             ?? '',
    company:           r.company           ?? '',
    email:             r.email             ?? null,
    linkedin_url:      r.linkedin_url      ?? null,
    status:            TO_FRONTEND[r.status] ?? 'new',
    connection_status: (r.connection_status as ConnectionStatus) ?? 'NOT_SENT',
    score:             r.score             ?? 0,
    tags:              [],
    location:          r.location          ?? '',
    industry:          r.industry          ?? '',
    company_size:      '',
    created_at:        r.created_at,
    last_activity:     r.last_message_at   ?? r.created_at,
    notes:             r.notes             ?? undefined,
  }
}

const leadsKey = ['leads']

export function useLeads() {
  return useQuery({
    queryKey: leadsKey,
    queryFn: async (): Promise<Lead[]> => {
      const res = await api<{ data: any[] }>('GET', '/leads?page=1&page_size=200')
      return (res.data ?? []).map(mapLead)
    },
    staleTime: 30_000,
  })
}

export function useLead(id: string | null) {
  return useQuery({
    queryKey: ['leads', id],
    queryFn: async (): Promise<Lead | null> => {
      const res = await api<{ data: any }>('GET', `/leads/${id}`)
      return res.data ? mapLead(res.data) : null
    },
    enabled: !!id,
  })
}

export function useUpdateLeadStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: LeadStatus }) => {
      await api('PATCH', `/leads/${id}`, { status: TO_BACKEND[status] ?? 'PENDING' })
      return { id, status }
    },
    onSuccess: ({ id, status }) => {
      qc.setQueryData<Lead[]>(leadsKey, (old) =>
        old?.map(l => l.id === id ? { ...l, status } : l) ?? []
      )
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useCreateLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (data: Partial<Lead>): Promise<Lead> => {
      const res = await api<{ data: any }>('POST', '/leads', {
        name:         data.name         ?? '',
        company:      data.company      || undefined,
        linkedin_url: data.linkedin_url || undefined,
        email:        data.email        || undefined,
      })
      return mapLead(res.data)
    },
    onSuccess: (newLead) => {
      qc.setQueryData<Lead[]>(leadsKey, (old) => [newLead, ...(old ?? [])])
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

// ── Connection request hooks ───────────────────────────────────────────────────

export interface ConnectJobData {
  job_id: string
  lead_id: number
  lead_name: string
  linkedin_url?: string
  status: 'pending' | 'running' | 'waiting_extension' | 'done' | 'error'
  note: string | null
  success: boolean | null
  error: string | null
  session_expired?: boolean
  already_sent?: boolean
  already_connected?: boolean
  already_pending?: boolean
  started_at: string
  finished_at: string | null
}

export function useConnectLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (leadId: string) => {
      const res = await api<{ data: ConnectJobData; message: string }>(
        'POST', `/leads/${leadId}/connect`
      )
      return res
    },
    onSuccess: () => {
      // Refresh leads list so connection_status updates
      qc.invalidateQueries({ queryKey: leadsKey })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useConnectJobStatus(jobId: string | null) {
  return useQuery({
    queryKey: ['lead-connect-job', jobId],
    queryFn: () =>
      api<{ data: ConnectJobData; message: string }>('GET', `/leads/connect-job/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const s = query.state.data?.data?.status
      if (s === 'done' || s === 'error') return false
      // Safety cap: never poll forever. If the extension never reports a result (tab closed,
      // crashed, or threw before notifying the backend), stop after ~2 min so the Network
      // tab doesn't fill with unbounded connect-job requests.
      if (query.state.dataUpdateCount > 60) return false
      return 2000
    },
    staleTime: 0,
    retry: false,
  })
}

export function useDeleteLead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (leadId: string | number) =>
      api<{ message: string }>('DELETE', `/leads/${leadId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: leadsKey })
      toast.success('Lead deleted')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
