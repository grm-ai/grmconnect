import React from 'react'
import { motion } from 'framer-motion'
import { BarChart3, TrendingUp, Users, MessageSquare, Calendar, Flame } from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { StatsCard } from '../src/components/StatsCard'
import { RepliesChart, SentVsRepliesChart, FunnelChart2, CampaignPerfChart } from '../src/components/AnalyticsCharts'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Badge } from '../src/components/ui/badge'
import { Progress } from '../src/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../src/components/ui/tabs'
import { useDashboardStats, useCampaignPerformance } from '../src/hooks/useAnalytics'
import { useCampaigns } from '../src/hooks/useCampaigns'

export default function AnalyticsPage() {
  const { data: stats } = useDashboardStats()
  const { data: campaigns } = useCampaigns()
  const { data: perfData } = useCampaignPerformance()

  return (
    <Layout>
      <div className="p-6 space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          <StatsCard title="Total Leads"     value={stats?.total_leads ?? 0}    change={12} icon={<Users className="w-5 h-5 text-primary" />}        iconBg="bg-primary/10"    delay={0} />
          <StatsCard title="Messages Sent"   value={342}                         change={8}  icon={<MessageSquare className="w-5 h-5 text-blue-500" />} iconBg="bg-blue-500/10"   delay={0.05} />
          <StatsCard title="Replies"         value={stats?.replies_received ?? 0} change={15} icon={<TrendingUp className="w-5 h-5 text-emerald-500" />} iconBg="bg-emerald-500/10" delay={0.1} />
          <StatsCard title="Reply Rate"      value="21.9%" change={2.4}           icon={<BarChart3 className="w-5 h-5 text-amber-500" />}  iconBg="bg-amber-500/10" delay={0.15} />
          <StatsCard title="Hot Leads"       value={stats?.hot_leads ?? 0}       change={25} icon={<Flame className="w-5 h-5 text-orange-500" />}      iconBg="bg-orange-500/10" delay={0.2} />
          <StatsCard title="Meetings Booked" value={stats?.meetings_booked ?? 0} change={50} icon={<Calendar className="w-5 h-5 text-yellow-500" />}   iconBg="bg-yellow-500/10" delay={0.25} />
        </div>

        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview"  className="text-xs">Overview</TabsTrigger>
            <TabsTrigger value="funnel"    className="text-xs">Funnel</TabsTrigger>
            <TabsTrigger value="campaigns" className="text-xs">Campaigns</TabsTrigger>
            <TabsTrigger value="team"      className="text-xs">Team</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <RepliesChart />
              <SentVsRepliesChart />
            </div>
            {/* Hot lead trend */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <Flame className="w-4 h-4 text-orange-500" />
                  Hot Lead Trends
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {[
                    { label: 'This Week',  count: 12, prev: 9,  pct: 33 },
                    { label: 'This Month', count: 47, prev: 38, pct: 24 },
                    { label: 'This Quarter', count: 112, prev: 89, pct: 26 },
                  ].map(row => (
                    <div key={row.label} className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground w-24 shrink-0">{row.label}</span>
                      <Progress value={(row.count / 150) * 100} className="flex-1 h-2" indicatorClassName="bg-orange-500" />
                      <span className="text-xs font-bold w-6 shrink-0">{row.count}</span>
                      <Badge variant="success" className="text-[10px] shrink-0">+{row.pct}%</Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="funnel">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <FunnelChart2 />
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Stage Conversion Rates</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {[
                    { from: 'Lead → Contacted',    rate: 66.9, color: 'bg-primary' },
                    { from: 'Contacted → Reply',   rate: 23.7, color: 'bg-amber-500' },
                    { from: 'Reply → Interested',  rate: 51.1, color: 'bg-pink-500' },
                    { from: 'Interested → Meeting', rate: 37.5, color: 'bg-yellow-500' },
                    { from: 'Meeting → Closed',    rate: 33.3, color: 'bg-emerald-500' },
                  ].map(row => (
                    <div key={row.from} className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">{row.from}</span>
                        <span className="font-medium">{row.rate}%</span>
                      </div>
                      <Progress value={row.rate} className="h-1.5" indicatorClassName={row.color} />
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="campaigns">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CampaignPerfChart />
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Campaign Leaderboard</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
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

          <TabsContent value="team">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Team Performance</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {[
                    { name: 'You',          sent: 198, replies: 47, meetings: 9,  rate: 23.7 },
                    { name: 'Jordan Lee',   sent: 87,  replies: 18, meetings: 4,  rate: 20.7 },
                    { name: 'Alex Morgan',  sent: 57,  replies: 11, meetings: 2,  rate: 19.3 },
                  ].map((member, i) => (
                    <motion.div
                      key={member.name}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.05 }}
                      className="flex items-center gap-4 p-3 bg-muted/40 rounded-lg"
                    >
                      <div className="w-8 h-8 rounded-full gradient-brand flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {member.name[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold">{member.name}</p>
                        <div className="flex gap-3 mt-1 text-[11px] text-muted-foreground">
                          <span>{member.sent} sent</span>
                          <span>{member.replies} replies</span>
                          <span>{member.meetings} meetings</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-bold text-primary">{member.rate}%</p>
                        <p className="text-[10px] text-muted-foreground">reply rate</p>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </Layout>
  )
}
