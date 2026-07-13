import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles, Copy, RefreshCw, Minimize2, Maximize2,
  Wand2, ChevronDown, CheckCheck,
} from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Badge } from './ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { useGenerateAI } from '../hooks/useAI'
import { toast } from 'sonner'
import type { AITone, AIAction, Lead } from '../types'
import { cn } from '../lib/utils'

const TONES: { value: AITone; label: string }[] = [
  { value: 'professional', label: '🎩 Professional' },
  { value: 'casual',       label: '😊 Casual' },
  { value: 'friendly',     label: '🤝 Friendly' },
  { value: 'direct',       label: '⚡ Direct' },
  { value: 'empathetic',   label: '💙 Empathetic' },
]

const ACTIONS: { value: AIAction; label: string; desc: string }[] = [
  { value: 'generate',  label: 'Generate',    desc: 'Create a new personalized outreach message' },
  { value: 'follow_up', label: 'Follow-Up',   desc: 'Write a follow-up message based on context' },
  { value: 'rewrite',   label: 'Rewrite',     desc: 'Rewrite your existing message' },
  { value: 'shorten',   label: 'Shorten',     desc: 'Make it more concise' },
  { value: 'expand',    label: 'Expand',      desc: 'Add more detail and value' },
]

interface AIComposerProps {
  lead?: Lead
  compact?: boolean
}

export function AIComposer({ lead, compact = false }: AIComposerProps) {
  const [action, setAction]       = useState<AIAction>('generate')
  const [tone, setTone]           = useState<AITone>('professional')
  const [context, setContext]     = useState('')
  const [result, setResult]       = useState('')
  const [copied, setCopied]       = useState(false)
  const generate = useGenerateAI()

  async function handleGenerate() {
    const res = await generate.mutateAsync({
      action,
      lead,
      tone,
      context,
      existing_message: action !== 'generate' ? context : undefined,
    })
    setResult(res.message)
    toast.success(`Message generated — ${res.tokens_used} tokens used`)
  }

  function handleCopy() {
    navigator.clipboard.writeText(result)
    setCopied(true)
    toast.success('Copied to clipboard!')
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card className={cn('flex flex-col', compact ? 'h-full' : '')}>
      <CardHeader className={cn('pb-3', compact && 'p-4 pb-2')}>
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          AI Composer
          <Badge variant="purple" className="text-[10px] ml-auto">GPT-4o</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className={cn('flex-1 flex flex-col gap-3', compact && 'p-4 pt-0')}>
        {/* Action + Tone row */}
        <div className="flex gap-2">
          <Select value={action} onValueChange={(v) => setAction(v as AIAction)}>
            <SelectTrigger className="flex-1 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTIONS.map(a => (
                <SelectItem key={a.value} value={a.value} className="text-xs">
                  <div>
                    <div className="font-medium">{a.label}</div>
                    <div className="text-muted-foreground text-[10px]">{a.desc}</div>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={tone} onValueChange={(v) => setTone(v as AITone)}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map(t => (
                <SelectItem key={t.value} value={t.value} className="text-xs">{t.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Lead context chip */}
        {lead && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 bg-primary/10 rounded-lg">
            <Sparkles className="w-3 h-3 text-primary" />
            <span className="text-xs text-primary font-medium">
              Personalizing for {lead.name} at {lead.company}
            </span>
          </div>
        )}

        {/* Context input */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {action === 'generate' ? 'Context / talking points (optional)' : 'Paste message to improve'}
          </label>
          <Textarea
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder={
              action === 'generate'
                ? 'e.g. "Focus on their recent funding round and team growth..."'
                : 'Paste your existing message here...'
            }
            className="h-20 text-xs"
          />
        </div>

        {/* Generate button */}
        <Button
          onClick={handleGenerate}
          loading={generate.isPending}
          className="w-full h-9"
          variant="gradient"
        >
          <Wand2 className="w-4 h-4 mr-2" />
          {generate.isPending ? 'Generating...' : 'Generate with AI'}
        </Button>

        {/* Result */}
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="space-y-2"
            >
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">Generated Message</label>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={handleGenerate}
                    disabled={generate.isPending}
                  >
                    <RefreshCw className="w-3 h-3" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy}>
                    {copied ? <CheckCheck className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
              </div>
              <Textarea
                value={result}
                onChange={e => setResult(e.target.value)}
                className="h-36 text-xs leading-relaxed"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  )
}
