import React from 'react'
import { BarChart3, TrendingUp, Users, Megaphone, Calendar, Flame } from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { StatsCard } from '../src/components/StatsCard'
import { RepliesChart, SentVsRepliesChart, FunnelChart2, CampaignPerfChart } from '../src/components/AnalyticsCharts'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Badge } from '../src/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs'
import { useDashboardStats, useCampaignPerformance } from '../src/hooks/useAnalytics'

export default function AnalyticsPage() {
  const { data: stats } = useDashboardStats()
  const { data: perfData } = useCampaignPerformance()

  return (
    <Layout>
      <div className="p-6 space-y-6">
        {/* Stats row — all from /analytics/stats (your account only) */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatsCard title="Total Leads"      value={stats?.total_leads ?? 0}      icon={<Users className="w-5 h-5 text-primary" />}          iconBg="bg-primary/10"     delay={0} />
          <StatsCard title="Active Campaigns" value={stats?.active_campaigns ?? 0} icon={<Megaphone className="w-5 h-5 text-amber-500" />}     iconBg="bg-amber-500/10"   delay={0.05} />
          <StatsCard title="Replies"          value={stats?.replies_received ?? 0} icon={<TrendingUp className="w-5 h-5 text-emerald-500" />}  iconBg="bg-emerald-500/10" delay={0.1} />
          <StatsCard title="Hot Leads"        value={stats?.hot_leads ?? 0}        icon={<Flame className="w-5 h-5 text-orange-500" />}       iconBg="bg-orange-500/10"  delay={0.15} />
          <StatsCard title="Meetings Booked"  value={stats?.meetings_booked ?? 0}  icon={<Calendar className="w-5 h-5 text-yellow-500" />}    iconBg="bg-yellow-500/10"  delay={0.2} />
          <StatsCard title="Conversion Rate"  value={`${stats?.conversion_rate ?? 0}%`} icon={<BarChart3 className="w-5 h-5 text-blue-500" />} iconBg="bg-blue-500/10" delay={0.25} />
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview"  className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="funnel"    className="text-xs">Funnel</TabsTrigger>
            <TabsTrigger value="campaigns" className="text-xs">Campaigns</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RepliesChart />
              <SentVsRepliesChart />
            </div>
          </TabsContent>

          <TabsContent value="funnel">
            <FunnelChart2 />
          </TabsContent>

          <TabsContent value="campaigns">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CampaignPerfChart />
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Campaign Leaderboard</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(!perfData || perfData.length === 0) && (
                    <p className="text-xs text-muted-foreground text-center py-6">No campaign data yet.</p>
                  )}
                  {perfData?.map((c, i) => (
                    <div key={c.name} className="flex items-center gap-3">
                      <span className="text-lg font-bold text-muted-foreground/30 w-6">#{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{c.name}</p>
                        <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5">
                          <span>{c.sent} sent</span>
                          <span>·</span>
                          <span>{c.replies} replies</span>
                          <span>·</span>
                          <span>{c.meetings} meetings</span>
                        </div>
                      </div>
                      <Badge variant={c.reply_rate > 25 ? 'success' : c.reply_rate > 15 ? 'warning' : 'secondary'} className="text-[10px]">
                        {c.reply_rate.toFixed(1)}%
                      </Badge>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  )
}
