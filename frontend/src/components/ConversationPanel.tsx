import React, { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Send, Sparkles, Brain, ThumbsUp, ThumbsDown, Minus,
  TrendingUp, AlertCircle, CheckCircle,
} from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Badge } from './ui/badge'
import { ScrollArea } from './ui/scroll-area'
import { Separator } from './ui/separator'
import { useSendMessage } from '../hooks/useConversations'
import { useGenerateAI } from '../hooks/useAI'
import { formatRelativeTime, getInitials } from '../lib/utils'
import type { Conversation, MessageSentiment } from '../types'
import { toast } from 'sonner'
import { cn } from '../lib/utils'

const SENTIMENT_CONFIG: Record<MessageSentiment, { icon: React.ReactNode; label: string; color: string }> = {
  positive: { icon: <ThumbsUp className="w-3 h-3" />,  label: 'Positive',  color: 'text-emerald-500' },
  neutral:  { icon: <Minus className="w-3 h-3" />,     label: 'Neutral',   color: 'text-yellow-500' },
  negative: { icon: <ThumbsDown className="w-3 h-3" />, label: 'Negative', color: 'text-red-500' },
}

const INTENT_CONFIG = {
  interested:      { label: 'Interested',      variant: 'success' as const },
  buying:          { label: '🔥 Buying Intent', variant: 'hot' as const },
  maybe:           { label: 'Maybe',           variant: 'warning' as const },
  not_interested:  { label: 'Not Interested',  variant: 'destructive' as const },
  unknown:         { label: 'Unknown',         variant: 'secondary' as const },
}

interface ConversationPanelProps {
  conversation: Conversation
}

export function ConversationPanel({ conversation }: ConversationPanelProps) {
  const [draft, setDraft] = useState('')
  const [showAISuggest, setShowAISuggest] = useState(false)
  const sendMessage = useSendMessage()
  const generateAI = useGenerateAI()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [conversation.messages])

  async function handleSend() {
    if (!draft.trim()) return
    await sendMessage.mutateAsync({ convId: conversation.id, body: draft })
    setDraft('')
    toast.success('Message sent')
  }

  async function handleAISuggest() {
    const res = await generateAI.mutateAsync({
      action: 'follow_up',
      lead: conversation.lead,
      context: conversation.messages.slice(-2).map(m => `${m.sender}: ${m.body}`).join('\n'),
    })
    setDraft(res.message)
    setShowAISuggest(false)
  }

  const sentimentCfg = SENTIMENT_CONFIG[conversation.sentiment]
  const intentCfg = INTENT_CONFIG[conversation.intent]

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border shrink-0 bg-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Avatar className="w-9 h-9">
              <AvatarFallback>{getInitials(conversation.lead.name)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-sm font-semibold">{conversation.lead.name}</p>
              <p className="text-xs text-muted-foreground">{conversation.lead.title} · {conversation.lead.company}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={intentCfg.variant} className="text-[10px]">{intentCfg.label}</Badge>
            <div className={cn('flex items-center gap-1 text-xs font-medium', sentimentCfg.color)}>
              {sentimentCfg.icon}
              <span>{sentimentCfg.label}</span>
            </div>
          </div>
        </div>

        {/* AI Summary */}
        {conversation.ai_summary && (
          <div className="mt-3 flex gap-2 bg-primary/10 rounded-lg p-2.5">
            <Brain className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <p className="text-[11px] text-primary/90 leading-relaxed">{conversation.ai_summary}</p>
          </div>
        )}
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4 py-3">
        <div className="space-y-4">
          {conversation.messages.map((msg, i) => {
            const isUser = msg.sender === 'user'
            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03 }}
                className={cn('flex gap-2.5', isUser && 'flex-row-reverse')}
              >
                {!isUser && (
                  <Avatar className="w-7 h-7 shrink-0 mt-1">
                    <AvatarFallback className="text-[10px]">{getInitials(conversation.lead.name)}</AvatarFallback>
                  </Avatar>
                )}
                <div className={cn('max-w-[75%] space-y-1', isUser && 'items-end')}>
                  <div className={cn(
                    'rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed',
                    isUser
                      ? 'bg-primary text-primary-foreground rounded-tr-sm'
                      : 'bg-muted rounded-tl-sm'
                  )}>
                    {msg.body}
                  </div>
                  <div className={cn('flex items-center gap-1.5', isUser && 'justify-end')}>
                    <span className="text-[10px] text-muted-foreground">{formatRelativeTime(msg.sent_at)}</span>
                    {msg.sentiment && !isUser && (
                      <span className={cn('text-[10px]', SENTIMENT_CONFIG[msg.sentiment].color)}>
                        · {SENTIMENT_CONFIG[msg.sentiment].label}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            )
          })}
        </div>
        <div ref={bottomRef} />
      </ScrollArea>

      {/* Compose */}
      <div className="border-t border-border px-4 py-3 space-y-2 shrink-0">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Write a message..."
          className="min-h-[72px] text-xs resize-none"
          onKeyDown={e => {
            if (e.key === 'Enter' && e.metaKey) handleSend()
          }}
        />
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs gap-1.5"
            onClick={handleAISuggest}
            loading={generateAI.isPending}
          >
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            AI Suggest
          </Button>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground hidden sm:block">⌘↵ to send</span>
            <Button
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={handleSend}
              loading={sendMessage.isPending}
              disabled={!draft.trim()}
            >
              <Send className="w-3.5 h-3.5" />
              Send
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
