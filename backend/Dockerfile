# ── LeadPilot backend (FastAPI + SQLite + in-process background worker) ───────
FROM python:3.12-slim

WORKDIR /app

# Build tools for wheels that may need compiling (bcrypt, cryptography, asyncpg…)
RUN apt-get update && apt-get install -y --no-install-recommends gcc curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Runtime data dirs (mounted as volumes in docker-compose so they persist)
RUN mkdir -p /app/data /app/sessions /app/logs

ENV ENV=production \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# run_dev.py = create tables + run the SQLite migrations + start the asyncio background
# worker + uvicorn (single process, no reload in production). This matches how the app runs
# locally, so the DB schema/migrations and autopilot loop all work the same on the server.
# NOTE: browser automation runs in the user's Chrome extension, so we do NOT install Playwright
# browsers here (keeps the image small).
CMD ["python", "run_dev.py"]
