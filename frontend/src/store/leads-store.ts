import { create } from 'zustand'
import type { Lead, LeadStatus } from '../types'

interface LeadsState {
  selectedLeadId: string | null
  searchQuery: string
  statusFilter: LeadStatus | 'all'
  industryFilter: string
  sortBy: 'score' | 'last_activity' | 'name' | 'created_at'
  sortDir: 'asc' | 'desc'
  setSelectedLeadId: (id: string | null) => void
  setSearchQuery: (q: string) => void
  setStatusFilter: (s: LeadStatus | 'all') => void
  setIndustryFilter: (i: string) => void
  setSortBy: (s: LeadsState['sortBy']) => void
  setSortDir: (d: 'asc' | 'desc') => void
  filterLeads: (leads: Lead[]) => Lead[]
}

export const useLeadsStore = create<LeadsState>((set, get) => ({
  selectedLeadId: null,
  searchQuery: '',
  statusFilter: 'all',
  industryFilter: '',
  sortBy: 'score',
  sortDir: 'desc',
  setSelectedLeadId: (id) => set({ selectedLeadId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setStatusFilter: (s) => set({ statusFilter: s }),
  setIndustryFilter: (i) => set({ industryFilter: i }),
  setSortBy: (s) => set({ sortBy: s }),
  setSortDir: (d) => set({ sortDir: d }),
  filterLeads: (leads) => {
    const { searchQuery, statusFilter, industryFilter, sortBy, sortDir } = get()
    let out = [...leads]
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      out = out.filter(l =>
        l.name.toLowerCase().includes(q) ||
        l.company.toLowerCase().includes(q) ||
        l.title.toLowerCase().includes(q) ||
        (l.email ?? '').toLowerCase().includes(q)
      )
    }
    if (statusFilter !== 'all') out = out.filter(l => l.status === statusFilter)
    if (industryFilter) out = out.filter(l => l.industry === industryFilter)
    out.sort((a, b) => {
      let av: string | number = 0, bv: string | number = 0
      if (sortBy === 'score') { av = a.score; bv = b.score }
      else if (sortBy === 'name') { av = a.name; bv = b.name }
      else if (sortBy === 'last_activity') { av = a.last_activity; bv = b.last_activity }
      else if (sortBy === 'created_at') { av = a.created_at; bv = b.created_at }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return out
  },
}))
