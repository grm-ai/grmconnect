import clsx from 'clsx'
import type { ActionStatus, ActionType } from '../src/lib/api'

const SS: Record<ActionStatus, string> = {
  PENDING:   'bg-gray-100   text-gray-700',
  QUEUED:    'bg-blue-100   text-blue-700',
  RUNNING:   'bg-yellow-100 text-yellow-700',
  SUCCESS:   'bg-green-100  text-green-700',
  FAILED:    'bg-red-100    text-red-700',
  CANCELLED: 'bg-slate-100  text-slate-700',
  RETRYING:  'bg-orange-100 text-orange-700',
}
const TS: Record<ActionType, string> = {
  CONNECT:      'bg-indigo-100 text-indigo-700',
  MESSAGE:      'bg-purple-100 text-purple-700',
  FOLLOWUP:     'bg-cyan-100   text-cyan-700',
  VIEW_PROFILE: 'bg-teal-100   text-teal-700',
  CUSTOM:       'bg-pink-100   text-pink-700',
}

export function StatusBadge({ status }: { status: ActionStatus }) {
  return (
    <span className={clsx('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', SS[status])}>
      {status}
    </span>
  )
}
export function TypeBadge({ type }: { type: ActionType }) {
  return (
    <span className={clsx('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', TS[type])}>
      {type.replace('_', ' ')}
    </span>
  )
}
