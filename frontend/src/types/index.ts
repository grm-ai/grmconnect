// ── Lead ──────────────────────────────────────────────────────────────────────
export type LeadStatus = 'new' | 'contacted' | 'replied' | 'hot' | 'warm' | 'cold' | 'meeting_booked'
export type ConnectionStatus = 'NOT_SENT' | 'PENDING' | 'ACCEPTED' | 'IGNORED'

export interface Lead {
  id: string | number
  name: string
  title: string
  company: string
  email: string | null
  linkedin_url: string | null
  avatar?: string
  status: LeadStatus
  connection_status?: ConnectionStatus
  score: number          // 0-100
  tags: string[]
  location: string
  industry: string
  company_size: string
  last_activity: string  // ISO date
  created_at: string
  campaign_id?: string
  notes?: string
  phone?: string
}

// ── Campaign ──────────────────────────────────────────────────────────────────
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed'

export interface SequenceStep {
  id: string
  type: 'connect' | 'message' | 'follow_up' | 'email' | 'wait'
  delay_days: number
  subject?: string
  body: string
  ai_generated?: boolean
}

export interface Campaign {
  id: string
  name: string
  description: string
  goal?: string
  autopilot?: boolean
  status: CampaignStatus
  target_industry: string
  target_title: string
  daily_limit: number
  sequence: SequenceStep[]
  leads_count: number
  sent_count: number
  reply_count: number
  meeting_count: number
  reply_rate: number
  created_at: string
  updated_at: string
}

// ── Conversation ──────────────────────────────────────────────────────────────
export type MessageSentiment = 'positive' | 'neutral' | 'negative'
export type MessageSender   = 'user' | 'lead'

export interface Message {
  id: string
  conversation_id: string
  sender: MessageSender
  body: string
  sent_at: string
  sentiment?: MessageSentiment
  read: boolean
}

export interface Conversation {
  id: string
  lead: Lead
  campaign_id?: string
  messages: Message[]
  last_message: string
  last_message_at: string
  unread_count: number
  sentiment: MessageSentiment
  intent: 'interested' | 'not_interested' | 'maybe' | 'buying' | 'unknown'
  ai_summary?: string
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export interface DashboardStats {
  total_leads: number
  active_campaigns: number
  replies_received: number
  hot_leads: number
  meetings_booked: number
  conversion_rate: number
}

export interface FunnelData {
  stage: string
  count: number
  percentage: number
  color: string
}

export interface TimeSeriesPoint {
  date: string
  value: number
  label?: string
}

export interface CampaignPerformance {
  name: string
  sent: number
  replies: number
  meetings: number
  reply_rate: number
}

// ── AI ────────────────────────────────────────────────────────────────────────
export type AITone = 'professional' | 'casual' | 'friendly' | 'direct' | 'empathetic'
export type AIAction = 'generate' | 'rewrite' | 'shorten' | 'expand' | 'follow_up'

export interface AIRequest {
  action: AIAction
  lead?: Partial<Lead>
  context?: string
  tone?: AITone
  existing_message?: string
}

export interface AIResponse {
  message: string
  subject?: string
  tokens_used: number
  warning?: string
}

// ── Lead Intelligence ─────────────────────────────────────────────────────────
export interface LeadIntelligence {
  lead_id: string
  company_overview: string
  pain_points: string[]
  buying_signals: string[]
  opportunity_score: number
  recent_news: string[]
  tech_stack: string[]
  competitors: string[]
  ai_insights: string
  updated_at: string
}

// ── Activity ──────────────────────────────────────────────────────────────────
export type ActivityType =
  | 'lead_added'
  | 'message_sent'
  | 'reply_received'
  | 'meeting_booked'
  | 'campaign_started'
  | 'lead_status_changed'
  | 'ai_draft_generated'

export interface Activity {
  id: string
  type: ActivityType
  title: string
  description: string
  lead?: Pick<Lead, 'id' | 'name' | 'avatar' | 'company'>
  created_at: string
}

// ── Settings ──────────────────────────────────────────────────────────────────
export interface Settings {
  openai_api_key: string
  gemini_api_key: string
  webhook_url: string
  webhook_secret: string
  notification_email: boolean
  notification_slack: boolean
  slack_webhook_url: string
  timezone: string
  daily_send_limit: number
}

export interface TeamMember {
  id: string
  name: string
  email: string
  role: 'admin' | 'member' | 'viewer'
  avatar?: string
  joined_at: string
  last_active: string
}
