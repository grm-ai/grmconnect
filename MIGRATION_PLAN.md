# Migration Plan: linkedin-automation → automation-platform

## Summary

The existing project (`linkedin-automation/`) was a pure-backend FastAPI project
with no frontend code. It was reorganised into a clean monorepo with three
distinct concerns: **backend**, **frontend**, and **infrastructure**.

No business logic was changed. Only files were moved, configs updated, and
a fully isolated frontend was created that communicates with the backend
exclusively via REST.

---

## Phase 1 – Backend (Move + Update)

All Python backend files moved to `automation-platform/backend/`.

| Old location | New location | Changed? |
|---|---|---|
| `app/**` (all 25 files) | `backend/app/**` | 2 files updated (see below) |
| `migrations/**` | `backend/migrations/**` | None |
| `requirements.txt` | `backend/requirements.txt` | None |
| `alembic.ini` | `backend/alembic.ini` | None |
| `.env.example` | `backend/.env.example` | Added `ALLOWED_ORIGINS` |
| `Dockerfile` | `backend/Dockerfile` | None |
| `docker-compose.yml` | `backend/docker-compose.yml` | Container names prefixed `ap_` |

### Code changes in backend (2 files only)

**`backend/app/config.py`** — added CORS field:
```python
allowed_origins: str = "http://localhost:3000"
```

**`backend/app/main.py`** — replaced wildcard CORS with env-driven list:
```python
# Before
allow_origins=["*"]

# After
_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins or ["*"], ...)
```

---

## Phase 2 – Frontend (Created)

No frontend existed. Scaffolded from scratch. **Zero backend logic introduced.**

### Key files

| File | Role |
|---|---|
| `src/lib/api.ts` | **Only file that knows the backend URL.** Typed fetch wrappers for all endpoints. |
| `src/hooks/use*.ts` | SWR data hooks — call `api.ts`, nothing else |
| `components/*.tsx` | Pure UI — no fetch calls, receive data as props |
| `pages/*.tsx` | Next.js pages — compose hooks + components, trigger API mutations |

### Separation enforced

- Frontend: no Python, no DB, no Celery, no Playwright
- Backend: no React, no Node, no TypeScript, no HTML templates

---

## Phase 3 – Infrastructure (Created)

| File | Purpose |
|---|---|
| `infrastructure/nginx/nginx.conf` | Routes `/api/*` → backend, `/` → frontend |
| `infrastructure/deployment/docker-compose.yml` | All 7 services (api, worker, scheduler, postgres, redis, frontend, nginx) |
| `infrastructure/monitoring/prometheus.yml` | Prometheus scrape config |
| `infrastructure/monitoring/docker-compose.monitoring.yml` | Prometheus + Grafana + exporters |

---

## Final directory tree

```
automation-platform/
├── README.md
├── MIGRATION_PLAN.md
├── .gitignore
│
├── backend/
│   ├── .env.example
│   ├── alembic.ini
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── requirements.txt
│   ├── logs/
│   ├── sessions/
│   ├── app/
│   │   ├── main.py            ← CORS env-driven
│   │   ├── config.py          ← +allowed_origins
│   │   ├── database.py
│   │   ├── models.py
│   │   ├── schemas.py
│   │   ├── logger.py
│   │   ├── auth.py
│   │   ├── exceptions.py
│   │   ├── dependencies.py
│   │   ├── redis_client.py
│   │   ├── celery_app.py
│   │   ├── scheduler.py
│   │   ├── tasks.py
│   │   ├── routes/
│   │   │   ├── health.py
│   │   │   ├── leads.py
│   │   │   ├── campaigns.py
│   │   │   ├── actions.py
│   │   │   ├── runner.py
│   │   │   └── webhook.py
│   │   ├── services/
│   │   │   ├── browser.py
│   │   │   ├── session_manager.py
│   │   │   ├── campaign_engine.py
│   │   │   ├── rate_limiter.py
│   │   │   ├── ai_generator.py
│   │   │   └── lead_importer.py
│   │   └── workers/
│   │       └── celery_worker.py
│   └── migrations/
│       ├── env.py
│       ├── script.py.mako
│       └── versions/
│           └── 0001_initial_schema.py
│
├── frontend/
│   ├── .env.example
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── next.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── styles/globals.css
│   ├── src/
│   │   ├── lib/api.ts         ← sole API coupling point
│   │   └── hooks/
│   │       ├── useLeads.ts
│   │       ├── useCampaigns.ts
│   │       └── useActions.ts
│   ├── components/
│   │   ├── Layout.tsx
│   │   ├── Navbar.tsx
│   │   ├── StatsCard.tsx
│   │   ├── ActionBadge.tsx
│   │   ├── LeadTable.tsx
│   │   ├── CampaignCard.tsx
│   │   └── modals/
│   │       ├── CreateLeadModal.tsx
│   │       └── CreateCampaignModal.tsx
│   ├── pages/
│   │   ├── _app.tsx
│   │   ├── index.tsx          ← Dashboard + health check
│   │   ├── leads.tsx
│   │   ├── campaigns.tsx
│   │   └── actions.tsx
│   └── public/
│
└── infrastructure/
    ├── nginx/
    │   └── nginx.conf
    ├── deployment/
    │   └── docker-compose.yml
    └── monitoring/
        ├── prometheus.yml
        └── docker-compose.monitoring.yml
```

---

## Import change summary

| Layer | Before | After |
|---|---|---|
| Python intra-app | `from app.xxx import ...` | Unchanged — `app/` is still the package root |
| Alembic | `from app.database import Base` | Unchanged |
| Frontend API calls | N/A (no frontend existed) | All via `src/lib/api.ts` |
| Docker volumes | `./logs`, `./sessions` | Same relative paths, working dir is `backend/` |
| Nginx → backend | N/A | `/api/*` stripped and forwarded to `api:8000` |
| Nginx → frontend | N/A | `/` forwarded to `frontend:3000` |
