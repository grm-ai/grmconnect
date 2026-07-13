import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Download, Users, Flame, Calendar, MessageSquare, Linkedin, AlertTriangle, ExternalLink,
  RefreshCw, Send,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { LeadTable } from '../src/components/LeadTable'
import { LeadScoreCard } from '../src/components/LeadScoreCard'
import { ImportFromLinkedIn } from '../src/components/ImportFromLinkedIn'
import { Button } from '../src/components/ui/button'
import { Card, CardContent } from '../src/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../src/components/ui/dialog'
import { Input } from '../src/components/ui/input'
import { Label } from '../src/components/ui/label'
import { useLeads, useCreateLead } from '../src/hooks/useLeads'
import { useLeadsStore } from '../src/store/leads-store'
import { useQueryClient } from '@tanstack/react-query'
import type { Lead } from '../src/types'
import { toast } from 'sonner'

export default function LeadsPage() {
  const { data: leads } = useLeads()
  const { selectedLeadId, setSelectedLeadId, filterLeads } = useLeadsStore()
  const createLead = useCreateLead()
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [form, setForm] = useState({ name: '', title: '', company: '', email: '', linkedin_url: '', location: '', industry: '' })

  const selectedLead = leads?.find(l => l.id === selectedLeadId) ?? null

  const stats = leads ? {
    total: leads.length,
    hot: leads.filter(l => l.status === 'hot').length,
    replied: leads.filter(l => l.status === 'replied').length,
    meetings: leads.filter(l => l.status === 'meeting_booked').length,
  } : { total: 0, hot: 0, replied: 0, meetings: 0 }

  // Leads with Sales Navigator URLs that need fixing
  const snLeads = leads?.filter(l => l.linkedin_url?.includes('/sales/lead/')) ?? []
  const [resolving, setResolving] = useState(false)
  const [resolvedCount, setResolvedCount] = useState(0)

  async function autoResolveAllSN() {
    if (!snLeads.length) return
    setResolving(true)
    setResolvedCount(0)
    toast.info(`Resolving ${snLeads.length} Sales Nav URLs via extension…`, { duration: 5000 })

    try {
      // Dispatch to content.js → background.js RESOLVE_SN_URLS
      const leadsPayload = snLeads.map(l => ({ lead_id: l.id, sn_url: l.linkedin_url! }))

      await new Promise<void>((resolve) => {
        let done = false
        let lastProgressAt = Date.now()

        const onProgress = (e: Event) => {
          const detail = (e as CustomEvent).detail as { done?: number; total?: number; resolved?: number }
          lastProgressAt = Date.now()
          if (typeof detail?.resolved === 'number') setResolvedCount(detail.resolved)
        }
        const onResult = (e: Event) => {
          const detail = (e as CustomEvent).detail as { resolved?: { lead_id: string; linkedin_url: string }[] }
          if (done) return
          done = true
          window.removeEventListener('leadpilot-sn-resolved', onResult)
          window.removeEventListener('leadpilot-sn-resolve-progress', onProgress)
          clearInterval(watchdog)
          const count = detail?.resolved?.length ?? 0
          setResolvedCount(count)
          if (count > 0) {
            toast.success(`Fixed ${count} of ${snLeads.length} Sales Nav URLs automatically!`)
            qc.invalidateQueries({ queryKey: ['leads'] })
          } else {
            toast.error('Could not resolve automatically. Make sure a Sales Navigator tab is open and logged in.')
          }
          resolve()
        }
        window.addEventListener('leadpilot-sn-resolved', onResult)
        window.addEventListener('leadpilot-sn-resolve-progress', onProgress)
        window.dispatchEvent(new CustomEvent('leadpilot-resolve-sn', { detail: { leads: leadsPayload } }))

        // Resolution is sequential and each lead can take 30-45s. Instead of a fixed
        // timeout, bail out only if no progress event has arrived for 90s straight.
        const watchdog = setInterval(() => {
          if (!done && Date.now() - lastProgressAt > 90000) {
            done = true
            window.removeEventListener('leadpilot-sn-resolved', onResult)
            window.removeEventListener('leadpilot-sn-resolve-progress', onProgress)
            clearInterval(watchdog)
            resolve()
          }
        }, 5000)
      })
    } catch (e) {
      toast.error('Extension not responding. Make sure GRM Connect extension is installed.')
    } finally {
      setResolving(false)
    }
  }

  // ── Sync real status from LinkedIn's actual "Sent invitations" list ──────────
  const [syncing, setSyncing] = useState(false)
  async function syncStatus() {
    setSyncing(true)
    try {
      const result = await new Promise<any>((resolve) => {
        const onResult = (e: Event) => {
          window.removeEventListener('leadpilot-sync-status-result', onResult)
          resolve((e as CustomEvent).detail || {})
        }
        window.addEventListener('leadpilot-sync-status-result', onResult)
        window.dispatchEvent(new CustomEvent('leadpilot-sync-status'))
        setTimeout(() => { window.removeEventListener('leadpilot-sync-status-result', onResult); resolve({ success: false, error: 'timeout' }) }, 60000)
      })
      if (result?.success) {
        qc.invalidateQueries({ queryKey: ['leads'] })
        toast.success(`Status synced — ${result.connected ?? 0} connected, ${result.pending ?? 0} pending, ${result.to_send ?? 0} to send.`)
      } else {
        toast.error(result?.error || 'Could not sync. Make sure a LinkedIn tab is open and logged in.')
      }
    } finally {
      setSyncing(false)
    }
  }

  // ── Send All: invite every not-yet-sent lead, up to the settings daily limit ──
  const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
  const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
  const jfetch = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: body ? JSON.stringify(body) : undefined })
    return res.json().catch(() => ({}))
  }
  const [sending, setSending] = useState(false)
  const [sendProg, setSendProg] = useState({ done: 0, total: 0, sent: 0 })

  async function sendOne(leadId: string | number): Promise<boolean> {
    const created = await jfetch('POST', `/leads/${leadId}/connect`)
    const job = created?.data
    if (job?.already_connected || job?.already_sent || job?.already_pending) return true
    if (!job?.job_id) return false
    const jobId = job.job_id
    // Wait for the backend to generate the note + mark the job ready for the extension.
    let ready: any = null
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const jr = await jfetch('GET', `/leads/connect-job/${jobId}`)
      ready = jr?.data
      if (!ready) continue
      if (ready.status === 'waiting_extension') break
      if (ready.status === 'done') return !!ready.success
      if (ready.status === 'error') return false
    }
    if (!ready || ready.status !== 'waiting_extension') return false
    // Hand off to the extension (same bridge the per-row button uses) and wait for its result.
    const result = await new Promise<any>((resolve) => {
      const onResult = (e: Event) => { window.removeEventListener(`leadpilot-invite-result-${jobId}`, onResult); resolve((e as CustomEvent).detail || {}) }
      window.addEventListener(`leadpilot-invite-result-${jobId}`, onResult)
      window.dispatchEvent(new CustomEvent('leadpilot-send-invite', { detail: { linkedin_url: ready.linkedin_url, note: ready.note ?? '', job_id: jobId } }))
      setTimeout(() => { window.removeEventListener(`leadpilot-invite-result-${jobId}`, onResult); resolve({ success: false, error: 'timeout' }) }, 120000)
    })
    return !!result?.success
  }

  async function sendAll() {
    let limit = 20
    try { const s = await jfetch('GET', '/settings'); if (s?.data?.daily_send_limit) limit = Math.min(Number(s.data.daily_send_limit) || 20, 50) } catch {}
    const targets = (leads ?? []).filter(l =>
      l.linkedin_url && !l.linkedin_url.includes('/sales/lead/') &&
      (!l.connection_status || l.connection_status === 'NOT_SENT' || l.connection_status === 'IGNORED')
    ).slice(0, limit)
    if (!targets.length) { toast.info('No leads to send — all are already pending or connected.'); return }
    setSending(true); setSendProg({ done: 0, total: targets.length, sent: 0 })
    toast.info(`Sending ${targets.length} invite${targets.length > 1 ? 's' : ''} (limit ${limit}/run). Keep this tab and a LinkedIn tab open.`, { duration: 6000 })
    let sent = 0
    for (let i = 0; i < targets.length; i++) {
      try { if (await sendOne(targets[i].id)) sent++ } catch {}
      setSendProg({ done: i + 1, total: targets.length, sent })
      qc.invalidateQueries({ queryKey: ['leads'] })
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000)) // human-like gap between sends
    }
    setSending(false)
    qc.invalidateQueries({ queryKey: ['leads'] })
    toast.success(`Send All done — ${sent}/${targets.length} invites sent.`)
  }

  const sendableCount = (leads ?? []).filter(l =>
    l.linkedin_url && !l.linkedin_url.includes('/sales/lead/') &&
    (!l.connection_status || l.connection_status === 'NOT_SENT' || l.connection_status === 'IGNORED')
  ).length

  async function handleCreate() {
    if (!form.name || !form.company) {
      toast.error('Name and company are required')
      return
    }
    await createLead.mutateAsync(form)
    toast.success('Lead added successfully!')
    setShowAdd(false)
    setForm({ name: '', title: '', company: '', email: '', linkedin_url: '', location: '', industry: '' })
  }

  return (
    <Layout>
      <div className="flex h-[calc(100vh-56px)] overflow-hidden">
        {/* Main content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 min-w-0">

          {/* Sales Navigator URL warning banner */}
          {snLeads.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                  {snLeads.length} lead{snLeads.length > 1 ? 's have' : ' has'} Sales Navigator URLs — invites will fail
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {resolving
                    ? `Resolving URLs via extension… ${resolvedCount} fixed so far. This can take ~30s per lead, keep the tab open.`
                    : 'Click to auto-fix all at once using your Sales Navigator tab (extension required)'}
                </p>
              </div>
              <button
                onClick={autoResolveAllSN}
                disabled={resolving}
                className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 underline underline-offset-2 whitespace-nowrap hover:text-amber-600 disabled:opacity-60"
              >
                {resolving ? (
                  <><span className="w-3 h-3 rounded-full border-2 border-amber-500 border-t-transparent animate-spin" /> Resolving…</>
                ) : (
                  <>Auto-Fix {snLeads.length} URLs →</>
                )}
              </button>
            </div>
          )}

          {/* Quick stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Total Leads',     value: stats.total,    icon: <Users className="w-4 h-4 text-primary" />,       bg: 'bg-primary/10' },
              { label: 'Hot Leads',       value: stats.hot,      icon: <Flame className="w-4 h-4 text-orange-500" />,    bg: 'bg-orange-500/10' },
              { label: 'Replied',         value: stats.replied,  icon: <MessageSquare className="w-4 h-4 text-amber-500" />, bg: 'bg-amber-500/10' },
              { label: 'Meetings Booked', value: stats.meetings, icon: <Calendar className="w-4 h-4 text-emerald-500" />, bg: 'bg-emerald-500/10' },
            ].map((s, i) => (
              <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                <Card className="p-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${s.bg}`}>{s.icon}</div>
                    <div>
                      <p className="text-xl font-bold">{s.value}</p>
                      <p className="text-[11px] text-muted-foreground">{s.label}</p>
                    </div>
                  </div>
                </Card>
              </motion.div>
            ))}
          </div>

          {/* Actions row */}
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">All Leads</h2>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={syncStatus}
                disabled={syncing || sending}
                title="Read LinkedIn's real 'Sent invitations' list and fix each lead's status"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing…' : 'Sync Status'}
              </Button>
              <Button
                size="sm"
                className="h-8 text-xs gap-1.5"
                onClick={sendAll}
                disabled={sending || syncing || sendableCount === 0}
                title="Send a connection request (with AI note) to every not-yet-sent lead, up to your per-run limit"
              >
                <Send className="w-3.5 h-3.5" />
                {sending ? `Sending ${sendProg.done}/${sendProg.total}…` : `Send All${sendableCount ? ` (${sendableCount})` : ''}`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 border-blue-500/40 text-blue-500 hover:bg-blue-500/10"
                onClick={() => setShowImport(true)}
              >
                <Linkedin className="w-3.5 h-3.5" />
                Import from LinkedIn
              </Button>
              <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
                <Download className="w-3.5 h-3.5" />
                Export
              </Button>
              <Button size="sm" className="h-8 text-xs gap-1.5" onClick={() => setShowAdd(true)}>
                <Plus className="w-3.5 h-3.5" />
                Add Lead
              </Button>
            </div>
          </div>

          <LeadTable onSelectLead={lead => setSelectedLeadId(String(lead.id))} />
        </div>

        {/* Side panel */}
        <AnimatePresence>
          {selectedLead && (
            <LeadScoreCard
              lead={selectedLead}
              onClose={() => setSelectedLeadId(null)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* Import from LinkedIn dialog */}
      <ImportFromLinkedIn
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={(count) => {
          setShowImport(false)
          qc.invalidateQueries({ queryKey: ['leads'] })
          toast.success(`${count} leads imported and ready to contact`)
        }}
      />

      {/* Add Lead Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Lead</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1">
              <Label className="text-xs">Full Name *</Label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Sarah Chen" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Job Title</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="VP Engineering" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Company *</Label>
              <Input value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} placeholder="Acme Corp" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email</Label>
              <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="sarah@acme.com" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">LinkedIn URL</Label>
              <Input value={form.linkedin_url} onChange={e => setForm(f => ({ ...f, linkedin_url: e.target.value }))} placeholder="linkedin.com/in/..." className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Location</Label>
              <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="San Francisco, CA" className="h-8 text-xs" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Industry</Label>
              <Input value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))} placeholder="Technology" className="h-8 text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} loading={createLead.isPending}>Add Lead</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </Layout>
  )
}
