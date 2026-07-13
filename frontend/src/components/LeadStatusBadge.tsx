import React from 'react'
import { Badge } from './ui/badge'
import type { LeadStatus } from '../types'
import type { BadgeProps } from './ui/badge'

const STATUS_CONFIG: Record<LeadStatus, { label: string; variant: BadgeProps['variant'] }> = {
  new:            { label: 'New',           variant: 'secondary' },
  contacted:      { label: 'Contacted',     variant: 'outline' },
  replied:        { label: 'Replied',       variant: 'purple' },
  hot:            { label: '🔥 Hot',        variant: 'hot' },
  warm:           { label: 'Warm',          variant: 'warm' },
  cold:           { label: 'Cold',          variant: 'cold' },
  meeting_booked: { label: '📅 Meeting',    variant: 'success' },
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const { label, variant } = STATUS_CONFIG[status]
  return <Badge variant={variant}>{label}</Badge>
}
