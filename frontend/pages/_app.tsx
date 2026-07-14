import type { AppProps } from 'next/app'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useEffect, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { Toaster } from 'sonner'
import { NotificationCenter } from '../src/components/NotificationCenter'
import { installFetchAuth, isAuthed } from '../src/lib/auth'
import '../styles/globals.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})

const PUBLIC_ROUTES = ['/', '/login', '/signup']

// Installs the fetch auth patch (runs during render, before children fire queries) and
// redirects unauthenticated users to /login for any non-public page.
function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const isPublic = PUBLIC_ROUTES.includes(router.pathname)
  // Public pages (login/signup) render immediately (incl. SSR); protected pages wait until we've
  // confirmed a token client-side, else redirect to /login.
  const [allowed, setAllowed] = useState(isPublic)

  if (typeof window !== 'undefined') installFetchAuth()

  useEffect(() => {
    if (isPublic) { setAllowed(true); return }
    if (!isAuthed()) { setAllowed(false); router.replace('/login') }
    else setAllowed(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.pathname])

  if (!allowed) return null
  return <>{children}</>
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <Head>
        <title>GRM Connect</title>
        <meta name="description" content="Turn LinkedIn into a meeting-booking machine — AI-powered outreach on autopilot." />
        <link rel="icon" type="image/png" href="/logo.png" />
      </Head>
      <AuthGate>
        <Component {...pageProps} />
      </AuthGate>
      <NotificationCenter />
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: 'bg-card border border-border text-foreground',
            title: 'text-foreground font-medium',
            description: 'text-muted-foreground text-sm',
          },
        }}
      />
      {process.env.NODE_ENV === 'development' && (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
      )}
    </QueryClientProvider>
  )
}
