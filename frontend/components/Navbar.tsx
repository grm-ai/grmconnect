import Link from 'next/link'
import { useRouter } from 'next/router'
import clsx from 'clsx'

const NAV = [
  { href: '/',          label: 'Dashboard' },
  { href: '/leads',     label: 'Leads'     },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/actions',   label: 'Actions'   },
]

export default function Navbar() {
  const { pathname } = useRouter()
  return (
    <nav className="bg-blue-800 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <span className="text-white font-bold text-lg">Automation Platform</span>
          <div className="flex space-x-1">
            {NAV.map(({ href, label }) => (
              <Link key={href} href={href}
                className={clsx('px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  pathname === href
                    ? 'bg-blue-900 text-white'
                    : 'text-blue-100 hover:bg-blue-700 hover:text-white')}>
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  )
}
