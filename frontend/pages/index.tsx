import React, { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import {
  Zap, Sparkles, Bot, CalendarCheck, BarChart3, Users, ArrowRight,
  MessageSquareText, ShieldCheck, Rocket, Download, Chrome,
} from 'lucide-react'
import { Logo } from '../src/components/Logo'
import { isAuthed } from '../src/lib/auth'

const FEATURES = [
  { icon: Sparkles, title: 'AI-written outreach', desc: 'Personalized connection notes & follow-ups generated from your profile and goal — no templates, no “[Your Name]”.' },
  { icon: Bot, title: 'Goal-driven autopilot', desc: 'It reads replies and responds on its own, steering every conversation toward booking a call.' },
  { icon: CalendarCheck, title: 'Calls booked, tracked', desc: 'The AI detects when a call is agreed and surfaces it on your dashboard to confirm.' },
  { icon: Users, title: 'Bulk lead sourcing', desc: 'Import from LinkedIn search or Sales Navigator, then run the whole sequence hands-off.' },
  { icon: BarChart3, title: 'Real analytics', desc: 'Track invites, acceptance, replies and conversion — see exactly what’s working.' },
  { icon: ShieldCheck, title: 'Safe by design', desc: 'Human-like pacing and hard daily caps keep your account within LinkedIn’s limits.' },
]

const STEPS = [
  { n: '1', title: 'Add your goal', desc: 'Tell it who you are and what you want — e.g. “book investor calls”.' },
  { n: '2', title: 'Import leads', desc: 'Paste a LinkedIn search or profile URLs. Autopilot enrolls them.' },
  { n: '3', title: 'It runs itself', desc: 'Invites → messages → replies → booked calls, all AI-driven.' },
]

export default function Home() {
  const [authed, setAuthed] = useState(false)
  useEffect(() => { setAuthed(isAuthed()) }, [])

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="sticky top-0 z-30 backdrop-blur-md bg-background/70 border-b border-border">
        <div className="max-w-6xl mx-auto px-5 h-16 flex items-center gap-3">
          <div className="flex items-center">
            <Logo className="w-11 h-11 shadow-sm border border-border" rounded="rounded-xl" />
          </div>
          <nav className="ml-auto flex items-center gap-2">
            {authed ? (
              <Link href="/dashboard" className="h-9 px-4 rounded-lg gradient-brand text-white text-sm font-medium flex items-center gap-1.5">
                Go to Dashboard <ArrowRight className="w-4 h-4" />
              </Link>
            ) : (
              <>
                <Link href="/login" className="h-9 px-4 rounded-lg text-sm font-medium flex items-center hover:bg-muted transition-colors">Log in</Link>
                <Link href="/signup" className="h-9 px-4 rounded-lg gradient-brand text-white text-sm font-medium flex items-center gap-1.5">
                  Get started <ArrowRight className="w-4 h-4" />
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 -z-10 opacity-[0.15] dark:opacity-25"
          style={{ background: 'radial-gradient(60% 60% at 50% 0%, hsl(43 72% 50%) 0%, transparent 70%)' }} />
        <div className="max-w-3xl mx-auto px-5 pt-20 pb-16 text-center">
          <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border border-border bg-muted/50 mb-5">
              <Sparkles className="w-3.5 h-3.5 text-primary" /> AI-powered LinkedIn outreach on autopilot
            </span>
            <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight leading-[1.1]">
              Turn LinkedIn into a<br />
              <span className="gradient-text">meeting-booking machine</span>
            </h1>
            <p className="mt-5 text-base sm:text-lg text-muted-foreground max-w-xl mx-auto">
              GRM Connect writes personalized invites, follows up, and converses with replies —
              automatically — until a call lands on your calendar.
            </p>
            <div className="mt-8 flex items-center justify-center gap-3">
              <Link href={authed ? '/dashboard' : '/signup'} className="h-11 px-6 rounded-xl gradient-brand text-white font-semibold flex items-center gap-2 shadow-lg shadow-primary/20 hover:opacity-90 transition-opacity">
                <Rocket className="w-5 h-5" /> {authed ? 'Open dashboard' : 'Start free'}
              </Link>
              {!authed && (
                <Link href="/login" className="h-11 px-6 rounded-xl border border-border font-semibold flex items-center hover:bg-muted transition-colors">
                  Log in
                </Link>
              )}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">No credit card needed · Your data, your account</p>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-5 py-16">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold">Everything you need to close from LinkedIn</h2>
          <p className="text-muted-foreground mt-2">From first message to booked call — hands-off.</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.04 }}
              className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors"
            >
              <div className="w-10 h-10 rounded-xl gradient-brand flex items-center justify-center mb-3">
                <f.icon className="w-5 h-5 text-white" />
              </div>
              <h3 className="font-semibold">{f.title}</h3>
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="max-w-4xl mx-auto px-5 py-12">
        <div className="text-center mb-10">
          <h2 className="text-2xl sm:text-3xl font-bold">Live in 3 steps</h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-5">
          {STEPS.map(s => (
            <div key={s.n} className="text-center">
              <div className="w-11 h-11 rounded-full gradient-brand text-white font-bold flex items-center justify-center mx-auto mb-3">{s.n}</div>
              <h3 className="font-semibold">{s.title}</h3>
              <p className="text-sm text-muted-foreground mt-1.5">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Chrome extension */}
      <section className="max-w-4xl mx-auto px-5 py-12">
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8 flex flex-col sm:flex-row items-center gap-5 text-center sm:text-left">
          <div className="w-12 h-12 rounded-xl gradient-brand flex items-center justify-center shrink-0">
            <Chrome className="w-6 h-6 text-white" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-lg">Get the Chrome extension</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Needed to connect your LinkedIn and run outreach in your own browser. Download, unzip, then load it via{' '}
              <span className="font-medium text-foreground">chrome://extensions → Load unpacked</span>. Full steps are on the Settings page after you log in.
            </p>
          </div>
          <a
            href="/grmconnect-extension.zip"
            download
            className="h-11 px-6 rounded-xl gradient-brand text-white font-semibold flex items-center gap-2 shrink-0 hover:opacity-90 transition-opacity"
          >
            <Download className="w-5 h-5" /> Download
          </a>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-5xl mx-auto px-5 py-16">
        <div className="rounded-3xl gradient-brand text-white p-10 sm:p-14 text-center relative overflow-hidden">
          <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, white 0%, transparent 50%)' }} />
          <div className="relative">
            <MessageSquareText className="w-9 h-9 mx-auto mb-4 opacity-90" />
            <h2 className="text-2xl sm:text-3xl font-bold">Stop chasing. Start booking.</h2>
            <p className="mt-3 text-white/80 max-w-lg mx-auto">Let the AI run your LinkedIn outreach while you focus on the calls.</p>
            <Link href={authed ? '/dashboard' : '/signup'} className="mt-7 inline-flex h-11 px-7 rounded-xl bg-white text-slate-900 font-semibold items-center gap-2 hover:bg-white/90 transition-colors">
              {authed ? 'Open dashboard' : 'Create your account'} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-6xl mx-auto px-5 py-8 flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <Logo className="w-9 h-9 border border-border" rounded="rounded-lg" />
          </div>
          <p>© {new Date().getFullYear()} GRM Connect. Built for founders who’d rather be on calls.</p>
        </div>
      </footer>
    </div>
  )
}
