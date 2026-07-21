import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Plus, Play, Pause, BarChart2, Users, MessageSquare,
  Calendar, ChevronRight, Megaphone, Settings2, Trash2, RefreshCw, RotateCcw,
  Upload, Download,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { SequenceEditor } from '../src/components/SequenceEditor'
import { Button } from '../src/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Badge } from '../src/components/ui/badge'
import { Switch } from '../src/components/ui/switch'
import { Progress } from '../src/components/ui/progress'
import { Input } from '../src/components/ui/input'
import { Textarea } from '../src/components/ui/textarea'
import { Label } from '../src/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../src/components/ui/dialog'
import { CampaignPerfChart } from '../src/components/AnalyticsCharts'
import { useCampaigns, useUpdateCampaignStatus, useCreateCampaign, useDeleteCampaign } from '../src/hooks/useCampaigns'
import { useQueryClient } from '@tanstack/react-query'
import { Rocket } from 'lucide-react'
import { Skeleton } from '../src/components/ui/skeleton'
import type { Campaign, CampaignStatus, SequenceStep } from '../src/types'
import { toast } from 'sonner'
import { cn } from '../src/lib/utils'


const STATUS_CONFIG: Record<CampaignStatus, { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' }> = {
  active:    { label: 'Active',    variant: 'success' },
  paused:    { label: 'Paused',    variant: 'warning' },
  draft:     { label: 'Draft',     variant: 'secondary' },
  completed: { label: 'Completed', variant: 'outline' },
}

export default function CampaignsPage() {
  const { data: campaigns, isLoading } = useCampaigns()
  const updateStatus = useUpdateCampaignStatus()
  const createCampaign = useCreateCampaign()
  const deleteCampaign = useDeleteCampaign()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newCampaign, setNewCampaign] = useState({ name: '', description: '', goal: '', autopilot: true, target_industry: '', target_title: '', daily_limit: 20 })
  const [newSteps, setNewSteps] = useState<SequenceStep[]>([])

  const selected = campaigns?.find(c => c.id === selectedId) ?? null

  // Kept in sync with the latest campaigns list so in-flight send loops (runDueSteps /
  // runAutopilotReplies) can check the CURRENT status mid-batch — a stale closure over
  // `campaigns` would otherwise keep sending for several more steps after Pause.
  const campaignsRef = React.useRef(campaigns)
  React.useEffect(() => { campaignsRef.current = campaigns }, [campaigns])
  const isCampaignActive = (campaignId: string) =>
    (campaignsRef.current || []).find(c => c.id === campaignId)?.status === 'active'

  // LinkedIn's OWN invite quota (FUSE_LIMIT_EXCEEDED) is a hard account-level wall, not a
  // per-lead problem — once hit, every remaining CONNECT in the batch fails the same way.
  // Back off CONNECT sends for a while instead of grinding through the rest of the list and
  // retrying again on the very next auto-run cycle 3 minutes later. Messages/follow-ups use a
  // different LinkedIn quota, so they're left unaffected.
  const connectBlockedUntilRef = React.useRef(0)

  // Manual Sync/Refresh: ask the extension to read who accepted your invites from LinkedIn,
  // reconcile it into the DB (flips leads to ACCEPTED → Day-2 messages become due), and refresh
  // the progress table + all related views.
  const [syncing, setSyncing] = useState(false)
  async function handleSync(campaignId: string) {
    setSyncing(true)
    try {
      toast.info('Syncing — reading who accepted your invites and any new replies from LinkedIn…', { duration: 4000 })
      await syncAcceptance()
      await fetchInboxSilently()
      await loadProgress(campaignId)
      qc.invalidateQueries({ queryKey: ['leads'] })
      qc.invalidateQueries({ queryKey: ['conversations'] })
      qc.invalidateQueries({ queryKey: ['meetings'] })
      qc.invalidateQueries({ queryKey: ['campaigns'] })
      toast.success('Synced — statuses & progress refreshed.')
    } catch {
      toast.error('Sync failed — make sure the extension is loaded and a LinkedIn tab is open & logged in.')
    } finally {
      setSyncing(false)
    }
  }

  // Re-queue FAILED connect steps (creator/Follow-primary profiles, redirects, timing) so they
  // get retried. SN member-id URLs redirect to the real profile, so retries usually succeed.
  const [retrying, setRetrying] = useState(false)
  async function handleRetryFailed(campaignId: string) {
    setRetrying(true)
    try {
      const r = await jfetch('POST', `/campaigns/${campaignId}/retry-failed`)
      toast.success(r?.message || 'Failed invites re-queued.', { duration: 6000 })
      await loadProgress(campaignId)
    } catch {
      toast.error('Could not re-queue failed invites.')
    } finally {
      setRetrying(false)
    }
  }

  async function handleToggle(c: Campaign) {
    const next: CampaignStatus = c.status === 'active' ? 'paused' : 'active'
    await updateStatus.mutateAsync({ id: c.id, status: next })
    if (next === 'active') {
      toast.success('Campaign activated — sending due invites now. Keep this tab + a LinkedIn tab open.')
      try { await runDueSteps(c.id, false) } catch {}   // fire the Day-0 connects immediately
    } else {
      toast.info('Campaign paused — no new invites/messages will go out.')
    }
  }

  async function handleCreate() {
    if (!newCampaign.name) { toast.error('Campaign name is required'); return }
    await createCampaign.mutateAsync({ ...newCampaign, sequence: newSteps })
    toast.success('Campaign created!')
    setShowCreate(false)
  }

  // ── Campaign drip runner: enrol URL-imported leads, then execute DUE steps via the extension ──
  const qc = useQueryClient()
  const [running, setRunning] = useState(false)
  const [runProgress, setRunProgress] = useState({ done: 0, total: 0 })
  const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
  const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
  const jfetch = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: body ? JSON.stringify(body) : undefined })
    return res.json().catch(() => ({}))
  }
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  // CONNECT with the campaign's OWN note (from the chosen template), sent via the extension.
  // Returns the FULL result object { success, already_connected, already_pending, error } so
  // an already-connected profile is recorded as connected, not a failure.
  const runConnect = (act: any) => new Promise<any>((resolve) => {
    const jobId = 'camp-' + act.action_id
    const onResult = (e: Event) => { window.removeEventListener(`leadpilot-invite-result-${jobId}`, onResult as any); resolve((e as CustomEvent).detail || { success: false }) }
    window.addEventListener(`leadpilot-invite-result-${jobId}`, onResult as any)
    window.dispatchEvent(new CustomEvent('leadpilot-send-invite', { detail: { linkedin_url: act.linkedin_url, note: act.text ?? '', job_id: jobId } }))
    setTimeout(() => { window.removeEventListener(`leadpilot-invite-result-${jobId}`, onResult as any); resolve({ success: false, error: 'timeout' }) }, 120000)
  })
  const runMessage = (act: any) => new Promise<boolean>((resolve) => {
    const reqId = String(Date.now()) + Math.random()
    const onResult = (e: Event) => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve(!!(e as CustomEvent).detail?.success) }
    window.addEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any)
    window.dispatchEvent(new CustomEvent('leadpilot-send-message', { detail: { reqId, target: act.thread || undefined, linkedin_url: act.linkedin_url, text: act.text } }))
    setTimeout(() => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve(false) }, 60000)
  })

  // Detect who ACCEPTED the connection request: ask the extension to read LinkedIn's connections
  // list and reconcile it into the DB (flips leads to ACCEPTED, by vanity OR fsd_profile id). This
  // is what makes Day-2 MESSAGE steps become "due" — without it, accepts are never noticed.
  const syncAcceptance = () => new Promise<boolean>((resolve) => {
    const onResult = (e: Event) => { window.removeEventListener('leadpilot-sync-status-result', onResult as any); resolve(!!(e as CustomEvent).detail?.success) }
    window.addEventListener('leadpilot-sync-status-result', onResult as any)
    window.dispatchEvent(new CustomEvent('leadpilot-sync-status'))
    setTimeout(() => { window.removeEventListener('leadpilot-sync-status-result', onResult as any); resolve(false) }, 60000)
  })

  // Pull new inbound LinkedIn messages into the DB (POST /inbox/ingest under the hood). Without
  // this, nothing ever puts a prospect's reply into the Message table on its own — it previously
  // required a human to click "Fetch Inbox" on the Conversations page — so autopilot never saw
  // replies and the plain drip (MESSAGE/FOLLOWUP due-check) never knew to hold off. Run once per
  // auto-run cycle, same cadence as syncAcceptance, before deciding what's due.
  const fetchInboxSilently = () => new Promise<boolean>((resolve) => {
    const onResult = (e: Event) => { window.removeEventListener('leadpilot-fetch-inbox-result', onResult as any); resolve(!!(e as CustomEvent).detail?.success) }
    window.addEventListener('leadpilot-fetch-inbox-result', onResult as any)
    window.dispatchEvent(new CustomEvent('leadpilot-fetch-inbox'))
    setTimeout(() => { window.removeEventListener('leadpilot-fetch-inbox-result', onResult as any); resolve(false) }, 60000)
  })

  // Execute the currently DUE steps for a campaign via the extension. `silent` = background auto-run.
  async function runDueSteps(campaignId: string, silent = false, skipSync = false): Promise<number> {
    // First reconcile acceptance so newly-accepted leads' Day-2 message becomes due this cycle.
    // (skipSync when the caller already synced this cycle — e.g. auto-run over many campaigns.)
    if (!skipSync) { try { await syncAcceptance() } catch {} }
    const due = await jfetch('GET', `/campaigns/${campaignId}/due`)
    const actions: any[] = due?.data || []
    if (!actions.length) {
      if (!silent) toast.info("Nothing to send right now — either today's daily limit is reached, or all leads are already invited / awaiting acceptance. Try again tomorrow.", { duration: 7000 })
      return 0
    }
    if (!silent) { setRunProgress({ done: 0, total: actions.length }); toast.info(`Running ${actions.length} due step(s). Keep this tab + a LinkedIn tab open.`, { duration: 5000 }) }
    let ok = 0
    for (let i = 0; i < actions.length; i++) {
      // Auto-run cycles a batch fetched before this loop started — if the campaign was Paused
      // mid-batch, stop sending the rest right now instead of finishing the whole batch first.
      if (silent && !isCampaignActive(campaignId)) break
      const a = actions[i]
      // LinkedIn's invite quota is currently blocked (see below) — leave this CONNECT step
      // PENDING and skip it entirely rather than sending it into the same wall again.
      if (a.action_type === 'CONNECT' && Date.now() < connectBlockedUntilRef.current) continue
      let res: any = { success: false }
      try {
        res = a.action_type === 'CONNECT' ? await runConnect(a) : { success: await runMessage(a) }
      } catch {}
      if (res.rate_limited) {
        connectBlockedUntilRef.current = Date.now() + 30 * 60 * 1000
        toast.error('LinkedIn has capped connection invites for now — pausing invite sends for 30 min so we don’t keep hitting the wall. Messages/follow-ups continue normally.', { duration: 8000 })
        continue   // don't record a failed result — leave it PENDING to retry after the backoff
      }
      const done = !!res.success || !!res.already_connected || !!res.already_pending
      await jfetch('POST', `/campaigns/actions/${a.action_id}/result`, {
        success: !!res.success,
        already_connected: !!res.already_connected,
        already_pending: !!res.already_pending,
        text: a.text,
      })
      if (done) ok++
      if (!silent) setRunProgress({ done: i + 1, total: actions.length })
      qc.invalidateQueries({ queryKey: ['leads'] }); qc.invalidateQueries({ queryKey: ['conversations'] })
      // Wider, more human gap between sends — a fast 5-10s burst pattern triggered LinkedIn's
      // CUSTOM_INVITE_LIMIT_REACHED after only ~4 sends; a manual (naturally-paced) send went
      // through fine right after, pointing at a burst/velocity limit rather than a hard cap.
      if (i < actions.length - 1) await sleep(20000 + Math.random() * 15000)
    }
    await loadProgress(campaignId)
    return ok
  }

  // ── Autopilot: draft goal-driven replies to inbound messages and auto-send them ──
  async function runAutopilotReplies(campaignId: string): Promise<number> {
    const res = await jfetch('GET', `/campaigns/${campaignId}/autopilot/pending`)
    const items: any[] = res?.data || []
    if (!items.length) return 0
    let sent = 0
    for (const it of items) {
      if (!isCampaignActive(campaignId)) break
      let ok = false
      try { ok = await runMessage({ thread: it.thread, linkedin_url: it.linkedin_url, text: it.reply }) } catch {}
      if (ok) {
        try { await jfetch('POST', `/inbox/${it.lead_id}/record`, { body: it.reply, campaign_id: Number(campaignId) }) } catch {}
        sent++
      }
      await sleep(4000 + Math.random() * 4000)  // human-like gap between replies
    }
    qc.invalidateQueries({ queryKey: ['conversations'] })
    qc.invalidateQueries({ queryKey: ['leads'] })
    qc.invalidateQueries({ queryKey: ['meetings'] })
    return sent
  }

  async function launchDrip(campaignId: string, opts?: { urls?: string[]; lead_ids?: number[]; connect_template?: string; message_template?: string; followup_template?: string }) {
    setRunning(true)
    setRunProgress({ done: 0, total: 0 })
    try {
      const act = await jfetch('POST', `/campaigns/${campaignId}/activate`, opts || {})
      toast.info(act?.message || 'Campaign activated.')
      const ok = await runDueSteps(campaignId, false)
      toast.success(`Drip run — ${ok} step(s) executed. Day-2/5 steps run automatically later (turn on Auto-run) or on the next launch.`)
    } finally {
      setRunning(false)
    }
  }

  // ── Auto-run: while this tab is open, execute due steps for ACTIVE campaigns on a schedule ──
  const [autoOn, setAutoOn] = useState(false)
  // A single due-step cycle (20-35s gap PER send, see runDueSteps) routinely runs past the 3-minute
  // tick interval below. Without this guard, a slow-running tick was still in-flight when the next
  // one fired — both read the same (stale, not-yet-committed) "sent today" count from /due and each
  // got their own quota's worth of actions, so the union sent past the daily cap (confirmed: a
  // 20/day campaign sent 21, with several leads double-processed by the overlapping cycles).
  const autoRunInFlightRef = React.useRef(false)
  React.useEffect(() => { if (typeof window !== 'undefined' && localStorage.getItem('leadpilot-autorun') === '1') setAutoOn(true) }, [])
  React.useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('leadpilot-autorun', autoOn ? '1' : '0')
    if (!autoOn) return
    let stop = false
    const tick = async () => {
      if (stop || running || autoRunInFlightRef.current) return
      autoRunInFlightRef.current = true
      try {
        const active = (campaigns || []).filter(c => c.status === 'active')
        if (!active.length) return
        // Sync acceptance + pull new replies ONCE per cycle, then run each campaign. Inbox must be
        // fetched BEFORE due-steps/autopilot so both see any reply that just came in this cycle
        // instead of acting a tick behind (or never, if no one opens Conversations to click Fetch).
        try { await syncAcceptance() } catch {}
        try { await fetchInboxSilently() } catch {}
        for (const c of active) {
          if (stop) break
          try { await runDueSteps(c.id, true, true) } catch {}
          // Autopilot: after drip steps, read new replies and auto-respond toward the goal.
          if (c.autopilot && !stop) { try { await runAutopilotReplies(c.id) } catch {} }
        }
      } finally {
        autoRunInFlightRef.current = false
      }
    }
    tick()
    const iv = setInterval(tick, 3 * 60 * 1000) // every 3 minutes
    return () => { stop = true; clearInterval(iv) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, campaigns])

  const [progress, setProgress] = useState<any>(null)
  async function loadProgress(id: string) {
    try { const r = await jfetch('GET', `/campaigns/${id}/progress`); setProgress(r?.data || null) } catch { setProgress(null) }
  }
  React.useEffect(() => { if (selectedId) loadProgress(selectedId); else setProgress(null) }, [selectedId])

  // ── Launch dialog: pick the AUDIENCE + write the TEMPLATES for this campaign ──
  const [showLaunch, setShowLaunch] = useState(false)
  const [launchCid, setLaunchCid] = useState('')
  const [launchLeads, setLaunchLeads] = useState<any[]>([])
  const [pickedIds, setPickedIds] = useState<Set<number>>(new Set())
  const [urlsText, setUrlsText] = useState('')
  const [tpl, setTpl] = useState({ connect: '', message: '', followup: '' })
  // Rows parsed from an uploaded CSV — same shape the scrape/import endpoint expects.
  const [fileRows, setFileRows] = useState<any[]>([])
  const [fileName, setFileName] = useState('')
  async function openLaunch(cid: string) {
    setLaunchCid(cid)
    setTpl({ connect: '', message: '', followup: '' })
    const r = await jfetch('GET', '/leads?page=1&page_size=200')
    const eligible = (r?.data || []).filter((l: any) => l.linkedin_url?.includes('/in/') && l.connection_status !== 'ACCEPTED')
    setLaunchLeads(eligible)
    setPickedIds(new Set())   // nothing pre-selected — audience = what you paste (search/URLs) or pick
    setUrlsText('')
    setFileRows([]); setFileName('')
    setShowLaunch(true)
  }

  // ── File import (same import + enrol path as URL fetch) ─────────────────────
  const SAMPLE_CSV =
    'linkedin_url,name,title,company,location\n' +
    'https://www.linkedin.com/in/jane-doe,Jane Doe,Founder & CEO,Acme Inc,San Francisco\n' +
    'https://www.linkedin.com/in/john-smith,John Smith,Head of Sales,Globex,London\n'
  function downloadSample() {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv;charset=utf-8;' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'grmconnect-leads-sample.csv'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  // Minimal CSV parser that respects quoted fields with embedded commas/newlines.
  function parseCsv(text: string): string[][] {
    const rows: string[][] = []
    let cur: string[] = [], val = '', inQ = false
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { val += '"'; i++ } else inQ = false }
        else val += c
      } else if (c === '"') inQ = true
      else if (c === ',') { cur.push(val); val = '' }
      else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = '' }
      else if (c !== '\r') val += c
    }
    if (val.length || cur.length) { cur.push(val); rows.push(cur) }
    return rows.filter(r => r.some(c => c.trim() !== ''))
  }
  function rowsToProfiles(rows: string[][]): any[] {
    if (rows.length < 2) return []
    const header = rows[0].map(h => h.trim().toLowerCase())
    const idx = (names: string[]) => header.findIndex(h => names.includes(h))
    const iUrl = idx(['linkedin_url', 'url', 'profile url', 'profile_url', 'linkedin'])
    const iName = idx(['name', 'full name', 'full_name'])
    const iTitle = idx(['title', 'headline', 'job title', 'job_title', 'role'])
    const iCompany = idx(['company', 'organization', 'organisation'])
    const iLocation = idx(['location', 'city', 'region'])
    const out: any[] = []
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]
      const get = (i: number) => (i >= 0 && row[i] != null ? String(row[i]).trim() : '')
      const url = get(iUrl), name = get(iName)
      if (!url || !name) continue
      out.push({
        name, title: get(iTitle), company: get(iCompany), location: get(iLocation),
        linkedin_url: url, profile_id: '', connection_degree: '', source: 'file',
      })
    }
    return out
  }
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''  // allow re-picking the same file later
    if (!f) return
    try {
      const profiles = rowsToProfiles(parseCsv(await f.text()))
      if (!profiles.length) {
        toast.error('No usable rows. Each row needs a linkedin_url and a name — use the sample file.')
        setFileRows([]); setFileName(''); return
      }
      setFileRows(profiles); setFileName(f.name)
      toast.success(`${profiles.length} row(s) loaded from ${f.name}`)
    } catch {
      toast.error('Could not read that file. Please upload a .csv in the sample format.')
    }
  }
  const togglePick = (id: number) => setPickedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  // Scrape a SEARCH url and enrol profiles into the campaign LIVE — each page's profiles are
  // imported + enrolled the moment they arrive, so they appear in the Progress table as they come
  // (no waiting for the whole scrape). Loops until the scrape reports done.
  async function scrapeAndEnrollLive(campaignId: string, searchUrl: string, tplBody: any) {
    toast.info('Fetching from the search — profiles will appear here as they come. Keep the LinkedIn tab open.', { duration: 6000 })
    const started = await jfetch('POST', '/scrape/start', { url: searchUrl, max_profiles: 100 })
    const jobId = started?.data?.job_id
    if (!jobId) { toast.error('Could not start the search fetch.'); return }
    console.log('[LeadPilot] scrape jobId (frontend):', jobId, '— this MUST match the background "Starting job …" id')
    window.dispatchEvent(new CustomEvent('leadpilot-scrape-start', { detail: { job_id: jobId, url: searchUrl, max_profiles: 100 } }))
    const seen = new Set<string>()
    let finished = false, guard = 0
    while (!finished && guard++ < 1200) {
      await sleep(2500)
      const st = await jfetch('GET', `/scrape/status/${jobId}`)
      const d = st?.data
      // Normalise any Sales Navigator url (/sales/lead/<id>) to a normal LinkedIn /in/<id> url — the
      // send model uses linkedin.com. (The old SN→/in/<vanity> resolver's endpoints are 404 now.)
      const norm = (u: string) => { const m = String(u || '').match(/\/sales\/lead\/([A-Za-z0-9_-]+)/); return m ? `https://www.linkedin.com/in/${m[1]}` : u }
      const all = (d?.profiles || []).map((p: any) => ({ ...p, linkedin_url: norm(p.linkedin_url) }))
      const fresh = all.filter((p: any) => p.linkedin_url && p.linkedin_url.includes('/in/') && !seen.has(p.linkedin_url))
      console.log('[LeadPilot] scrape poll — status:', d?.status, 'profiles:', all.length, 'in-urls:', fresh.length, 'sampleUrl:', all[0]?.linkedin_url)
      if (fresh.length) {
        fresh.forEach((p: any) => seen.add(p.linkedin_url))
        const imp = await jfetch('POST', '/scrape/import', { profiles: fresh })
        const ids = (imp?.data?.lead_ids || []) as number[]
        console.log('[LeadPilot] imported', fresh.length, 'profiles → lead_ids:', ids.length, imp?.message)
        if (ids.length) {
          const act = await jfetch('POST', `/campaigns/${campaignId}/activate`, { lead_ids: ids, ...tplBody })
          console.log('[LeadPilot] enrolled into campaign:', act?.data?.enrolled, act?.message)
          await loadProgress(campaignId)   // live refresh → new leads show up immediately
          qc.invalidateQueries({ queryKey: ['leads'] })
          toast.info(`Fetched ${seen.size} · enrolled +${act?.data?.enrolled ?? ids.length}…`, { id: 'scrape-live', duration: 2500 })
        } else {
          toast.info(`Fetched ${seen.size} profiles (import returned 0 leads — check console)`, { id: 'scrape-live', duration: 2500 })
        }
      }
      if (d?.status === 'done' || d?.status === 'error') finished = true
    }
    toast.success(`Fetch complete — ${seen.size} profile(s) enrolled.`)
  }

  async function confirmLaunch() {
    const lines = urlsText.split(/\n+/).map(s => s.trim()).filter(Boolean)
    const profileUrls = lines.filter(u => u.includes('/in/'))
    const searchUrls = lines.filter(u => !u.includes('/in/') && (u.includes('/search/') || u.includes('savedSearchId') || u.includes('/sales/')))
    if (!profileUrls.length && !searchUrls.length && pickedIds.size === 0 && fileRows.length === 0) {
      toast.error('Paste profile/search URL(s), upload a file, or pick at least one lead.'); return
    }
    setShowLaunch(false)
    // set_active:false → import/enrol ONLY. Nothing is sent until the user clicks ▶ Activate.
    const tplBody = { connect_template: tpl.connect, message_template: tpl.message, followup_template: tpl.followup, set_active: false }
    setRunning(true)
    try {
      // 1) Profile URLs + picked leads → import right away (no send).
      if (profileUrls.length || pickedIds.size) {
        await jfetch('POST', `/campaigns/${launchCid}/activate`, { urls: profileUrls, lead_ids: [...pickedIds], ...tplBody })
        await loadProgress(launchCid)
      }
      // 2) File-imported rows → SAME import + enrol path as fetch (no send).
      if (fileRows.length) {
        const imp = await jfetch('POST', '/scrape/import', { profiles: fileRows })
        const ids = (imp?.data?.lead_ids || []) as number[]
        if (ids.length) {
          const act = await jfetch('POST', `/campaigns/${launchCid}/activate`, { lead_ids: ids, ...tplBody })
          await loadProgress(launchCid)
          qc.invalidateQueries({ queryKey: ['leads'] })
          toast.info(`Imported ${ids.length} lead(s) from ${fileName || 'file'} · enrolled +${act?.data?.enrolled ?? ids.length}.`, { duration: 4000 })
        } else {
          toast.error('File import added 0 leads — check the linkedin_url and name columns are filled.')
        }
      }
      // 3) Search URLs → scrape + import LIVE (profiles appear as fetched, still nothing sent).
      for (const su of searchUrls) await scrapeAndEnrollLive(launchCid, su, tplBody)
      toast.success('Profiles imported into the campaign — nothing sent yet. Click ▶ Activate to start sending invites.', { duration: 8000 })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Layout>
      <div className="flex h-[calc(100vh-56px)] overflow-hidden">
        {/* Left: Campaign list */}
        <div className={cn('flex flex-col border-r border-border bg-card shrink-0 overflow-y-auto', selected ? 'w-72' : 'flex-1')}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-semibold">Campaigns ({campaigns?.length ?? 0})</h2>
            <Button size="sm" className="h-7 text-xs gap-1" onClick={() => setShowCreate(true)}>
              <Plus className="w-3 h-3" />
              New
            </Button>
          </div>
          <div className="flex-1 p-3 space-y-2">
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)
              : campaigns?.map((campaign, i) => {
                  const cfg = STATUS_CONFIG[campaign.status]
                  const isSelected = campaign.id === selectedId
                  return (
                    <motion.div
                      key={campaign.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04 }}
                      onClick={() => setSelectedId(isSelected ? null : campaign.id)}
                      className={cn(
                        'p-3 rounded-xl cursor-pointer transition-all border',
                        isSelected
                          ? 'bg-primary/10 border-primary/30'
                          : 'bg-background border-border hover:bg-muted/50'
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-xs font-semibold leading-snug">{campaign.name}</p>
                        <div className="flex items-center gap-1 shrink-0">
                          <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                          <button
                            className="p-0.5 rounded text-muted-foreground/60 hover:text-red-500 hover:bg-red-500/10"
                            title="Delete campaign"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (confirm(`Delete campaign "${campaign.name}"? This removes its drip actions (leads and sent invites are NOT deleted).`)) {
                                if (selectedId === campaign.id) setSelectedId(null)
                                deleteCampaign.mutate(campaign.id)
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1 line-clamp-1">{campaign.description}</p>
                      <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
                        <span className="flex items-center gap-1"><Users className="w-3 h-3" />{campaign.leads_count}</span>
                        <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{campaign.reply_count}</span>
                        <span className="text-emerald-500 font-medium">{campaign.reply_rate.toFixed(1)}%</span>
                      </div>
                      {selected?.id !== campaign.id && (
                        <Progress
                          value={(campaign.sent_count / Math.max(campaign.leads_count, 1)) * 100}
                          className="h-1 mt-2"
                        />
                      )}
                    </motion.div>
                  )
                })
            }
          </div>
        </div>

        {/* Right: Campaign detail */}
        <AnimatePresence>
          {selected && (
            <motion.div
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              className="flex-1 overflow-y-auto p-6 space-y-5"
            >
              {/* Header */}
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold">{selected.name}</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">{selected.description}</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => handleSync(selected.id)}
                    disabled={syncing}
                    title="Refresh: read who accepted your invites from LinkedIn and update the progress table"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
                    {syncing ? 'Syncing…' : 'Sync'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => handleRetryFailed(selected.id)}
                    disabled={retrying}
                    title="Re-queue failed invites so they're attempted again (creator/Follow-primary profiles often need a retry)"
                  >
                    <RotateCcw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
                    {retrying ? 'Retrying…' : 'Retry failed'}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5"
                    onClick={() => openLaunch(selected.id)}
                    disabled={running}
                    title="Fetch/import leads into this campaign (nothing is sent). Then click Activate to start sending."
                  >
                    <Rocket className={`w-3.5 h-3.5 ${running ? 'animate-pulse' : ''}`} />
                    {running ? `Importing ${runProgress.done}/${runProgress.total}…` : 'Fetch & Import'}
                  </Button>
                  <div
                    className="flex items-center gap-2 h-8 px-3 rounded-lg border border-input bg-background"
                    title="While ON and this tab stays open, due steps run automatically every few minutes"
                  >
                    <span className="text-xs font-medium text-muted-foreground">Auto-run</span>
                    <Switch
                      checked={autoOn}
                      onCheckedChange={(v) => { setAutoOn(v); toast.info(v ? 'Auto-run ON — keep this tab + a LinkedIn tab open; due steps run every ~3 min.' : 'Auto-run OFF.') }}
                    />
                    <span className={`text-xs font-semibold tabular-nums ${autoOn ? 'text-emerald-500' : 'text-muted-foreground'}`}>
                      {autoOn ? 'ON' : 'OFF'}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-8 gap-1.5 ${
                      selected.status === 'active'
                        ? 'border-amber-500/40 text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400'
                        : 'border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400'
                    }`}
                    onClick={() => handleToggle(selected)}
                    loading={updateStatus.isPending}
                    title={selected.status === 'active' ? 'Pause this campaign (stops sending)' : 'Activate this campaign (starts sending)'}
                  >
                    {selected.status === 'active' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                    {selected.status === 'active' ? 'Pause campaign' : 'Activate campaign'}
                  </Button>
                </div>
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Leads',    value: selected.leads_count,  icon: <Users className="w-4 h-4 text-primary" /> },
                  { label: 'Sent',     value: selected.sent_count,   icon: <MessageSquare className="w-4 h-4 text-amber-500" /> },
                  { label: 'Replies',  value: selected.reply_count,  icon: <BarChart2 className="w-4 h-4 text-emerald-500" /> },
                  { label: 'Meetings', value: selected.meeting_count, icon: <Calendar className="w-4 h-4 text-yellow-500" /> },
                ].map(s => (
                  <Card key={s.label} className="p-3">
                    <div className="flex items-center gap-2">
                      {s.icon}
                      <div>
                        <p className="text-lg font-bold">{s.value}</p>
                        <p className="text-[10px] text-muted-foreground">{s.label}</p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <Tabs defaultValue="progress">
                <TabsList>
                  <TabsTrigger value="progress" className="text-xs">Progress{progress ? ` (${progress.summary?.enrolled ?? 0})` : ''}</TabsTrigger>
                  <TabsTrigger value="sequence" className="text-xs">Sequence ({selected.sequence.length} steps)</TabsTrigger>
                  <TabsTrigger value="analytics" className="text-xs">Analytics</TabsTrigger>
                </TabsList>
                <TabsContent value="progress">
                  {(() => {
                    const stepBadge = (s: any) => {
                      const st = s?.status
                      if (st === 'SUCCESS') return <span className="text-emerald-500">✓ sent</span>
                      if (st === 'FAILED') return <span className="text-red-500">✕ failed</span>
                      if (st === 'PENDING') return <span className="text-muted-foreground">· pending</span>
                      return <span className="text-muted-foreground/40">—</span>
                    }
                    if (!progress) return <p className="text-xs text-muted-foreground py-6 text-center">No one enrolled yet. Click <b>Launch / Run Drip</b> to start.</p>
                    const sm = progress.summary || {}
                    return (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
                          <Card className="p-2.5"><p className="text-lg font-bold">{sm.enrolled ?? 0}</p><p className="text-[10px] text-muted-foreground">Enrolled</p></Card>
                          <Card className="p-2.5"><p className="text-lg font-bold text-emerald-500">{sm.connect?.SUCCESS ?? 0}</p><p className="text-[10px] text-muted-foreground">Invites sent</p></Card>
                          <Card className="p-2.5">
                            <p className="text-lg font-bold text-teal-500">{sm.accepted ?? 0}</p>
                            <p className="text-[10px] text-muted-foreground">
                              Accepted{(sm.connect?.SUCCESS ?? 0) > 0 ? ` (${Math.round(((sm.accepted ?? 0) / sm.connect.SUCCESS) * 100)}%)` : ''}
                            </p>
                          </Card>
                          <Card className="p-2.5"><p className="text-lg font-bold text-amber-500">{sm.message?.SUCCESS ?? 0}</p><p className="text-[10px] text-muted-foreground">Messages sent</p></Card>
                          <Card className="p-2.5"><p className="text-lg font-bold text-blue-500">{sm.followup?.SUCCESS ?? 0}</p><p className="text-[10px] text-muted-foreground">Follow-ups sent</p></Card>
                        </div>
                        <div className="overflow-x-auto rounded-lg border border-border">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/40 text-muted-foreground">
                              <tr>
                                <th className="text-left font-medium px-3 py-2">Lead</th>
                                <th className="text-left font-medium px-2 py-2">Connect</th>
                                <th className="text-left font-medium px-2 py-2">Message</th>
                                <th className="text-left font-medium px-2 py-2">Follow-up</th>
                                <th className="text-left font-medium px-3 py-2">Current stage</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {(progress.leads || []).map((l: any) => (
                                <tr key={l.lead_id}>
                                  <td className="px-3 py-2">
                                    <div className="font-medium">{l.lead_name}</div>
                                    <div className="text-[10px] text-muted-foreground">{l.lead_company || '—'}</div>
                                  </td>
                                  <td className="px-2 py-2">{stepBadge(l.connect)}</td>
                                  <td className="px-2 py-2">{stepBadge(l.message)}</td>
                                  <td className="px-2 py-2">{stepBadge(l.followup)}</td>
                                  <td className="px-3 py-2 text-muted-foreground">{l.stage}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {!(progress.leads || []).length && <p className="text-xs text-muted-foreground py-4 text-center">No leads enrolled yet.</p>}
                      </div>
                    )
                  })()}
                </TabsContent>
                <TabsContent value="sequence">
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">View and edit the message sequence for this campaign.</p>
                    <SequenceEditor
                      steps={selected.sequence}
                      onChange={() => {}}
                    />
                  </div>
                </TabsContent>
                <TabsContent value="analytics">
                  <CampaignPerfChart />
                </TabsContent>
              </Tabs>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Empty state when nothing selected */}
        {!selected && !isLoading && campaigns && campaigns.length > 0 && (
          <div className="hidden" />
        )}
      </div>

      {/* Create Campaign Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create New Campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Campaign Name *</Label>
                <Input value={newCampaign.name} onChange={e => setNewCampaign(f => ({ ...f, name: e.target.value }))} placeholder="Q3 SaaS Outreach" className="h-8 text-xs" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Description</Label>
                <Textarea value={newCampaign.description} onChange={e => setNewCampaign(f => ({ ...f, description: e.target.value }))} placeholder="Targeting VP+ at SaaS companies..." className="h-16 text-xs" />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs flex items-center gap-1.5">
                  🎯 Campaign Goal <span className="text-[10px] text-muted-foreground font-normal">— what the AI drives every message toward</span>
                </Label>
                <Textarea
                  value={newCampaign.goal}
                  onChange={e => setNewCampaign(f => ({ ...f, goal: e.target.value }))}
                  placeholder="e.g. Book a 15-minute call to explore funding for The Greps. Get them interested and propose a specific time."
                  className="h-16 text-xs"
                />
                <p className="text-[10px] text-muted-foreground">Combined with your <b>About You</b> profile, the AI writes the invite note, follow-ups &amp; replies to reach this goal.</p>
              </div>
              <div className="col-span-2 flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                <input
                  type="checkbox"
                  id="autopilot"
                  checked={newCampaign.autopilot}
                  onChange={e => setNewCampaign(f => ({ ...f, autopilot: e.target.checked }))}
                  className="mt-0.5"
                />
                <label htmlFor="autopilot" className="cursor-pointer">
                  <span className="text-xs font-medium flex items-center gap-1.5">⚡ Autopilot replies</span>
                  <span className="block text-[10px] text-muted-foreground mt-0.5">
                    When ON, the AI reads inbound replies and auto-sends goal-driven responses (incl. proposing a call) with no approval step. Runs while the Campaigns tab + a LinkedIn tab stay open.
                  </span>
                </label>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Target Industry</Label>
                <Input value={newCampaign.target_industry} onChange={e => setNewCampaign(f => ({ ...f, target_industry: e.target.value }))} placeholder="Technology" className="h-8 text-xs" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Target Title</Label>
                <Input value={newCampaign.target_title} onChange={e => setNewCampaign(f => ({ ...f, target_title: e.target.value }))} placeholder="VP Engineering / CTO" className="h-8 text-xs" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Daily Send Limit</Label>
                <Input type="number" value={newCampaign.daily_limit} onChange={e => setNewCampaign(f => ({ ...f, daily_limit: parseInt(e.target.value) || 20 }))} className="h-8 text-xs" min={1} max={100} />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-semibold">Message Sequence</Label>
              <SequenceEditor steps={newSteps} onChange={setNewSteps} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button size="sm" onClick={handleCreate} loading={createCampaign.isPending}>Create Campaign</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Launch: pick audience + templates */}
      <Dialog open={showLaunch} onOpenChange={setShowLaunch}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Fetch & Import leads</DialogTitle>
          </DialogHeader>
          <div className="grid md:grid-cols-2 gap-4">
            {/* Audience */}
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Paste profile URLs or a search URL</Label>
                <Textarea
                  value={urlsText}
                  onChange={e => setUrlsText(e.target.value)}
                  placeholder={'https://www.linkedin.com/in/xyz\n— or a search URL —\nhttps://www.linkedin.com/search/results/people/?...\nhttps://www.linkedin.com/sales/search/people?...'}
                  className="text-xs h-20"
                />
                <p className="text-[10px] text-muted-foreground">Profile <b>/in/</b> URLs → added directly. A <b>search / Sales Nav</b> URL → all its profiles are fetched &amp; enrolled automatically (keep a LinkedIn tab open).</p>
              </div>
              {/* Import from file — same import + enrol behaviour as fetch */}
              <div className="rounded-lg border border-dashed border-border p-2.5 space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-semibold flex items-center gap-1"><Upload className="w-3 h-3" /> Or import from a file</Label>
                  <button type="button" onClick={downloadSample} className="text-[11px] underline text-primary inline-flex items-center gap-0.5">
                    <Download className="w-3 h-3" /> Sample file
                  </button>
                </div>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={onPickFile}
                  className="block w-full text-[11px] file:mr-2 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:cursor-pointer"
                />
                {fileRows.length > 0
                  ? <p className="text-[10px] text-primary">✓ {fileRows.length} row(s) ready from <b>{fileName}</b> — will be imported &amp; enrolled just like fetch.</p>
                  : <p className="text-[10px] text-muted-foreground">Download the sample, fill <b>linkedin_url</b> &amp; <b>name</b> (title/company/location optional), then upload. Nothing is sent until you click ▶ Activate.</p>}
              </div>
              <div className="flex items-center justify-between pt-1">
                <Label className="text-xs font-semibold">Or pick existing ({pickedIds.size}/{launchLeads.length})</Label>
                <div className="flex gap-2 text-[11px]">
                  <button className="underline text-primary" onClick={() => setPickedIds(new Set(launchLeads.map(l => Number(l.id))))}>All</button>
                  <button className="underline text-muted-foreground" onClick={() => setPickedIds(new Set())}>None</button>
                </div>
              </div>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {launchLeads.length === 0 && <p className="text-[11px] text-muted-foreground px-3 py-4 text-center">No eligible imported leads (need a /in/ URL, not already connected).</p>}
                {launchLeads.map(l => (
                  <label key={l.id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/40">
                    <input type="checkbox" checked={pickedIds.has(Number(l.id))} onChange={() => togglePick(Number(l.id))} />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium">{l.name}</span>
                      <span className="text-muted-foreground"> · {l.company || '—'}</span>
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{l.connection_status || 'NOT_SENT'}</span>
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">Only NOT_SENT leads are pre-selected. Already-pending leads skip the connect step automatically.</p>
            </div>
            {/* Messages — blank = AI writes it from goal + About You */}
            <div className="space-y-2">
              <Label className="text-xs font-semibold flex items-center gap-1.5">
                ✨ Messages <span className="text-muted-foreground font-normal">— leave blank &amp; the AI writes each from your goal + About You</span>
              </Label>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Day 0 · Connect note</Label>
                <Textarea value={tpl.connect} onChange={e => setTpl(t => ({ ...t, connect: e.target.value }))} placeholder="Leave blank → AI writes it per-lead. Or type your own (use {{first_name}}, {{company}})." className="text-xs h-16" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Day 2 · Message (after they accept)</Label>
                <Textarea value={tpl.message} onChange={e => setTpl(t => ({ ...t, message: e.target.value }))} placeholder="Leave blank → AI writes it from your goal + About You." className="text-xs h-16" />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] text-muted-foreground">Day 5 · Follow-up</Label>
                <Textarea value={tpl.followup} onChange={e => setTpl(t => ({ ...t, followup: e.target.value }))} placeholder="Leave blank → AI writes it." className="text-xs h-16" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowLaunch(false)}>Cancel</Button>
            <Button size="sm" onClick={confirmLaunch} disabled={pickedIds.size === 0 && !urlsText.trim() && fileRows.length === 0} className="gap-1.5">
              <Rocket className="w-3.5 h-3.5" /> {(urlsText.trim() || fileRows.length)
                ? `Fetch & Import${fileRows.length ? ` (${fileRows.length} from file)` : ''} (no send)`
                : `Import ${pickedIds.size} lead${pickedIds.size === 1 ? '' : 's'} (no send)`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  )
}
