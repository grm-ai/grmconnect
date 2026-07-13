// Central API client – frontend talks to backend ONLY through this module.
// No business logic lives here; it is a thin fetch wrapper.

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const API_KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const json = await res.json()

  if (!res.ok) {
    throw new Error(json?.message ?? `HTTP ${res.status}`)
  }

  return json as T
}

// ── Health ────────────────────────────────────────────────────────────────────

export const healthApi = {
  check: () => request<ApiResponse<HealthData>>('GET', '/health'),
}

// ── Leads ─────────────────────────────────────────────────────────────────────

export const leadsApi = {
  list:   (page = 1, pageSize = 20, status?: string) =>
    request<PaginatedResponse<Lead>>('GET',
      `/leads?page=${page}&page_size=${pageSize}${status ? `&status=${status}` : ''}`),
  get:    (id: number) => request<ApiResponse<Lead>>('GET', `/leads/${id}`),
  create: (data: CreateLeadInput) => request<ApiResponse<Lead>>('POST', '/leads', data),
  update: (id: number, data: Partial<CreateLeadInput>) =>
    request<ApiResponse<Lead>>('PATCH', `/leads/${id}`, data),
  remove: (id: number) => request<ApiResponse<null>>('DELETE', `/leads/${id}`),
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

export const campaignsApi = {
  list:   (page = 1, pageSize = 20) =>
    request<PaginatedResponse<Campaign>>('GET', `/campaigns?page=${page}&page_size=${pageSize}`),
  get:    (id: number) => request<ApiResponse<Campaign>>('GET', `/campaigns/${id}`),
  create: (data: CreateCampaignInput) => request<ApiResponse<Campaign>>('POST', '/campaigns', data),
  update: (id: number, data: Partial<CreateCampaignInput>) =>
    request<ApiResponse<Campaign>>('PATCH', `/campaigns/${id}`, data),
  remove: (id: number) => request<ApiResponse<null>>('DELETE', `/campaigns/${id}`),
}

// ── Actions ───────────────────────────────────────────────────────────────────

export const actionsApi = {
  list: (params: ActionListParams = {}) => {
    const qs = new URLSearchParams()
    qs.set('page', String(params.page ?? 1))
    qs.set('page_size', String(params.pageSize ?? 20))
    if (params.status)     qs.set('status', params.status)
    if (params.campaignId) qs.set('campaign_id', String(params.campaignId))
    if (params.leadId)     qs.set('lead_id', String(params.leadId))
    return request<PaginatedResponse<Action>>('GET', `/actions?${qs}`)
  },
  get:    (id: number) => request<ApiResponse<Action>>('GET', `/actions/${id}`),
  create: (data: CreateActionInput) => request<ApiResponse<Action>>('POST', '/actions', data),
  remove: (id: number) => request<ApiResponse<null>>('DELETE', `/actions/${id}`),
  queue:  (ids: number[]) =>
    request<ApiResponse<{ queued: Array<{ action_id: number; task_id: string }> }>>(
      'POST', '/actions/queue', { action_ids: ids }),
  retry:  (id: number) =>
    request<ApiResponse<{ action_id: number; task_id: string }>>('POST', `/actions/${id}/retry`),
  cancel: (id: number) => request<ApiResponse<null>>('POST', `/actions/${id}/cancel`),
  logs:   (id: number) => request<ApiResponse<ActionLog>>('GET', `/actions/${id}/logs`),
}

// ── Runner ────────────────────────────────────────────────────────────────────

export const runnerApi = {
  dispatch: (taskName: string, kwargs: Record<string, unknown> = {}, countdown = 0) =>
    request<ApiResponse<RunTaskResponse>>('POST', '/run-task', {
      task_name: taskName,
      kwargs,
      countdown,
    }),
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export const webhookApi = {
  n8n: (event: string, data: Record<string, unknown>) =>
    request<ApiResponse<Record<string, unknown>>>('POST', '/webhook/n8n', { event, data }),
}

// ── Type definitions ──────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean
  message: string
  data: T | null
}

export interface PaginatedResponse<T> {
  success: boolean
  message: string
  data: T[]
  total: number
  page: number
  page_size: number
}

export interface HealthData {
  status: string
  version: string
  db: string
  redis: string
}

export type LeadStatus = 'PENDING' | 'ACTIVE' | 'CONTACTED' | 'REPLIED' | 'CONVERTED' | 'ARCHIVED'
export type CampaignStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED'
export type ActionType = 'CONNECT' | 'MESSAGE' | 'FOLLOWUP' | 'VIEW_PROFILE' | 'CUSTOM'
export type ActionStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'RETRYING'

export interface Lead {
  id: number
  name: string
  company: string | null
  linkedin_url: string | null
  email: string | null
  status: LeadStatus
  created_at: string
}

export interface Campaign {
  id: number
  name: string
  description: string | null
  status: CampaignStatus
  daily_limit: number
  created_at: string
}

export interface Action {
  id: number
  campaign_id: number | null
  lead_id: number | null
  action_type: ActionType
  payload: Record<string, unknown>
  status: ActionStatus
  retry_count: number
  result: Record<string, unknown> | null
  scheduled_at: string | null
  executed_at: string | null
  created_at: string
}

export interface ActionLog {
  action_id: number
  status: ActionStatus
  retry_count: number
  result: Record<string, unknown>
  scheduled_at: string | null
  executed_at: string | null
}

export interface RunTaskResponse {
  task_id: string
  task_name: string
  status: string
}

export interface CreateLeadInput {
  name: string
  company?: string
  linkedin_url?: string
  email?: string
  status?: LeadStatus
}

export interface CreateCampaignInput {
  name: string
  description?: string
  status?: CampaignStatus
  daily_limit?: number
}

export interface CreateActionInput {
  campaign_id?: number
  lead_id?: number
  action_type: ActionType
  payload?: Record<string, unknown>
  scheduled_at?: string
}

export interface ActionListParams {
  page?: number
  pageSize?: number
  status?: ActionStatus
  campaignId?: number
  leadId?: number
}
