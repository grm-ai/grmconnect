import React, { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Sparkles, Wand2, RefreshCw, Copy, CheckCheck,
  Users, ChevronDown, Brain, Zap, Send, Inbox, MessageSquare,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { AIComposer } from '../src/components/AIComposer'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Button } from '../src/components/ui/button'
import { Badge } from '../src/components/ui/badge'
import { Textarea } from '../src/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../src/components/ui/select'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs'
import { useLeads } from '../src/hooks/useLeads'
import { useGenerateAI } from '../src/hooks/useAI'
import { getInitials } from '../src/lib/utils'
import type { Lead, AITone } from '../src/types'
import { toast } from 'sonner'

const TONE_OPTIONS: { value: AITone; label: string; desc: string }[] = [
  { value: 'professional', label: '🎩 Professional', desc: 'Formal and business-focused' },
  { value: 'casual',       label: '😊 Casual',       desc: 'Relaxed and conversational' },
  { value: 'friendly',     label: '🤝 Friendly',     desc: 'Warm and approachable' },
  { value: 'direct',       label: '⚡ Direct',       desc: 'Concise and to the point' },
  { value: 'empathetic',   label: '💙 Empathetic',   desc: 'Understanding and caring' },
]

const QUICK_ACTIONS = [
  { label: 'Generate Outreach',  action: 'generate'  as const, icon: <Sparkles className="w-4 h-4" />,   color: 'from-amber-500 to-amber-500' },
  { label: 'Write Follow-Up',    action: 'follow_up' as const, icon: <RefreshCw className="w-4 h-4" />,  color: 'from-blue-500 to-cyan-500' },
  { label: 'Rewrite Message',    action: 'rewrite'   as const, icon: <Wand2 className="w-4 h-4" />,      color: 'from-pink-500 to-rose-500' },
  { label: 'Make it Shorter',    action: 'shorten'   as const, icon: <Zap className="w-4 h-4" />,        color: 'from-orange-500 to-yellow-500' },
  { label: 'Expand Message',     action: 'expand'    as const, icon: <Brain className="w-4 h-4" />,      color: 'from-emerald-500 to-teal-500' },
]

export default function AIWorkspacePage() {
  const { data: leads } = useLeads()
  const generate = useGenerateAI()
  const [selectedLeadId, setSelectedLeadId] = useState<string>('')
  const [tone, setTone] = useState<AITone>('professional')
  const [context, setContext] = useState('')
  const [result, setResult] = useState('')
  const [copied, setCopied] = useState(false)

  // ── "About You" sender profile — filled once, used in every generation ──
  const [profile, setProfile] = useState({ sender_name: '', sender_role: '', sender_company: '', sender_about: '' })
  const [savingProfile, setSavingProfile] = useState(false)

  const selectedLead = leads?.find(l => l.id === selectedLeadId)

  async function handleQuickAction(action: typeof QUICK_ACTIONS[0]['action']) {
    const res = await generate.mutateAsync({
      action,
      lead: selectedLead,
      tone,
      context,
      existing_message: action !== 'generate' && action !== 'follow_up' ? context : undefined,
    })
    setResult(res.message)
    toast.success('Generated!')
  }

  function handleCopy() {
    navigator.clipboard.writeText(result)
    setCopied(true)
    toast.success('Copied!')
    setTimeout(() => setCopied(false), 2000)
  }

  // ── Send via the extension (in-tab LinkedIn message API) ──
  const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
  const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
  const jfetch = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-API-Key': KEY }, body: body ? JSON.stringify(body) : undefined })
    return res.json().catch(() => ({}))
  }
  const sendViaExtension = (target: string, text: string) => new Promise<boolean>((resolve) => {
    const reqId = String(Date.now()) + Math.random()
    const onResult = (e: Event) => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve(!!(e as CustomEvent).detail?.success) }
    window.addEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any)
    window.dispatchEvent(new CustomEvent('leadpilot-send-message', { detail: { reqId, target, text } }))
    setTimeout(() => { window.removeEventListener(`leadpilot-send-message-result-${reqId}`, onResult as any); resolve(false) }, 60000)
  })

  // Load the saved sender profile once on mount
  React.useEffect(() => {
    jfetch('GET', '/auth/me').then((r: any) => {
      const d = r?.data || {}
      setProfile({
        sender_name:    d.sender_name    || '',
        sender_role:    d.sender_role    || '',
        sender_company: d.sender_company || '',
        sender_about:   d.sender_about   || '',
      })
      setContext(d.sender_talking_points || '')   // persisted talking points → prefill & reuse
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  async function saveProfile() {
    setSavingProfile(true)
    try {
      await jfetch('PATCH', '/auth/profile', profile)
      toast.success('Saved! Your info now personalizes every message.')
    } catch {
      toast.error('Could not save your info.')
    } finally {
      setSavingProfile(false)
    }
  }

  // Persist the Context / Talking Points so every message & reply is built on it too.
  const [savingContext, setSavingContext] = useState(false)
  async function saveContext() {
    setSavingContext(true)
    try {
      await jfetch('PATCH', '/auth/profile', { sender_talking_points: context })
      toast.success('Talking points saved — the AI will use these in every message & reply.')
    } catch {
      toast.error('Could not save your talking points.')
    } finally {
      setSavingContext(false)
    }
  }

  const [sending, setSending] = useState(false)
  async function sendGenerated() {
    const url = (selectedLead as any)?.linkedin_url
    if (!url) { toast.error('Pick a lead with a LinkedIn URL first.'); return }
    if (!result.trim()) { toast.error('Generate a message first.'); return }
    setSending(true)
    try {
      const vanity = (url.split('/in/')[1] || '').split(/[/?#]/)[0]
      const ok = await sendViaExtension(vanity, result)
      if (ok) { try { await jfetch('POST', `/inbox/${selectedLead!.id}/record`, { body: result }) } catch {} ; toast.success(`Sent to ${selectedLead!.name}!`) }
      else toast.error('Send failed — is the extension loaded and a LinkedIn tab open & logged in?')
    } finally { setSending(false) }
  }

  // ── AI Auto-Reply: read inbox replies → draft AI follow-ups → send ──
  const [autoReplies, setAutoReplies] = useState<any[]>([])
  const [scanning, setScanning] = useState(false)
  async function scanAndDraft() {
    setScanning(true)
    try {
      const res = await jfetch('GET', '/inbox')
      const convs = (res?.data || []) as any[]
      // Conversations where THEY replied last (last message is inbound) → need our follow-up.
      const needReply = convs.filter(c => {
        const msgs = c.messages || []
        const last = msgs[msgs.length - 1]
        return last && last.direction === 'INBOUND'
      })
      if (!needReply.length) { toast.info('No new replies to follow up on right now.'); setAutoReplies([]); return }
      const drafts: any[] = []
      for (const c of needReply) {
        const lastInbound = [...(c.messages || [])].reverse().find((m: any) => m.direction === 'INBOUND')
        try {
          const g = await generate.mutateAsync({
            action: 'follow_up',
            lead: leads?.find(l => String(l.id) === String(c.lead_id)),
            tone,
            context: `They replied: "${lastInbound?.body || ''}". Write a short, warm, relevant follow-up reply.`,
          })
          drafts.push({ lead_id: c.lead_id, lead_name: c.lead_name, linkedin_url: c.lead_linkedin_url, their_msg: lastInbound?.body || '', reply: g.message })
        } catch {}
      }
      setAutoReplies(drafts)
      toast.success(`Drafted ${drafts.length} AI repl${drafts.length === 1 ? 'y' : 'ies'}. Review, then send.`)
    } finally { setScanning(false) }
  }
  async function sendReply(idx: number) {
    const d = autoReplies[idx]
    const vanity = (d.linkedin_url?.split('/in/')[1] || '').split(/[/?#]/)[0]
    const ok = await sendViaExtension(vanity, d.reply)
    if (ok) { try { await jfetch('POST', `/inbox/${d.lead_id}/record`, { body: d.reply }) } catch {} ; toast.success(`Reply sent to ${d.lead_name}!`); setAutoReplies(prev => prev.filter((_, i) => i !== idx)) }
    else toast.error('Send failed.')
  }
  async function sendAllReplies() {
    setSending(true)
    try { for (let i = autoReplies.length - 1; i >= 0; i--) { await sendReply(i); await new Promise(r => setTimeout(r, 4000 + Math.random() * 4000)) } }
    finally { setSending(false) }
  }

  return (
    <Layout>
      <div className="p-6 space-y-6 max-w-5xl">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-6 rounded-2xl gradient-brand text-white relative overflow-hidden"
        >
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 70% 50%, white 0%, transparent 60%)' }} />
          <div className="flex items-start justify-between relative">
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-5 h-5" />
                <Badge className="bg-white/20 text-white border-0 text-xs">Powered by GPT-4o</Badge>
              </div>
              <h2 className="text-xl font-bold">AI Outreach Workspace</h2>
              <p className="text-white/80 text-sm mt-1 max-w-lg">
                Generate hyper-personalized LinkedIn messages, follow-ups, and email drafts in seconds.
                Select a lead to automatically personalize the message.
              </p>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Controls */}
          <div className="lg:col-span-1 space-y-4">
            {/* About You — persisted sender profile, used in every generation */}
            <Card className="border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" />
                  About You
                </CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  Fill this once — it's used in every connect note, message &amp; follow-up, so you never see “[Your Name]” again.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <input
                  value={profile.sender_name}
                  onChange={e => setProfile(p => ({ ...p, sender_name: e.target.value }))}
                  placeholder="Your name"
                  className="w-full h-8 px-2.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={profile.sender_role}
                    onChange={e => setProfile(p => ({ ...p, sender_role: e.target.value }))}
                    placeholder="Your role/title"
                    className="w-full h-8 px-2.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <input
                    value={profile.sender_company}
                    onChange={e => setProfile(p => ({ ...p, sender_company: e.target.value }))}
                    placeholder="Your company"
                    className="w-full h-8 px-2.5 rounded-md border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
                <Textarea
                  value={profile.sender_about}
                  onChange={e => setProfile(p => ({ ...p, sender_about: e.target.value }))}
                  placeholder="What you do / what you offer / why you're reaching out. e.g. 'I help B2B SaaS teams book more demos with LinkedIn automation.'"
                  className="h-20 text-xs"
                />
                <Button size="sm" className="w-full gap-1.5" onClick={saveProfile} disabled={savingProfile} loading={savingProfile}>
                  <CheckCheck className="w-3.5 h-3.5" /> Save my info
                </Button>
              </CardContent>
            </Card>

            {/* Lead selector */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="w-4 h-4 text-primary" />
                  Select Lead (Optional)
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Select value={selectedLeadId} onValueChange={setSelectedLeadId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose a lead to personalize..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="" className="text-xs">No specific lead</SelectItem>
                    {leads?.slice(0, 12).map(l => (
                      <SelectItem key={l.id} value={String(l.id)} className="text-xs">
                        <div className="flex items-center gap-2">
                          <span>{l.name}</span>
                          <span className="text-muted-foreground">· {l.company}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedLead && (
                  <div className="flex items-center gap-2 p-2 bg-primary/10 rounded-lg">
                    <Avatar className="w-7 h-7">
                      <AvatarFallback className="text-xs">{getInitials(selectedLead.name)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{selectedLead.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{selectedLead.title} · {selectedLead.company}</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Tone selector */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Tone</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {TONE_OPTIONS.map(t => (
                  <button
                    key={t.value}
                    onClick={() => setTone(t.value)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-xs transition-colors ${
                      tone === t.value ? 'bg-primary/10 text-primary' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-[10px] text-muted-foreground ml-auto">{t.desc}</span>
                  </button>
                ))}
              </CardContent>
            </Card>

            {/* Context / Talking Points — persisted, drives every generation & reply */}
            <Card className="border-primary/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-primary" />
                  Context / Talking Points
                </CardTitle>
                <p className="text-[11px] text-muted-foreground">
                  Saved &amp; reused — the AI weaves these into every message, follow-up &amp; auto-reply. Edit anytime.
                </p>
              </CardHeader>
              <CardContent className="space-y-2">
                <Textarea
                  value={context}
                  onChange={e => setContext(e.target.value)}
                  placeholder="e.g. We help D2C brands cut CAC; mention our 14-day pilot; reference their recent funding; always aim to book a 15-min call."
                  className="h-24 text-xs"
                />
                <Button size="sm" className="w-full gap-1.5" onClick={saveContext} disabled={savingContext} loading={savingContext}>
                  <CheckCheck className="w-3.5 h-3.5" /> Save talking points
                </Button>
              </CardContent>
            </Card>
          </div>

          {/* Generator */}
          <div className="lg:col-span-2 space-y-4">
            {/* Quick action buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {QUICK_ACTIONS.map(qa => (
                <Button
                  key={qa.action}
                  variant="outline"
                  className="h-auto py-3 flex-col gap-1.5 text-xs font-medium hover:border-primary/50 hover:bg-primary/5"
                  onClick={() => handleQuickAction(qa.action)}
                  disabled={generate.isPending}
                >
                  <span className={`w-7 h-7 rounded-lg bg-gradient-to-br ${qa.color} flex items-center justify-center text-white`}>
                    {qa.icon}
                  </span>
                  {qa.label}
                </Button>
              ))}
            </div>

            {/* Result area */}
            <Card className="min-h-[300px] flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Generated Message</CardTitle>
                  {result && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleQuickAction('generate')}
                        disabled={generate.isPending}
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleCopy}>
                        {copied
                          ? <CheckCheck className="w-3.5 h-3.5 text-emerald-500" />
                          : <Copy className="w-3.5 h-3.5" />
                        }
                      </Button>
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col">
                {generate.isPending ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center space-y-3">
                      <div className="w-10 h-10 rounded-full gradient-brand mx-auto flex items-center justify-center animate-pulse">
                        <Sparkles className="w-5 h-5 text-white" />
                      </div>
                      <p className="text-sm text-muted-foreground">AI is crafting your message...</p>
                    </div>
                  </div>
                ) : result ? (
                  <div className="flex-1 flex flex-col gap-2">
                    <Textarea
                      value={result}
                      onChange={e => setResult(e.target.value)}
                      className="flex-1 min-h-[200px] text-xs leading-relaxed"
                    />
                    <Button size="sm" className="gap-1.5" onClick={sendGenerated} disabled={sending || !selectedLead} loading={sending}>
                      <Send className="w-3.5 h-3.5" /> {selectedLead ? `Send to ${selectedLead.name}` : 'Pick a lead above to send'}
                    </Button>
                  </div>
                ) : (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="text-center space-y-2">
                      <Sparkles className="w-10 h-10 text-muted-foreground/30 mx-auto" />
                      <p className="text-sm text-muted-foreground">Click a quick action to generate</p>
                      <p className="text-xs text-muted-foreground">Or use the full AI Composer below</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* AI Auto-Reply: read replies → draft follow-ups → send */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Inbox className="w-4 h-4 text-primary" />
                AI Auto-Reply to Inbox
              </CardTitle>
              <div className="flex gap-2">
                {autoReplies.length > 0 && (
                  <Button size="sm" className="h-8 gap-1.5" onClick={sendAllReplies} disabled={sending}>
                    <Send className="w-3.5 h-3.5" /> Send all ({autoReplies.length})
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={scanAndDraft} disabled={scanning || generate.isPending}>
                  <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                  {scanning ? 'Reading replies…' : 'Scan inbox & draft replies'}
                </Button>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Reads leads who replied, drafts a personalized AI follow-up for each, and sends on your click. (Fetch Inbox first so replies are up to date.)</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {autoReplies.length === 0 && (
              <p className="text-xs text-muted-foreground py-4 text-center">No drafts yet — click <b>Scan inbox &amp; draft replies</b>.</p>
            )}
            {autoReplies.map((d, i) => (
              <div key={i} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold">{d.lead_name}</span>
                  <Button size="sm" className="h-7 gap-1.5" onClick={() => sendReply(i)}>
                    <Send className="w-3 h-3" /> Send
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-start gap-1.5"><MessageSquare className="w-3 h-3 mt-0.5 shrink-0" /> They said: “{d.their_msg.slice(0, 140)}”</p>
                <Textarea value={d.reply} onChange={e => setAutoReplies(prev => prev.map((x, j) => j === i ? { ...x, reply: e.target.value } : x))} className="text-xs h-20" />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Full AI Composer */}
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" />
            Full AI Composer
          </h3>
          <AIComposer lead={selectedLead} />
        </div>
      </div>
    </Layout>
  )
}
