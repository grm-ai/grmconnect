import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, ExternalLink, MoreHorizontal,
  Linkedin, Mail, Building2, Loader2,
  UserCheck, Clock, UserPlus, Sparkles, CheckCircle2, XCircle,
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Progress } from './ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu'
import { Skeleton } from './ui/skeleton'
import { LeadStatusBadge } from './LeadStatusBadge'
import { useQueryClient } from '@tanstack/react-query'
import { useLeads, useConnectLead, useConnectJobStatus, useDeleteLead, type ConnectJobData } from '../hooks/useLeads'
import { useLinkedInSession } from '../hooks/useLinkedIn'
import { useLeadsStore } from '../store/leads-store'
import { formatRelativeTime, getInitials, scoreToColor, cn } from '../lib/utils'
import type { Lead, ConnectionStatus } from '../types'
import { toast } from 'sonner'

interface LeadTableProps {
  onSelectLead?: (lead: Lead) => void
}

// ── Connect button — PhantomBuster style (backend Voyager, no extension) ────────

function ConnectButton({ lead }: { lead: Lead }) {
  const [jobId, setJobId] = useState<string | null>(null)
  const connectMutation = useConnectLead()
  const jobQuery = useConnectJobStatus(jobId)
  const job = jobQuery.data?.data as ConnectJobData | undefined
  const qc = useQueryClient()
  const { data: sessionData } = useLinkedInSession()
  // Extension uses live browser cookies — works even if stored session is "EXPIRED"
  // Only block if there's NO session row at all (never connected)
  const hasActiveSession = !!(sessionData?.data && ['ACTIVE', 'EXPIRED'].includes(sessionData.data.status))

  const status: ConnectionStatus = (() => {
    if (job?.status === 'done' && job.success) return 'PENDING'
    return lead.connection_status ?? 'NOT_SENT'
  })()

  const isWorking = connectMutation.isPending ||
    (job && (job.status === 'pending' || job.status === 'running' || job.status === 'waiting_extension'))

  // For Sales Navigator leads: backend can't resolve SN IDs → delegates to extension
  React.useEffect(() => {
    if (!job || job.status !== 'waiting_extension') return
    const linkedinUrl = (job as any).linkedin_url as string
    const note = job.note ?? ''
    const id = job.job_id
    let sent = false
    const onReady = () => {
      if (sent) return
      sent = true
      window.dispatchEvent(new CustomEvent('leadpilot-send-invite', {
        detail: { linkedin_url: linkedinUrl, note, job_id: id },
      }))
    }
    window.addEventListener('leadpilot-extension-ready', onReady, { once: true })
    window.dispatchEvent(new CustomEvent('leadpilot-ping'))
    const timer = setTimeout(() => {
      window.removeEventListener('leadpilot-extension-ready', onReady)
      if (!sent) toast.error('Extension not responding — install the LeadPilot extension or use the ⋮ menu to fix the LinkedIn URL.')
    }, 3000)
    return () => { clearTimeout(timer); window.removeEventListener('leadpilot-extension-ready', onReady) }
  }, [job?.status])

  async function handleConnect(e: React.MouseEvent) {
    e.stopPropagation()
    if (!hasActiveSession) {
      toast.error('No LinkedIn session', {
        description: 'Go to Settings → LinkedIn and click "Connect LinkedIn" first.',
        action: { label: 'Settings →', onClick: () => window.location.href = '/settings' },
      })
      return
    }
    try {
      const res = await connectMutation.mutateAsync(String(lead.id))
      const data = res.data as ConnectJobData
      if (data?.already_sent) { toast.info('Connection request already sent'); return }
      if (data?.already_connected) { toast.info(`Already connected with ${lead.name}`); return }
      if (data?.job_id) setJobId(data.job_id)
    } catch {
      // error toast handled by hook
    }
  }

  // Safety net: if a job never reaches a terminal state (extension crashed, tab closed, or
  // never reported back), stop the spinner and clear the job after ~2.5 min so the row
  // doesn't hang forever and the status poll (useConnectJobStatus) stops firing.
  React.useEffect(() => {
    if (!jobId) return
    const t = setTimeout(() => {
      setJobId(null)
      toast.error(`Connection request timed out for ${lead.name}`, {
        description: 'The extension did not report back — please verify on LinkedIn manually.',
      })
    }, 150_000)
    return () => clearTimeout(t)
  }, [jobId])

  // Show success/error toasts when job finishes + refresh lead status
  React.useEffect(() => {
    if (!job) return
    if (job.status === 'done') {
      qc.invalidateQueries({ queryKey: ['leads'] })
      if (job.success) {
        toast.success(`Connection request sent to ${lead.name}!`, {
          description: job.note ? `"${job.note.slice(0, 80)}…"` : undefined,
        })
      } else if (job.already_connected) {
        toast.info(`Already connected with ${lead.name}`)
      } else if (job.already_pending) {
        toast.info(`Request to ${lead.name} already pending`)
      }
      setJobId(null)
    }
    if (job.status === 'error') {
      qc.invalidateQueries({ queryKey: ['leads'] })
      const err = job.error ?? ''
      const isExpired = job.session_expired || err.toLowerCase().includes('session expired') || err.toLowerCase().includes('session_expired')
      if (isExpired) {
        qc.invalidateQueries({ queryKey: ['linkedin-session'] })
        toast.error('LinkedIn session expired', {
          description: 'Go to Settings → LinkedIn and click "Connect LinkedIn" to refresh.',
          action: { label: 'Settings →', onClick: () => window.location.href = '/settings' },
          duration: 12000,
        })
      } else {
        toast.error(`Could not connect with ${lead.name}`, {
          description: err || 'Profile may have restricted connections.',
        })
      }
      setJobId(null)
    }
  }, [job?.status])

  if (isWorking) {
    return (
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />
        <span>{job?.status === 'running' ? 'Sending…' : 'Preparing…'}</span>
      </div>
    )
  }

  if (status === 'ACCEPTED') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 whitespace-nowrap">
        <UserCheck className="w-3.5 h-3.5 shrink-0" />
        Connected
      </span>
    )
  }

  if (status === 'PENDING') {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 whitespace-nowrap">
        <Clock className="w-3.5 h-3.5 shrink-0" />
        Pending
      </span>
    )
  }

  if (status === 'IGNORED') {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground whitespace-nowrap">
        <XCircle className="w-3.5 h-3.5 shrink-0" />
        Ignored
      </span>
    )
  }

  if (!lead.linkedin_url) {
    return <span className="text-[11px] text-muted-foreground/40">No URL</span>
  }

  if (!hasActiveSession) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-[11px] gap-1.5 opacity-50 cursor-not-allowed whitespace-nowrap"
        onClick={(e) => {
          e.stopPropagation()
          toast.error('LinkedIn not connected', {
            description: 'Connect your LinkedIn account in Settings to send invites.',
            action: { label: 'Settings →', onClick: () => window.location.href = '/settings?tab=linkedin' },
            duration: 8000,
          })
        }}
      >
        <Linkedin className="w-3 h-3 shrink-0" />
        Reconnect
      </Button>
    )
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2.5 text-[11px] gap-1.5 hover:border-primary hover:text-primary whitespace-nowrap"
      onClick={handleConnect}
      disabled={connectMutation.isPending}
    >
      <Sparkles className="w-3 h-3 shrink-0" />
      Send Invite
    </Button>
  )
}

// ── Main table ────────────────────────────────────────────────────────────────

export function LeadTable({ onSelectLead }: LeadTableProps) {
  const { data: leads, isLoading } = useLeads()
  const { searchQuery, statusFilter, sortBy, setSearchQuery, setStatusFilter, setSortBy, filterLeads } = useLeadsStore()
  const deleteLead = useDeleteLead()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [scheduling, setScheduling] = useState(false)
  const qcMain = useQueryClient()

  const filtered = leads ? filterLeads(leads) : []
  // Only allow selecting leads that haven't been connected or are ignored
  const selectable = filtered.filter(l =>
    !l.connection_status || l.connection_status === 'NOT_SENT' || l.connection_status === 'IGNORED'
  )
  const allSelected = selectable.length > 0 && selectable.every(l => selectedIds.has(String(l.id)))
  const someSelected = selectedIds.size > 0

  function toggleSelect(id: string | number) {
    const key = String(id)
    const next = new Set(selectedIds)
    next.has(key) ? next.delete(key) : next.add(key)
    setSelectedIds(next)
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(selectable.map(l => String(l.id))))
    }
  }

  async function scheduleSelected() {
    if (selectedIds.size === 0) return
    setScheduling(true)
    try {
      const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
      const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
      const res = await fetch(`${BASE}/leads/schedule-invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
        body: JSON.stringify({ lead_ids: [...selectedIds].map(Number), daily_limit: 20 }),
      })
      const data = await res.json()
      if (data.success) {
        toast.success(`Scheduled ${selectedIds.size} invite${selectedIds.size > 1 ? 's' : ''}`, {
          description: `Sending 20/day automatically — no login needed.`,
        })
        setSelectedIds(new Set())
        qcMain.invalidateQueries({ queryKey: ['leads'] })
      } else {
        toast.error('Scheduling failed', { description: data.message })
      }
    } catch {
      toast.error('Could not reach backend')
    } finally {
      setScheduling(false)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-48">
          <Input
            placeholder="Search leads..."
            icon={<Search className="w-3.5 h-3.5" />}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="h-8 text-xs"
          />
        </div>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="new">New</SelectItem>
            <SelectItem value="contacted">Contacted</SelectItem>
            <SelectItem value="replied">Replied</SelectItem>
            <SelectItem value="hot">Hot</SelectItem>
            <SelectItem value="warm">Warm</SelectItem>
            <SelectItem value="cold">Cold</SelectItem>
            <SelectItem value="meeting_booked">Meeting Booked</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sortBy} onValueChange={(v) => setSortBy(v as any)}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="score">Score</SelectItem>
            <SelectItem value="last_activity">Last Activity</SelectItem>
            <SelectItem value="name">Name</SelectItem>
            <SelectItem value="created_at">Date Added</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">{filtered.length} leads</span>
      </div>

      {/* Bulk action bar */}
      {someSelected && (
        <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/10 border border-primary/20 rounded-xl">
          <span className="text-xs font-medium text-primary">{selectedIds.size} lead{selectedIds.size > 1 ? 's' : ''} selected</span>
          <Button
            size="sm"
            className="h-7 px-3 text-xs gap-1.5 ml-auto"
            onClick={scheduleSelected}
            disabled={scheduling}
          >
            {scheduling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {scheduling ? 'Scheduling…' : 'Schedule Invites (20/day auto)'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/5"
            onClick={async () => {
              if (!confirm(`Delete ${selectedIds.size} lead(s)? This cannot be undone.`)) return
              await Promise.all([...selectedIds].map(id => deleteLead.mutateAsync(id)))
              setSelectedIds(new Set())
            }}
            disabled={deleteLead.isPending}
          >
            <XCircle className="w-3 h-3" />
            Delete Selected
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="w-10 h-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm font-medium">No leads found</p>
          <p className="text-xs text-muted-foreground mt-1">Try adjusting your search or filters</p>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="w-8 p-3">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    title="Select all unconnected leads"
                  />
                </th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground">Lead</th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Company</th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground hidden sm:table-cell">Status</th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground w-32">Connect</th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground hidden lg:table-cell">Score</th>
                <th className="text-left p-3 text-xs font-medium text-muted-foreground hidden xl:table-cell">Last Activity</th>
                <th className="w-8 p-3" />
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {filtered.map((lead, i) => (
                  <motion.tr
                    key={lead.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ delay: i * 0.02 }}
                    onClick={() => onSelectLead?.(lead)}
                    className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                  >
                    <td className="p-3" onClick={e => { e.stopPropagation(); toggleSelect(lead.id) }}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(String(lead.id))}
                        onChange={() => toggleSelect(lead.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar className="w-8 h-8 shrink-0">
                          <AvatarFallback className="text-xs">{getInitials(lead.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="font-medium text-xs truncate">{lead.name}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{lead.title}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 hidden md:table-cell">
                      <div className="flex items-center gap-1.5">
                        <Building2 className="w-3 h-3 text-muted-foreground shrink-0" />
                        <span className="text-xs truncate max-w-[120px]">{lead.company}</span>
                      </div>
                    </td>
                    <td className="p-3 hidden sm:table-cell">
                      <LeadStatusBadge status={lead.status} />
                    </td>
                    <td className="p-3 w-32" onClick={e => e.stopPropagation()}>
                      <ConnectButton lead={lead} />
                    </td>
                    <td className="p-3 hidden lg:table-cell">
                      <div className="flex items-center gap-2">
                        <Progress
                          value={lead.score}
                          className="w-16 h-1.5"
                          indicatorClassName={
                            lead.score >= 80 ? 'bg-emerald-500' :
                            lead.score >= 60 ? 'bg-yellow-500' :
                            lead.score >= 40 ? 'bg-orange-500' : 'bg-red-500'
                          }
                        />
                        <span className={`text-xs font-medium ${scoreToColor(lead.score)}`}>{lead.score}</span>
                      </div>
                    </td>
                    <td className="p-3 hidden xl:table-cell">
                      <span className="text-[11px] text-muted-foreground">{formatRelativeTime(lead.last_activity)}</span>
                    </td>
                    <td className="p-3" onClick={e => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onSelectLead?.(lead)}>
                            View Profile
                          </DropdownMenuItem>
                          {lead.linkedin_url && (
                            <DropdownMenuItem onClick={() => window.open(lead.linkedin_url!, '_blank')}>
                              <Linkedin className="w-3.5 h-3.5 mr-2" />
                              Open LinkedIn
                            </DropdownMenuItem>
                          )}
                          {/* Show URL edit option — especially useful for Sales Navigator leads */}
                          <DropdownMenuItem onClick={() => {
                            const newUrl = prompt(
                              `Update LinkedIn URL for ${lead.name}:\n\nCurrent: ${lead.linkedin_url || '(none)'}\n\nPaste the regular /in/... URL:`,
                              lead.linkedin_url || ''
                            )
                            if (newUrl && newUrl !== lead.linkedin_url) {
                              const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
                              const KEY  = process.env.NEXT_PUBLIC_API_KEY ?? ''
                              fetch(`${BASE}/leads/${lead.id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY },
                                body: JSON.stringify({ linkedin_url: newUrl.trim() }),
                              }).then(() => {
                                qcMain.invalidateQueries({ queryKey: ['leads'] })
                                toast.success('LinkedIn URL updated')
                              })
                            }
                          }}>
                            <ExternalLink className="w-3.5 h-3.5 mr-2" />
                            {lead.linkedin_url?.includes('/sales/') ? '⚠ Fix Sales Nav URL' : 'Edit LinkedIn URL'}
                          </DropdownMenuItem>
                          {lead.email && (
                            <DropdownMenuItem>
                              <Mail className="w-3.5 h-3.5 mr-2" />
                              Send Email
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => deleteLead.mutate(lead.id)}
                            disabled={deleteLead.isPending}
                          >
                            <XCircle className="w-3.5 h-3.5 mr-2" />
                            Delete Lead
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
