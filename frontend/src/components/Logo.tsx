import React from 'react'
import { cn } from '../lib/utils'

/**
 * GRM Connect brand mark. Renders /logo.png inside a white rounded tile so the
 * gold logo stays legible on both light and dark backgrounds.
 * Size it with a width/height utility in `className` (e.g. "w-8 h-8").
 */
export function Logo({ className, rounded = 'rounded-lg' }: { className?: string; rounded?: string }) {
  return (
    <span className={cn('inline-flex items-center justify-center overflow-hidden bg-white', rounded, className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/logo.png" alt="GRM Connect" className="w-full h-full object-contain" />
    </span>
  )
}
