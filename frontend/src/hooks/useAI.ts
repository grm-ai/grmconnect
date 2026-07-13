import { useMutation } from '@tanstack/react-query'
import type { AIRequest, AIResponse } from '../types'
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

export function useGenerateAI() {
  return useMutation({
    mutationFn: async (req: AIRequest): Promise<AIResponse> => {
      const res = await api<{ data: { message: string; tokens_used: number } }>(
        'POST', '/ai/generate', {
          action:           req.action,
          lead_name:        req.lead?.name,
          lead_company:     req.lead?.company,
          lead_title:       req.lead?.title,
          lead_industry:    req.lead?.industry,
          context:          req.context,
          tone:             req.tone,
          existing_message: req.existing_message,
        }
      )
      return {
        message:      res.data?.message      ?? '',
        subject:      req.action === 'generate'
          ? `Quick question about ${req.lead?.company ?? 'your team'}`
          : undefined,
        tokens_used:  res.data?.tokens_used  ?? 0,
      }
    },
    onError: (err: Error) => toast.error(`AI generation failed: ${err.message}`),
  })
}

export function useLeadIntelligence() {
  return useMutation({
    mutationFn: async (leadId: string): Promise<string> => {
      const res = await api<{ data: { message: string } }>(
        'POST', '/ai/generate', {
          action:  'generate',
          context: 'Provide a brief outreach strategy for this lead including best approach, timing, and conversation starters. Format as bullet points.',
          lead_name: leadId,
        }
      )
      return res.data?.message ?? 'Unable to generate insights at this time.'
    },
    onError: (err: Error) => toast.error(`Lead intelligence failed: ${err.message}`),
  })
}
