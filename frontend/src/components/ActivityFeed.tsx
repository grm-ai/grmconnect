import React from 'react'
import { motion } from 'framer-motion'
import {
  UserPlus, MessageSquare, Calendar, Play, TrendingUp, Sparkles, ArrowUpRight
} from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from './ui/card'
import { Avatar, AvatarFallback } from './ui/avatar'
import { ScrollArea } from './ui/scroll-area'
import { useActivities } from '../hooks/useAnalytics'
import { formatRelativeTime, getInitials } from '../lib/utils'
import { Skeleton } from './ui/skeleton'
import type { ActivityType } from '../types'

const ACTIVITY_ICONS: Record<ActivityType, React.ReactNode> = {
  lead_added:          <UserPlus className="w-3.5 h-3.5 text-blue-500" />,
  message_sent:        <MessageSquare className="w-3.5 h-3.5 text-amber-500" />,
  reply_received:      <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" />,
  meeting_booked:      <Calendar className="w-3.5 h-3.5 text-orange-500" />,
  campaign_started:    <Play className="w-3.5 h-3.5 text-primary" />,
  lead_status_changed: <TrendingUp className="w-3.5 h-3.5 text-yellow-500" />,
  ai_draft_generated:  <Sparkles className="w-3.5 h-3.5 text-pink-500" />,
}

const ACTIVITY_BG: Record<ActivityType, string> = {
  lead_added:          'bg-blue-500/10',
  message_sent:        'bg-amber-500/10',
  reply_received:      'bg-emerald-500/10',
  meeting_booked:      'bg-orange-500/10',
  campaign_started:    'bg-primary/10',
  lead_status_changed: 'bg-yellow-500/10',
  ai_draft_generated:  'bg-pink-500/10',
}

export function ActivityFeed() {
  const { data: activities, isLoading } = useActivities()

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Activity Timeline</CardTitle>
      </CardHeader>
      <CardContent className="p-0 flex-1">
        <ScrollArea className="h-[380px]">
          <div className="px-5 pb-4 space-y-3">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="w-7 h-7 rounded-full shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-2.5 w-1/2" />
                    </div>
                  </div>
                ))
              : activities?.map((activity, i) => (
                  <motion.div
                    key={activity.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="flex items-start gap-3"
                  >
                    <div className={`flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${ACTIVITY_BG[activity.type]}`}>
                      {ACTIVITY_ICONS[activity.type]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium leading-snug">{activity.title}</p>
                        <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(activity.created_at)}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{activity.description}</p>
                      {activity.lead && (
                        <div className="flex items-center gap-1.5 mt-1.5">
                          <Avatar className="w-4 h-4">
                            <AvatarFallback className="text-[8px]">{getInitials(activity.lead.name)}</AvatarFallback>
                          </Avatar>
                          <span className="text-[10px] text-muted-foreground">{activity.lead.name} · {activity.lead.company}</span>
                        </div>
                      )}
                    </div>
                  </motion.div>
                ))
            }
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
