import React, { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Brain, Building2, Flame, TrendingUp, AlertTriangle,
  CheckCircle2, Lightbulb, Search, ChevronRight, Layers,
  Users, Zap,
} from 'lucide-react'
import { Layout } from '../src/components/layout/Layout'
import { Card, CardContent, CardHeader, CardTitle } from '../src/components/ui/card'
import { Button } from '../src/components/ui/button'
import { Badge } from '../src/components/ui/badge'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Progress } from '../src/components/ui/progress'
import { Input } from '../src/components/ui/input'
import { ScrollArea } from '../src/components/ui/scroll-area'
import { Skeleton } from '../src/components/ui/skeleton'
import { useAllLeadsWithIntelligence, useLeadIntelligence } from '../src/hooks/useLeadIntelligence'
import { useLeadIntelligence as useAIInsights } from '../src/hooks/useAI'
import { getInitials, scoreToColor } from '../src/lib/utils'
import { LeadStatusBadge } from '../src/components/LeadStatusBadge'
import { toast } from 'sonner'

export default function LeadIntelligencePage() {
  const { data: leads, isLoading: leadsLoading } = useAllLeadsWithIntelligence()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const { data: intel, isLoading: intelLoading } = useLeadIntelligence(selectedId)
  const generateInsights = useAIInsights()
  const [aiInsight, setAIInsight] = useState('')

  const filtered = leads?.filter(l =>
    l.name.toLowerCase().includes(search.toLowerCase()) ||
    l.company.toLowerCase().includes(search.toLowerCase())
  ) ?? []

  async function handleGenerateInsights() {
    if (!selectedId) return
    const result = await generateInsights.mutateAsync(selectedId)
    setAIInsight(result)
    toast.success('AI insights generated!')
  }

  return (
    <Layout>
      <div className="flex h-[calc(100vh-56px)] overflow-hidden">
        {/* Lead list */}
        <div className="w-64 shrink-0 flex flex-col border-r border-border bg-card overflow-hidden">
          <div className="px-3 py-3 border-b border-border">
            <Input
              placeholder="Search leads..."
              icon={<Search className="w-3.5 h-3.5" />}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {leadsLoading
                ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
                : filtered.map(lead => (
                    <button
                      key={lead.id}
                      onClick={() => setSelectedId(lead.id)}
                      className={`w-full flex items-center gap-2.5 p-2.5 rounded-lg text-left transition-colors ${
                        lead.id === selectedId ? 'bg-primary/10' : 'hover:bg-muted/50'
                      }`}
                    >
                      <Avatar className="w-8 h-8 shrink-0">
                        <AvatarFallback className="text-xs">{getInitials(lead.name)}</AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{lead.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{lead.company}</p>
                      </div>
                      <span className={`text-xs font-bold shrink-0 ${scoreToColor(lead.score)}`}>{lead.score}</span>
                    </button>
                  ))
              }
            </div>
          </ScrollArea>
        </div>

        {/* Intelligence detail */}
        <div className="flex-1 overflow-y-auto">
          {!selectedId ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Brain className="w-16 h-16 text-muted-foreground/20 mb-4" />
              <h3 className="text-base font-semibold">Lead Intelligence</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                Select a lead from the list to view deep AI-powered insights, company analysis, and buying signals.
              </p>
            </div>
          ) : intelLoading ? (
            <div className="p-6 space-y-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
            </div>
          ) : intel ? (
            <div className="p-6 space-y-5">
              {/* Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl gradient-brand flex items-center justify-center text-white text-sm font-bold">
                    {getInitials(leads?.find(l => l.id === selectedId)?.name ?? '')}
                  </div>
                  <div>
                    <h2 className="text-base font-bold">{leads?.find(l => l.id === selectedId)?.name}</h2>
                    <p className="text-xs text-muted-foreground">{leads?.find(l => l.id === selectedId)?.company}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-center">
                    <p className="text-2xl font-bold gradient-text">{intel.opportunity_score}</p>
                    <p className="text-[10px] text-muted-foreground">Opp Score</p>
                  </div>
                  <Button
                    size="sm"
                    variant="gradient"
                    className="h-8 text-xs gap-1.5"
                    onClick={handleGenerateInsights}
                    loading={generateInsights.isPending}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Refresh AI
                  </Button>
                </div>
              </div>

              {/* Opportunity score */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Flame className="w-4 h-4 text-orange-500" />
                    Opportunity Score
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">Overall Opportunity</span>
                      <span className={`font-bold ${scoreToColor(intel.opportunity_score)}`}>{intel.opportunity_score}/100</span>
                    </div>
                    <Progress
                      value={intel.opportunity_score}
                      className="h-3"
                      indicatorClassName={intel.opportunity_score >= 80 ? 'bg-gradient-to-r from-orange-400 to-red-500' : 'bg-gradient-to-r from-yellow-400 to-orange-400'}
                    />
                  </div>
                </CardContent>
              </Card>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Company overview */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-primary" />
                      Company Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-xs text-muted-foreground leading-relaxed">{intel.company_overview}</p>
                    <div className="mt-3 flex flex-wrap gap-1">
                      {intel.tech_stack.map(t => (
                        <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>

                {/* Pain points */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 text-yellow-500" />
                      Pain Points
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {intel.pain_points.map((p, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 mt-1.5 shrink-0" />
                          {p}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>

                {/* Buying signals */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <TrendingUp className="w-4 h-4 text-emerald-500" />
                      Buying Signals
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {intel.buying_signals.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                          {s}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>

                {/* Recent news */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Layers className="w-4 h-4 text-blue-500" />
                      Recent News
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {intel.recent_news.map((n, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                          <ChevronRight className="w-3 h-3 text-blue-500 shrink-0 mt-0.5" />
                          {n}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>

              {/* AI Insights */}
              <Card className="border-primary/30 bg-primary/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2 text-primary">
                    <Lightbulb className="w-4 h-4" />
                    AI Insights & Recommendations
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-xs leading-relaxed text-foreground/80">
                    {aiInsight || intel.ai_insights}
                  </p>
                </CardContent>
              </Card>
            </div>
          ) : null}
        </div>
      </div>
    </Layout>
  )
}
