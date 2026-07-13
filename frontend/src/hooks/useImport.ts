import { useMutation, useQuery } from '@tanstack/react-query'
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

export interface ScrapedProfile {
  name: string
  title: string
  company: string
  location: string
  linkedin_url: string
  profile_id: string
  connection_degree: string
  source: string
  // Enhanced fields
  mutual_connections: string
  is_open_to_work: boolean
  is_premium: boolean
  company_size: string
  industry: string
  seniority: string
}

export interface ScrapeResult {
  job_id: string
  url: string
  profiles_found: number
  pages_scraped: number
  profiles: ScrapedProfile[]
  scraped_at: string
  error?: string
}

export type ScrapeJobStatus = 'pending' | 'running' | 'done' | 'error'

export interface AsyncJobStatus {
  job_id: string
  status: ScrapeJobStatus
  progress_profiles: number
  progress_pages: number
  profiles: ScrapedProfile[]
  error: string | null
  url: string
  max_profiles: number
  started_at: string
  finished_at: string | null
}

export interface ImportResult {
  imported: number
  updated: number
  skipped: number
  lead_ids: number[]
}

// ── Legacy sync preview (dialog) ──────────────────────────────────────────────

export function usePreviewScrape() {
  return useMutation({
    mutationFn: ({ url, max_profiles }: { url: string; max_profiles?: number }) =>
      api<{ data: ScrapeResult; message: string }>('POST', '/scrape/preview', {
        url,
        max_profiles: max_profiles ?? 100,
      }),
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useImportProfiles() {
  return useMutation({
    mutationFn: (profiles: ScrapedProfile[]) =>
      api<{ data: ImportResult; message: string }>('POST', '/scrape/import', { profiles }),
    onSuccess: (res) => {
      toast.success(res.message)
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

// ── Async job API (searcher page) ─────────────────────────────────────────────

export function useStartScrape() {
  return useMutation({
    mutationFn: ({ url, max_profiles }: { url: string; max_profiles: number }) =>
      api<{ data: { job_id: string; status: string; started_at: string }; message: string }>(
        'POST', '/scrape/start', { url, max_profiles }
      ),
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useScrapeJobStatus(jobId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['scrape-job-status', jobId],
    queryFn: () =>
      api<{ data: AsyncJobStatus; message: string }>('GET', `/scrape/status/${jobId}`),
    enabled: !!jobId && enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status
      // Stop polling once done or errored
      if (status === 'done' || status === 'error') return false
      return 2000  // poll every 2 seconds while running
    },
    staleTime: 0,
    retry: false,
  })
}

// ── Connect-from-search jobs ──────────────────────────────────────────────────

export interface ConnectJobResult {
  name: string
  linkedin_url: string
  note: string
  success: boolean
  error?: string | null
  already_connected?: boolean
  already_pending?: boolean
}

export interface ConnectJobStatus {
  job_id: string
  status: 'pending' | 'running' | 'done' | 'error'
  total: number
  sent: number
  failed: number
  results: ConnectJobResult[]
  error: string | null
  started_at: string
  finished_at: string | null
}

export function useStartConnectJob() {
  return useMutation({
    mutationFn: ({
      profiles,
      limit,
      note_context,
    }: {
      profiles: ScrapedProfile[]
      limit: number
      note_context?: string
    }) =>
      api<{ data: { job_id: string; status: string; total: number; started_at: string }; message: string }>(
        'POST', '/scrape/connect', { profiles, limit, note_context: note_context ?? '' }
      ),
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useConnectJobStatus(jobId: string | null) {
  return useQuery({
    queryKey: ['connect-job-status', jobId],
    queryFn: () =>
      api<{ data: ConnectJobStatus; message: string }>('GET', `/scrape/connect-status/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status
      if (status === 'done' || status === 'error') return false
      return 3000
    },
    staleTime: 0,
    retry: false,
  })
}

// ── Scrape history ─────────────────────────────────────────────────────────────

export function useScrapeJobs() {
  return useQuery({
    queryKey: ['scrape-jobs'],
    queryFn: () => api<{ data: Array<{ job_id: string; url: string; profiles_found: number; scraped_at: string }> }>(
      'GET', '/scrape/jobs'
    ),
    staleTime: 30_000,
    retry: false,
  })
}
