# LinkedIn Automation Platform

A production-ready FastAPI automation platform for browser-based outreach workflows. The core architecture is **generic and extensible** – LinkedIn-specific actions are implemented as pluggable handlers and can be swapped or augmented without touching the core.

---

## Tech Stack

| Layer | Technology |
|---|---|
| API | FastAPI 0.111 + Uvicorn |
| Database | PostgreSQL 16 + SQLAlchemy 2.0 (async) + Alembic |
| Queue | Celery 5 + Redis 7 |
| Scheduler | APScheduler 3.10 (Redis job store) |
| Browser | Playwright 1.44 (Chromium) |
| AI | Anthropic Claude (optional) |
| Infra | Docker + Docker Compose |

---

## Quick Start (Docker)

### 1. Clone and configure

```bash
git clone <repo-url> linkedin-automation
cd linkedin-automation
cp .env.example .env
# Edit .env – set a strong API_KEY at minimum
```

### 2. Build and start all services

```bash
docker compose up --build -d
```

This starts five containers:

| Container | Role |
|---|---|
| `linkedin_api` | FastAPI app on port 8000 |
| `linkedin_worker` | Celery worker (browser automation) |
| `linkedin_scheduler` | Celery beat (runs every 5 min) |
| `linkedin_postgres` | PostgreSQL database |
| `linkedin_redis` | Redis broker + result backend |

### 3. Run database migrations

```bash
docker compose exec api alembic upgrade head
```

### 4. Verify

```bash
curl http://localhost:8000/health
```

---

## Running Locally (without Docker)

### Prerequisites

- Python 3.12
- PostgreSQL running locally
- Redis running locally

### Setup

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
playwright install chromium

cp .env.example .env
# Edit DATABASE_URL and REDIS_URL to point to local instances
```

### Start services in separate terminals

```bash
# Terminal 1 – API
uvicorn app.main:app --reload --port 8000

# Terminal 2 – Celery worker
celery -A app.workers.celery_worker worker --loglevel=info

# Terminal 3 – Celery beat (scheduler)
celery -A app.workers.celery_worker beat --loglevel=info
```

### Apply migrations

```bash
alembic upgrade head
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | – | Async PostgreSQL URL (`postgresql+asyncpg://...`) |
| `SYNC_DATABASE_URL` | Yes | – | Sync PostgreSQL URL (`postgresql+psycopg2://...`) |
| `REDIS_URL` | Yes | – | Redis URL |
| `API_KEY` | Yes | – | Secret key sent in `X-API-Key` header |
| `LOG_LEVEL` | No | `INFO` | Python log level |
| `LOG_DIR` | No | `/app/logs` | Directory for rotating log files |
| `SESSION_DIR` | No | `/app/sessions` | Directory for Playwright storage state JSON |
| `ANTHROPIC_API_KEY` | No | – | Enable AI-generated messages |

---

## Authentication

All endpoints (except `GET /health`) require the header:

```
X-API-Key: <your-api-key>
```

---

## API Reference

Interactive docs are available at `http://localhost:8000/docs`.

### Health

```http
GET /health
```

### Leads

```http
POST   /leads
GET    /leads?page=1&page_size=20&status=PENDING
GET    /leads/{id}
PATCH  /leads/{id}
DELETE /leads/{id}
```

#### Create a lead

```bash
curl -X POST http://localhost:8000/leads \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Jane Smith",
    "company": "Acme Corp",
    "linkedin_url": "https://linkedin.com/in/janesmith",
    "email": "jane@acme.com"
  }'
```

### Campaigns

```http
POST   /campaigns
GET    /campaigns
GET    /campaigns/{id}
PATCH  /campaigns/{id}
DELETE /campaigns/{id}
```

#### Create a campaign

```bash
curl -X POST http://localhost:8000/campaigns \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Q1 Outreach",
    "description": "Target VP Engineering at SaaS companies",
    "daily_limit": 30
  }'
```

### Actions

```http
POST   /actions                    # create action
GET    /actions                    # list (filter by status, campaign_id, lead_id)
GET    /actions/{id}
DELETE /actions/{id}
POST   /actions/queue              # bulk-queue actions by ID
POST   /actions/{id}/retry         # retry failed action
POST   /actions/{id}/cancel        # cancel pending action
GET    /actions/{id}/logs          # execution log / result
```

#### Create and queue a CONNECT action

```bash
# 1. Create
curl -X POST http://localhost:8000/actions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": 1,
    "campaign_id": 1,
    "action_type": "CONNECT",
    "payload": {"note": "Hi Jane, I loved your recent talk on platform engineering!"}
  }'

# 2. Queue
curl -X POST http://localhost:8000/actions/queue \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action_ids": [1]}'
```

#### Send a MESSAGE

```bash
curl -X POST http://localhost:8000/actions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "lead_id": 1,
    "action_type": "MESSAGE",
    "payload": {"message": "Hi Jane, following up on my connection request. Would love to chat about platform tooling."}
  }'
```

#### Run a CUSTOM action (Playwright steps)

```bash
curl -X POST http://localhost:8000/actions \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "action_type": "CUSTOM",
    "payload": {
      "steps": [
        {"action": "goto",       "value": "https://linkedin.com/in/janesmith"},
        {"action": "wait",       "value": "2000"},
        {"action": "screenshot", "value": "/app/sessions/jane_profile.png"}
      ]
    }
  }'
```

### Runner (ad-hoc task dispatch)

```http
POST /run-task
```

```bash
curl -X POST http://localhost:8000/run-task \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"task_name": "process_pending_actions", "kwargs": {}}'
```

---

## n8n Integration

The platform exposes `POST /webhook/n8n` for deep integration with n8n.

### Supported events

| Event | Payload | Effect |
|---|---|---|
| `lead.create` | Lead fields | Creates a new lead |
| `lead.update` | `id` + fields to update | Updates an existing lead |
| `campaign.activate` | `{"campaign_id": 1}` | Sets campaign ACTIVE |
| `action.queue` | `{"action_ids": [1,2,3]}` | Queues actions immediately |
| `action.create` | ActionCreate fields | Creates + queues an action |

### n8n HTTP Request node setup

```
Method: POST
URL:    http://linkedin-api:8000/webhook/n8n
Headers:
  X-API-Key: <your-api-key>
  Content-Type: application/json
Body (JSON):
  {
    "event": "lead.create",
    "data": {
      "name": "{{ $json.fullName }}",
      "company": "{{ $json.company }}",
      "linkedin_url": "{{ $json.linkedinUrl }}",
      "email": "{{ $json.email }}"
    }
  }
```

### Trigger an action after creating a lead (n8n workflow)

```
[Trigger] → [HTTP Request: lead.create] → [HTTP Request: action.create (CONNECT)]
```

Example `action.create` body:
```json
{
  "event": "action.create",
  "data": {
    "lead_id": "{{ $json.data.lead_id }}",
    "action_type": "CONNECT",
    "payload": {
      "note": "Hi {{ $json.data.name }}, I would love to connect!"
    }
  }
}
```

---

## Adding a Custom Action Handler

Create a subclass of `BaseActionHandler` and register it:

```python
# my_handlers.py
from app.services.browser import BaseActionHandler, register_handler
from app.models import ActionType

class EndorseSkillsHandler(BaseActionHandler):
    async def execute(self, page, payload, lead_url):
        await page.goto(lead_url, wait_until="domcontentloaded")
        # ... your Playwright logic ...
        return {"success": True, "action": "ENDORSE_SKILLS"}

# Register at startup (e.g. in app/main.py lifespan)
register_handler(ActionType.CUSTOM, EndorseSkillsHandler())
```

---

## Session Management

Browser sessions (Playwright storage state) are stored as JSON files under `/app/sessions/`.

```bash
# After a manual login, export storage state and save via API or directly:
cp my_session.json sessions/my_account.json
```

The session file contains cookies and localStorage so subsequent actions bypass login.

---

## Logs

| File | Content |
|---|---|
| `logs/app.log` | FastAPI request/response + application logs |
| `logs/celery.log` | Celery worker task logs |
| `logs/browser.log` | Playwright handler execution logs |
| `logs/scheduler.log` | APScheduler tick logs |

All logs rotate at 10 MB, keeping 5 backups. Logs are also streamed to stdout (visible via `docker compose logs`).

---

## Project Structure

```
linkedin-automation/
├── app/
│   ├── main.py              # FastAPI app + lifespan
│   ├── config.py            # Pydantic Settings
│   ├── database.py          # Async + sync SQLAlchemy engines
│   ├── models.py            # ORM models + enums
│   ├── schemas.py           # Pydantic request/response models
│   ├── logger.py            # Rotating file + stdout loggers
│   ├── auth.py              # API key verification
│   ├── exceptions.py        # Custom exceptions + handlers
│   ├── dependencies.py      # FastAPI DI helpers
│   ├── redis_client.py      # Async Redis pool
│   ├── celery_app.py        # Celery configuration
│   ├── scheduler.py         # APScheduler (Redis job store)
│   ├── tasks.py             # Celery tasks
│   ├── routes/
│   │   ├── health.py
│   │   ├── leads.py
│   │   ├── campaigns.py
│   │   ├── actions.py
│   │   ├── runner.py
│   │   └── webhook.py
│   ├── services/
│   │   ├── browser.py       # Handler registry + BrowserService
│   │   ├── session_manager.py
│   │   ├── campaign_engine.py
│   │   ├── rate_limiter.py
│   │   ├── ai_generator.py
│   │   └── lead_importer.py
│   └── workers/
│       └── celery_worker.py
├── migrations/
│   ├── env.py
│   ├── script.py.mako
│   └── versions/
│       └── 0001_initial_schema.py
├── logs/
├── sessions/
├── .env.example
├── alembic.ini
├── docker-compose.yml
├── Dockerfile
└── requirements.txt
```
