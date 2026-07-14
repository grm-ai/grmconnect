import React, { useEffect, useState } from 'react'
import { useRouter } from 'next/router'
import { Bell, Moon, Sun, Search, Plus, LogOut } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useQueryClient } from '@tanstack/react-query'
import { useUIStore } from '../../store/ui-store'
import { getUser, clearAuth, type AuthUser } from '../../lib/auth'

const PAGE_TITLES: Record<string, { title: string; subtitle: string }> = {
  '/dashboard':         { title: 'Dashboard',          subtitle: 'Welcome back — here\'s your overview' },
  '/leads':             { title: 'Leads',               subtitle: 'Manage and track your prospects' },
  '/campaigns':         { title: 'Campaigns',           subtitle: 'Build and manage outreach sequences' },
  '/conversations':     { title: 'Conversations',       subtitle: 'Inbox, messages, and AI summaries' },
  '/ai-workspace':      { title: 'AI Workspace',        subtitle: 'Generate personalized outreach with AI' },
  '/lead-intelligence': { title: 'Lead Intelligence',   subtitle: 'Deep insights on your prospects' },
  '/analytics':         { title: 'Analytics',           subtitle: 'Performance metrics and trends' },
  '/settings':          { title: 'Settings',            subtitle: 'Configure your GRM Connect workspace' },
}

export function Header() {
  const router = useRouter()
  const { theme, toggleTheme, setNotificationPanelOpen, notificationPanelOpen } = useUIStore()
  const meta = PAGE_TITLES[router.pathname] ?? { title: 'GRM Connect AI', subtitle: '' }

  const qc = useQueryClient()
  const [user, setUser] = useState<AuthUser | null>(null)
  useEffect(() => { setUser(getUser()) }, [])
  function handleLogout() {
    clearAuth()
    qc.clear()  // drop cached data so the next account starts clean
    router.replace('/login')
  }

  return (
    <header className="h-14 border-b border-border bg-background/80 backdrop-blur-sm flex items-center px-6 gap-4 shrink-0 sticky top-0 z-30">
      {/* Page title */}
      <div className="flex-1 min-w-0">
        <h1 className="text-base font-semibold leading-none">{meta.title}</h1>
        <p className="text-xs text-muted-foreground mt-0.5 hidden sm:block">{meta.subtitle}</p>
      </div>

      {/* Search */}
      <div className="hidden md:block w-64">
        <Input
          placeholder="Search leads, campaigns..."
          icon={<Search className="w-3.5 h-3.5" />}
          className="h-8 text-xs"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-8 w-8">
          {theme === 'dark'
            ? <Sun className="w-4 h-4" />
            : <Moon className="w-4 h-4" />
          }
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 relative"
          onClick={() => setNotificationPanelOpen(!notificationPanelOpen)}
        >
          <Bell className="w-4 h-4" />
        </Button>

        <Button size="sm" className="h-8 gap-1.5 text-xs">
          <Plus className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Add Lead</span>
        </Button>

        {user && (
          <div className="flex items-center gap-1.5 pl-2 ml-1 border-l border-border">
            <div className="hidden md:block text-right leading-tight">
              <p className="text-[11px] font-medium truncate max-w-[140px]">{user.name || user.email}</p>
              {user.name && <p className="text-[10px] text-muted-foreground truncate max-w-[140px]">{user.email}</p>}
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleLogout} title="Log out">
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>
    </header>
  )
}
