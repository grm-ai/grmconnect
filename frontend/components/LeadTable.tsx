import clsx from 'clsx'
import type { Lead, LeadStatus } from '../src/lib/api'
import { leadsApi } from '../src/lib/api'

const SC: Record<LeadStatus, string> = {
  PENDING:   'bg-gray-100   text-gray-600',
  ACTIVE:    'bg-blue-100   text-blue-700',
  CONTACTED: 'bg-yellow-100 text-yellow-700',
  REPLIED:   'bg-green-100  text-green-700',
  CONVERTED: 'bg-emerald-100 text-emerald-700',
  ARCHIVED:  'bg-slate-100  text-slate-500',
}

interface LeadTableProps {
  leads: Lead[]
  onDeleted?: () => void
}

export default function LeadTable({ leads, onDeleted }: LeadTableProps) {
  const del = async (id: number) => {
    if (!confirm('Delete this lead?')) return
    await leadsApi.remove(id)
    onDeleted?.()
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            {['ID','Name','Company','Email','LinkedIn','Status','Created',''].map(h => (
              <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {leads.map(l => (
            <tr key={l.id} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3 text-sm text-gray-500">{l.id}</td>
              <td className="px-4 py-3 text-sm font-medium text-gray-900">{l.name}</td>
              <td className="px-4 py-3 text-sm text-gray-600">{l.company ?? '-'}</td>
              <td className="px-4 py-3 text-sm text-gray-600">{l.email ?? '-'}</td>
              <td className="px-4 py-3 text-sm">
                {l.linkedin_url
                  ? <a href={l.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">View</a>
                  : '-'}
              </td>
              <td className="px-4 py-3">
                <span className={clsx('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium', SC[l.status])}>
                  {l.status}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-gray-500">{new Date(l.created_at).toLocaleDateString()}</td>
              <td className="px-4 py-3 text-right">
                <button onClick={() => del(l.id)} className="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
              </td>
            </tr>
          ))}
          {leads.length === 0 && (
            <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-gray-400">No leads found.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
