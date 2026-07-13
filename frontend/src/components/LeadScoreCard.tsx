import React from 'react'
import { motion } from 'framer-motion'
import {
  X, Linkedin, Mail, MapPin, Building2, Users, ExternalLink,
  Flame, Calendar, Tag, Brain,
} from 'lucide-react'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Progress } from './ui/progress'
import { Separator } from './ui/separator'
import { ScrollArea } from './ui/scroll-area'
import { LeadStatusBadge } from './LeadStatusBadge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useUpdateLeadStatus } from '../hooks/useLeads'
import { scoreToColor, scoreToLabel, formatRelativeTime, getInitials } from '../lib/utils'
import type { Lead, LeadStatus } from '../types'
import { toast } from 'sonner'

interface LeadScoreCardProps {
  lead: Lead
  onClose: () => void
}

export function LeadScoreCard({ lead, onClose }: LeadScoreCardProps) {
  const updateStatus = useUpdateLeadStatus()

  async function handleStatusChange(status: LeadStatus) {
    await updateStatus.mutateAsync({ id: lead.id, status })
    toast.success(`Status updated to ${status}`)
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      className="w-80 shrink-0 border-l border-border bg-card flex flex-col h-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold">Lead Profile</h3>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-4">
          {/* Avatar + Name */}
          <div className="flex flex-col items-center text-center py-2">
            <Avatar className="w-16 h-16 mb-3">
              <AvatarFallback className="text-lg">{getInitials(lead.name)}</AvatarFallback>
            </Avatar>
            <h4 className="font-semibold text-sm">{lead.name}</h4>
            <p className="text-xs text-muted-foreground mt-0.5">{lead.title}</p>
            <div className="flex items-center gap-1.5 mt-2">
              <LeadStatusBadge status={lead.status} />
            </div>
          </div>

          {/* Score */}
          <div className="bg-muted/50 rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium flex items-center gap-1.5">
                <Flame className="w-3.5 h-3.5 text-orange-500" />
                Lead Score
              </span>
              <span className={`text-sm font-bold ${scoreToColor(lead.score)}`}>
                {lead.score} — {scoreToLabel(lead.score)}
              </span>
            </div>
            <Progress
              value={lead.score}
              className="h-2"
              indicatorClassName={
                lead.score >= 80 ? 'bg-gradient-to-r from-orange-400 to-red-500' :
                lead.score >= 60 ? 'bg-gradient-to-r from-yellow-400 to-orange-400' :
                'bg-gradient-to-r from-blue-400 to-amber-400'
              }
            />
          </div>

          {/* Status update */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Update Status</label>
            <Select value={lead.status} onValueChange={(v) => handleStatusChange(v as LeadStatus)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['new','contacted','replied','hot','warm','cold','meeting_booked'] as LeadStatus[]).map(s => (
                  <SelectItem key={s} value={s} className="text-xs capitalize">{s.replace('_', ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Details */}
          <div className="space-y-2.5">
            <InfoRow icon={<Building2 className="w-3.5 h-3.5" />} label={lead.company} />
            <InfoRow icon={<MapPin className="w-3.5 h-3.5" />} label={lead.location} />
            <InfoRow icon={<Users className="w-3.5 h-3.5" />} label={`${lead.company_size} employees`} />
            <InfoRow icon={<Tag className="w-3.5 h-3.5" />} label={lead.industry} />
            {lead.email && <InfoRow icon={<Mail className="w-3.5 h-3.5" />} label={lead.email} />}
          </div>

          {/* Links */}
          <div className="flex gap-2">
            {lead.linkedin_url && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1 h-8 text-xs"
                onClick={() => window.open(lead.linkedin_url!, '_blank')}
              >
                <Linkedin className="w-3.5 h-3.5 mr-1.5" />
                LinkedIn
              </Button>
            )}
            {lead.email && (
              <Button variant="outline" size="sm" className="flex-1 h-8 text-xs">
                <Mail className="w-3.5 h-3.5 mr-1.5" />
                Email
              </Button>
            )}
          </div>

          {/* Tags */}
          {lead.tags.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Tags</p>
              <div className="flex flex-wrap gap-1">
                {lead.tags.map(tag => (
                  <Badge key={tag} variant="secondary" className="text-[10px] px-2 py-0.5">{tag}</Badge>
                ))}
              </div>
            </div>
          )}

          {/* Notes */}
          {lead.notes && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Notes</p>
              <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-2.5 leading-relaxed">{lead.notes}</p>
            </div>
          )}

          {/* Last activity */}
          <div className="text-[11px] text-muted-foreground text-center pt-1">
            Last activity {formatRelativeTime(lead.last_activity)}
          </div>
        </div>
      </ScrollArea>

      {/* Actions */}
      <div className="border-t border-border p-3 flex gap-2">
        <Button className="flex-1 h-8 text-xs" size="sm">
          <Brain className="w-3.5 h-3.5 mr-1.5" />
          AI Insights
        </Button>
        <Button variant="outline" className="flex-1 h-8 text-xs" size="sm">
          <Calendar className="w-3.5 h-3.5 mr-1.5" />
          Book Meeting
        </Button>
      </div>
    </motion.div>
  )
}

function InfoRow({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  )
}
