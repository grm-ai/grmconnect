interface Props {
  label: string
  value: string | number
  sub?: string
  color?: 'blue' | 'green' | 'yellow' | 'red'
}
const C = {
  blue:   'bg-blue-50 border-blue-200 text-blue-700',
  green:  'bg-green-50 border-green-200 text-green-700',
  yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
  red:    'bg-red-50 border-red-200 text-red-700',
}
export default function StatsCard({ label, value, sub, color = 'blue' }: Props) {
  return (
    <div className={`rounded-xl border p-6 ${C[color]}`}>
      <p className="text-sm font-medium opacity-70">{label}</p>
      <p className="mt-2 text-4xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-xs opacity-60">{sub}</p>}
    </div>
  )
}
