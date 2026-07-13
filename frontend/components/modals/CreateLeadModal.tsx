import { useState } from 'react'
import { leadsApi } from '../../src/lib/api'
import type { CreateLeadInput } from '../../src/lib/api'

interface Props { onCreated: () => void; onClose: () => void }

export default function CreateLeadModal({ onCreated, onClose }: Props) {
  const [form, setForm] = useState<CreateLeadInput>({ name: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setLoading(true); setError('')
    try { await leadsApi.create(form); onCreated(); onClose() }
    catch (err: any) { setError(err.message ?? 'Error') }
    finally { setLoading(false) }
  }

  const fields = [
    { label: 'Name *', key: 'name' as const, required: true, placeholder: 'Jane Smith' },
    { label: 'Company', key: 'company' as const, placeholder: 'Acme Corp' },
    { label: 'LinkedIn URL', key: 'linkedin_url' as const, placeholder: 'https://linkedin.com/in/...' },
    { label: 'Email', key: 'email' as const, placeholder: 'jane@acme.com' },
  ]

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
        <h2 className="text-lg font-semibold mb-4">Create Lead</h2>
        <form onSubmit={submit} className="space-y-4">
          {fields.map(({ label, key, required, placeholder }) => (
            <div key={key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
              <input required={required} placeholder={placeholder}
                value={(form as any)[key] ?? ''}
                onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 py-2 border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
              {loading ? 'Creating…' : 'Create Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
