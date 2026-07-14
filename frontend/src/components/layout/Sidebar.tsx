import React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { motion, AnimatePresence } from 'framer-motion'
import {
  LayoutDashboard, Users, Megaphone, MessageSquare, Sparkles,
  Brain, BarChart3, Settings, ChevronLeft, Zap, Plus,
  Inbox, ChevronDown, Search,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { Logo } from '../Logo'
import { getUser, type AuthUser } from '../../lib/auth'
import { useUIStore } from '../../store/ui-store'
import { useLinkedInSession } from '../../hooks/useLinkedIn'
import { useLeads } from '../../hooks/useLeads'
import { useCampaigns } from '../../hooks/useCampaigns'
import { useConversations } from '../../hooks/useConversations'

// ── Sidebar ────────────────────────────────────────────────────────────────────

export function Sidebar() {
  const router = useRouter()
  const { sidebarCollapsed, toggleSidebar } = useUIStore()

  const { data: sessionData }   = useLinkedInSession()
  const { data: leads }         = useLeads()
  const { data: campaigns }     = useCampaigns()
  const { data: conversations } = useConversations()

  const session      = sessionData?.data
  const leadsCount   = leads?.length ?? 0
  const activeCamps  = campaigns?.filter(c => c.status === 'active').length ?? 0
  const inboxUnread  = conversations?.reduce((sum, c) => sum + (c.unread_count ?? 0), 0) ?? 0

  // The logged-in account (used as the label when no LinkedIn is connected yet).
  const [user, setUser] = React.useState<AuthUser | null>(null)
  React.useEffect(() => { setUser(getUser()) }, [])

  // Avatar: real photo or initials
  const avatarSrc   = session?.has_avatar
    ? `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/linkedin/avatar`
    : null
  const displayName = session?.linkedin_name ?? user?.name ?? user?.email ?? 'GRM Connect'
  const initials    = displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()

  const W = sidebarCollapsed ? 68 : 240

  // Build nav groups from real data
  const NAV_GROUPS = [
    {
      label: 'Overview',
      items: [
        {
          href: '/dashboard', icon: LayoutDashboard, label: 'Dashboard',
          badge: undefined, hot: false,
        },
        {
          href: '/conversations', icon: Inbox, label: 'Inbox',
          badge: inboxUnread > 0 ? String(inboxUnread) : undefined,
          hot: inboxUnread > 0,
        },
        {
          href: '/leads', icon: Users, label: 'Leads',
          badge: leadsCount > 0 ? String(leadsCount) : undefined,
          hot: false,
        },
        {
          href: '/campaigns', icon: Megaphone, label: 'Campaigns',
          badge: activeCamps > 0 ? `${activeCamps} active` : undefined,
          hot: false,
        },
        {
          href: '/searcher', icon: Search, label: 'Searcher',
          badge: undefined, hot: false,
        },
        {
          href: '/analytics', icon: BarChart3, label: 'Analytics',
          badge: undefined, hot: false,
        },
      ],
    },
    {
      label: 'AI Power',
      items: [
        { href: '/ai-workspace',      icon: Sparkles, label: 'AI Workspace',      badge: undefined, hot: false },
        { href: '/lead-intelligence', icon: Brain,    label: 'Lead Intelligence',  badge: undefined, hot: false },
      ],
    },
    {
      label: 'Settings',
      items: [
        { href: '/settings', icon: Settings, label: 'Settings', badge: undefined, hot: false },
      ],
    },
  ]

  return (
    <motion.aside
      animate={{ width: W }}
      transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
      className={cn(
        'relative flex flex-col h-full shrink-0 overflow-hidden',
        'bg-white border-r border-slate-200/80',
        'dark:bg-[hsl(222,47%,7%)] dark:border-white/[0.06]',
      )}
    >
      {/* ── Logo ─────────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2.5 px-4 h-[56px] shrink-0 border-b border-slate-200/60 dark:border-white/[0.06]">
        <Logo className="w-9 h-9 shrink-0 shadow-sm border border-border" rounded="rounded-lg" />
        <AnimatePresence>
          {!sidebarCollapsed && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={toggleSidebar}
              className="ml-auto w-6 h-6 rounded-md flex items-center justify-center hover:bg-slate-100 dark:hover:bg-white/10 transition-colors text-slate-400 dark:text-slate-500"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* ── Stats bar (expanded only) ─────────────────────────────────────────── */}
      <AnimatePresence>
        {!sidebarCollapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="px-3 pt-3 pb-1 overflow-hidden"
          >
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { val: leadsCount,  label: 'Leads',  color: 'text-primary' },
                { val: inboxUnread, label: 'Inbox',  color: 'text-amber-500 dark:text-amber-400' },
                { val: activeCamps, label: 'Active', color: 'text-yellow-600 dark:text-yellow-500' },
              ].map(s => (
                <div
                  key={s.label}
                  className="flex flex-col items-center py-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-100 dark:border-white/[0.06]"
                >
                  <span className={cn('text-[15px] font-bold leading-none', s.color)}>{s.val}</span>
                  <span className="text-[9px] text-slate-400 dark:text-slate-500 mt-0.5 font-medium tracking-wide uppercase">{s.label}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── New Campaign CTA ─────────────────────────────────────────────────── */}
      <div className={cn('px-3 pt-2 pb-1', sidebarCollapsed && 'flex justify-center')}>
        <Link href="/campaigns">
          {sidebarCollapsed ? (
            <button className="w-9 h-9 rounded-xl gradient-brand flex items-center justify-center shadow-md shadow-amber-500/20 hover:opacity-90 transition-opacity">
              <Plus className="w-4 h-4 text-white" strokeWidth={2.5} />
            </button>
          ) : (
            <button className="w-full h-9 rounded-xl gradient-brand flex items-center justify-center gap-2 shadow-md shadow-amber-500/20 hover:opacity-90 transition-opacity">
              <Plus className="w-3.5 h-3.5 text-white" strokeWidth={2.5} />
              <span className="text-[12px] font-semibold text-white">New Campaign</span>
            </button>
          )}
        </Link>
      </div>

      {/* ── Navigation groups ─────────────────────────────────────────────────── */}
      <nav className="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        {NAV_GROUPS.map(group => (
          <div key={group.label}>
            <AnimatePresence>
              {!sidebarCollapsed && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="px-2 pt-3 pb-1 text-[9px] font-bold uppercase tracking-[0.1em] text-slate-400 dark:text-slate-600 select-none"
                >
                  {group.label}
                </motion.p>
              )}
            </AnimatePresence>
            {sidebarCollapsed && <div className="pt-2" />}

            {group.items.map(({ href, icon: Icon, label, badge, hot }) => {
              const active = router.pathname === href
              return (
                <Link key={href} href={href}>
                  <span className={cn(
                    'group flex items-center gap-2.5 rounded-lg h-[34px] px-2.5 cursor-pointer transition-all duration-150 relative',
                    sidebarCollapsed && 'justify-center px-0 w-full',
                    active
                      ? ['bg-primary/10', 'text-primary']
                      : ['text-slate-600 dark:text-slate-400', 'hover:bg-slate-100 dark:hover:bg-white/[0.05]', 'hover:text-slate-900 dark:hover:text-slate-200'],
                  )}>
                    {active && (
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full gradient-brand" />
                    )}

                    <Icon className={cn(
                      'w-[15px] h-[15px] shrink-0 transition-colors',
                      active
                        ? 'text-primary'
                        : 'text-slate-400 dark:text-slate-500 group-hover:text-slate-600 dark:group-hover:text-slate-300',
                    )} />

                    <AnimatePresence>
                      {!sidebarCollapsed && (
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          className="flex-1 text-[12px] font-medium whitespace-nowrap"
                        >
                          {label}
                        </motion.span>
                      )}
                    </AnimatePresence>

                    {!sidebarCollapsed && badge && (
                      <span className={cn(
                        'ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full leading-none',
                        hot
                          ? 'bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400'
                          : 'bg-slate-100 text-slate-500 dark:bg-white/[0.08] dark:text-slate-400',
                      )}>
                        {badge}
                      </span>
                    )}

                    {sidebarCollapsed && hot && (
                      <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-amber-500" />
                    )}
                  </span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* ── Collapse toggle ──────────────────────────────────────────────────── */}
      {sidebarCollapsed && (
        <button
          onClick={toggleSidebar}
          className="mx-auto mb-2 w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-white/[0.07] hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5 rotate-180" />
        </button>
      )}

      {/* ── User profile ─────────────────────────────────────────────────────── */}
      <div className={cn(
        'border-t border-slate-200/60 dark:border-white/[0.06] px-3 py-3',
        sidebarCollapsed ? 'flex justify-center' : 'flex items-center gap-2.5',
      )}>
        <div className="relative shrink-0">
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt={displayName}
              className="w-8 h-8 rounded-full object-cover border-2 border-white dark:border-white/10 shadow-sm"
              onError={e => {
                e.currentTarget.style.display = 'none'
                const fb = e.currentTarget.nextElementSibling as HTMLElement | null
                if (fb) fb.style.display = 'flex'
              }}
            />
          ) : null}
          <div className={cn(
            'w-8 h-8 rounded-full gradient-brand items-center justify-center text-white text-[10px] font-bold border-2 border-white dark:border-white/10 shadow-sm',
            avatarSrc ? 'hidden' : 'flex',
          )}>
            {initials}
          </div>
          <span className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 border border-white dark:border-slate-800" />
        </div>

        <AnimatePresence>
          {!sidebarCollapsed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 min-w-0 flex items-center justify-between"
            >
              <div className="min-w-0">
                <p className="text-[12px] font-semibold truncate text-slate-800 dark:text-slate-100 leading-tight">
                  {displayName}
                </p>
                <p className="text-[10px] text-slate-400 dark:text-slate-500 truncate leading-tight">
                  {session?.linkedin_headline
                    ? session.linkedin_headline.split(' ').slice(0, 4).join(' ') + '…'
                    : (user?.email ?? '')}
                </p>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0 ml-1" />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.aside>
  )
}
