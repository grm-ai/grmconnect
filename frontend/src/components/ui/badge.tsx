import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary text-primary-foreground',
        secondary:   'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive/15 text-destructive border-destructive/20',
        outline:     'text-foreground',
        success:     'border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        warning:     'border-transparent bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/20',
        hot:         'border-transparent bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/20',
        warm:        'border-transparent bg-orange-500/15 text-orange-600 dark:text-orange-400 border-orange-500/20',
        cold:        'border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20',
        purple:      'border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
