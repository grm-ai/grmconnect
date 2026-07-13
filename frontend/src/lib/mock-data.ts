import type {
  Lead, Campaign, Conversation, Message, Activity,
  DashboardStats, FunnelData, TimeSeriesPoint, CampaignPerformance,
  LeadIntelligence, TeamMember, Settings,
} from '../types'

// ── Leads ─────────────────────────────────────────────────────────────────────
export const MOCK_LEADS: Lead[] = [
  { id: 'l1', name: 'Sarah Chen', title: 'VP of Engineering', company: 'Datawave Inc', email: 'sarah@datawave.io', linkedin_url: 'https://linkedin.com/in/sarahchen', status: 'hot', score: 92, tags: ['SaaS', 'Enterprise'], location: 'San Francisco, CA', industry: 'Technology', company_size: '201-500', last_activity: '2026-06-17T10:30:00Z', created_at: '2026-05-20T08:00:00Z', campaign_id: 'c1', notes: 'Very interested in AI automation features' },
  { id: 'l2', name: 'Marcus Johnson', title: 'CTO', company: 'BuildRight Solutions', email: 'marcus@buildright.com', linkedin_url: 'https://linkedin.com/in/marcusjohnson', status: 'replied', score: 78, tags: ['Construction Tech', 'Mid-Market'], location: 'Austin, TX', industry: 'Construction', company_size: '51-200', last_activity: '2026-06-16T14:00:00Z', created_at: '2026-05-22T09:00:00Z', campaign_id: 'c1' },
  { id: 'l3', name: 'Priya Kapoor', title: 'Head of Growth', company: 'FinFlow AI', email: 'priya@finflow.ai', linkedin_url: 'https://linkedin.com/in/priyakapoor', status: 'meeting_booked', score: 95, tags: ['FinTech', 'AI', 'Series B'], location: 'New York, NY', industry: 'Financial Services', company_size: '51-200', last_activity: '2026-06-17T09:00:00Z', created_at: '2026-05-18T11:00:00Z', campaign_id: 'c2' },
  { id: 'l4', name: 'Tom Rivera', title: 'Director of Sales', company: 'CloudEdge Corp', email: 'tom@cloudedge.com', linkedin_url: null, status: 'contacted', score: 55, tags: ['Cloud', 'B2B SaaS'], location: 'Seattle, WA', industry: 'Technology', company_size: '201-500', last_activity: '2026-06-14T16:00:00Z', created_at: '2026-06-01T10:00:00Z', campaign_id: 'c2' },
  { id: 'l5', name: 'Amanda Wells', title: 'Founder & CEO', company: 'NurtureBot', email: 'amanda@nurturebot.co', linkedin_url: 'https://linkedin.com/in/amandawells', status: 'warm', score: 67, tags: ['AI', 'Startup', 'Seed'], location: 'Boston, MA', industry: 'Marketing Tech', company_size: '1-10', last_activity: '2026-06-15T12:00:00Z', created_at: '2026-06-03T08:30:00Z' },
  { id: 'l6', name: 'David Kim', title: 'SVP Product', company: 'MedSynth', email: 'dkim@medsynth.com', linkedin_url: 'https://linkedin.com/in/davidkim', status: 'new', score: 43, tags: ['HealthTech', 'Enterprise'], location: 'Chicago, IL', industry: 'Healthcare', company_size: '501-1000', last_activity: '2026-06-17T08:00:00Z', created_at: '2026-06-17T08:00:00Z' },
  { id: 'l7', name: 'Elena Russo', title: 'Marketing Director', company: 'Growthly', email: 'elena@growthly.com', linkedin_url: 'https://linkedin.com/in/elenarusso', status: 'cold', score: 28, tags: ['Marketing', 'SMB'], location: 'Miami, FL', industry: 'Marketing', company_size: '11-50', last_activity: '2026-05-30T10:00:00Z', created_at: '2026-05-15T14:00:00Z' },
  { id: 'l8', name: 'James Park', title: 'Head of Operations', company: 'LogiTrack', email: 'james@logitrack.io', linkedin_url: 'https://linkedin.com/in/jamespark', status: 'replied', score: 71, tags: ['Logistics', 'Operations'], location: 'Denver, CO', industry: 'Logistics', company_size: '51-200', last_activity: '2026-06-16T11:00:00Z', created_at: '2026-05-28T09:00:00Z', campaign_id: 'c1' },
  { id: 'l9', name: 'Nicole Brown', title: 'CEO', company: 'RetailIQ', email: 'nicole@retailiq.com', linkedin_url: 'https://linkedin.com/in/nicolebrown', status: 'hot', score: 88, tags: ['Retail Tech', 'Series A'], location: 'Los Angeles, CA', industry: 'Retail', company_size: '11-50', last_activity: '2026-06-17T07:30:00Z', created_at: '2026-06-05T10:00:00Z', campaign_id: 'c3' },
  { id: 'l10', name: 'Ryan Foster', title: 'VP Engineering', company: 'SecureVault', email: null, linkedin_url: 'https://linkedin.com/in/ryanfoster', status: 'contacted', score: 51, tags: ['CyberSec', 'Enterprise'], location: 'Washington, DC', industry: 'Cybersecurity', company_size: '201-500', last_activity: '2026-06-13T15:00:00Z', created_at: '2026-06-08T11:00:00Z', campaign_id: 'c2' },
  { id: 'l11', name: 'Lisa Tang', title: 'Product Manager', company: 'AgriTech Pro', email: 'lisa@agritechpro.com', linkedin_url: 'https://linkedin.com/in/lisatang', status: 'new', score: 38, tags: ['AgriTech', 'IoT'], location: 'Minneapolis, MN', industry: 'Agriculture', company_size: '51-200', last_activity: '2026-06-17T06:00:00Z', created_at: '2026-06-17T06:00:00Z' },
  { id: 'l12', name: 'Carlos Mendez', title: 'CRO', company: 'SalesForce Next', email: 'carlos@sfnext.com', linkedin_url: 'https://linkedin.com/in/carlosmendez', status: 'meeting_booked', score: 97, tags: ['Sales Tech', 'Enterprise', 'Hot'], location: 'San Jose, CA', industry: 'Technology', company_size: '1001+', last_activity: '2026-06-16T16:00:00Z', created_at: '2026-05-10T09:00:00Z', campaign_id: 'c3' },
]

// ── Campaigns ─────────────────────────────────────────────────────────────────
export const MOCK_CAMPAIGNS: Campaign[] = [
  {
    id: 'c1', name: 'Q2 Enterprise Outreach', description: 'Targeting VP+ at SaaS companies with 50-500 employees', status: 'active',
    target_industry: 'Technology', target_title: 'VP Engineering / CTO', daily_limit: 25,
    sequence: [
      { id: 's1', type: 'connect', delay_days: 0, body: 'Hi {{first_name}}, I noticed your work at {{company}} and would love to connect. We help engineering leaders automate their outreach workflows.' },
      { id: 's2', type: 'message', delay_days: 3, body: "Hi {{first_name}}, thanks for connecting! I wanted to share how we've helped similar companies like yours reduce manual prospecting by 70%. Would you be open to a quick 15-min chat?", ai_generated: true },
      { id: 's3', type: 'follow_up', delay_days: 7, body: "Hey {{first_name}}, just following up on my last message. I know things get busy — is there a better time this week to connect?", ai_generated: true },
      { id: 's4', type: 'wait', delay_days: 14, body: '' },
      { id: 's5', type: 'follow_up', delay_days: 0, body: 'Hi {{first_name}}, I wanted to reach out one more time. If now isn\'t a great time, totally understand! Feel free to reach out whenever the timing is right.' },
    ],
    leads_count: 145, sent_count: 98, reply_count: 22, meeting_count: 6, reply_rate: 22.4,
    created_at: '2026-05-01T10:00:00Z', updated_at: '2026-06-10T14:00:00Z',
  },
  {
    id: 'c2', name: 'FinTech Decision Makers', description: 'CTOs and heads of product at fintech companies', status: 'active',
    target_industry: 'Financial Services', target_title: 'CTO / Head of Product', daily_limit: 20,
    sequence: [
      { id: 's6', type: 'connect', delay_days: 0, body: 'Hi {{first_name}}, your recent work on {{company}}\'s product expansion caught my eye. Would love to connect!' },
      { id: 's7', type: 'message', delay_days: 4, body: "Thanks for connecting {{first_name}}! I help fintech leaders like yourself scale outbound without scaling headcount. Mind if I share a quick case study?", ai_generated: true },
      { id: 's8', type: 'follow_up', delay_days: 10, body: "Hi {{first_name}}, circling back — many of our fintech clients saw a 3x increase in qualified meetings within 60 days. Happy to show you how. 15 minutes?", ai_generated: true },
    ],
    leads_count: 89, sent_count: 63, reply_count: 14, meeting_count: 4, reply_rate: 22.2,
    created_at: '2026-05-15T09:00:00Z', updated_at: '2026-06-12T11:00:00Z',
  },
  {
    id: 'c3', name: 'Startup Founders — Series A/B', description: 'Founders and co-founders at post-series A startups', status: 'paused',
    target_industry: 'Startup', target_title: 'Founder / Co-Founder / CEO', daily_limit: 15,
    sequence: [
      { id: 's9', type: 'connect', delay_days: 0, body: 'Hi {{first_name}}, congrats on the recent funding round! Building something impressive at {{company}}.' },
      { id: 's10', type: 'message', delay_days: 3, body: "Hey {{first_name}}, I help funded startups like {{company}} build their outbound engine fast. After raising, outbound becomes critical — want to see how we do it?", ai_generated: true },
    ],
    leads_count: 62, sent_count: 41, reply_count: 11, meeting_count: 3, reply_rate: 26.8,
    created_at: '2026-04-20T10:00:00Z', updated_at: '2026-06-01T09:00:00Z',
  },
  {
    id: 'c4', name: 'Healthcare IT Leaders', description: 'Targeting IT and product decision-makers at health systems', status: 'draft',
    target_industry: 'Healthcare', target_title: 'CIO / VP Technology', daily_limit: 10,
    sequence: [
      { id: 's11', type: 'connect', delay_days: 0, body: 'Hi {{first_name}}, the digital transformation work happening at {{company}} is genuinely impressive. Would love to connect.' },
    ],
    leads_count: 0, sent_count: 0, reply_count: 0, meeting_count: 0, reply_rate: 0,
    created_at: '2026-06-15T14:00:00Z', updated_at: '2026-06-15T14:00:00Z',
  },
]

// ── Conversations ──────────────────────────────────────────────────────────────
const makeMessages = (convId: string, msgs: Partial<Message>[]): Message[] =>
  msgs.map((m, i) => ({
    id: `${convId}-m${i}`,
    conversation_id: convId,
    sender: m.sender ?? 'user',
    body: m.body ?? '',
    sent_at: m.sent_at ?? new Date(Date.now() - (msgs.length - i) * 3600000 * 24).toISOString(),
    sentiment: m.sentiment,
    read: true,
  }))

export const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: 'cv1', lead: MOCK_LEADS[0], campaign_id: 'c1',
    messages: makeMessages('cv1', [
      { sender: 'user', body: 'Hi Sarah, I noticed your work at Datawave and would love to connect. We help engineering leaders automate their outreach workflows.', sent_at: '2026-06-10T10:00:00Z' },
      { sender: 'lead', body: "Hey! Thanks for reaching out. Datawave is actually exploring automation tools right now. What specifically do you offer?", sent_at: '2026-06-11T09:30:00Z', sentiment: 'positive' },
      { sender: 'user', body: "Great timing! We offer AI-powered LinkedIn outreach automation with personalized message generation, sequence management, and analytics. I'd love to show you a quick demo. Are you free this week?", sent_at: '2026-06-11T10:00:00Z' },
      { sender: 'lead', body: "Absolutely! Thursday at 2pm PST works for me. Can you send a calendar invite?", sent_at: '2026-06-12T14:00:00Z', sentiment: 'positive' },
    ]),
    last_message: 'Absolutely! Thursday at 2pm PST works for me. Can you send a calendar invite?',
    last_message_at: '2026-06-12T14:00:00Z',
    unread_count: 0, sentiment: 'positive', intent: 'buying',
    ai_summary: 'Sarah is actively evaluating automation tools at Datawave. She responded positively and booked a meeting for Thursday. High buying intent detected.',
  },
  {
    id: 'cv2', lead: MOCK_LEADS[2], campaign_id: 'c2',
    messages: makeMessages('cv2', [
      { sender: 'user', body: 'Hi Priya, your recent work on FinFlow\'s growth strategy caught my eye. Would love to connect!', sent_at: '2026-06-08T09:00:00Z' },
      { sender: 'lead', body: "Hi! Thanks. What is it you do exactly?", sent_at: '2026-06-09T11:00:00Z', sentiment: 'neutral' },
      { sender: 'user', body: "We help growth leaders like you scale outbound efficiently using AI. Would you be open to a 15-min call to see if it could apply to FinFlow?", sent_at: '2026-06-09T11:30:00Z' },
      { sender: 'lead', body: "Sure, let's do it. I have time Monday at 10am EST.", sent_at: '2026-06-10T08:00:00Z', sentiment: 'positive' },
    ]),
    last_message: "Sure, let's do it. I have time Monday at 10am EST.",
    last_message_at: '2026-06-10T08:00:00Z',
    unread_count: 0, sentiment: 'positive', intent: 'buying',
    ai_summary: 'Priya was initially cautious but agreed to a meeting. She\'s interested in scaling FinFlow\'s growth operations.',
  },
  {
    id: 'cv3', lead: MOCK_LEADS[1], campaign_id: 'c1',
    messages: makeMessages('cv3', [
      { sender: 'user', body: 'Hi Marcus, impressive work scaling BuildRight\'s engineering team. Would love to connect.', sent_at: '2026-06-05T10:00:00Z' },
      { sender: 'lead', body: "Thanks for reaching out. What are you selling?", sent_at: '2026-06-06T09:00:00Z', sentiment: 'neutral' },
      { sender: 'user', body: "Ha, fair question! We help CTOs automate their sales outreach so engineering leaders can focus on building. Mind if I share a 2-min video?", sent_at: '2026-06-06T09:30:00Z' },
      { sender: 'lead', body: "Sure send it over.", sent_at: '2026-06-07T13:00:00Z', sentiment: 'neutral' },
      { sender: 'user', body: "Here's the overview: [link]. Happy to walk through it live if helpful!", sent_at: '2026-06-07T14:00:00Z' },
      { sender: 'lead', body: "Watched it. Interesting. We might have budget for this in Q3. Can you send pricing?", sent_at: '2026-06-08T10:00:00Z', sentiment: 'positive' },
    ]),
    last_message: 'Watched it. Interesting. We might have budget for this in Q3. Can you send pricing?',
    last_message_at: '2026-06-08T10:00:00Z',
    unread_count: 1, sentiment: 'positive', intent: 'interested',
    ai_summary: 'Marcus is interested but constrained by budget timing. He mentioned Q3 budget and asked for pricing — strong buying signal.',
  },
  {
    id: 'cv4', lead: MOCK_LEADS[7], campaign_id: 'c1',
    messages: makeMessages('cv4', [
      { sender: 'user', body: 'Hi James, I\'d love to connect with you about operational efficiency at LogiTrack.', sent_at: '2026-06-12T10:00:00Z' },
      { sender: 'lead', body: "Hey, sure — always interested in efficiency tools. What do you have?", sent_at: '2026-06-13T09:00:00Z', sentiment: 'positive' },
      { sender: 'user', body: "We specialize in AI-driven outreach automation for ops and sales teams. Quick call this week?", sent_at: '2026-06-13T09:30:00Z' },
      { sender: 'lead', body: "Maybe next week, a bit swamped right now.", sent_at: '2026-06-14T15:00:00Z', sentiment: 'neutral' },
    ]),
    last_message: 'Maybe next week, a bit swamped right now.',
    last_message_at: '2026-06-14T15:00:00Z',
    unread_count: 0, sentiment: 'neutral', intent: 'maybe',
    ai_summary: 'James is interested but not urgent. Follow up next week with a concrete value proposition.',
  },
  {
    id: 'cv5', lead: MOCK_LEADS[8], campaign_id: 'c3',
    messages: makeMessages('cv5', [
      { sender: 'user', body: 'Nicole, congrats on the Series A! RetailIQ is doing amazing things in the space.', sent_at: '2026-06-14T09:00:00Z' },
      { sender: 'lead', body: "Thank you! It's been a wild ride. What brings you to my inbox? 😄", sent_at: '2026-06-14T11:00:00Z', sentiment: 'positive' },
      { sender: 'user', body: "We help post-funding founders build their outbound machine quickly. After raising, every week counts. Want to see how we accelerate this for founders like you?", sent_at: '2026-06-14T11:30:00Z' },
      { sender: 'lead', body: "Definitely! This is timely — we just hired our first SDR. Send me something to review before we talk.", sent_at: '2026-06-15T08:00:00Z', sentiment: 'positive' },
      { sender: 'user', body: "Perfect! Here's a one-pager: [link]. I'll also send a calendar link for whenever works for you.", sent_at: '2026-06-15T09:00:00Z' },
    ]),
    last_message: "Perfect! Here's a one-pager: [link]. I'll also send a calendar link for whenever works for you.",
    last_message_at: '2026-06-15T09:00:00Z',
    unread_count: 0, sentiment: 'positive', intent: 'buying',
    ai_summary: 'Nicole is highly engaged post-Series A. She hired her first SDR and is actively evaluating outbound tools. Extremely high intent.',
  },
]

// ── Activities ────────────────────────────────────────────────────────────────
export const MOCK_ACTIVITIES: Activity[] = [
  { id: 'a1', type: 'meeting_booked', title: 'Meeting Booked', description: 'Priya Kapoor booked a demo for Monday 10am', lead: { id: 'l3', name: 'Priya Kapoor', company: 'FinFlow AI' }, created_at: '2026-06-17T09:00:00Z' },
  { id: 'a2', type: 'reply_received', title: 'New Reply', description: 'Sarah Chen replied — high buying intent detected', lead: { id: 'l1', name: 'Sarah Chen', company: 'Datawave Inc' }, created_at: '2026-06-17T08:30:00Z' },
  { id: 'a3', type: 'lead_added', title: 'New Leads Imported', description: '24 leads imported from LinkedIn Sales Navigator', created_at: '2026-06-17T08:00:00Z' },
  { id: 'a4', type: 'ai_draft_generated', title: 'AI Draft Generated', description: 'Follow-up messages generated for Q2 Enterprise Outreach', created_at: '2026-06-16T17:00:00Z' },
  { id: 'a5', type: 'reply_received', title: 'New Reply', description: 'Marcus Johnson replied asking for pricing info', lead: { id: 'l2', name: 'Marcus Johnson', company: 'BuildRight Solutions' }, created_at: '2026-06-16T14:00:00Z' },
  { id: 'a6', type: 'campaign_started', title: 'Campaign Activated', description: 'Q2 Enterprise Outreach campaign resumed', created_at: '2026-06-16T10:00:00Z' },
  { id: 'a7', type: 'lead_status_changed', title: 'Lead Upgraded to Hot', description: 'Nicole Brown upgraded to Hot based on engagement score', lead: { id: 'l9', name: 'Nicole Brown', company: 'RetailIQ' }, created_at: '2026-06-15T16:00:00Z' },
  { id: 'a8', type: 'message_sent', title: 'Sequence Step Sent', description: '18 follow-up messages sent in FinTech Decision Makers', created_at: '2026-06-15T12:00:00Z' },
  { id: 'a9', type: 'meeting_booked', title: 'Meeting Booked', description: 'Carlos Mendez scheduled a full demo session', lead: { id: 'l12', name: 'Carlos Mendez', company: 'SalesForce Next' }, created_at: '2026-06-14T16:00:00Z' },
  { id: 'a10', type: 'reply_received', title: 'New Reply', description: 'James Park replied — follow up next week', lead: { id: 'l8', name: 'James Park', company: 'LogiTrack' }, created_at: '2026-06-14T15:00:00Z' },
]

// ── Dashboard Stats ───────────────────────────────────────────────────────────
export const MOCK_STATS: DashboardStats = {
  total_leads: 296,
  active_campaigns: 2,
  replies_received: 47,
  hot_leads: 12,
  meetings_booked: 9,
  conversion_rate: 18.4,
}

// ── Funnel ────────────────────────────────────────────────────────────────────
export const MOCK_FUNNEL: FunnelData[] = [
  { stage: 'Total Leads', count: 296, percentage: 100, color: '#c79a1f' },
  { stage: 'Contacted',   count: 198, percentage: 66.9, color: '#d4a72a' },
  { stage: 'Replied',     count: 47,  percentage: 23.7, color: '#e0b93c' },
  { stage: 'Interested',  count: 24,  percentage: 51.1, color: '#ec4899' },
  { stage: 'Meeting',     count: 9,   percentage: 37.5, color: '#f59e0b' },
  { stage: 'Converted',   count: 3,   percentage: 33.3, color: '#10b981' },
]

// ── Time Series ───────────────────────────────────────────────────────────────
export const MOCK_REPLIES_TREND: TimeSeriesPoint[] = [
  { date: '2026-06-01', value: 3 }, { date: '2026-06-02', value: 5 }, { date: '2026-06-03', value: 2 },
  { date: '2026-06-04', value: 7 }, { date: '2026-06-05', value: 4 }, { date: '2026-06-06', value: 1 },
  { date: '2026-06-07', value: 0 }, { date: '2026-06-08', value: 6 }, { date: '2026-06-09', value: 8 },
  { date: '2026-06-10', value: 5 }, { date: '2026-06-11', value: 9 }, { date: '2026-06-12', value: 4 },
  { date: '2026-06-13', value: 3 }, { date: '2026-06-14', value: 7 }, { date: '2026-06-15', value: 11 },
  { date: '2026-06-16', value: 8 }, { date: '2026-06-17', value: 6 },
]

export const MOCK_SENT_TREND: TimeSeriesPoint[] = [
  { date: '2026-06-01', value: 18 }, { date: '2026-06-02', value: 22 }, { date: '2026-06-03', value: 15 },
  { date: '2026-06-04', value: 25 }, { date: '2026-06-05', value: 20 }, { date: '2026-06-06', value: 8 },
  { date: '2026-06-07', value: 5 },  { date: '2026-06-08', value: 24 }, { date: '2026-06-09', value: 25 },
  { date: '2026-06-10', value: 22 }, { date: '2026-06-11', value: 25 }, { date: '2026-06-12', value: 19 },
  { date: '2026-06-13', value: 21 }, { date: '2026-06-14', value: 25 }, { date: '2026-06-15', value: 23 },
  { date: '2026-06-16', value: 25 }, { date: '2026-06-17', value: 14 },
]

// ── Campaign Performance ──────────────────────────────────────────────────────
export const MOCK_CAMPAIGN_PERF: CampaignPerformance[] = [
  { name: 'Q2 Enterprise', sent: 98, replies: 22, meetings: 6, reply_rate: 22.4 },
  { name: 'FinTech DMs',   sent: 63, replies: 14, meetings: 4, reply_rate: 22.2 },
  { name: 'Startup Series A', sent: 41, replies: 11, meetings: 3, reply_rate: 26.8 },
  { name: 'Healthcare IT', sent: 0,  replies: 0,  meetings: 0, reply_rate: 0 },
]

// ── Lead Intelligence ─────────────────────────────────────────────────────────
export const MOCK_INTELLIGENCE: Record<string, LeadIntelligence> = {
  l1: {
    lead_id: 'l1',
    company_overview: 'Datawave Inc is a Series C data infrastructure company serving enterprise customers across 12 countries. They recently raised $45M and are expanding their engineering team by 40%.',
    pain_points: [
      'Manual prospecting taking 15+ hours/week from engineering leadership',
      'Inconsistent outbound messaging across team members',
      'Difficulty tracking prospect engagement at scale',
      'High cost of SDR team not converting well',
    ],
    buying_signals: [
      'Posted about "scaling outbound" on LinkedIn 3 days ago',
      'Actively hiring SDRs on job boards',
      'Viewed pricing page 2x this week',
      'Engaged with 3 competitor posts recently',
    ],
    opportunity_score: 92,
    recent_news: [
      'Datawave raised $45M Series C led by Sequoia — June 2026',
      'Announced expansion into European markets — May 2026',
      'Engineering team grew 40% YoY per LinkedIn headcount data',
    ],
    tech_stack: ['Salesforce', 'HubSpot', 'Outreach', 'Slack', 'AWS', 'Kubernetes', 'PostgreSQL'],
    competitors: ['Outreach.io', 'Salesloft', 'Apollo.io'],
    ai_insights: "Sarah is a decision-maker with budget authority. Her recent LinkedIn activity signals she's actively evaluating outbound tools. The combination of Series C funding, rapid team growth, and her personal posts about scaling suggests she has both the need and the budget. Recommended approach: Lead with ROI data and time-savings statistics. Reference Outreach.io as a competitor they likely know.",
    updated_at: '2026-06-17T08:00:00Z',
  },
}

// ── Team Members ──────────────────────────────────────────────────────────────
export const MOCK_TEAM: TeamMember[] = [
  { id: 't1', name: 'You (Admin)', email: 'wittyadverts.team@gmail.com', role: 'admin', joined_at: '2026-01-01T00:00:00Z', last_active: '2026-06-17T10:00:00Z' },
  { id: 't2', name: 'Jordan Lee', email: 'jordan@company.com', role: 'member', joined_at: '2026-03-15T00:00:00Z', last_active: '2026-06-16T17:00:00Z' },
  { id: 't3', name: 'Alex Morgan', email: 'alex@company.com', role: 'member', joined_at: '2026-04-01T00:00:00Z', last_active: '2026-06-15T12:00:00Z' },
  { id: 't4', name: 'Casey Williams', email: 'casey@company.com', role: 'viewer', joined_at: '2026-05-20T00:00:00Z', last_active: '2026-06-10T09:00:00Z' },
]

// ── Settings ──────────────────────────────────────────────────────────────────
export const MOCK_SETTINGS: Settings = {
  openai_api_key: 'sk-••••••••••••••••••••••••••••••••',
  gemini_api_key: '',
  webhook_url: 'https://n8n.company.com/webhook/leadpilot',
  webhook_secret: 'whsec_••••••••••••',
  notification_email: true,
  notification_slack: false,
  slack_webhook_url: '',
  timezone: 'America/Los_Angeles',
  daily_send_limit: 50,
}
