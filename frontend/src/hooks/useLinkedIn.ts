import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''

const headers = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? json?.detail ?? `HTTP ${res.status}`)
  return json as T
}

interface SessionInfo {
  account_name: string
  status: string
  last_used: string | null
  linkedin_name: string | null
  linkedin_headline: string | null
  linkedin_profile_url: string | null
  has_avatar: boolean
}

interface ApiResponse<T> { data: T; message: string; success?: boolean }

export function useLinkedInSession() {
  return useQuery({
    queryKey: ['linkedin-session'],
    queryFn: () => api<ApiResponse<SessionInfo | null>>('GET', '/linkedin/session'),
    staleTime: 30_000,   // 30 s — catch session expiry quickly
    gcTime:   5 * 60_000,
    retry: false,
    refetchOnWindowFocus: true,
  })
}

// ── Chrome profiles ───────────────────────────────────────────────────────────

export interface ChromeProfile { dir: string; name: string; email: string }

export function useChromeProfiles() {
  return useQuery({
    queryKey: ['chrome-profiles'],
    queryFn: () => api<ApiResponse<ChromeProfile[]>>('GET', '/linkedin/chrome-profiles'),
    staleTime: 300_000,
    retry: false,
  })
}

// ── Open-browser connect flow ─────────────────────────────────────────────────

export function useOpenBrowser() {
  return useMutation({
    mutationFn: (profileDir?: string) =>
      api<ApiResponse<{ session_id: string; status: string; message: string }>>(
        'POST', '/linkedin/open-browser',
        profileDir ? { profile_dir: profileDir } : {}
      ),
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useBrowserStatus(sessionId: string | null) {
  return useQuery({
    queryKey: ['browser-status', sessionId],
    queryFn: () =>
      api<ApiResponse<{ session_id: string; open: boolean; logged_in: boolean; linkedin_user: string | null }>>(
        'GET', `/linkedin/browser-status/${sessionId}`
      ),
    enabled: !!sessionId,
    refetchInterval: 3000,   // poll every 3 s
    staleTime: 0,
  })
}

export function useCaptureSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) =>
      api<ApiResponse<{ account_name: string; linkedin_user: string | null; cookies_saved: number }>>(
        'POST', `/linkedin/capture/${sessionId}`, { account_name: 'default' }
      ),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['linkedin-session'] })
      const user = res.data?.linkedin_user
      toast.success(user ? `Connected as ${user}!` : 'LinkedIn session saved!')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useCloseBrowser() {
  return useMutation({
    mutationFn: (sessionId: string) =>
      api<ApiResponse<null>>('DELETE', `/linkedin/browser/${sessionId}`),
  })
}

export function useLinkedInLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { email: string; password: string; account_name?: string; headless?: boolean }) =>
      api<ApiResponse<{ status?: string; requires_2fa?: boolean; session_id?: string }>>(
        'POST', '/linkedin/login', { headless: true, account_name: 'default', ...data }
      ),
    onSuccess: (res) => {
      if (res.data?.status === 'authenticated') {
        qc.invalidateQueries({ queryKey: ['linkedin-session'] })
        toast.success('LinkedIn session connected!')
      }
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useLinkedIn2FA() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { session_id: string; code: string }) =>
      api<ApiResponse<{ status: string }>>('POST', '/linkedin/login/verify', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['linkedin-session'] })
      toast.success('2FA verified. LinkedIn connected!')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useRefreshProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<ApiResponse<{
        account_name: string; status: string; last_used: string | null;
        linkedin_name: string | null; linkedin_headline: string | null;
        linkedin_profile_url: string | null; has_avatar: boolean;
      }>>('POST', '/linkedin/profile/refresh'),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['linkedin-session'] })
      const name = res.data?.linkedin_name
      toast.success(name ? `Profile loaded for ${name}!` : 'Profile refreshed!')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useRevokeLinkedIn() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api<ApiResponse<null>>('DELETE', '/linkedin/session'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['linkedin-session'] })
      toast.success('LinkedIn session revoked.')
    },
  })
}

export function usePollInbox() {
  return useMutation({
    mutationFn: () => api<ApiResponse<{ task_id: string }>>('POST', '/inbox/poll'),
    onSuccess: (res) => toast.success(`Inbox poll dispatched (task: ${res.data?.task_id?.slice(0, 8)}...)`),
    onError: (err: Error) => toast.error(err.message),
  })
}

export interface DailyLimits {
  connect_sent: number
  messages_sent: number
  connect_limit: number
  message_limit: number
  connect_remaining: number
  message_remaining: number
  date: string
}

export function useDailyLimits() {
  return useQuery({
    queryKey: ['daily-limits'],
    queryFn: () => api<ApiResponse<DailyLimits>>('GET', '/linkedin/limits'),
    staleTime: 30_000,
    retry: false,
  })
}

export function useUpdateLimits() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: { daily_connect_limit?: number; daily_message_limit?: number }) =>
      api<ApiResponse<Record<string, number>>>('PATCH', '/linkedin/limits', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['daily-limits'] })
      toast.success('Limits updated')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function usePollStatus() {
  return useQuery({
    queryKey: ['poll-status'],
    queryFn: () => api<ApiResponse<{
      id: number; polled_at: string; accepts_found: number;
      replies_found: number; followups_queued: number; error: string | null;
    } | null>>('GET', '/inbox/poll/status'),
    staleTime: 60_000,
    retry: false,
  })
}
