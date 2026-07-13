import React, { useState } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import {
  Plus, Grip, Trash2, Sparkles, Link2, MessageSquare,
  Clock, Mail, ArrowDown,
} from 'lucide-react'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'
import { Input } from './ui/input'
import { Badge } from './ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { useGenerateAI } from '../hooks/useAI'
import { generateId } from '../lib/utils'
import type { SequenceStep } from '../types'
import { toast } from 'sonner'
import { cn } from '../lib/utils'

const STEP_TYPES: Record<SequenceStep['type'], { icon: React.ReactNode; label: string; color: string }> = {
  connect:    { icon: <Link2 className="w-3.5 h-3.5" />,       label: 'Connect',   color: 'bg-blue-500/10 text-blue-500' },
  message:    { icon: <MessageSquare className="w-3.5 h-3.5" />, label: 'Message', color: 'bg-amber-500/10 text-amber-500' },
  follow_up:  { icon: <ArrowDown className="w-3.5 h-3.5" />,   label: 'Follow-Up', color: 'bg-orange-500/10 text-orange-500' },
  email:      { icon: <Mail className="w-3.5 h-3.5" />,        label: 'Email',     color: 'bg-emerald-500/10 text-emerald-500' },
  wait:       { icon: <Clock className="w-3.5 h-3.5" />,       label: 'Wait',      color: 'bg-muted text-muted-foreground' },
}

interface SequenceEditorProps {
  steps: SequenceStep[]
  onChange: (steps: SequenceStep[]) => void
}

export function SequenceEditor({ steps, onChange }: SequenceEditorProps) {
  const generateAI = useGenerateAI()

  function addStep(type: SequenceStep['type']) {
    onChange([...steps, {
      id: generateId(),
      type,
      delay_days: type === 'wait' ? 3 : 0,
      body: '',
    }])
  }

  function removeStep(id: string) {
    onChange(steps.filter(s => s.id !== id))
  }

  function updateStep(id: string, patch: Partial<SequenceStep>) {
    onChange(steps.map(s => s.id === id ? { ...s, ...patch } : s))
  }

  async function generateForStep(id: string, type: SequenceStep['type']) {
    const action = type === 'follow_up' ? 'follow_up' : 'generate'
    const res = await generateAI.mutateAsync({ action, tone: 'professional' })
    updateStep(id, { body: res.message, ai_generated: true })
    toast.success('AI message generated!')
  }

  return (
    <div className="space-y-2">
      <Reorder.Group axis="y" values={steps} onReorder={onChange} className="space-y-2">
        {steps.map((step, i) => {
          const cfg = STEP_TYPES[step.type]
          return (
            <Reorder.Item key={step.id} value={step}>
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="border border-border rounded-xl bg-card overflow-hidden"
              >
                {/* Step header */}
                <div className="flex items-center gap-2.5 px-3 py-2 bg-muted/30 border-b border-border">
                  <button className="cursor-grab active:cursor-grabbing text-muted-foreground">
                    <Grip className="w-3.5 h-3.5" />
                  </button>
                  <div className={cn('flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium', cfg.color)}>
                    {cfg.icon}
                    Step {i + 1}: {cfg.label}
                  </div>
                  {step.ai_generated && (
                    <Badge variant="purple" className="text-[10px] px-1.5 py-0 h-4">
                      <Sparkles className="w-2.5 h-2.5 mr-1" />
                      AI
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {step.type !== 'wait' && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>Day</span>
                        <Input
                          type="number"
                          value={step.delay_days}
                          onChange={e => updateStep(step.id, { delay_days: parseInt(e.target.value) || 0 })}
                          className="w-12 h-6 text-xs text-center"
                          min={0}
                        />
                      </div>
                    )}
                    {step.type !== 'connect' && step.type !== 'wait' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => generateForStep(step.id, step.type)}
                        disabled={generateAI.isPending}
                      >
                        <Sparkles className="w-3 h-3 text-primary" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive"
                      onClick={() => removeStep(step.id)}
                    >
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>

                {/* Step body */}
                {step.type === 'wait' ? (
                  <div className="px-3 py-2.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Wait</span>
                    <Input
                      type="number"
                      value={step.delay_days}
                      onChange={e => updateStep(step.id, { delay_days: parseInt(e.target.value) || 1 })}
                      className="w-14 h-6 text-xs text-center"
                      min={1}
                    />
                    <span>days before next step</span>
                  </div>
                ) : (
                  <div className="p-3">
                    <Textarea
                      value={step.body}
                      onChange={e => updateStep(step.id, { body: e.target.value })}
                      placeholder={`Write your ${cfg.label.toLowerCase()} message... Use {{first_name}}, {{company}} for personalization.`}
                      className="h-24 text-xs"
                    />
                  </div>
                )}
              </motion.div>
            </Reorder.Item>
          )
        })}
      </Reorder.Group>

      {/* Add step */}
      <div className="flex flex-wrap gap-2 pt-1">
        {(Object.keys(STEP_TYPES) as SequenceStep['type'][]).map(type => (
          <Button
            key={type}
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1.5"
            onClick={() => addStep(type)}
          >
            <Plus className="w-3 h-3" />
            {STEP_TYPES[type].label}
          </Button>
        ))}
      </div>
    </div>
  )
}
