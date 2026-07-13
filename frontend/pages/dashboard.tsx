import React from 'react'
import { motion } from 'framer-motion'
import {
  Users, Megaphone, MessageSquare, Flame, Calendar, TrendingUp,
  ArrowRight, Sparkles,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { StatsCard } from '../src/components/StatsCard'
import { ActivityFeed } from '../src/components/ActivityFeed'
import { CallsBooked } from '../src/components/CallsBooked'
import { RepliesChart, SentVsRepliesChart } from '../src/components/AnalyticsCharts'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Badge } from '../src/components/ui/badge'
import { Button } from '../src/components/ui/button'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Progress } from '../src/components/ui/progress'
import { useDashboardStats } from '../src/hooks/useAnalytics'
import { useLeads } from '../src/hooks/useLeads'
import { useCampaigns } from '../src/hooks/useCampaigns'
import { LeadStatusBadge } from '../src/components/LeadStatusBadge'
import { getInitials, scoreToColor, formatRelativeTime } from '../src/lib/utils'
import Link from 'next/link'

export default function Dashboard() {
  const { data: stats } = useDashboardStats()
  const { data: leads } = useLeads()
  const { data: campaigns } = useCampaigns()

  const hotLeads = leads?.filter(l => l.status === 'hot' || l.score >= 80).slice(0, 5) ?? []
  const activeCampaigns = campaigns?.filter(c => c.status === 'active') ?? []

  return (
    <Layout>
      <div className="p-6 space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatsCard title="Total Leads"       value={stats?.total_leads ?? 0}    change={12}  icon={<Users className="w-5 h-5 text-primary" />}        iconBg="bg-primary/10"   delay={0} />
          <StatsCard title="Active Campaigns"  value={stats?.active_campaigns ?? 0} change={0} icon={<Megaphone className="w-5 h-5 text-amber-500" />}  iconBg="bg-amber-500/10" delay={0.05} />
          <StatsCard title="Replies Received"  value={stats?.replies_received ?? 0} change={8} icon={<MessageSquare className="w-5 h-5 text-emerald-500" />} iconBg="bg-emerald-500/10" delay={0.1} />
          <StatsCard title="Hot Leads"         value={stats?.hot_leads ?? 0}      change={25}  icon={<Flame className="w-5 h-5 text-orange-500" />}       iconBg="bg-orange-500/10" delay={0.15} />
          <StatsCard title="Meetings Booked"   value={stats?.meetings_booked ?? 0} change={50} icon={<Calendar className="w-5 h-5 text-yellow-500" />}    iconBg="bg-yellow-500/10" delay={0.2} />
          <StatsCard title="Conversion Rate"   value={`${stats?.conversion_rate ?? 0}%`} change={3.2} icon={<TrendingUp className="w-5 h-5 text-blue-500" />} iconBg="bg-blue-500/10" delay={0.25} />
        </div>

        {/* Calls booked by autopilot (pending confirmation + confirmed) */}
        <CallsBooked />

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <RepliesChart />
          <SentVsRepliesChart />
        </div>

        {/* Hot leads + Activity + Campaigns */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Hot Leads */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Flame className="w-4 h-4 text-orange-500" />
                  Hot Leads
                </CardTitle>
                <Link href="/leads">
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                    View all <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {hotLeads.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No hot leads yet</p>
              ) : hotLeads.map((lead, i) => (
                <motion.div
                  key={lead.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="flex items-center gap-2.5"
                >
                  <Avatar className="w-8 h-8 shrink-0">
                    <AvatarFallback className="text-xs">{getInitials(lead.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{lead.name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">{lead.company}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Progress value={lead.score} className="w-10 h-1.5" indicatorClassName="bg-orange-500" />
                    <span className={`text-xs font-bold ${scoreToColor(lead.score)}`}>{lead.score}</span>
                  </div>
                </motion.div>
              ))}
            </CardContent>
          </Card>

          {/* Activity Feed */}
          <ActivityFeed />

          {/* Active Campaigns */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Megaphone className="w-4 h-4 text-amber-500" />
                  Active Campaigns
                </CardTitle>
                <Link href="/campaigns">
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                    View all <ArrowRight className="w-3 h-3" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              {activeCampaigns.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">No active campaigns</p>
              ) : activeCampaigns.map((campaign, i) => (
                <motion.div
                  key={campaign.id}
                  initial={{ opacity: 0, x: 8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.05 }}
                  className="space-y-2 p-3 bg-muted/40 rounded-lg"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium truncate">{campaign.name}</p>
                    <Badge variant="success" className="text-[10px] px-1.5 py-0 h-4">Active</Badge>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span>{campaign.sent_count} sent</span>
                    <span>·</span>
                    <span className="text-emerald-500 font-medium">{campaign.reply_rate.toFixed(1)}% reply rate</span>
                  </div>
                  <Progress value={(campaign.sent_count / Math.max(campaign.leads_count, 1)) * 100} className="h-1.5" />
                </motion.div>
              ))}
              <div className="pt-2">
                <div className="flex items-center gap-2 p-3 border border-dashed border-primary/30 rounded-lg cursor-pointer hover:bg-primary/5 transition-colors">
                  <Sparkles className="w-4 h-4 text-primary" />
                  <div className="flex-1">
                    <p className="text-xs font-medium text-primary">AI Workspace</p>
                    <p className="text-[10px] text-muted-foreground">Generate personalized outreach</p>
                  </div>
                  <ArrowRight className="w-3 h-3 text-primary" />
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  )
}
