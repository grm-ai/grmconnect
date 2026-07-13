import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Search, MessageSquare, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Layout } from '../src/components/layout/Layout'
import { ConversationPanel } from '../src/components/ConversationPanel'
import { Avatar, AvatarFallback } from '../src/components/ui/avatar'
import { Badge } from '../src/components/ui/badge'
import { Button } from '../src/components/ui/button'
import { Input } from '../src/components/ui/input'
import { Skeleton } from '../src/components/ui/skeleton'
import { useConversations } from '../src/hooks/useConversations'
import { formatRelativeTime, getInitials } from '../src/lib/utils'
import type { Conversation } from '../src/types'
import { cn } from '../src/lib/utils'

const INTENT_COLORS: Record<string, string> = {
  buying:         'text-red-500',
  interested:     'text-emerald-500',
  maybe:          'text-yellow-500',
  not_interested: 'text-muted-foreground',
  unknown:        'text-muted-foreground',
}

const SENTIMENT_COLORS: Record<string, string> = {
  positive: 'bg-emerald-500',
  neutral:  'bg-yellow-500',
  negative: 'bg-red-500',
}

export default function ConversationsPage() {
  const { data: conversations, isLoading } = useConversations()
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [fetching, setFetching] = useState(false)

  async function fetchInbox() {
    setFetching(true)
    try {
      const result = await new Promise<any>((resolve) => {
        const onResult = (e: Event) => {
          window.removeEventListener('leadpilot-fetch-inbox-result', onResult)
          resolve((e as CustomEvent).detail || {})
        }
        window.addEventListener('leadpilot-fetch-inbox-result', onResult)
        window.dispatchEvent(new CustomEvent('leadpilot-fetch-inbox'))
        setTimeout(() => { window.removeEventListener('leadpilot-fetch-inbox-result', onResult); resolve({ success: false, error: 'timeout' }) }, 60000)
      })
      if (result?.success) {
        qc.invalidateQueries({ queryKey: ['conversations'] })
        toast.success(`Inbox synced — ${result.added ?? 0} new message(s) across ${result.matched_threads ?? 0} conversation(s).`)
      } else {
        toast.error(result?.error || 'Could not fetch inbox. Make sure a LinkedIn tab is open and logged in.')
      }
    } finally {
      setFetching(false)
    }
  }

  const filtered = conversations?.filter(c =>
    c.lead.name.toLowerCase().includes(search.toLowerCase()) ||
    c.lead.company.toLowerCase().includes(search.toLowerCase()) ||
    c.last_message.toLowerCase().includes(search.toLowerCase())
  ) ?? []

  const selected = conversations?.find(c => c.id === selectedId) ?? null

  return (
    <Layout>
      <div className="flex h-[calc(100vh-56px)] overflow-hidden">
        {/* Sidebar list */}
        <div className="w-72 shrink-0 flex flex-col border-r border-border bg-card overflow-hidden">
          <div className="px-3 py-3 border-b border-border space-y-2">
            <Button
              size="sm"
              className="h-8 w-full text-xs gap-1.5"
              onClick={fetchInbox}
              disabled={fetching}
              title="Pull your LinkedIn conversations for these leads into the inbox"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${fetching ? 'animate-spin' : ''}`} />
              {fetching ? 'Fetching inbox…' : 'Fetch Inbox'}
            </Button>
            <Input
              placeholder="Search conversations..."
              icon={<Search className="w-3.5 h-3.5" />}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-border">
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-3 px-3 py-3">
                    <Skeleton className="w-9 h-9 rounded-full shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-2.5 w-full" />
                    </div>
                  </div>
                ))
              : filtered.map((conv, i) => (
                  <motion.div
                    key={conv.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    onClick={() => setSelectedId(conv.id)}
                    className={cn(
                      'flex gap-3 px-3 py-3 cursor-pointer transition-colors',
                      conv.id === selectedId ? 'bg-primary/10' : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="relative shrink-0">
                      <Avatar className="w-9 h-9">
                        <AvatarFallback className="text-xs">{getInitials(conv.lead.name)}</AvatarFallback>
                      </Avatar>
                      <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-card ${SENTIMENT_COLORS[conv.sentiment]}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <p className="text-xs font-semibold truncate">{conv.lead.name}</p>
                        <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeTime(conv.last_message_at)}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate">{conv.lead.company}</p>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{conv.last_message}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-[10px] font-medium ${INTENT_COLORS[conv.intent]}`}>
                          {conv.intent.replace('_', ' ')}
                        </span>
                        {conv.unread_count > 0 && (
                          <Badge variant="hot" className="text-[10px] px-1 py-0 h-4 ml-auto">{conv.unread_count}</Badge>
                        )}
                      </div>
                    </div>
                  </motion.div>
                ))
            }
          </div>
        </div>

        {/* Conversation panel */}
        <div className="flex-1 overflow-hidden">
          {selected ? (
            <ConversationPanel conversation={selected} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <MessageSquare className="w-12 h-12 text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">Select a conversation</p>
              <p className="text-xs text-muted-foreground mt-1">Choose a conversation from the list to view messages</p>
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
