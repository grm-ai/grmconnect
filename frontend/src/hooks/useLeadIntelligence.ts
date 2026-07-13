import { useQuery } from '@tanstack/react-query'
import type { LeadIntelligence } from '../types'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
const H    = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: H,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
  return json as T
}

export function useLeadIntelligence(leadId: string | null) {
  return useQuery({
    queryKey: ['intelligence', leadId],
    queryFn: async (): Promise<LeadIntelligence | null> => {
      // Fetch real lead data
      const leadRes = await api<{ data: any }>('GET', `/leads/${leadId}`)
      const lead = leadRes.data
      if (!lead) return null

      // Generate AI insights for this lead
      const aiRes = await api<{ data: { message: string } }>(
        'POST', '/ai/generate', {
          action:       'generate',
          lead_name:    lead.name,
          lead_company: lead.company,
          lead_title:   lead.title,
          lead_industry:lead.industry,
          context:      'Provide a concise outreach strategy: best approach, timing, likely objections, and a conversation starter. Use bullet points.',
        }
      )

      return {
        lead_id:          String(lead.id),
        company_overview: lead.company
          ? `${lead.company} — ${lead.industry ?? 'industry not specified'}${lead.location ? `, ${lead.location}` : ''}.`
          : 'Company information not available.',
        pain_points: [
          'Scaling outbound prospecting efficiently',
          'Consistent and personalised follow-ups',
          'Tracking engagement across multiple channels',
        ],
        buying_signals: [
          lead.connection_status === 'ACCEPTED' ? 'Accepted connection request' : 'In your network',
          lead.status === 'REPLIED' ? 'Has replied to a message' : 'Not yet engaged',
          lead.score > 50 ? `High lead score (${lead.score})` : `Lead score: ${lead.score ?? 0}`,
        ].filter(Boolean) as string[],
        opportunity_score: lead.score ?? 0,
        recent_news:  [],
        tech_stack:   [],
        competitors:  [],
        ai_insights:  aiRes.data?.message ?? 'Unable to generate insights at this time.',
        updated_at:   new Date().toISOString(),
      }
    },
    enabled: !!leadId,
    staleTime: 5 * 60_000,
  })
}

export function useAllLeadsWithIntelligence() {
  return useQuery({
    queryKey: ['leads-intelligence'],
    queryFn: async () => {
      const res = await api<{ data: any[] }>('GET', '/leads?page=1&page_size=50')
      return (res.data ?? []).filter((l: any) => (l.score ?? 0) >= 60)
    },
    staleTime: 60_000,
  })
}
