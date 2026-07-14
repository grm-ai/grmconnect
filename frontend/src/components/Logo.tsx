import React from 'react'
import { cn } from '../lib/utils'

/**
 * GRM Connect brand mark. Renders /logo.png inside a white rounded tile so the
 * gold logo stays legible on both light and dark backgrounds.
 * Size it with a width/height utility in `className` (e.g. "w-8 h-8").
 */
export function Logo({
  className,
  rounded = 'rounded-lg',
  zoom = 2.7,
  bare = false,
}: {
  className?: string
  rounded?: string
  /** Scales the artwork inside its tile to crop the logo's white padding so the name reads clearly. */
  zoom?: number
  /** Render the raw logo with no white tile/border — use on light backgrounds where the padding blends in. */
  bare?: boolean
}) {
  if (bare) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src="/logo.png" alt="GRM Connect" className={cn('object-contain', className)} />
  }
  return (
    <span className={cn('inline-flex items-center justify-center overflow-hidden bg-white', rounded, className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logo.png"
        alt="GRM Connect"
        className="w-full h-full object-contain"
        style={{ transform: `scale(${zoom})` }}
      />
    </span>
  )
}
