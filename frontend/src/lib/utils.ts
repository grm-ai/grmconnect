import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatDistanceToNow, format, parseISO } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatRelativeTime(dateStr: string): string {
  try {
    return formatDistanceToNow(parseISO(dateStr), { addSuffix: true })
  } catch {
    return dateStr
  }
}

export function formatDate(dateStr: string, fmt = 'MMM d, yyyy'): string {
  try {
    return format(parseISO(dateStr), fmt)
  } catch {
    return dateStr
  }
}

export function formatPercent(value: number, decimals = 1): string {
  return `${value.toFixed(decimals)}%`
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toString()
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function scoreToColor(score: number): string {
  if (score >= 80) return 'text-emerald-500'
  if (score >= 60) return 'text-yellow-500'
  if (score >= 40) return 'text-orange-500'
  return 'text-red-500'
}

export function scoreToLabel(score: number): string {
  if (score >= 80) return 'Hot'
  if (score >= 60) return 'Warm'
  if (score >= 40) return 'Lukewarm'
  return 'Cold'
}

export function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

export function generateId(): string {
  return Math.random().toString(36).slice(2, 11)
}
