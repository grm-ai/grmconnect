# Automation Platform – Monorepo

```
automation-platform/
├── backend/       FastAPI + Celery + Playwright API
├── frontend/      Next.js 14 + Tailwind CSS UI
└── infrastructure/
    ├── nginx/     Reverse proxy config
    ├── deployment/ Full-stack Docker Compose
    └── monitoring/ Prometheus + Grafana
```

## Quick start (full stack)

```bash
cd infrastructure/deployment
cp ../../backend/.env.example .env
# set API_KEY in .env
docker compose up --build -d
docker compose exec api alembic upgrade head
```

Open http://localhost (nginx) or:
- Frontend direct:  http://localhost:3000
- Backend API:      http://localhost:8000/docs
- Grafana:          http://localhost:3001  (admin/admin)
- Prometheus:       http://localhost:9090

## Backend only

```bash
cd backend
cp .env.example .env
docker compose up --build -d
docker compose exec api alembic upgrade head
```

## Frontend only

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev   # http://localhost:3000
```

## Environment variables

| File | Purpose |
|---|---|
| `backend/.env` | API key, DB/Redis URLs, log level |
| `frontend/.env.local` | `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_API_KEY` |
| `infrastructure/deployment/.env` | Full-stack override (extends backend/.env) |
