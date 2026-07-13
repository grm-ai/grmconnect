/**
 * Inbox hooks — real backend calls to /inbox/*.
 * Kept for backwards compatibility; prefer useConversations from useConversations.ts.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Conversation } from '../types'
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

function mapConv(c: any): Conversation {
  const convId = String(c.lead_id)
  return {
    id:   convId,
    lead: {
      id:           convId,
      name:         c.lead_name    ?? '',
      company:      c.lead_company ?? '',
      title:        '',
      linkedin_url: c.lead_linkedin_url ?? null,
      status:       'contacted',
      score:        0,
      tags:         [],
      location:     '',
      industry:     '',
      company_size: '',
      created_at:   c.last_message_at ?? new Date().toISOString(),
      last_activity: c.last_message_at ?? new Date().toISOString(),
      email:        null,
    },
    messages: (c.messages ?? []).map((m: any) => ({
      id:              String(m.id),
      conversation_id: convId,
      sender:          m.direction === 'OUTBOUND' ? 'user' as const : 'lead' as const,
      body:            m.body,
      sent_at:         m.sent_at,
      read:            m.read,
    })),
    last_message:    c.last_message    ?? '',
    last_message_at: c.last_message_at ?? '',
    unread_count:    c.unread_count    ?? 0,
    sentiment:       'neutral',
    intent:          'unknown',
  }
}

export function useRealConversations() {
  return useQuery({
    queryKey: ['conversations-real'],
    queryFn: async (): Promise<Conversation[]> => {
      const res = await api<{ data: any[] }>('GET', '/inbox')
      return (res.data ?? []).map(mapConv)
    },
    staleTime: 20_000,
  })
}

export function useSendRealMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ leadId, body, campaignId }: { leadId: string; body: string; campaignId?: string }) =>
      api('POST', `/inbox/${leadId}/reply`, {
        body,
        campaign_id: campaignId ? parseInt(campaignId) : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversations-real'] })
      toast.success('Message sent')
    },
    onError: (err: Error) => toast.error(err.message),
  })
}

export function useRealLeads() {
  return useQuery({
    queryKey: ['leads-real'],
    queryFn: async () => {
      const res = await api<{ data: unknown[] }>('GET', '/leads?page=1&page_size=200')
      return res.data ?? []
    },
    staleTime: 30_000,
  })
}
