import React, { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Key, Webhook, Bell, Users, User, Save, Eye, EyeOff,
  Plus, Trash2, Shield, Check, ExternalLink, Linkedin,
  RefreshCw, LogOut, CheckCircle2, XCircle, Clock, Zap,
  AlertTriangle, ChevronRight, Link2, Loader2,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../src/components/ui/card'
import { Button } from '../src/components/ui/button'
import { Input } from '../src/components/ui/input'
import { Label } from '../src/components/ui/label'
import { Switch } from '../src/components/ui/switch'
import { Badge } from '../src/components/ui/badge'
import { Separator } from '../src/components/ui/separator'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs'
import { Progress } from '../src/components/ui/progress'
import {
  useLinkedInSession, useLinkedInLogin, useLinkedIn2FA,
  useRevokeLinkedIn, usePollInbox, usePollStatus,
  useDailyLimits, useUpdateLimits,
  useOpenBrowser, useBrowserStatus, useCaptureSession, useCloseBrowser,
  useChromeProfiles, type ChromeProfile,
} from '../src/hooks/useLinkedIn'
import { getUser, getToken, setAuth, type AuthUser } from '../src/lib/auth'
import { formatRelativeTime } from '../src/lib/utils'
import { toast } from 'sonner'

// ── Settings API helpers ──────────────────────────────────────────────────────
const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'
const KEY  = process.env.NEXT_PUBLIC_API_KEY  ?? ''
const H    = { 'Content-Type': 'application/json', 'X-API-Key': KEY }

async function fetchSettings(): Promise<Record<string, any>> {
  const res = await fetch(`${BASE}/settings`, { headers: H })
  const json = await res.json()
  return json?.data ?? {}
}

async function saveSettings(body: Record<string, any>): Promise<void> {
  const res = await fetch(`${BASE}/settings`, {
    method: 'POST', headers: H,
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
}

export default function SettingsPage() {
  // The logged-in account (shown on the Team tab as the current member).
  const [me, setMe] = useState<AuthUser | null>(null)
  React.useEffect(() => { setMe(getUser()) }, [])

  // ── Your Profile (per-user, not shared) ─────────────────────────────────────
  const [profileFirstName, setProfileFirstName] = useState('')
  const [profileLastName, setProfileLastName] = useState('')
  const [profileTimezone, setProfileTimezone] = useState('UTC')
  const [profileEmail, setProfileEmail] = useState('')
  const [profileSaving, setProfileSaving] = useState(false)
  React.useEffect(() => {
    fetch(`${BASE}/auth/me`).then(r => r.json()).then(json => {
      const u = json?.data
      if (!u) return
      const [first, ...rest] = String(u.name || '').trim().split(/\s+/)
      setProfileFirstName(u.name ? first : '')
      setProfileLastName(u.name ? rest.join(' ') : '')
      setProfileTimezone(u.timezone || 'UTC')
      setProfileEmail(u.email || '')
    }).catch(() => {/* backend may not be running */})
  }, [])

  async function handleSaveProfile() {
    setProfileSaving(true)
    try {
      const name = `${profileFirstName} ${profileLastName}`.trim()
      const res = await fetch(`${BASE}/auth/profile`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, timezone: profileTimezone }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`)
      // Keep the cached user (Team tab, header, etc.) in sync with the new name immediately.
      const token = getToken()
      if (token && me) setAuth(token, { ...me, name })
      setMe(prev => prev ? { ...prev, name } : prev)
      toast.success('Profile saved!')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save profile')
    } finally {
      setProfileSaving(false)
    }
  }
  // ── Sync profile via extension ──────────────────────────────────────────────
  // /linkedin/profile/refresh (refreshProfile below) intentionally does NOT call LinkedIn — it
  // only re-reads whatever's already cached in the DB, to avoid a server-side API call that would
  // force-logout the session (same-session-two-IPs). So it can never populate a name/headline that
  // was never captured. The only real way to (re)capture it is the SAME extension mechanism the
  // initial "Save Session from Browser" button uses — re-run it here so a session that connected
  // without an active LinkedIn tab (and so missed the name) can pick it up on a later Sync click.
  const [profileSyncPending, setProfileSyncPending] = useState(false)
  async function handleSyncProfile() {
    setProfileSyncPending(true)
    try {
      await new Promise<void>((resolve, reject) => {
        const onSaved = (e: any) => {
          window.removeEventListener('leadpilot-session-saved', onSaved)
          if (e.detail?.success) resolve()
          else reject(new Error(e.detail?.error || 'unknown'))
        }
        window.addEventListener('leadpilot-session-saved', onSaved, { once: true })
        window.dispatchEvent(new CustomEvent('leadpilot-save-session'))
        setTimeout(() => { window.removeEventListener('leadpilot-session-saved', onSaved); reject(new Error('timeout — make sure a LinkedIn tab is open')) }, 8000)
      })
      queryClient.invalidateQueries({ queryKey: ['linkedin-session'] })
      toast.success('Profile synced!')
    } catch (err: any) {
      toast.error('Sync failed: ' + (err?.message ?? 'unknown') + ' — make sure a LinkedIn tab is open and the extension is installed.')
    } finally {
      setProfileSyncPending(false)
    }
  }

  // ── API key state ─────────────────────────────────────────────────────────
  const [geminiKey,    setGeminiKey]    = useState('')
  const [anthropicKey, setAnthropicKey] = useState('')
  const [openaiKey,    setOpenaiKey]    = useState('')
  const [webhookUrl,   setWebhookUrl]   = useState('')
  const [webhookSecret,setWebhookSecret]= useState('')
  const [dailyLimit,   setDailyLimit]   = useState(50)
  const [notifEmail,   setNotifEmail]   = useState(false)
  const [notifSlack,   setNotifSlack]   = useState(false)
  const [slackWebhook, setSlackWebhook] = useState('')

  // Configured flags (key exists on backend but we don't show the value)
  const [geminiConfigured,    setGeminiConfigured]    = useState(false)
  const [anthropicConfigured, setAnthropicConfigured] = useState(false)
  const [openaiConfigured,    setOpenaiConfigured]    = useState(false)

  const [showOpenAI, setShowOpenAI] = useState(false)
  const [showGemini, setShowGemini] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved,  setSaved]  = useState(false)

  // Load persisted settings on mount
  React.useEffect(() => {
    fetchSettings().then(data => {
      setGeminiConfigured(!!data.gemini_configured)
      setAnthropicConfigured(!!data.anthropic_configured)
      setOpenaiConfigured(!!data.openai_configured)
      if (data.webhook_url)   setWebhookUrl(data.webhook_url)
      if (data.webhook_secret) setWebhookSecret(data.webhook_secret)
      if (data.daily_send_limit) setDailyLimit(data.daily_send_limit)
      if (data.notification_email != null) setNotifEmail(data.notification_email)
      if (data.notification_slack != null) setNotifSlack(data.notification_slack)
      if (data.slack_webhook_url) setSlackWebhook(data.slack_webhook_url)
    }).catch(() => {/* backend may not be running */})
  }, [])

  // LinkedIn login state
  const [liEmail, setLiEmail] = useState('')
  const [liPassword, setLiPassword] = useState('')
  const [showLiPassword, setShowLiPassword] = useState(false)
  const [pending2FA, setPending2FA] = useState<string | null>(null)
  const [twoFACode, setTwoFACode] = useState('')

  const queryClient    = useQueryClient()
  const { data: sessionData, isLoading: sessionLoading } = useLinkedInSession()
  const openBrowser    = useOpenBrowser()
  const captureSession = useCaptureSession()
  const closeBrowser   = useCloseBrowser()
  const login          = useLinkedInLogin()
  const verify2FA      = useLinkedIn2FA()
  const revoke         = useRevokeLinkedIn()
  const pollInbox      = usePollInbox()

  // open-browser session tracking
  const [browserSessionId, setBrowserSessionId] = useState<string | null>(null)
  const { data: browserStatus } = useBrowserStatus(browserSessionId)
  const bStatus = browserStatus?.data

  // When auto-capture succeeds (browser closed, logged_in=true), refresh session
  React.useEffect(() => {
    if (bStatus?.logged_in && !bStatus?.open) {
      setTimeout(() => { window.location.reload() }, 2000)
    }
  }, [bStatus?.logged_in, bStatus?.open])

  // Note: we deliberately do NOT auto-call refreshProfile here.
  // refresh_profile used to hit LinkedIn's Voyager API from the server IP,
  // which caused LinkedIn to see the same session active from two locations
  // simultaneously and force an immediate logout. Session status is read
  // from the DB via GET /linkedin/session — no outbound LinkedIn calls.
  const { data: pollStatus } = usePollStatus()
  const { data: limitsData } = useDailyLimits()
  const updateLimits = useUpdateLimits()
  const limits = limitsData?.data
  const [connectLimit, setConnectLimit] = useState(20)
  const [messageLimit, setMessageLimit] = useState(50)

  // Chrome profile selection
  const { data: profilesData } = useChromeProfiles()
  const chromeProfiles = profilesData?.data ?? []
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null)

  const session = sessionData?.data
  const isConnected = session?.status === 'ACTIVE'

  async function handleLogin() {
    if (!liEmail || !liPassword) {
      toast.error('Email and password are required')
      return
    }
    const res = await login.mutateAsync({ email: liEmail, password: liPassword })
    if (res.data?.requires_2fa && res.data?.session_id) {
      setPending2FA(res.data.session_id)
    } else if (res.data?.status === 'authenticated') {
      setLiEmail(''); setLiPassword('')
    }
  }

  async function handle2FA() {
    if (!pending2FA || !twoFACode) return
    await verify2FA.mutateAsync({ session_id: pending2FA, code: twoFACode })
    setPending2FA(null); setTwoFACode('')
  }

  async function handleSaveApiKeys() {
    setSaving(true)
    try {
      const payload: Record<string, any> = { daily_send_limit: dailyLimit }
      if (geminiKey.trim())    payload.gemini_api_key    = geminiKey.trim()
      if (anthropicKey.trim()) payload.anthropic_api_key = anthropicKey.trim()
      if (openaiKey.trim())    payload.openai_api_key    = openaiKey.trim()
      await saveSettings(payload)
      setSaved(true)
      toast.success('API keys saved!')
      // Update configured flags & clear inputs
      if (geminiKey.trim())    { setGeminiConfigured(true);    setGeminiKey('') }
      if (anthropicKey.trim()) { setAnthropicConfigured(true); setAnthropicKey('') }
      if (openaiKey.trim())    { setOpenaiConfigured(true);    setOpenaiKey('') }
      setTimeout(() => setSaved(false), 2500)
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveWebhook() {
    setSaving(true)
    try {
      await saveSettings({ webhook_url: webhookUrl, webhook_secret: webhookSecret })
      toast.success('Webhook settings saved!')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveNotifications() {
    setSaving(true)
    try {
      await saveSettings({
        notification_email: notifEmail,
        notification_slack: notifSlack,
        slack_webhook_url: slackWebhook,
      })
      toast.success('Notification settings saved!')
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Layout>
      <div className="p-6 max-w-3xl">
        <Tabs defaultValue="linkedin">
          <TabsList className="mb-6 flex flex-wrap gap-1 h-auto">
            <TabsTrigger value="linkedin"      className="text-xs gap-1.5"><Linkedin className="w-3.5 h-3.5" />LinkedIn</TabsTrigger>
            <TabsTrigger value="api-keys"      className="text-xs gap-1.5"><Key className="w-3.5 h-3.5" />API Keys</TabsTrigger>
            <TabsTrigger value="webhooks"      className="text-xs gap-1.5"><Webhook className="w-3.5 h-3.5" />Webhooks</TabsTrigger>
            <TabsTrigger value="notifications" className="text-xs gap-1.5"><Bell className="w-3.5 h-3.5" />Notifications</TabsTrigger>
            <TabsTrigger value="team"          className="text-xs gap-1.5"><Users className="w-3.5 h-3.5" />Team</TabsTrigger>
            <TabsTrigger value="profile"       className="text-xs gap-1.5"><User className="w-3.5 h-3.5" />Profile</TabsTrigger>
          </TabsList>

          {/* ── LinkedIn ─────────────────────────────────────────────────────── */}
          <TabsContent value="linkedin" className="space-y-4">

            {/* Extension install card — shown when NOT connected */}
            {!isConnected && !browserSessionId && (
              <Card className="border-primary/40 bg-primary/5">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Zap className="w-4 h-4 text-primary" />
                    Install GRM Connect Extension
                    <Badge className="text-[10px] ml-auto bg-primary/20 text-primary border-0">Recommended</Badge>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    One-time setup. After that — click the extension icon and you're connected instantly. No popups, no login screen.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <ol className="space-y-2.5">
                    {[
                      { n: '1', text: 'Open Chrome → address bar → chrome://extensions' },
                      { n: '2', text: 'Enable "Developer mode" (top-right toggle)' },
                      { n: '3', text: 'Click "Load unpacked" → select the extension folder below' },
                      { n: '4', text: 'Pin the ⚡ GRM Connect icon to your toolbar' },
                      { n: '5', text: 'Click the icon → "Connect to GRM Connect" — done!' },
                    ].map(s => (
                      <li key={s.n} className="flex items-start gap-2.5 text-xs text-muted-foreground">
                        <span className="w-5 h-5 rounded-full gradient-brand flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">{s.n}</span>
                        {s.text}
                      </li>
                    ))}
                  </ol>
                  <div className="flex items-center gap-2 p-2.5 bg-muted/50 rounded-lg">
                    <div className="w-6 h-6 rounded gradient-brand flex items-center justify-center text-white text-xs shrink-0">⚡</div>
                    <div>
                      <p className="text-xs font-medium">Extension folder location:</p>
                      <p className="text-[10px] text-muted-foreground font-mono">C:\Users\DELL\linkedin-automation\extension</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* ── LinkedIn Account Card ─────────────────────────────────── */}
            {!isConnected ? (
              /* Not connected — simple status pill */
              <Card className="border-border">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Linkedin className="w-4 h-4 text-blue-500" />
                      LinkedIn Account
                    </CardTitle>
                    {sessionLoading ? (
                      <Badge variant="secondary" className="text-[10px]">Checking…</Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px] gap-1">
                        <XCircle className="w-3 h-3" /> Not connected
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs">
                    Connect your LinkedIn account so GRM Connect can send connection requests,
                    messages, and read your inbox automatically.
                  </CardDescription>
                </CardHeader>
              </Card>
            ) : session && (
              /* Connected — full professional profile card */
              <Card className="overflow-hidden border-blue-500/20 shadow-sm">
                {/* LinkedIn-style banner */}
                <div className="h-20 bg-gradient-to-r from-blue-700 via-blue-600 to-amber-600 relative">
                  {/* Subtle pattern overlay */}
                  <div className="absolute inset-0 opacity-10"
                    style={{ backgroundImage: 'repeating-linear-gradient(45deg,#fff 0,#fff 1px,transparent 0,transparent 50%)', backgroundSize: '8px 8px' }} />
                  <div className="absolute top-3 right-3 flex items-center gap-2">
                    <Badge className="bg-emerald-500/90 text-white border-0 text-[10px] gap-1 backdrop-blur-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                      Live Session
                    </Badge>
                  </div>
                </div>

                <CardContent className="px-5 pb-5">
                  {/* Avatar row — overlaps banner */}
                  <div className="flex items-end justify-between -mt-8 mb-4">
                    <div className="relative">
                      {session.has_avatar ? (
                        <>
                          <img
                            src={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/linkedin/avatar`}
                            alt={session.linkedin_name ?? 'Profile'}
                            className="w-16 h-16 rounded-full border-4 border-background object-cover shadow-md"
                            onError={e => {
                              e.currentTarget.style.display = 'none'
                              const fb = document.getElementById('__avatar_fb__')
                              if (fb) fb.style.display = 'flex'
                            }}
                          />
                          <div id="__avatar_fb__"
                            className="w-16 h-16 rounded-full border-4 border-background gradient-brand items-center justify-center text-white text-xl font-bold shadow-md"
                            style={{ display: 'none' }}
                          >
                            {session.linkedin_name?.[0]?.toUpperCase() ?? 'L'}
                          </div>
                        </>
                      ) : (
                        <div className="w-16 h-16 rounded-full border-4 border-background gradient-brand flex items-center justify-center text-white text-xl font-bold shadow-md">
                          {(session.linkedin_name ?? 'L')[0].toUpperCase()}
                        </div>
                      )}
                      <span className="absolute bottom-1 right-1 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-background shadow-sm" />
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 mb-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        onClick={handleSyncProfile}
                        loading={profileSyncPending}
                        title="Re-read your name/headline from the open LinkedIn tab via the extension"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Sync
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/5"
                        onClick={() => revoke.mutate()}
                        loading={revoke.isPending}
                      >
                        <LogOut className="w-3 h-3" />
                        Disconnect
                      </Button>
                    </div>
                  </div>

                  {/* Name & Headline */}
                  <div className="mb-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-bold text-base leading-tight">
                        {session.linkedin_name
                          ? session.linkedin_name
                          : profileSyncPending
                            ? 'Loading profile…'
                            : 'Click Sync to load your name'}
                      </h3>
                      <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
                        <CheckCircle2 className="w-2.5 h-2.5 mr-0.5 text-emerald-500" />
                        Verified
                      </Badge>
                    </div>

                    {session.linkedin_headline ? (
                      <p className="text-sm text-muted-foreground mt-1 leading-snug">
                        {session.linkedin_headline}
                      </p>
                    ) : profileSyncPending ? (
                      <div className="h-3 w-48 bg-muted animate-pulse rounded mt-1.5" />
                    ) : null}

                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      {session.linkedin_profile_url && (
                        <a
                          href={session.linkedin_profile_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-blue-500 hover:text-blue-600 hover:underline flex items-center gap-1 transition-colors"
                        >
                          <Link2 className="w-3 h-3" />
                          {session.linkedin_profile_url.replace('https://www.linkedin.com', '')}
                        </a>
                      )}
                      {session.last_used && (
                        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Connected {formatRelativeTime(session.last_used)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Activity stats */}
                  <div className="grid grid-cols-3 gap-3 p-3 bg-muted/40 rounded-xl mb-4">
                    <div className="text-center">
                      <p className="text-lg font-bold text-primary">{limits?.connect_sent ?? 0}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Connects<br/>Today</p>
                    </div>
                    <div className="text-center border-x border-border/50">
                      <p className="text-lg font-bold text-emerald-500">{limits?.messages_sent ?? 0}</p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Messages<br/>Today</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-orange-500">
                        {pollStatus?.data?.accepts_found ?? 0}
                      </p>
                      <p className="text-[10px] text-muted-foreground leading-tight">Accepts<br/>Found</p>
                    </div>
                  </div>

                  {/* Inbox polling row */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
                        <RefreshCw className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-medium">Inbox Polling</p>
                        <p className="text-[10px] text-muted-foreground">
                          {pollStatus?.data
                            ? `Last: ${formatRelativeTime(pollStatus.data.polled_at)}`
                            : 'Auto every 15 min'}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1.5"
                      onClick={() => pollInbox.mutate()}
                      loading={pollInbox.isPending}
                    >
                      <RefreshCw className="w-3 h-3" />
                      Poll Now
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Connect flow — shown when not yet connected and no 2FA pending */}
            <AnimatePresence>
              {!isConnected && !pending2FA && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="space-y-3"
                >
                  {/* ── STEP 1: One-click open ────────────────────────────── */}
                  {!browserSessionId && (
                    <Card className="border-primary/30 bg-primary/5">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Zap className="w-4 h-4 text-primary" />
                          Connect LinkedIn
                          <Badge className="text-[10px] ml-auto bg-primary/20 text-primary border-0">
                            One click
                          </Badge>
                        </CardTitle>
                        <CardDescription className="text-xs">
                          Opens your Chrome with the profile where LinkedIn is already logged in.
                          No credentials needed.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">

                        {/* Primary: save session directly from the browser — no Playwright, no logouts */}
                        <Button
                          onClick={async () => {
                            await new Promise<void>((resolve, reject) => {
                              const onSaved = (e: any) => {
                                window.removeEventListener('leadpilot-session-saved', onSaved)
                                if (e.detail?.success) { toast.success('LinkedIn session saved!'); resolve() }
                                else { toast.error('Save failed: ' + (e.detail?.error || 'unknown')); reject() }
                              }
                              window.addEventListener('leadpilot-session-saved', onSaved, { once: true })
                              window.dispatchEvent(new CustomEvent('leadpilot-save-session'))
                              setTimeout(() => { window.removeEventListener('leadpilot-session-saved', onSaved); reject(new Error('timeout')) }, 8000)
                            }).then(() => {
                              // Invalidate the session query so the UI refreshes from DB.
                              // Do NOT call refreshProfile — that hits LinkedIn's API from the
                              // server IP and forces an immediate logout.
                              queryClient.invalidateQueries({ queryKey: ['linkedin-session'] })
                            }).catch(() => {})
                          }}
                          className="w-full h-12 gap-2 text-base"
                          variant="gradient"
                        >
                          <Linkedin className="w-5 h-5" />
                          Save Session from Browser
                        </Button>
                        <p className="text-[11px] text-center text-muted-foreground">
                          Make sure you're logged into LinkedIn in this Chrome window, then click above
                        </p>

                        <div className="relative flex items-center gap-2 my-1">
                          <div className="flex-1 h-px bg-border" />
                          <span className="text-[10px] text-muted-foreground">or use Playwright (may cause logout)</span>
                          <div className="flex-1 h-px bg-border" />
                        </div>

                        <Button
                          onClick={async () => {
                            const res = await openBrowser.mutateAsync(undefined)
                            if (res.data?.session_id) {
                              setBrowserSessionId(res.data.session_id)
                            }
                          }}
                          loading={openBrowser.isPending}
                          className="w-full h-10 gap-2 text-sm"
                          variant="outline"
                        >
                          <Linkedin className="w-4 h-4" />
                          {openBrowser.isPending ? 'Opening Chrome…' : 'Connect via Playwright'}
                        </Button>

                        <p className="text-[11px] text-center text-muted-foreground">
                          Auto-detects which Chrome profile has LinkedIn — no setup needed
                        </p>

                        {/* Optional: manual profile override */}
                        {chromeProfiles.length > 1 && (
                          <details className="group">
                            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 select-none list-none">
                              <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                              Use a specific profile instead
                            </summary>
                            <div className="mt-2 space-y-1">
                              {chromeProfiles.map(p => (
                                <button
                                  key={p.dir}
                                  onClick={async () => {
                                    const res = await openBrowser.mutateAsync(p.dir)
                                    if (res.data?.session_id) setBrowserSessionId(res.data.session_id)
                                  }}
                                  disabled={openBrowser.isPending}
                                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border hover:bg-muted text-left transition-colors text-xs disabled:opacity-50"
                                >
                                  <div className="w-6 h-6 rounded-full gradient-brand flex items-center justify-center text-white text-[10px] font-bold shrink-0">
                                    {p.name?.[0]?.toUpperCase()}
                                  </div>
                                  <span className="font-medium truncate">{p.name}</span>
                                  <span className="text-muted-foreground truncate">{p.email}</span>
                                </button>
                              ))}
                            </div>
                          </details>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* ── STEP 2: Popup open — waiting / auto-captured ──────── */}
                  {browserSessionId && (
                    <Card className={`border-2 transition-all duration-500 ${
                      bStatus?.logged_in
                        ? 'border-emerald-500/60 bg-emerald-500/5'
                        : 'border-primary/30 bg-primary/5'
                    }`}>
                      <CardContent className="pt-5 space-y-3">
                        {bStatus?.logged_in ? (
                          /* Auto-captured! */
                          <div className="flex flex-col items-center text-center gap-3 py-2">
                            <div className="w-14 h-14 rounded-full bg-emerald-500/10 flex items-center justify-center">
                              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                            </div>
                            <div>
                              <p className="font-semibold text-emerald-600 dark:text-emerald-400">
                                LinkedIn Connected!
                              </p>
                              {bStatus.linkedin_user && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  Logged in as {bStatus.linkedin_user}
                                </p>
                              )}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-xs h-8"
                              onClick={() => setBrowserSessionId(null)}
                            >
                              Done
                            </Button>
                          </div>
                        ) : (
                          /* Waiting for login */
                          <div className="space-y-3">
                            <div className="flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                              </div>
                              <div>
                                <p className="text-sm font-medium">Log in to LinkedIn</p>
                                <p className="text-xs text-muted-foreground">
                                  A popup window opened — sign in there.
                                  Session saves automatically.
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-lg">
                              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse shrink-0" />
                              <span className="text-xs text-muted-foreground">
                                Waiting for you to log in…
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full h-8 text-xs text-muted-foreground"
                              onClick={() => {
                                closeBrowser.mutate(browserSessionId)
                                setBrowserSessionId(null)
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* ── FALLBACK: Manual credentials ─────────────────────── */}
                  <details className="group">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 select-none list-none py-1 px-1">
                      <ChevronRight className="w-3.5 h-3.5 transition-transform group-open:rotate-90" />
                      Or enter email &amp; password manually
                    </summary>
                    <Card className="mt-2">
                      <CardContent className="pt-4 space-y-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">LinkedIn Email</Label>
                          <Input type="email" value={liEmail} onChange={e => setLiEmail(e.target.value)} placeholder="your@email.com" className="h-8 text-xs" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Password</Label>
                          <div className="relative">
                            <Input
                              type={showLiPassword ? 'text' : 'password'}
                              value={liPassword}
                              onChange={e => setLiPassword(e.target.value)}
                              placeholder="••••••••"
                              className="h-8 text-xs pr-9"
                              onKeyDown={e => e.key === 'Enter' && handleLogin()}
                            />
                            <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowLiPassword(v => !v)}>
                              {showLiPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        </div>
                        <Button onClick={handleLogin} loading={login.isPending} className="w-full h-9 gap-2" variant="gradient">
                          <Linkedin className="w-4 h-4" />
                          {login.isPending ? 'Connecting…' : 'Connect with Credentials'}
                        </Button>
                      </CardContent>
                    </Card>
                  </details>
                </motion.div>
              )}

              {/* 2FA / verification code form */}
              {pending2FA && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <Card className="border-primary/30">
                    <CardHeader className="pb-3">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <Shield className="w-4 h-4 text-primary" />
                        Two-Factor Verification
                      </CardTitle>
                      <CardDescription className="text-xs">
                        LinkedIn requires a verification code. Check your email or authenticator app.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Verification Code</Label>
                        <Input
                          value={twoFACode}
                          onChange={e => setTwoFACode(e.target.value)}
                          placeholder="123456"
                          className="h-8 text-xs text-center tracking-widest text-lg font-mono"
                          maxLength={8}
                          onKeyDown={e => e.key === 'Enter' && handle2FA()}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1 h-8 text-xs"
                          onClick={() => { setPending2FA(null); setTwoFACode('') }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="flex-1 h-8 text-xs"
                          onClick={handle2FA}
                          loading={verify2FA.isPending}
                          disabled={!twoFACode}
                        >
                          Verify & Connect
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Daily send limits */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="w-4 h-4 text-primary" />
                  Daily Send Limits
                  <Badge variant="secondary" className="text-[10px] ml-auto">Resets at midnight UTC</Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Stay within LinkedIn's limits to avoid account restrictions.
                  Free accounts: max 20 connections/day. Premium: up to 100/day.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Live usage bars */}
                <div className="space-y-3">
                  {/* Connection requests */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-primary" />
                        Connection Requests
                      </span>
                      <span>
                        <span className={limits && limits.connect_sent >= limits.connect_limit ? 'text-red-500 font-bold' : 'font-medium'}>
                          {limits?.connect_sent ?? 0}
                        </span>
                        <span className="text-muted-foreground"> / {limits?.connect_limit ?? connectLimit} today</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${Math.min(100, ((limits?.connect_sent ?? 0) / (limits?.connect_limit ?? connectLimit)) * 100)}%`,
                          background: (limits?.connect_sent ?? 0) >= (limits?.connect_limit ?? connectLimit)
                            ? '#ef4444'
                            : (limits?.connect_sent ?? 0) >= (limits?.connect_limit ?? connectLimit) * 0.8
                            ? '#f59e0b'
                            : '#c79a1f',
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {limits?.connect_remaining ?? connectLimit} remaining today
                    </p>
                  </div>

                  {/* Messages */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-500" />
                        Follow-up Messages
                      </span>
                      <span>
                        <span className={limits && limits.messages_sent >= limits.message_limit ? 'text-red-500 font-bold' : 'font-medium'}>
                          {limits?.messages_sent ?? 0}
                        </span>
                        <span className="text-muted-foreground"> / {limits?.message_limit ?? messageLimit} today</span>
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                        style={{
                          width: `${Math.min(100, ((limits?.messages_sent ?? 0) / (limits?.message_limit ?? messageLimit)) * 100)}%`,
                        }}
                      />
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      {limits?.message_remaining ?? messageLimit} remaining today
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Limit controls */}
                <div className="space-y-3">
                  <p className="text-xs font-medium">Adjust Limits</p>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Connections / day</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={connectLimit}
                          onChange={e => setConnectLimit(parseInt(e.target.value) || 20)}
                          className="h-8 text-xs"
                          min={1} max={100}
                        />
                        <div className="flex flex-col gap-0.5">
                          {[10, 20, 50].map(n => (
                            <button
                              key={n}
                              onClick={() => setConnectLimit(n)}
                              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                                connectLimit === n ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Messages / day</Label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          value={messageLimit}
                          onChange={e => setMessageLimit(parseInt(e.target.value) || 50)}
                          className="h-8 text-xs"
                          min={1} max={300}
                        />
                        <div className="flex flex-col gap-0.5">
                          {[30, 50, 100].map(n => (
                            <button
                              key={n}
                              onClick={() => setMessageLimit(n)}
                              className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                                messageLimit === n ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'
                              }`}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Safe zone guide */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      { label: 'Safe (free)',    connect: 10, msg: 30,  color: 'text-emerald-500' },
                      { label: 'Moderate',       connect: 20, msg: 50,  color: 'text-yellow-500' },
                      { label: 'Premium',        connect: 50, msg: 100, color: 'text-orange-500' },
                      { label: 'Max (risk)',     connect: 100, msg: 200, color: 'text-red-500' },
                    ].map(preset => (
                      <button
                        key={preset.label}
                        onClick={() => { setConnectLimit(preset.connect); setMessageLimit(preset.msg) }}
                        className="flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs hover:bg-muted transition-colors"
                      >
                        <span className={`font-medium ${preset.color}`}>{preset.label}</span>
                        <span className="text-muted-foreground">{preset.connect}c / {preset.msg}m</span>
                      </button>
                    ))}
                  </div>

                  <Button
                    size="sm"
                    className="w-full h-8 text-xs gap-2"
                    onClick={() => updateLimits.mutate({
                      daily_connect_limit: connectLimit,
                      daily_message_limit: messageLimit,
                    })}
                    loading={updateLimits.isPending}
                  >
                    <Save className="w-3.5 h-3.5" />
                    Apply Limits
                  </Button>
                </div>

                {/* Warning */}
                <div className="flex items-start gap-2 p-2.5 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
                  <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 shrink-0 mt-0.5" />
                  <p className="text-[11px] text-yellow-600 dark:text-yellow-400 leading-relaxed">
                    Exceeding LinkedIn's limits risks a temporary restriction or permanent ban.
                    Stay under <strong>20 connections/day</strong> on free accounts.
                    Spread sends throughout the day — never send everything at once.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* How it works */}
            <Card className="bg-muted/30">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  How the automation works
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="space-y-2.5">
                  {[
                    { step: '1', text: 'Add leads with LinkedIn profile URLs via the Leads page' },
                    { step: '2', text: 'Create a Campaign with a connection request message + follow-up sequence' },
                    { step: '3', text: 'Activate the campaign — GRM Connect sends connection requests with your personalized invite note (up to your daily limit)' },
                    { step: '4', text: 'Every 15 minutes, GRM Connect polls your LinkedIn inbox and detects accepted connections' },
                    { step: '5', text: 'When someone accepts, the first follow-up message is automatically scheduled and sent' },
                    { step: '6', text: 'When they reply, the message appears in Conversations — you write back or let AI suggest a response' },
                  ].map(({ step, text }) => (
                    <li key={step} className="flex items-start gap-3 text-xs text-muted-foreground">
                      <span className="w-5 h-5 rounded-full gradient-brand flex items-center justify-center text-white text-[10px] font-bold shrink-0 mt-0.5">{step}</span>
                      {text}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── API Keys ─────────────────────────────────────────────────────── */}
          <TabsContent value="api-keys" className="space-y-4">

            {/* Gemini — primary AI */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">G</span>
                  </div>
                  Google Gemini API Key
                  <Badge className="ml-auto text-[10px] bg-primary/10 text-primary border-0">Primary AI</Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Used to generate personalised LinkedIn connection notes. Gemini Flash — fast and free tier available.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {geminiConfigured && !geminiKey && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Gemini API key configured</span>
                    <button className="ml-auto text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setGeminiKey(' ')}>Replace</button>
                  </div>
                )}
                {(!geminiConfigured || geminiKey) && (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type={geminiKey.trim() ? (showGemini ? 'text' : 'password') : 'text'}
                        value={geminiKey.trim() ? geminiKey : ''}
                        onChange={e => setGeminiKey(e.target.value)}
                        placeholder="AIzaSy..."
                        className="h-8 text-xs pr-9"
                        autoComplete="new-password"
                        name="gemini-api-key"
                        spellCheck={false}
                      />
                      <button className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" onClick={() => setShowGemini(v => !v)}>
                        {showGemini ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                    <Button variant="outline" size="sm" className="h-8 text-xs shrink-0 gap-1.5" onClick={() => window.open('https://aistudio.google.com/app/apikey', '_blank')}>
                      <ExternalLink className="w-3.5 h-3.5 mr-1" />Get Key
                    </Button>
                  </div>
                )}
                {!geminiConfigured && (
                  <Badge variant="secondary" className="text-[10px]">Not configured — connection notes will use fallback templates</Badge>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Shield className="w-3 h-3 text-emerald-500" />
                  Stored locally on your server, never shared
                </div>
              </CardContent>
            </Card>

            {/* Anthropic — fallback AI */}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <div className="w-6 h-6 rounded bg-[#c96442] flex items-center justify-center">
                    <span className="text-white text-[10px] font-bold">A</span>
                  </div>
                  Anthropic (Claude) API Key
                  <Badge variant="secondary" className="ml-auto text-[10px]">Fallback AI</Badge>
                </CardTitle>
                <CardDescription className="text-xs">
                  Used if Gemini is not configured. Claude Haiku — fast and cost-effective.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {anthropicConfigured && !anthropicKey && (
                  <div className="flex items-center gap-2 px-3 py-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">Anthropic API key configured</span>
                    <button className="ml-auto text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setAnthropicKey(' ')}>Replace</button>
                  </div>
                )}
                {(!anthropicConfigured || anthropicKey) && (
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        type={anthropicKey.trim() ? 'password' : 'text'}
                        value={anthropicKey.trim() ? anthropicKey : ''}
                        onChange={e => setAnthropicKey(e.target.value)}
                        placeholder="sk-ant-..."
                        className="h-8 text-xs"
                        autoComplete="new-password"
                        name="anthropic-api-key"
                        spellCheck={false}
                      />
                    </div>
                    <Button variant="outline" size="sm" className="h-8 text-xs shrink-0" onClick={() => window.open('https://console.anthropic.com/settings/keys', '_blank')}>
                      <ExternalLink className="w-3.5 h-3.5 mr-1" />Get Key
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Daily limit */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Daily Message Limit</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  value={dailyLimit}
                  onChange={e => setDailyLimit(parseInt(e.target.value) || 50)}
                  className="w-24 h-8 text-xs"
                  min={1} max={200}
                />
                <span className="text-xs text-muted-foreground">messages per day (max 200)</span>
              </div>
            </div>

            <Button
              onClick={handleSaveApiKeys}
              className="gap-2"
              disabled={saving}
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : saved ? (
                <Check className="w-4 h-4" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {saving ? 'Saving…' : saved ? 'Saved!' : 'Save API Keys'}
            </Button>
          </TabsContent>

          {/* ── Webhooks ─────────────────────────────────────────────────────── */}
          <TabsContent value="webhooks" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Webhook className="w-4 h-4" />n8n / Webhook Integration
                </CardTitle>
                <CardDescription className="text-xs">Send events to your automation workflows when leads reply, meetings are booked, etc.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Webhook URL</Label>
                  <Input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://n8n.yourserver.com/webhook/..." className="h-8 text-xs" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Webhook Secret</Label>
                  <Input type="password" value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} placeholder="whsec_..." className="h-8 text-xs" />
                </div>
                <div className="pt-1 space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Events sent:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {['connection.accepted','lead.replied','meeting.booked','lead.status_changed','campaign.completed'].map(e => (
                      <Badge key={e} variant="secondary" className="text-[10px] font-mono">{e}</Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
            <Button onClick={handleSaveWebhook} disabled={saving} className="gap-2">
              <Save className="w-4 h-4" />Save Webhook Settings
            </Button>
          </TabsContent>

          {/* ── Notifications ─────────────────────────────────────────────────── */}
          <TabsContent value="notifications" className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Notification Channels</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Email Notifications</p>
                    <p className="text-xs text-muted-foreground">Get notified about replies, meetings, and hot leads</p>
                  </div>
                  <Switch checked={notifEmail} onCheckedChange={setNotifEmail} />
                </div>
                <Separator />
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Slack Notifications</p>
                    <p className="text-xs text-muted-foreground">Send alerts to a Slack channel</p>
                  </div>
                  <Switch checked={notifSlack} onCheckedChange={setNotifSlack} />
                </div>
                {notifSlack && (
                  <div className="space-y-1.5 pl-4 border-l-2 border-primary/30">
                    <Label className="text-xs">Slack Webhook URL</Label>
                    <Input value={slackWebhook} onChange={e => setSlackWebhook(e.target.value)} placeholder="https://hooks.slack.com/services/..." className="h-8 text-xs" />
                  </div>
                )}
              </CardContent>
            </Card>
            <Button onClick={handleSaveNotifications} disabled={saving} className="gap-2">
              <Save className="w-4 h-4" />Save Notification Settings
            </Button>
          </TabsContent>

          {/* ── Team ─────────────────────────────────────────────────────────── */}
          <TabsContent value="team" className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">Team Members</CardTitle>
                  <Button size="sm" className="h-7 text-xs gap-1"><Plus className="w-3 h-3" />Invite</Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <Avatar className="w-8 h-8">
                    <AvatarFallback className="text-xs">{(me?.name || me?.email || 'U')[0].toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{me?.name || me?.email || 'You'}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{me?.email || ''}</p>
                  </div>
                  <Badge variant="default" className="text-[10px] capitalize">Owner</Badge>
                </div>
                <p className="text-[11px] text-muted-foreground pt-1">Team invites are coming soon — for now each person signs up with their own account.</p>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Profile ──────────────────────────────────────────────────────── */}
          <TabsContent value="profile" className="space-y-4">
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><User className="w-4 h-4" />Your Profile</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <Avatar className="w-16 h-16"><AvatarFallback className="text-xl">
                    {(profileFirstName[0] || profileEmail[0] || 'U').toUpperCase()}{(profileLastName[0] || '').toUpperCase()}
                  </AvatarFallback></Avatar>
                  <Button variant="outline" size="sm" className="h-8 text-xs">Change Photo</Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5"><Label className="text-xs">First Name</Label><Input value={profileFirstName} onChange={e => setProfileFirstName(e.target.value)} className="h-8 text-xs" /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Last Name</Label><Input value={profileLastName} onChange={e => setProfileLastName(e.target.value)} className="h-8 text-xs" /></div>
                  <div className="col-span-2 space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input value={profileEmail} disabled className="h-8 text-xs opacity-70" />
                    <p className="text-[11px] text-muted-foreground">Email is your login — contact support to change it.</p>
                  </div>
                  <div className="space-y-1.5"><Label className="text-xs">Timezone</Label><Input value={profileTimezone} onChange={e => setProfileTimezone(e.target.value)} className="h-8 text-xs" /></div>
                </div>
              </CardContent>
            </Card>
            <Button onClick={handleSaveProfile} loading={profileSaving} className="gap-2"><Save className="w-4 h-4" />Save Profile</Button>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  )
}
