import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { CalendarCheck, Check, X, Clock, ExternalLink } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { toast } from 'sonner'

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
const H    = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

type Meeting = {
  lead_id: number
  lead_name: string
  lead_company: string | null
  linkedin_url: string | null
  detail: string
  detected_at: string | null
  campaign: string | null
}

async function jfetch(method: string, path: string) {
  const res = await fetch(`${BASE}${path}`, { method, headers: H })
  return res.json().catch(() => ({}))
}

export function CallsBooked() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['meetings'],
    queryFn: async () => {
      const r = await jfetch('GET', '/meetings')
      return (r?.data ?? { pending: [], confirmed: [], pending_count: 0, confirmed_count: 0 }) as {
        pending: Meeting[]; confirmed: Meeting[]; pending_count: number; confirmed_count: number
      }
    },
    refetchInterval: 60_000,
  })

  const act = useMutation({
    mutationFn: async ({ leadId, kind }: { leadId: number; kind: 'confirm' | 'dismiss' }) =>
      jfetch('POST', `/meetings/${leadId}/${kind}`),
    onSuccess: (_res, { kind }) => {
      qc.invalidateQueries({ queryKey: ['meetings'] })
      toast.success(kind === 'confirm' ? 'Call confirmed 🎉' : 'Dismissed')
    },
  })

  const pending = data?.pending ?? []
  const confirmed = data?.confirmed ?? []

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CalendarCheck className="w-4 h-4 text-yellow-500" />
            Calls Booked
            {confirmed.length > 0 && (
              <Badge variant="success" className="text-[10px] px-1.5 py-0 h-4">{confirmed.length}</Badge>
            )}
          </CardTitle>
          {pending.length > 0 && (
            <Badge variant="warning" className="text-[10px] gap-1">
              <Clock className="w-3 h-3" /> {pending.length} to confirm
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {pending.length === 0 && confirmed.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            No calls yet. When autopilot lands a call, it'll appear here to confirm.
          </p>
        )}

        {/* Pending — AI thinks a call was agreed; user confirms */}
        {pending.map((m, i) => (
          <motion.div
            key={m.lead_id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  {m.lead_name}
                  {m.linkedin_url && (
                    <a href={m.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-primary">
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </p>
                <p className="text-[10px] text-muted-foreground truncate">
                  {m.lead_company || '—'}{m.campaign ? ` · ${m.campaign}` : ''}
                </p>
              </div>
              <Badge variant="warning" className="text-[9px] shrink-0">AI detected</Badge>
            </div>
            {m.detail && <p className="text-[11px] text-muted-foreground italic">“{m.detail}”</p>}
            <div className="flex gap-2">
              <Button size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={() => act.mutate({ leadId: m.lead_id, kind: 'confirm' })} disabled={act.isPending}>
                <Check className="w-3 h-3" /> Confirm call
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => act.mutate({ leadId: m.lead_id, kind: 'dismiss' })} disabled={act.isPending}>
                <X className="w-3 h-3" /> Not real
              </Button>
            </div>
          </motion.div>
        ))}

        {/* Confirmed calls */}
        {confirmed.map((m, i) => (
          <motion.div
            key={m.lead_id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className="flex items-center gap-2.5 rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-2.5"
          >
            <div className="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
              <CalendarCheck className="w-3.5 h-3.5 text-emerald-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{m.lead_name}</p>
              <p className="text-[10px] text-muted-foreground truncate">{m.detail || m.lead_company || 'Call confirmed'}</p>
            </div>
            <Badge variant="success" className="text-[9px] shrink-0">Booked</Badge>
          </motion.div>
        ))}
      </CardContent>
    </Card>
  )
}
