# Deploy on Railway (backend) + Vercel (frontend)

No server to manage — both platforms deploy straight from GitHub (`grm-ai/grmconnect`).
Vercel is free; Railway is ~$5/mo (has trial credit).

```
Browser ──► Vercel (Next.js)  ──API calls──►  Railway (FastAPI + SQLite on a volume)
```

---

## Part 1 — Backend on Railway

1. Go to **railway.app** → **New Project** → **Deploy from GitHub repo** → pick **grm-ai/grmconnect**.
2. Open the created service → **Settings**:
   - **Root Directory:** `backend`   (Railway then uses `backend/Dockerfile` + `railway.json`)
3. **Variables** tab → add these (Raw Editor makes it fast):
   ```
   ENV=production
   API_KEY=<paste a long random secret>          # generate: openssl rand -hex 32
   DATABASE_URL=sqlite+aiosqlite:////data/leadpilot.db
   SYNC_DATABASE_URL=sqlite:////data/leadpilot.db
   SESSION_DIR=/data/sessions
   LOG_DIR=/data/logs
   LOG_LEVEL=INFO
   ALLOWED_ORIGINS=https://TEMP        # update after Vercel gives you a URL (Part 3)
   ```
   (Optional: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` — or set them later in the app's Settings page.)
4. **Add a Volume** (so the SQLite DB + LinkedIn cookies survive restarts):
   - Service → **Variables/Settings → Volumes → New Volume** → **Mount path:** `/data`
5. **Generate a public URL:** Settings → **Networking → Generate Domain**.
   - You'll get something like `https://grmconnect-production.up.railway.app` — **copy it** (this is your backend URL).

---

## Part 2 — Frontend on Vercel

1. Go to **vercel.com** → **Add New… → Project** → **Import** `grm-ai/grmconnect`.
2. Configure:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Next.js (auto-detected)
3. **Environment Variables** → add:
   ```
   NEXT_PUBLIC_API_URL = <your Railway backend URL from Part 1.5>
   NEXT_PUBLIC_API_KEY = <same value as API_KEY>
   ```
4. Click **Deploy**. You'll get a URL like `https://grmconnect.vercel.app` — **copy it**.

---

## Part 3 — Connect the two (CORS)

1. Back in **Railway → Variables**, set:
   ```
   ALLOWED_ORIGINS = https://grmconnect.vercel.app       # your real Vercel URL
   ```
   Railway auto-redeploys.
2. Open your Vercel URL → the landing page loads → **sign up / log in** → it works. 🎉

---

## Part 4 — Point the Chrome extension at production

Each user loads the extension in their own Chrome. Update it to talk to the Railway backend:
- `extension/background.js` line 1:
  ```js
  const API = 'https://grmconnect-production.up.railway.app';   // your Railway URL
  ```
- Reload the extension (`chrome://extensions` → ⟳) and hard-refresh the site.

The extension already sends each logged-in user's token, so it acts as that user.

---

## Auto-deploy (already on)
Both platforms are linked to GitHub — **every `git push` to `main` auto-redeploys** both frontend and backend. No CI/CD secrets needed.

## Notes / gotchas
- **NEXT_PUBLIC_API_URL has NO `/api` here** (unlike the VPS setup) — the Railway backend serves at its own root URL.
- **Volume is essential** — without it, Railway wipes the SQLite DB on each redeploy.
- Railway ~$5/mo. If you want it fully free later, the DB can move to a free managed Postgres (Neon/Supabase) — ask me and I'll switch it.
- **Back up** the Railway volume periodically (it holds all your data).
