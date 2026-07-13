import clsx from 'clsx'
import type { Campaign, CampaignStatus } from '../src/lib/api'
import { campaignsApi } from '../src/lib/api'

const SS: Record<CampaignStatus, string> = {
  DRAFT:     'bg-gray-100  text-gray-600  border-gray-200',
  ACTIVE:    'bg-green-50  text-green-700 border-green-200',
  PAUSED:    'bg-yellow-50 text-yellow-700 border-yellow-200',
  COMPLETED: 'bg-blue-50   text-blue-700  border-blue-200',
}

interface Props {
  campaign: Campaign
  onUpdated?: () => void
}

export default function CampaignCard({ campaign, onUpdated }: Props) {
  const toggle = async () => {
    const next: CampaignStatus = campaign.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE'
    await campaignsApi.update(campaign.id, { status: next })
    onUpdated?.()
  }
  return (
    <div className={clsx('rounded-xl border p-5 shadow-sm transition-shadow hover:shadow-md', SS[campaign.status])}>
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-gray-900">{campaign.name}</h3>
          {campaign.description && <p className="mt-1 text-sm text-gray-500 line-clamp-2">{campaign.description}</p>}
        </div>
        <span className={clsx('text-xs font-medium px-2.5 py-1 rounded-full border', SS[campaign.status])}>{campaign.status}</span>
      </div>
      <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
        <span>Daily limit: <strong className="text-gray-800">{campaign.daily_limit}</strong></span>
        <button onClick={toggle} className="text-xs font-medium text-blue-600 hover:text-blue-800 underline">
          {campaign.status === 'ACTIVE' ? 'Pause' : 'Activate'}
        </button>
      </div>
    </div>
  )
}
