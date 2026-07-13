# Deploy LeadPilot (grmconnect) on a Hostinger VPS

Everything (frontend + backend + database + SSL) runs on **one VPS** with Docker.
Push to `main` on GitHub → GitHub Actions auto-deploys to the VPS.

```
Browser ──HTTPS──► nginx ──► frontend (Next.js :3000)
                        └──► /api ──► backend (FastAPI :8000) ──► SQLite (volume)
```

---

## 0. What you need
- A **Hostinger VPS** — KVM 1 or bigger, **Ubuntu 22.04** (shared hosting will NOT work).
- A **domain** pointed at the VPS (Hostinger gives you one). Optional — you can start with the raw IP over HTTP.
- The GitHub repo (already done: `royalstylishrahul/grmconnect`).

---

## 1. Point your domain at the VPS
In Hostinger → your domain → DNS → add an **A record**:
```
Type A   Host @     Value <YOUR_VPS_IP>
Type A   Host www   Value <YOUR_VPS_IP>
```
(Skip if you'll use the raw IP for now.)

---

## 2. Set up the VPS (one time)
SSH in (Hostinger gives you the IP + root password):
```bash
ssh root@YOUR_VPS_IP
```

Install Docker + Compose + git:
```bash
apt update && apt install -y git
curl -fsSL https://get.docker.com | sh          # installs Docker + compose plugin
docker --version && docker compose version       # verify
```

Clone the repo:
```bash
mkdir -p /opt && cd /opt
git clone https://github.com/royalstylishrahul/grmconnect.git
cd grmconnect
```

---

## 3. Create the production config
```bash
cp .env.production.example .env
nano .env
```
Fill in:
- `API_KEY` — run `openssl rand -hex 32` and paste it.
- `NEXT_PUBLIC_API_KEY` — **same value** as `API_KEY`.
- `ALLOWED_ORIGINS` — `https://YOUR_DOMAIN.com`
- `NEXT_PUBLIC_API_URL` — `https://YOUR_DOMAIN.com/api`
- (Optional) `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` — or set them later in the Settings page.

> Using the raw IP first (no domain/SSL)? Set `NEXT_PUBLIC_API_URL=http://YOUR_VPS_IP/api` and `ALLOWED_ORIGINS=http://YOUR_VPS_IP`.

Create the data folders (persist across rebuilds):
```bash
mkdir -p data/db data/sessions data/logs certbot/conf certbot/www
```

---

## 4. First deploy (HTTP)
```bash
docker compose up -d --build
```
Wait ~2 min (first build). Then open **http://YOUR_DOMAIN.com** (or **http://YOUR_VPS_IP**) — the landing page should load. Sign up, log in, use the app.

Check logs if needed: `docker compose logs -f backend` / `frontend` / `nginx`.

---

## 5. Add HTTPS (Let's Encrypt — free) — do this once you have a domain
Get the certificate (nginx is already serving the challenge on port 80):
```bash
docker compose run --rm --entrypoint "certbot certonly --webroot -w /var/www/certbot -d YOUR_DOMAIN.com -d www.YOUR_DOMAIN.com --email you@email.com --agree-tos --no-eff-email" certbot
```
Switch nginx to the HTTPS config:
```bash
cp nginx/app-ssl.conf.example nginx/conf.d/app.conf
sed -i 's/YOUR_DOMAIN.com/your-real-domain.com/g' nginx/conf.d/app.conf
docker compose restart nginx
```
Now **https://YOUR_DOMAIN.com** works, and the `certbot` container auto-renews the cert.

> If you switched to HTTPS, make sure `.env` uses the `https://` URLs (step 3), then rebuild the frontend: `docker compose up -d --build frontend`.

---

## 6. Turn on auto-deploy (GitHub CI/CD)
On the VPS, create an SSH key for GitHub Actions to log in with:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/gh_deploy -N ""
cat ~/.ssh/gh_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/gh_deploy            # copy this PRIVATE key
```
In GitHub → repo **Settings → Secrets and variables → Actions → New repository secret**, add:
| Secret | Value |
|---|---|
| `VPS_HOST` | your VPS IP |
| `VPS_USER` | `root` (or your user) |
| `VPS_SSH_KEY` | the **private** key you copied (`gh_deploy`) |
| `VPS_PATH` | `/opt/grmconnect` (optional, this is the default) |

Now every `git push` to `main` → GitHub Actions SSHes in, pulls, rebuilds, restarts. 🎉

---

## 7. Point the Chrome extension at production
The extension (each user loads it in their own Chrome) must talk to the deployed backend:
- Open `extension/background.js`, change line 1:
  ```js
  const API = 'https://YOUR_DOMAIN.com/api';
  ```
- Reload the extension (`chrome://extensions` → ⟳) and hard-refresh the site.

The extension already sends each logged-in user's token, so it acts as that user.

---

## Handy commands
```bash
docker compose ps                 # status
docker compose logs -f backend    # tail backend logs
docker compose up -d --build      # rebuild + restart (what CI runs)
docker compose down               # stop everything

# Backup (do this regularly!) — the whole database + sessions are just files:
tar czf backup-$(date +%F).tgz data/
```

## Notes
- **Data lives in `data/`** on the VPS (SQLite DB + LinkedIn cookies + settings). Back it up.
- SQLite is fine for a handful of users. For many users later, switch `DATABASE_URL` to a managed Postgres.
- Server-side Playwright browser automation is **not** installed (the Chrome extension does automation), which keeps the image small.
