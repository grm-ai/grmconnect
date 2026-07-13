import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Conversation, Message } from '../types'
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

function mapMessage(m: any, convId: string): Message {
  return {
    id:              String(m.id),
    conversation_id: convId,
    sender:          m.direction === 'OUTBOUND' ? 'user' : 'lead',
    body:            m.body,
    sent_at:         m.sent_at,
    read:            m.read,
  }
}

function mapConversation(r: any): Conversation {
  const convId = String(r.lead_id)
  const messages = (r.messages ?? []).map((m: any) => mapMessage(m, convId))
  return {
    id:              convId,
    lead: {
      id:           convId,
      name:         r.lead_name    ?? '',
      title:        '',
      company:      r.lead_company ?? '',
      email:        null,
      linkedin_url: r.lead_linkedin_url ?? null,
      status:       'contacted',
      score:        0,
      tags:         [],
      location:     '',
      industry:     '',
      company_size: '',
      created_at:   r.last_message_at ?? new Date().toISOString(),
      last_activity: r.last_message_at ?? new Date().toISOString(),
    },
    messages,
    last_message:    r.last_message    ?? '',
    last_message_at: r.last_message_at ?? new Date().toISOString(),
    unread_count:    r.unread_count    ?? 0,
    sentiment:       'neutral',
    intent:          'unknown',
    linkedin_thread_id: r.linkedin_thread_id ?? null,
  } as Conversation & { linkedin_thread_id: string | null }
}

const convsKey = ['conversations']

export function useConversations() {
  return useQuery({
    queryKey: convsKey,
    queryFn: async (): Promise<Conversation[]> => {
      const res = await api<{ data: any[] }>('GET', '/inbox')
      return (res.data ?? []).map(mapConversation)
    },
    staleTime: 20_000,
  })
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ['conversations', id],
    queryFn: async (): Promise<Conversation | null> => {
      const res = await api<{ data: any }>('GET', `/inbox/${id}`)
      return res.data ? mapConversation(res.data) : null
    },
    enabled: !!id,
  })
}

export function useSendMessage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ convId, body }: { convId: string; body: string }): Promise<Message> => {
      // Send via the extension (in-tab LinkedIn API) — the backend Playwright path is dead.
      const convs = qc.getQueryData<Conversation[]>(convsKey) || []
      const conv = convs.find(c => c.id === convId)
      const threadId = (conv as any)?.linkedin_thread_id            // existing conversation urn (preferred)
      const linkedinUrl = (conv?.lead as any)?.linkedin_url
      if (!threadId && !linkedinUrl) throw new Error('No conversation/LinkedIn URL for this lead.')
      const result = await new Promise<any>((resolve) => {
        const reqId = String(Date.now())
        const onResult = (e: Event) => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve((e as CustomEvent).detail || {}) }
        window.addEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any)
        // Prefer the existing conversation urn (confirmed format); fall back to the profile url.
        window.dispatchEvent(new CustomEvent('leadpilot-send-message', { detail: { reqId, target: threadId || undefined, linkedin_url: linkedinUrl, text: body } }))
        setTimeout(() => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve({ success: false, error: 'timeout — is the extension loaded and a LinkedIn tab open?' }) }, 30000)
      })
      if (!result?.success) throw new Error(result?.error || 'Message not sent')
      // Persist the outbound message (extension already sent it via LinkedIn).
      try { await api('POST', `/inbox/${convId}/record`, { body }) } catch {}
      return {
        id:              String(Date.now()),
        conversation_id: convId,
        sender:          'user',
        body,
        sent_at:         new Date().toISOString(),
        read:            true,
      }
    },
    onSuccess: (msg) => {
      qc.setQueryData<Conversation[]>(convsKey, (old) =>
        old?.map(c =>
          c.id === msg.conversation_id
            ? { ...c, messages: [...c.messages, msg], last_message: msg.body, last_message_at: msg.sent_at }
            : c
        ) ?? []
      )
      // Refresh to pick up the stored outbound message from the server
      qc.invalidateQueries({ queryKey: convsKey })
    },
    onError: (err: Error) => toast.error(err.message),
  })
}
