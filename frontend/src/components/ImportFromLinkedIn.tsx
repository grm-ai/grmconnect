import React, { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Linkedin, Search, Download, CheckSquare, Square, Loader2,
  AlertTriangle, Building2, MapPin, ChevronRight,
  ExternalLink, Sparkles, Info, CheckCircle2, XCircle, Send,
} from 'lucide-react'
import { Textarea } from './ui/textarea'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Label } from './ui/label'
import { ScrollArea } from './ui/scroll-area'
import { Progress } from './ui/progress'
import { Avatar, AvatarFallback } from './ui/avatar'
import {
  usePreviewScrape, useImportProfiles,
  useStartConnectJob, useConnectJobStatus,
  type ScrapedProfile, type ConnectJobResult,
} from '../hooks/useImport'
import { getInitials } from '../lib/utils'
import { toast } from 'sonner'
import { cn } from '../lib/utils'

interface ImportFromLinkedInProps {
  open: boolean
  onClose: () => void
  onImported: (count: number) => void
}

const EXAMPLE_URLS = [
  {
    label: 'CTOs at SaaS companies',
    url: 'https://www.linkedin.com/search/results/people/?keywords=CTO%20SaaS&origin=GLOBAL_SEARCH_HEADER',
  },
  {
    label: 'VPs of Engineering in USA',
    url: 'https://www.linkedin.com/search/results/people/?keywords=VP%20Engineering&geoUrn=%5B%22103644278%22%5D',
  },
  {
    label: 'Founders at Series A startups',
    url: 'https://www.linkedin.com/search/results/people/?keywords=Founder%20Series%20A',
  },
]

type Step = 'input' | 'scraping' | 'preview' | 'importing' | 'done' | 'connect-config' | 'connecting' | 'connect-done'

export function ImportFromLinkedIn({ open, onClose, onImported }: ImportFromLinkedInProps) {
  const [url, setUrl]             = useState('')
  const [maxProfiles, setMax]     = useState(50)
  const [step, setStep]           = useState<Step>('input')
  const [profiles, setProfiles]   = useState<ScrapedProfile[]>([])
  const [selected, setSelected]   = useState<Set<string>>(new Set())
  const [importedCount, setImportedCount] = useState(0)
  const [connectLimit, setConnectLimit]   = useState(10)
  const [connectContext, setConnectContext] = useState('')
  const [connectJobId, setConnectJobId]   = useState<string | null>(null)

  const preview        = usePreviewScrape()
  const importProfiles = useImportProfiles()
  const startConnect   = useStartConnectJob()
  const connectStatus  = useConnectJobStatus(connectJobId)

  function resetDialog() {
    setUrl(''); setStep('input'); setProfiles([]); setSelected(new Set()); setImportedCount(0)
    setConnectLimit(10); setConnectContext(''); setConnectJobId(null)
  }

  async function handleStartConnect() {
    const toConnect = profiles.filter(p => selected.has(p.linkedin_url))
    if (!toConnect.length) { toast.error('Select at least one profile'); return }
    setStep('connecting')
    try {
      const res = await startConnect.mutateAsync({
        profiles: toConnect,
        limit: connectLimit,
        note_context: connectContext.trim(),
      })
      setConnectJobId(res.data.job_id)
    } catch {
      setStep('connect-config')
    }
  }

  function handleClose() {
    resetDialog(); onClose()
  }

  async function handleScrape() {
    if (!url.trim()) {
      toast.error('Paste a LinkedIn search URL first')
      return
    }
    setStep('scraping')
    try {
      const res = await preview.mutateAsync({ url: url.trim(), max_profiles: maxProfiles })
      const found = res.data?.profiles ?? []
      setProfiles(found)
      // Select all by default
      setSelected(new Set(found.map(p => p.linkedin_url)))
      setStep('preview')
    } catch {
      setStep('input')
    }
  }

  async function handleImport() {
    const toImport = profiles.filter(p => selected.has(p.linkedin_url))
    if (!toImport.length) {
      toast.error('Select at least one profile')
      return
    }
    setStep('importing')
    try {
      const res = await importProfiles.mutateAsync(toImport)
      const count = (res.data?.imported ?? 0) + (res.data?.updated ?? 0)
      setImportedCount(count)
      setStep('done')
      onImported(count)
    } catch {
      setStep('preview')
    }
  }

  function toggleSelect(url: string) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(url) ? next.delete(url) : next.add(url)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === profiles.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(profiles.map(p => p.linkedin_url)))
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center">
              <Linkedin className="w-3.5 h-3.5 text-white" />
            </div>
            Import from LinkedIn Search
          </DialogTitle>
        </DialogHeader>

        {/* Step: Input URL */}
        {step === 'input' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            {/* Info banner */}
            <div className="flex items-start gap-2.5 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <div className="text-xs text-blue-600 dark:text-blue-400 space-y-1">
                <p className="font-medium">How to get the search URL:</p>
                <ol className="list-decimal pl-4 space-y-1 text-muted-foreground">
                  <li>Go to <strong>linkedin.com/search/results/people</strong></li>
                  <li>Apply your filters (title, location, industry, company size, etc.)</li>
                  <li>Copy the full URL from the browser address bar</li>
                  <li>Paste it below — LeadPilot will extract all matching profiles</li>
                </ol>
                <p className="text-muted-foreground">Sales Navigator URLs also work.</p>
              </div>
            </div>

            {/* URL input */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">LinkedIn Search URL *</Label>
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="https://www.linkedin.com/search/results/people/?keywords=..."
                  className="h-9 text-xs flex-1"
                  onKeyDown={e => e.key === 'Enter' && handleScrape()}
                />
              </div>
            </div>

            {/* Max profiles */}
            <div className="flex items-center gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Max profiles to extract</Label>
                <div className="flex items-center gap-2">
                  {[25, 50, 100, 200].map(n => (
                    <button
                      key={n}
                      onClick={() => setMax(n)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs border transition-colors',
                        maxProfiles === n
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'border-border hover:bg-muted'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Example URLs */}
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground font-medium">Example searches:</p>
              <div className="space-y-1">
                {EXAMPLE_URLS.map(ex => (
                  <button
                    key={ex.url}
                    onClick={() => setUrl(ex.url)}
                    className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-left hover:bg-muted transition-colors"
                  >
                    <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 text-muted-foreground">{ex.label}</span>
                    <ChevronRight className="w-3 h-3 text-muted-foreground" />
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              LinkedIn must be connected in Settings for scraping to work.
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
              <Button
                size="sm"
                onClick={handleScrape}
                disabled={!url.trim()}
                className="gap-2"
                variant="gradient"
              >
                <Search className="w-3.5 h-3.5" />
                Extract Profiles
              </Button>
            </DialogFooter>
          </motion.div>
        )}

        {/* Step: Scraping */}
        {step === 'scraping' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-12 space-y-4"
          >
            <div className="w-14 h-14 rounded-full gradient-brand flex items-center justify-center animate-pulse">
              <Linkedin className="w-7 h-7 text-white" />
            </div>
            <div className="text-center space-y-1">
              <p className="text-sm font-semibold">Extracting profiles...</p>
              <p className="text-xs text-muted-foreground">
                Opening LinkedIn, scrolling through results, reading profile cards
              </p>
            </div>
            <Progress className="w-48 h-1.5" value={undefined} />
            <p className="text-[11px] text-muted-foreground">
              This takes 20–60 seconds depending on how many pages there are
            </p>
          </motion.div>
        )}

        {/* Step: Preview */}
        {step === 'preview' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col flex-1 min-h-0 space-y-3">
            {/* Summary bar */}
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{profiles.length} profiles found</span>
                <span>{selected.size} selected</span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={toggleAll}
              >
                {selected.size === profiles.length ? 'Deselect all' : 'Select all'}
              </Button>
            </div>

            {profiles.length === 0 ? (
              <div className="flex flex-col items-center py-10 text-center">
                <Search className="w-10 h-10 text-muted-foreground/30 mb-3" />
                <p className="text-sm font-medium">No profiles found</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Try a different URL or check your LinkedIn session is active
                </p>
                <Button variant="outline" size="sm" className="mt-4" onClick={() => setStep('input')}>
                  Try another URL
                </Button>
              </div>
            ) : (
              <ScrollArea className="flex-1 min-h-0 max-h-[380px] border border-border rounded-xl">
                <div className="divide-y divide-border">
                  {profiles.map(profile => (
                    <div
                      key={profile.linkedin_url}
                      onClick={() => toggleSelect(profile.linkedin_url)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors',
                        selected.has(profile.linkedin_url)
                          ? 'bg-primary/5'
                          : 'hover:bg-muted/50'
                      )}
                    >
                      {/* Checkbox */}
                      <div className="shrink-0">
                        {selected.has(profile.linkedin_url)
                          ? <CheckSquare className="w-4 h-4 text-primary" />
                          : <Square className="w-4 h-4 text-muted-foreground" />
                        }
                      </div>

                      {/* Avatar */}
                      <Avatar className="w-8 h-8 shrink-0">
                        <AvatarFallback className="text-xs">{getInitials(profile.name)}</AvatarFallback>
                      </Avatar>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium truncate">{profile.name}</p>
                          {profile.connection_degree && (
                            <Badge variant="secondary" className="text-[9px] px-1 py-0 h-3.5 shrink-0">
                              {profile.connection_degree}
                            </Badge>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">{profile.title}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {profile.company && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <Building2 className="w-2.5 h-2.5" />{profile.company}
                            </span>
                          )}
                          {profile.location && (
                            <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                              <MapPin className="w-2.5 h-2.5" />{profile.location}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* LinkedIn link */}
                      <a
                        href={profile.linkedin_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="shrink-0 text-muted-foreground hover:text-primary"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            {profiles.length > 0 && (
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setStep('input')}>Back</Button>
                <Button
                  size="sm"
                  onClick={handleImport}
                  disabled={selected.size === 0}
                  className="gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  Import {selected.size} Lead{selected.size !== 1 ? 's' : ''}
                </Button>
                <Button
                  size="sm"
                  onClick={() => setStep('connect-config')}
                  disabled={selected.size === 0}
                  className="gap-2"
                  variant="gradient"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Send AI Invites
                </Button>
              </DialogFooter>
            )}
          </motion.div>
        )}

        {/* Step: Importing */}
        {step === 'importing' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center py-12 space-y-4"
          >
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
            <p className="text-sm font-medium">Importing {selected.size} profiles...</p>
          </motion.div>
        )}

        {/* Step: Connect config */}
        {step === 'connect-config' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
            <div className="flex items-start gap-2.5 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg">
              <Sparkles className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                <p className="font-medium">AI-Personalized Connection Requests</p>
                <p className="text-muted-foreground">
                  Claude AI writes a unique invite note per profile using their name, title &amp; company.
                  Requests are sent one-by-one with human-like delays to stay safe.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">How many to send</Label>
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
                <span className="text-muted-foreground font-normal">(optional — helps AI write better notes)</span>
              </Label>
              <Textarea
                value={connectContext}
                onChange={e => setConnectContext(e.target.value)}
                placeholder="e.g. Looking to connect with SaaS founders to discuss AI tooling…"
                className="h-20 text-xs resize-none"
              />
            </div>

            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
              1st-degree connections are already connected and will be skipped automatically.
            </div>

            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setStep('preview')}>Back</Button>
              <Button
                size="sm"
                onClick={handleStartConnect}
                disabled={startConnect.isPending}
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

        {/* Step: Connecting — live progress */}
        {step === 'connecting' && (() => {
          const job = connectStatus.data?.data
          const isDone  = job?.status === 'done'
          const isError = job?.status === 'error'

          if (isDone && step === 'connecting') {
            // Auto-advance to done summary (defer to avoid setState-in-render)
            setTimeout(() => setStep('connect-done'), 0)
          }

          return (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-4">
              {/* Header progress */}
              <div className="flex flex-col items-center py-4 space-y-3">
                <div className={cn(
                  'w-12 h-12 rounded-full flex items-center justify-center',
                  isError ? 'bg-destructive/10' : 'gradient-brand animate-pulse'
                )}>
                  {isError
                    ? <XCircle className="w-6 h-6 text-destructive" />
                    : <Send className="w-6 h-6 text-white" />
                  }
                </div>
                <div className="text-center space-y-0.5">
                  <p className="text-sm font-semibold">
                    {isError
                      ? 'Connection job failed'
                      : `Sending ${job?.total ?? connectLimit} invites…`
                    }
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {connectStatus.data?.message ?? 'Starting browser…'}
                  </p>
                </div>
                {job && !isError && (
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
                )}
                {job && !isError && (
                  <Progress
                    className="w-48 h-1.5"
                    value={job.total > 0 ? ((job.sent + job.failed) / job.total) * 100 : undefined}
                  />
                )}
              </div>

              {/* Per-profile results feed */}
              {(job?.results ?? []).length > 0 && (
                <ScrollArea className="max-h-[220px] border border-border rounded-xl">
                  <div className="divide-y divide-border">
                    {[...(job?.results ?? [])].reverse().map((r: ConnectJobResult, i: number) => (
                      <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                        {r.already_connected || r.already_pending
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                          : r.success
                          ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          : <XCircle className="w-3.5 h-3.5 text-destructive shrink-0 mt-0.5" />
                        }
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium truncate">{r.name}</p>
                          {r.already_connected
                            ? <p className="text-[11px] text-blue-500 truncate">Already connected</p>
                            : r.already_pending
                            ? <p className="text-[11px] text-amber-500 truncate">Request already pending</p>
                            : r.success
                            ? <p className="text-[11px] text-muted-foreground italic truncate">&ldquo;{r.note}&rdquo;</p>
                            : <p className="text-[11px] text-destructive truncate">{r.error ?? 'Failed'}</p>
                          }
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              )}

              {isError && (
                <DialogFooter>
                  <Button variant="outline" size="sm" onClick={() => setStep('connect-config')}>Try again</Button>
                  <Button size="sm" onClick={handleClose}>Close</Button>
                </DialogFooter>
              )}
            </motion.div>
          )
        })()}

        {/* Step: Connect done */}
        {step === 'connect-done' && (() => {
          const job = connectStatus.data?.data
          return (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center py-8 space-y-4 text-center"
            >
              <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                <Send className="w-7 h-7 text-emerald-500" />
              </div>
              <div className="space-y-1">
                <p className="text-base font-bold">{job?.sent ?? 0} invites sent!</p>
                {(job?.failed ?? 0) > 0 && (
                  <p className="text-xs text-muted-foreground">{job?.failed} couldn&apos;t be sent (already connected or no Connect button)</p>
                )}
                <p className="text-xs text-muted-foreground mt-1">Each note was personalised by Claude AI.</p>
              </div>

              {/* Summary list */}
              {(job?.results ?? []).length > 0 && (
                <ScrollArea className="w-full max-h-[180px] border border-border rounded-xl text-left">
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

              <div className="flex gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={() => { resetDialog() }}>
                  Search again
                </Button>
                <Button size="sm" onClick={handleClose}>Done</Button>
              </div>
            </motion.div>
          )
        })()}

        {/* Step: Done */}
        {step === 'done' && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center justify-center py-12 space-y-4 text-center"
          >
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <Download className="w-7 h-7 text-emerald-500" />
            </div>
            <div className="space-y-1">
              <p className="text-base font-bold">{importedCount} leads synced!</p>
              <p className="text-xs text-muted-foreground">
                Your Leads page is up to date — new leads added, existing ones refreshed.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => { resetDialog() }}>
                Import more
              </Button>
              <Button size="sm" onClick={handleClose}>
                Go to Leads
              </Button>
            </div>
          </motion.div>
        )}
      </DialogContent>
    </Dialog>
  )
}
