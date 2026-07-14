import React, { useState } from 'react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import { Sparkles, Mail, Lock, User as UserIcon, Loader2, Eye, EyeOff } from 'lucide-react'
import { Button } from '../src/components/ui/button'
import { Input } from '../src/components/ui/input'
import { Label } from '../src/components/ui/label'
import { apiSignup, setAuth } from '../src/lib/auth'
import { toast } from 'sonner'

export default function SignupPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { toast.error('Email and password required'); return }
    if (password.length < 6) { toast.error('Password must be at least 6 characters'); return }
    setLoading(true)
    try {
      const { token, user } = await apiSignup(email.trim(), password, name.trim() || undefined)
      setAuth(token, user)
      qc.clear()  // fresh account → no stale cache
      toast.success('Account created — welcome!')
      router.replace('/dashboard')
    } catch (err: any) {
      toast.error(err?.message ?? 'Signup failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-sm"
      >
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl gradient-brand mx-auto flex items-center justify-center mb-3">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-bold">Create your account</h1>
          <p className="text-sm text-muted-foreground mt-1">Start automating your outreach</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 bg-card border border-border rounded-2xl p-6">
          <div className="space-y-1.5">
            <Label className="text-xs">Name</Label>
            <div className="relative">
              <UserIcon className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" className="h-10 pl-9 text-sm" autoComplete="name" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Email</Label>
            <div className="relative">
              <Mail className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@email.com" className="h-10 pl-9 text-sm" autoComplete="email" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Password</Label>
            <div className="relative">
              <Lock className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} placeholder="At least 6 characters" className="h-10 pl-9 pr-9 text-sm" autoComplete="new-password" />
              <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? 'Hide password' : 'Show password'} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <Button type="submit" variant="gradient" className="w-full h-10 gap-2" disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {loading ? 'Creating…' : 'Create account'}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            Already have an account?{' '}
            <Link href="/login" className="text-primary font-medium hover:underline">Log in</Link>
          </p>
        </form>
      </motion.div>
    </div>
  )
}
