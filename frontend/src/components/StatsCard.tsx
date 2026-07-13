import React from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { Card } from './ui/card'
import { cn } from '../lib/utils'

interface StatsCardProps {
  title: string
  value: string | number
  change?: number
  icon: React.ReactNode
  iconBg?: string
  suffix?: string
  description?: string
  delay?: number
}

export function StatsCard({ title, value, change, icon, iconBg, suffix, description, delay = 0 }: StatsCardProps) {
  const isPositive = (change ?? 0) >= 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.3 }}
    >
      <Card className="p-5 card-hover cursor-default">
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
            <div className="flex items-baseline gap-1 mt-1.5">
              <span className="text-2xl font-bold tabular-nums">{value}</span>
              {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
            </div>
            {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
            {change !== undefined && (
              <div className={cn('flex items-center gap-1 mt-2 text-xs font-medium', isPositive ? 'text-emerald-500' : 'text-red-500')}>
                {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                <span>{isPositive ? '+' : ''}{change}% vs last week</span>
              </div>
            )}
          </div>
          <div className={cn('flex items-center justify-center w-10 h-10 rounded-lg shrink-0', iconBg ?? 'bg-primary/10')}>
            {icon}
          </div>
        </div>
      </Card>
    </motion.div>
  )
}
