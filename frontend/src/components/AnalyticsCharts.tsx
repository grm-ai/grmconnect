import React from 'react'
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, FunnelChart, Funnel, LabelList,
  Cell,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Skeleton } from './ui/skeleton'
import { useRepliesTrend, useSentTrend, useFunnel, useCampaignPerformance } from '../hooks/useAnalytics'
import { format, parseISO } from 'date-fns'

const COLORS = ['#c79a1f', '#d4a72a', '#e0b93c', '#ec4899', '#f59e0b', '#10b981']

const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 shadow-lg text-xs">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full" style={{ background: p.color }} />
          <span className="text-muted-foreground capitalize">{p.dataKey}:</span>
          <span className="font-medium">{p.value}</span>
        </div>
      ))}
    </div>
  )
}

export function RepliesChart() {
  const { data, isLoading } = useRepliesTrend()
  if (isLoading) return <Skeleton className="h-48 w-full" />
  const formatted = data?.map(d => ({ ...d, date: format(parseISO(d.date), 'MMM d') }))
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Replies Over Time</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={formatted}>
            <defs>
              <linearGradient id="repliesGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#c79a1f" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#c79a1f" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} interval={3} />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="value" stroke="#c79a1f" strokeWidth={2} fill="url(#repliesGrad)" name="replies" />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

export function SentVsRepliesChart() {
  const { data: sent } = useSentTrend()
  const { data: replies } = useRepliesTrend()
  if (!sent || !replies) return <Skeleton className="h-52 w-full" />
  const combined = sent.map((s, i) => ({
    date: format(parseISO(s.date), 'MMM d'),
    sent: s.value,
    replies: replies[i]?.value ?? 0,
  }))
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Sent vs Replies</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={combined} barSize={8}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} interval={3} />
            <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="sent"    fill="#c79a1f" radius={[3, 3, 0, 0]} />
            <Bar dataKey="replies" fill="#10b981" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="flex gap-4 mt-2 justify-center">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-3 h-3 rounded-sm bg-primary" /> Sent
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="w-3 h-3 rounded-sm bg-emerald-500" /> Replies
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function FunnelChart2() {
  const { data, isLoading } = useFunnel()
  if (isLoading) return <Skeleton className="h-64 w-full" />
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Conversion Funnel</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {data?.map((stage, i) => (
          <div key={stage.stage} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{stage.stage}</span>
              <span className="font-medium">{stage.count.toLocaleString()}</span>
            </div>
            <div className="h-6 rounded-md overflow-hidden bg-muted">
              <div
                className="h-full rounded-md transition-all duration-700 flex items-center justify-end pr-2"
                style={{ width: `${stage.percentage}%`, background: COLORS[i] }}
              >
                <span className="text-[10px] text-white font-medium">{stage.percentage.toFixed(0)}%</span>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function CampaignPerfChart() {
  const { data, isLoading } = useCampaignPerformance()
  if (isLoading) return <Skeleton className="h-52 w-full" />
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Campaign Performance</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={data} layout="vertical" barSize={8}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickLine={false} axisLine={false} width={90} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="sent"     fill="#c79a1f" radius={[0, 3, 3, 0]} />
            <Bar dataKey="replies"  fill="#10b981" radius={[0, 3, 3, 0]} />
            <Bar dataKey="meetings" fill="#f59e0b" radius={[0, 3, 3, 0]} />
          </BarChart>
        </ResponsiveContainer>
        <div className="flex gap-4 mt-2 justify-center">
          {[['Sent','bg-primary'],['Replies','bg-emerald-500'],['Meetings','bg-yellow-500']].map(([l,c]) => (
            <div key={l} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`w-3 h-3 rounded-sm ${c}`} /> {l}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
