import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Bell, Calendar, MessageSquare, TrendingUp, Sparkles, Check } from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { ScrollArea } from './ui/scroll-area'
import { useUIStore } from '../store/ui-store'
import { formatRelativeTime } from '../lib/utils'

const NOTIFICATIONS = [
  { id: '1', type: 'reply', title: 'Sarah Chen replied', body: 'Asked about pricing and timeline for Q3.', time: '2026-06-17T10:30:00Z', unread: true },
  { id: '2', type: 'meeting', title: 'Meeting booked', body: 'Priya Kapoor confirmed Monday 10am EST demo.', time: '2026-06-17T09:00:00Z', unread: true },
  { id: '3', type: 'ai', title: 'AI drafts ready', body: '15 follow-up messages generated for Q2 Enterprise campaign.', time: '2026-06-16T17:00:00Z', unread: true },
  { id: '4', type: 'hot', title: 'New hot lead detected', body: 'Nicole Brown at RetailIQ upgraded to Hot (score: 88).', time: '2026-06-15T16:00:00Z', unread: false },
  { id: '5', type: 'reply', title: 'Marcus Johnson replied', body: 'Interested in Q3 budget conversation, asked for pricing.', time: '2026-06-14T14:00:00Z', unread: false },
]

const ICONS = {
  reply:   <MessageSquare className="w-3.5 h-3.5 text-amber-500" />,
  meeting: <Calendar className="w-3.5 h-3.5 text-orange-500" />,
  ai:      <Sparkles className="w-3.5 h-3.5 text-primary" />,
  hot:     <TrendingUp className="w-3.5 h-3.5 text-red-500" />,
}

const BG = {
  reply:   'bg-amber-500/10',
  meeting: 'bg-orange-500/10',
  ai:      'bg-primary/10',
  hot:     'bg-red-500/10',
}

export function NotificationCenter() {
  const { notificationPanelOpen, setNotificationPanelOpen } = useUIStore()
  const unreadCount = NOTIFICATIONS.filter(n => n.unread).length

  return (
    <AnimatePresence>
      {notificationPanelOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40"
            onClick={() => setNotificationPanelOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, x: 20, scale: 0.95 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.95 }}
            transition={{ duration: 0.15 }}
            className="fixed right-4 top-14 z-50 w-80 bg-card border border-border rounded-xl shadow-xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4" />
                <span className="text-sm font-semibold">Notifications</span>
                {unreadCount > 0 && (
                  <Badge variant="hot" className="text-[10px] px-1.5 py-0 h-4">{unreadCount}</Badge>
                )}
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Mark all read">
                  <Check className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setNotificationPanelOpen(false)}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            {/* List */}
            <ScrollArea className="h-80">
              <div className="divide-y divide-border">
                {NOTIFICATIONS.map(n => (
                  <div key={n.id} className={`flex gap-3 px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors ${n.unread ? 'bg-primary/5' : ''}`}>
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${BG[n.type as keyof typeof BG]}`}>
                      {ICONS[n.type as keyof typeof ICONS]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-1">
                        <p className="text-xs font-medium leading-snug">{n.title}</p>
                        {n.unread && <span className="w-1.5 h-1.5 bg-primary rounded-full shrink-0 mt-1" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{n.body}</p>
                      <p className="text-[10px] text-muted-foreground/70 mt-1">{formatRelativeTime(n.time)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
