import React, { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Search, Download, Linkedin, Building2, MapPin, ExternalLink,
  CheckSquare, Square, Users, Globe, Sparkles, AlertTriangle,
  ChevronRight, ArrowRight, X, Loader2, CheckCircle2, XCircle,
  Trophy, Briefcase, Star, Info, RefreshCw, Clock, Send,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { Button } from '../src/components/ui/button'
import { Input } from '../src/components/ui/input'
import { Badge } from '../src/components/ui/badge'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Card, CardContent } from '../src/components/ui/card'
import { ScrollArea } from '../src/components/ui/scroll-area'
import { Progress } from '../src/components/ui/progress'
import { Separator } from '../src/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../src/components/ui/dialog'
import { Label } from '../src/components/ui/label'
import { Textarea } from '../src/components/ui/textarea'
import {
  useStartScrape, useScrapeJobStatus, useImportProfiles, useScrapeJobs,
  useStartConnectJob, useConnectJobStatus,
  type ScrapedProfile, type ScrapeJobStatus, type ConnectJobResult,
} from '../src/hooks/useImport'
import { getInitials, cn } from '../src/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

// ── Example searches ──────────────────────────────────────────────────────────

const EXAMPLES = [
  {
    label: 'CTOs at SaaS companies',
    desc: 'LinkedIn People Search',
    type: 'linkedin',
    url: 'https://www.linkedin.com/search/results/people/?keywords=CTO+SaaS&origin=GLOBAL_SEARCH_HEADER',
  },
  {
    label: 'VP Engineering – USA',
    desc: 'LinkedIn People Search',
    type: 'linkedin',
    url: 'https://www.linkedin.com/search/results/people/?keywords=VP+Engineering&geoUrn=%5B%22103644278%22%5D',
  },
  {
    label: 'Founders Series A startups',
    desc: 'LinkedIn People Search',
    type: 'linkedin',
    url: 'https://www.linkedin.com/search/results/people/?keywords=Founder+Series+A',
  },
  {
    label: 'Sales Directors – Tech (Sales Nav)',
    desc: 'Sales Navigator',
    type: 'salesnav',
    url: 'https://www.linkedin.com/sales/search/people?query=(filters:List((type:CURRENT_TITLE,values:List((text:Sales+Director)))))',
  },
]

const MAX_OPTIONS = [25, 50, 100, 200, 500]

// ── Detect URL type ──────────────────────────────────────────────────────────

function detectUrlType(url: string): 'linkedin' | 'salesnav' | 'unknown' {
  if (url.includes('/sales/search/')) return 'salesnav'
  if (url.includes('linkedin.com/search/results/people') || url.includes('linkedin.com/recruiter/')) return 'linkedin'
  return 'unknown'
}

// ── Source badge ──────────────────────────────────────────────────────────────

function SourceBadge({ source }: { source: string }) {
  if (source === 'sales_navigator') {
    return (
      <Badge className="text-[9px] px-1.5 py-0 h-4 bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-500/30 shrink-0">
        Sales Nav
      </Badge>
    )
  }
  return (
    <Badge className="text-[9px] px-1.5 py-0 h-4 bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-500/20 dark:text-blue-400 dark:border-blue-500/30 shrink-0">
      LinkedIn
    </Badge>
  )
}

// ── Profile card ──────────────────────────────────────────────────────────────

interface ProfileRowProps {
  profile: ScrapedProfile
  selected: boolean
  onToggle: () => void
}

function ProfileRow({ profile, selected, onToggle }: ProfileRowProps) {
  return (
    <div
      onClick={onToggle}
      className={cn(
        'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors border-b border-border/50 last:border-0',
        selected ? 'bg-primary/5 dark:bg-primary/10' : 'hover:bg-muted/40'
      )}
    >
      {/* Checkbox */}
      <div className="shrink-0">
        {selected
          ? <CheckSquare className="w-4 h-4 text-primary" />
          : <Square className="w-4 h-4 text-muted-foreground/50" />
        }
      </div>

      {/* Avatar */}
      <Avatar className="w-9 h-9 shrink-0">
        <AvatarFallback className="text-xs font-semibold">{getInitials(profile.name)}</AvatarFallback>
      </Avatar>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground truncate">{profile.name}</span>
          {profile.is_premium && (
            <span title="LinkedIn Premium">
              <Star className="w-3 h-3 text-amber-500 shrink-0" />
            </span>
          )}
          {profile.is_open_to_work && (
            <Badge className="text-[9px] px-1 py-0 h-3.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400 shrink-0">
              Open to work
            </Badge>
          )}
          {profile.connection_degree && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 shrink-0">
              {profile.connection_degree}
            </Badge>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{profile.title}</p>

        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {profile.company && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Building2 className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate max-w-[120px]">{profile.company}</span>
            </span>
          )}
          {profile.location && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <MapPin className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate max-w-[110px]">{profile.location}</span>
            </span>
          )}
          {profile.industry && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Briefcase className="w-2.5 h-2.5 shrink-0" />
              <span className="truncate max-w-[110px]">{profile.industry}</span>
            </span>
          )}
          {profile.company_size && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
              <Users className="w-2.5 h-2.5 shrink-0" />
              {profile.company_size}
            </span>
          )}
          {profile.mutual_connections && (
            <span className="text-[10px] text-blue-500 dark:text-blue-400 flex items-center gap-1">
              <Users className="w-2.5 h-2.5 shrink-0" />
              {profile.mutual_connections}
            </span>
          )}
        </div>
      </div>

      {/* Right: source + link */}
      <div className="flex items-center gap-2 shrink-0">
        <SourceBadge source={profile.source} />
        <a
          href={profile.linkedin_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground hover:text-primary transition-colors"
          title="Open profile"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>
    </div>
  )
}

// ── Live status indicator ─────────────────────────────────────────────────────

function StatusBar({ status, profilesFound, pagesScraped, error }: {
  status: ScrapeJobStatus
  profilesFound: number
  pagesScraped: number
  error: string | null
}) {
  if (status === 'pending') {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 bg-blue-500/5 border border-blue-500/20 rounded-xl">
        <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
        <div>
          <p className="text-xs font-medium text-blue-600 dark:text-blue-400">Extension starting...</p>
          <p className="text-[11px] text-muted-foreground">
            Opening LinkedIn in your Chrome — make sure the LeadPilot extension is installed & enabled
          </p>
        </div>
      </div>
    )
  }

  if (status === 'running') {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
        <div className="w-4 h-4 shrink-0 relative">
          <div className="absolute inset-0 rounded-full bg-amber-500 animate-ping opacity-40" />
          <div className="absolute inset-1 rounded-full bg-amber-500" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Scraping page {pagesScraped} in your Chrome...
          </p>
          <p className="text-[11px] text-muted-foreground">
            {profilesFound} profiles found — extension is reading the page like a human
          </p>
        </div>
        <span className="text-sm font-bold text-amber-600 dark:text-amber-400 shrink-0">
          {profilesFound}
        </span>
      </div>
    )
  }

  if (status === 'done') {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
        <div>
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Extraction complete
          </p>
          <p className="text-[11px] text-muted-foreground">
            {profilesFound} profiles across {pagesScraped} page{pagesScraped !== 1 ? 's' : ''}
          </p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-2.5 px-4 py-3 bg-red-500/5 border border-red-500/20 rounded-xl">
        <XCircle className="w-4 h-4 text-red-500 shrink-0" />
        <div>
          <p className="text-xs font-medium text-red-600 dark:text-red-400">Extraction failed</p>
          <p className="text-[11px] text-muted-foreground">{error ?? 'Unknown error'}</p>
        </div>
      </div>
    )
  }

  return null
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SearcherPage() {
  const qc = useQueryClient()

  const [url, setUrl]           = useState('')
  const [maxProfiles, setMax]   = useState(100)
  const [jobId, setJobId]       = useState<string | null>(null)
  const [isActive, setIsActive] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filterText, setFilterText] = useState('')
  const [extConnected, setExtConnected] = useState(false)
  const [pendingTooLong, setPendingTooLong] = useState(false)
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Detect if the LeadPilot extension is installed
  useEffect(() => {
    const onReady = () => setExtConnected(true)
    window.addEventListener('leadpilot-extension-ready', onReady)
    // Ping the content script in case it loaded before this component mounted
    window.dispatchEvent(new CustomEvent('leadpilot-ping'))
    // If no response in 1s, content script is not loaded
    return () => window.removeEventListener('leadpilot-extension-ready', onReady)
  }, [])

  const [connectOpen, setConnectOpen]       = useState(false)
  const [connectStep, setConnectStep]       = useState<'config' | 'connecting' | 'done'>('config')
  const [connectLimit, setConnectLimit]     = useState(10)
  const [connectContext, setConnectContext] = useState('')
  const [connectJobId, setConnectJobId]     = useState<string | null>(null)

  const startScrape    = useStartScrape()
  const importProfiles = useImportProfiles()
  const startConnect   = useStartConnectJob()
  const connectStatus  = useConnectJobStatus(connectJobId)
  const { data: jobsData } = useScrapeJobs()

  const { data: statusData } = useScrapeJobStatus(jobId, isActive)
  const jobStatus   = statusData?.data
  const scrapeStatus: ScrapeJobStatus = jobStatus?.status ?? 'done'

  // Auto-select all new profiles as they arrive
  const prevCountRef = useRef(0)
  useEffect(() => {
    const profiles = jobStatus?.profiles ?? []
    if (profiles.length > prevCountRef.current) {
      const newUrls = profiles.slice(prevCountRef.current).map((p) => p.linkedin_url)
      setSelected((prev) => {
        const next = new Set(prev)
        newUrls.forEach((u) => next.add(u))
        return next
      })
      prevCountRef.current = profiles.length
    }
  }, [jobStatus?.profiles])

  // Stop polling when done
  useEffect(() => {
    if (scrapeStatus === 'done' || scrapeStatus === 'error') {
      setIsActive(false)
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    }
    // If job moves out of pending, reset the "too long" flag
    if (scrapeStatus !== 'pending') setPendingTooLong(false)
  }, [scrapeStatus])

  // Show helpful error if job is pending for more than 12 seconds (extension not responding)
  useEffect(() => {
    if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current)
    if (isActive && scrapeStatus === 'pending') {
      pendingTimerRef.current = setTimeout(() => setPendingTooLong(true), 12000)
    }
    return () => { if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current) }
  }, [isActive, scrapeStatus])

  const urlType = detectUrlType(url)

  async function handleStart() {
    if (!url.trim()) {
      toast.error('Paste a LinkedIn or Sales Navigator search URL')
      return
    }
    if (urlType === 'unknown') {
      toast.error('URL must be a LinkedIn or Sales Navigator search URL')
      return
    }
    prevCountRef.current = 0
    setSelected(new Set())
    setJobId(null)

    try {
      const res = await startScrape.mutateAsync({ url: url.trim(), max_profiles: maxProfiles })
      const id = res.data?.job_id
      if (id) {
        setJobId(id)
        setIsActive(true)
        qc.invalidateQueries({ queryKey: ['scrape-job-status', id] })

        // Wake up the LeadPilot Chrome extension to process this job.
        setPendingTooLong(false)
        window.dispatchEvent(new CustomEvent('leadpilot-scrape-start', {
          detail: { job_id: id, url: url.trim(), max_profiles: maxProfiles }
        }))
      }
    } catch {
      // error toast from hook
    }
  }

  function handleReset() {
    setJobId(null)
    setIsActive(false)
    setSelected(new Set())
    setFilterText('')
    prevCountRef.current = 0
  }

  async function handleImport() {
    const allProfiles = jobStatus?.profiles ?? []
    const toImport = allProfiles.filter((p) => selected.has(p.linkedin_url))
    if (!toImport.length) {
      toast.error('Select at least one profile to import')
      return
    }
    try {
      await importProfiles.mutateAsync(toImport)
      qc.invalidateQueries({ queryKey: ['leads'] })
    } catch {
      // error toast from hook
    }
  }

  function toggleSelect(url: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(url) ? next.delete(url) : next.add(url)
      return next
    })
  }

  function toggleAll() {
    const profiles = jobStatus?.profiles ?? []
    if (selected.size === profiles.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(profiles.map((p) => p.linkedin_url)))
    }
  }

  function handleOpenConnect() {
    setConnectStep('config')
    setConnectJobId(null)
    setConnectOpen(true)
  }

  async function handleStartConnect() {
    const toConnect = allProfiles.filter((p) => selected.has(p.linkedin_url))
    if (!toConnect.length) { toast.error('Select at least one profile'); return }
    setConnectStep('connecting')
    try {
      const res = await startConnect.mutateAsync({
        profiles: toConnect,
        limit: connectLimit,
        note_context: connectContext.trim(),
      })
      setConnectJobId(res.data.job_id)
    } catch {
      setConnectStep('config')
    }
  }

  // Auto-advance to 'done' when connect job completes
  useEffect(() => {
    const status = connectStatus.data?.data?.status
    if (status === 'done' && connectStep === 'connecting') {
      setConnectStep('done')
    }
  }, [connectStatus.data?.data?.status, connectStep])

  const allProfiles   = jobStatus?.profiles ?? []
  const filteredProfiles = filterText.trim()
    ? allProfiles.filter((p) => {
        const q = filterText.toLowerCase()
        return (
          p.name.toLowerCase().includes(q) ||
          p.company.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          p.location.toLowerCase().includes(q) ||
          p.industry.toLowerCase().includes(q)
        )
      })
    : allProfiles

  const hasResults   = allProfiles.length > 0
  const isJobActive  = !!jobId
  const isRunning    = isJobActive && (scrapeStatus === 'pending' || scrapeStatus === 'running')
  const isDone       = scrapeStatus === 'done'

  return (
    <Layout>
      <div className="flex h-[calc(100vh-56px)] overflow-hidden">
        {/* ── Left panel: controls ── */}
        <div className="w-80 shrink-0 flex flex-col border-r border-border bg-muted/20 overflow-y-auto">
          <div className="p-5 space-y-5">
            {/* Header */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-7 h-7 rounded-lg gradient-brand flex items-center justify-center">
                  <Search className="w-3.5 h-3.5 text-white" />
                </div>
                <h1 className="text-sm font-bold">LinkedIn Searcher</h1>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Extract leads from any LinkedIn or Sales Navigator search URL with human-like browsing.
              </p>
            </div>

            <Separator />

            {/* Extension status */}
            <div className={cn(
              'flex items-center gap-2 px-3 py-2 rounded-lg text-xs border',
              extConnected
                ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/5 border-amber-500/20 text-amber-600 dark:text-amber-400'
            )}>
              <div className={cn('w-2 h-2 rounded-full shrink-0', extConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse')} />
              {extConnected ? (
                <span>Extension connected ✓</span>
              ) : (
                <div>
                  <p className="font-semibold">Extension not detected</p>
                  <p className="text-[10px] opacity-80 mt-0.5">
                    Reload the extension → press <strong>F5</strong> here → try again
                  </p>
                </div>
              )}
            </div>

            {/* URL input */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground">Search URL</label>
              <div className="relative">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste LinkedIn or Sales Nav URL..."
                  className="h-9 text-xs pr-8"
                  onKeyDown={(e) => e.key === 'Enter' && !isRunning && handleStart()}
                  disabled={isRunning}
                />
                {url && (
                  <button
                    onClick={() => setUrl('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>

              {/* URL type badge */}
              {url && (
                <div className="flex items-center gap-2">
                  {urlType === 'linkedin' && (
                    <Badge className="text-[10px] gap-1 bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400 border-blue-200 dark:border-blue-500/30">
                      <Linkedin className="w-2.5 h-2.5" /> LinkedIn People Search
                    </Badge>
                  )}
                  {urlType === 'salesnav' && (
                    <Badge className="text-[10px] gap-1 bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 border-amber-200 dark:border-amber-500/30">
                      <Trophy className="w-2.5 h-2.5" /> Sales Navigator
                    </Badge>
                  )}
                  {urlType === 'unknown' && url.includes('linkedin') && (
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      <AlertTriangle className="w-2.5 h-2.5 mr-1" /> Unsupported URL type
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {/* Max profiles */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-foreground">Max profiles to extract</label>
              <div className="flex flex-wrap gap-1.5">
                {MAX_OPTIONS.map((n) => (
                  <button
                    key={n}
                    onClick={() => setMax(n)}
                    disabled={isRunning}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs border transition-colors',
                      maxProfiles === n
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'border-border hover:bg-muted text-muted-foreground'
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                LinkedIn typically shows ~10 profiles/page. 100 = ~10 pages.
              </p>
            </div>

            {/* CTA */}
            {!isJobActive ? (
              <Button
                onClick={handleStart}
                disabled={!url.trim() || urlType === 'unknown' || startScrape.isPending}
                className="w-full gap-2"
                variant="gradient"
                size="sm"
              >
                {startScrape.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Search className="w-3.5 h-3.5" />
                )}
                Start Search
              </Button>
            ) : (
              <div className="flex gap-2">
                <Button
                  onClick={handleReset}
                  variant="outline"
                  size="sm"
                  className="flex-1 gap-2 text-xs"
                  disabled={isRunning}
                >
                  <RefreshCw className="w-3 h-3" />
                  New Search
                </Button>
                {hasResults && !isRunning && (
                  <Button
                    onClick={handleImport}
                    disabled={selected.size === 0 || importProfiles.isPending}
                    size="sm"
                    className="flex-1 gap-2 text-xs"
                    variant="gradient"
                  >
                    {importProfiles.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    Import {selected.size}
                  </Button>
                )}
              </div>
            )}

            {/* Info notice */}
            <div className="flex items-start gap-2 p-3 bg-blue-500/5 border border-blue-500/15 rounded-lg">
              <Info className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
              <div className="text-[10px] text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">How to get the URL</p>
                <ol className="list-decimal pl-3 space-y-0.5">
                  <li>Go to LinkedIn → People search</li>
                  <li>Apply filters (title, company, location…)</li>
                  <li>Copy the browser URL and paste it here</li>
                </ol>
              </div>
            </div>

            <Separator />

            {/* Example searches */}
            <div className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Quick examples</p>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.url}
                  onClick={() => { setUrl(ex.url); handleReset() }}
                  disabled={isRunning}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-left hover:bg-muted transition-colors group disabled:opacity-50"
                >
                  <div className={cn(
                    'w-4 h-4 rounded shrink-0 flex items-center justify-center',
                    ex.type === 'salesnav' ? 'bg-amber-100 dark:bg-amber-500/20' : 'bg-blue-100 dark:bg-blue-500/20'
                  )}>
                    {ex.type === 'salesnav'
                      ? <Trophy className="w-2.5 h-2.5 text-amber-600 dark:text-amber-400" />
                      : <Linkedin className="w-2.5 h-2.5 text-blue-600 dark:text-blue-400" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate">{ex.label}</p>
                    <p className="text-[10px] text-muted-foreground">{ex.desc}</p>
                  </div>
                  <ChevronRight className="w-3 h-3 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
                </button>
              ))}
            </div>

            {/* Recent jobs */}
            {jobsData?.data && jobsData.data.length > 0 && (
              <>
                <Separator />
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent searches</p>
                  {jobsData.data.slice(0, 4).map((job) => (
                    <div key={job.job_id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[10px] text-muted-foreground hover:bg-muted cursor-default">
                      <Clock className="w-3 h-3 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground truncate">{job.url.split('?')[0].replace('https://www.', '').slice(0, 35)}...</p>
                        <p>{job.profiles_found} profiles</p>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Right panel: results ── */}
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* Top bar */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0">
            {isJobActive && jobStatus && (
              <StatusBar
                status={scrapeStatus}
                profilesFound={jobStatus.progress_profiles}
                pagesScraped={jobStatus.progress_pages}
                error={jobStatus.error}
              />
            )}
            {!isJobActive && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Globe className="w-4 h-4" />
                <span>Enter a search URL on the left to extract profiles</span>
              </div>
            )}
            {hasResults && (
              <>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <Input
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder="Filter results..."
                    className="h-7 text-xs w-44"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={toggleAll}
                  >
                    {selected.size === allProfiles.length ? 'Deselect all' : `Select all (${allProfiles.length})`}
                  </Button>
                </div>
              </>
            )}
          </div>

          {/* Results area */}
          <div className="flex-1 overflow-hidden">
            {!isJobActive && !hasResults && (
              /* Empty state */
              <div className="flex flex-col items-center justify-center h-full text-center px-8">
                <motion.div
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="space-y-4 max-w-sm"
                >
                  <div className="w-16 h-16 rounded-2xl gradient-brand flex items-center justify-center mx-auto shadow-lg shadow-amber-500/20">
                    <Sparkles className="w-8 h-8 text-white" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold">Find Anyone on LinkedIn</h2>
                    <p className="text-sm text-muted-foreground mt-1">
                      Paste a LinkedIn People Search or Sales Navigator URL on the left.
                      We'll extract all profiles using human-like browsing behavior.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-left">
                    {[
                      { icon: <Linkedin className="w-3.5 h-3.5" />, text: 'LinkedIn People Search' },
                      { icon: <Trophy className="w-3.5 h-3.5" />, text: 'Sales Navigator Search' },
                      { icon: <Users className="w-3.5 h-3.5" />, text: 'All filters respected' },
                      { icon: <Sparkles className="w-3.5 h-3.5" />, text: 'Human-like browsing' },
                    ].map((f, i) => (
                      <div key={i} className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50 text-xs text-muted-foreground">
                        <span className="text-primary">{f.icon}</span>
                        {f.text}
                      </div>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={() => {
                      setUrl(EXAMPLES[0].url)
                    }}
                  >
                    <ArrowRight className="w-3.5 h-3.5" />
                    Try an example search
                  </Button>
                </motion.div>
              </div>
            )}

            {/* Loading state (no results yet) */}
            {isJobActive && !hasResults && isRunning && (
              <div className="flex flex-col items-center justify-center h-full gap-5 px-8">
                {pendingTooLong ? (
                  /* Extension not responding */
                  <div className="max-w-sm w-full space-y-4 text-center">
                    <div className="w-14 h-14 rounded-2xl bg-amber-500/10 flex items-center justify-center mx-auto">
                      <AlertTriangle className="w-7 h-7 text-amber-500" />
                    </div>
                    <div>
                      <p className="text-sm font-bold">Extension not responding</p>
                      <p className="text-xs text-muted-foreground mt-1 max-w-xs mx-auto">
                        The LeadPilot extension didn't start. Follow these steps:
                      </p>
                    </div>
                    <div className="text-left space-y-2 bg-muted/50 rounded-xl p-4">
                      {[
                        'Press F5 to reload this page (required after extension reload)',
                        'Make sure LeadPilot extension is enabled in chrome://extensions',
                        'Click "New Search" and try again',
                      ].map((step, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          <span className="w-5 h-5 rounded-full gradient-brand text-white text-[10px] font-bold flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                          <span className="text-muted-foreground">{step}</span>
                        </div>
                      ))}
                    </div>
                    <Button variant="outline" size="sm" className="gap-2" onClick={() => window.location.reload()}>
                      <RefreshCw className="w-3.5 h-3.5" /> Reload page now
                    </Button>
                  </div>
                ) : (
                  <>
                    <motion.div
                      animate={{ scale: [1, 1.08, 1] }}
                      transition={{ duration: 2, repeat: Infinity }}
                      className="w-20 h-20 rounded-2xl gradient-brand flex items-center justify-center shadow-xl shadow-amber-500/25"
                    >
                      <Linkedin className="w-10 h-10 text-white" />
                    </motion.div>
                    <div className="text-center space-y-1.5">
                      <p className="text-sm font-semibold">
                        {scrapeStatus === 'pending' ? 'Waiting for extension...' : 'Extracting profiles in your Chrome...'}
                      </p>
                      <p className="text-xs text-muted-foreground max-w-xs">
                        {scrapeStatus === 'pending'
                          ? 'Extension is opening a LinkedIn tab in your browser'
                          : 'Scrolling through results and reading profile cards'}
                      </p>
                      {jobStatus && jobStatus.progress_pages > 0 && (
                        <p className="text-xs font-medium text-amber-500 dark:text-amber-400">
                          Page {jobStatus.progress_pages} — {jobStatus.progress_profiles} profiles found
                        </p>
                      )}
                    </div>
                    <Progress value={undefined} className="w-48 h-1.5" />
                  </>
                )}
              </div>
            )}

            {/* Results list */}
            {hasResults && (
              <div className="flex flex-col h-full">
                {/* Stats row */}
                <div className="flex items-center gap-4 px-5 py-2.5 border-b border-border/50 bg-muted/20 shrink-0">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="font-bold text-foreground">{allProfiles.length}</span>
                    <span className="text-muted-foreground">profiles extracted</span>
                    {isRunning && <Loader2 className="w-3 h-3 animate-spin text-amber-500 ml-1" />}
                  </div>
                  {filterText && (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="text-foreground font-medium">{filteredProfiles.length}</span> matching filter
                    </div>
                  )}
                  <div className="flex items-center gap-3 ml-auto text-xs text-muted-foreground">
                    {allProfiles.filter(p => p.source === 'sales_navigator').length > 0 && (
                      <span className="flex items-center gap-1">
                        <Trophy className="w-3 h-3 text-amber-500" />
                        {allProfiles.filter(p => p.source === 'sales_navigator').length} Sales Nav
                      </span>
                    )}
                    {allProfiles.filter(p => p.source === 'linkedin_search').length > 0 && (
                      <span className="flex items-center gap-1">
                        <Linkedin className="w-3 h-3 text-blue-500" />
                        {allProfiles.filter(p => p.source === 'linkedin_search').length} LinkedIn
                      </span>
                    )}
                    {allProfiles.filter(p => p.is_open_to_work).length > 0 && (
                      <span className="flex items-center gap-1 text-emerald-500">
                        <CheckCircle2 className="w-3 h-3" />
                        {allProfiles.filter(p => p.is_open_to_work).length} open to work
                      </span>
                    )}
                  </div>
                </div>

                <ScrollArea className="flex-1">
                  <AnimatePresence>
                    {filteredProfiles.map((profile, idx) => (
                      <motion.div
                        key={profile.linkedin_url}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2, delay: Math.min(idx * 0.02, 0.4) }}
                      >
                        <ProfileRow
                          profile={profile}
                          selected={selected.has(profile.linkedin_url)}
                          onToggle={() => toggleSelect(profile.linkedin_url)}
                        />
                      </motion.div>
                    ))}
                  </AnimatePresence>

                  {filteredProfiles.length === 0 && filterText && (
                    <div className="flex flex-col items-center justify-center py-16 text-center">
                      <Search className="w-8 h-8 text-muted-foreground/30 mb-2" />
                      <p className="text-sm font-medium">No matches for "{filterText}"</p>
                      <p className="text-xs text-muted-foreground mt-1">Try a different name, company, or title</p>
                    </div>
                  )}
                </ScrollArea>

                {/* Import action bar */}
                {!isRunning && selected.size > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 px-5 py-3 border-t border-border bg-background shrink-0"
                  >
                    <div className="flex-1 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">{selected.size}</span> selected
                      {selected.size < allProfiles.length && (
                        <button
                          className="ml-2 text-primary hover:underline"
                          onClick={toggleAll}
                        >
                          Select all {allProfiles.length}
                        </button>
                      )}
                    </div>
                    <Button
                      onClick={handleImport}
                      disabled={importProfiles.isPending}
                      size="sm"
                      className="gap-2"
                    >
                      {importProfiles.isPending ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Download className="w-3.5 h-3.5" />
                      )}
                      Import {selected.size} to CRM
                    </Button>
                    <Button
                      onClick={handleOpenConnect}
                      size="sm"
                      className="gap-2"
                      variant="gradient"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      Send AI Invites
                    </Button>
                  </motion.div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {/* ── Connect Dialog ── */}
      <Dialog open={connectOpen} onOpenChange={(o) => { if (!o) setConnectOpen(false) }}>
        <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <div className="w-6 h-6 rounded gradient-brand flex items-center justify-center">
                <Sparkles className="w-3.5 h-3.5 text-white" />
              </div>
              Send AI-Personalized Connection Requests
            </DialogTitle>
          </DialogHeader>

          {/* Config step */}
          {connectStep === 'config' && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              <div className="flex items-start gap-2.5 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
                <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  Claude AI writes a unique invite note for each profile using their name, title &amp; company.
                  Sent one-by-one with human-like delays.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">How many invites to send</Label>
                <div className="flex items-center gap-2">
                  {[5, 10, 20, 50].map(n => (
                    <button
                      key={n}
                      onClick={() => setConnectLimit(n)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        connectLimit === n
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border hover:bg-muted'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Will send to {Math.min(connectLimit, selected.size)} of {selected.size} selected profiles
                </p>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-medium">
                  What&apos;s your outreach about?{' '}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  value={connectContext}
                  onChange={e => setConnectContext(e.target.value)}
                  placeholder="e.g. Looking to connect with marketing directors about AI-driven campaign tools…"
                  className="h-20 text-xs resize-none"
                />
              </div>

              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                1st-degree connections are already connected and will be skipped automatically.
              </div>

              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setConnectOpen(false)}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={handleStartConnect}
                  disabled={startConnect.isPending || selected.size === 0}
                  className="gap-2"
                  variant="gradient"
                >
                  {startConnect.isPending
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Send className="w-3.5 h-3.5" />
                  }
                  Send {Math.min(connectLimit, selected.size)} Invites with AI
                </Button>
              </DialogFooter>
            </motion.div>
          )}

          {/* Connecting step — live progress */}
          {connectStep === 'connecting' && (() => {
            const job = connectStatus.data?.data
            const isErr = job?.status === 'error'
            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-4">
                <div className="flex flex-col items-center py-4 space-y-3">
                  <div className={cn(
                    'w-12 h-12 rounded-full flex items-center justify-center',
                    isErr ? 'bg-destructive/10' : 'gradient-brand animate-pulse'
                  )}>
                    {isErr ? <XCircle className="w-6 h-6 text-destructive" /> : <Send className="w-6 h-6 text-white" />}
                  </div>
                  <div className="text-center space-y-0.5">
                    <p className="text-sm font-semibold">
                      {isErr ? 'Job failed' : `Sending ${job?.total ?? connectLimit} invites…`}
                    </p>
                    <p className="text-xs text-muted-foreground">{connectStatus.data?.message ?? 'Starting browser…'}</p>
                  </div>
                  {job && !isErr && (
                    <>
                      <div className="flex items-center gap-4 text-xs">
                        <span className="flex items-center gap-1 text-emerald-500">
                          <CheckCircle2 className="w-3.5 h-3.5" />{job.sent} sent
                        </span>
                        {job.failed > 0 && (
                          <span className="flex items-center gap-1 text-destructive">
                            <XCircle className="w-3.5 h-3.5" />{job.failed} failed
                          </span>
                        )}
                        <span className="text-muted-foreground">{job.total - job.sent - job.failed} remaining</span>
                      </div>
                      <Progress className="w-48 h-1.5" value={job.total > 0 ? ((job.sent + job.failed) / job.total) * 100 : undefined} />
                    </>
                  )}
                </div>

                {(job?.results ?? []).length > 0 && (
                  <ScrollArea className="max-h-[200px] border border-border rounded-xl">
                    <div className="divide-y divide-border">
                      {[...(job?.results ?? [])].reverse().map((r: ConnectJobResult, i: number) => (
                        <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                          {r.success
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                            : <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                          }
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{r.name}</p>
                            {r.success
                              ? <p className="text-[11px] text-muted-foreground italic truncate">&ldquo;{r.note}&rdquo;</p>
                              : <p className="text-[11px] text-destructive truncate">{r.error ?? 'Failed'}</p>
                            }
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}

                {isErr && (
                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setConnectStep('config')}>Try again</Button>
                    <Button size="sm" onClick={() => setConnectOpen(false)}>Close</Button>
                  </DialogFooter>
                )}
              </motion.div>
            )
          })()}

          {/* Done step */}
          {connectStep === 'done' && (() => {
            const job = connectStatus.data?.data
            return (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="flex flex-col items-center py-6 space-y-4 text-center"
              >
                <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                  <Send className="w-7 h-7 text-emerald-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-base font-bold">{job?.sent ?? 0} invites sent!</p>
                  {(job?.failed ?? 0) > 0 && (
                    <p className="text-xs text-muted-foreground">{job?.failed} skipped (already connected or no Connect button)</p>
                  )}
                  <p className="text-xs text-muted-foreground">Each note was personalised by Claude AI.</p>
                </div>

                {(job?.results ?? []).length > 0 && (
                  <ScrollArea className="w-full max-h-[200px] border border-border rounded-xl text-left">
                    <div className="divide-y divide-border">
                      {job!.results.map((r, i) => (
                        <div key={i} className="flex items-start gap-2.5 px-3 py-2">
                          {r.success
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                            : <XCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
                          }
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium truncate">{r.name}</p>
                            {r.success && (
                              <p className="text-[11px] text-muted-foreground italic truncate">&ldquo;{r.note}&rdquo;</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}

                <Button size="sm" onClick={() => setConnectOpen(false)}>Done</Button>
              </motion.div>
            )
          })()}
        </DialogContent>
      </Dialog>
    </Layout>
  )
}
