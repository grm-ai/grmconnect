import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIState {
  sidebarCollapsed: boolean
  theme: 'light' | 'dark' | 'system'
  notificationPanelOpen: boolean
  setSidebarCollapsed: (v: boolean) => void
  toggleSidebar: () => void
  setTheme: (t: 'light' | 'dark' | 'system') => void
  toggleTheme: () => void
  setNotificationPanelOpen: (v: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarCollapsed: false,
      theme: 'dark',
      notificationPanelOpen: false,
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setTheme: (theme) => set({ theme }),
      toggleTheme: () => {
        const current = get().theme
        set({ theme: current === 'dark' ? 'light' : 'dark' })
      },
      setNotificationPanelOpen: (v) => set({ notificationPanelOpen: v }),
    }),
    { name: 'leadpilot-ui' }
  )
)
