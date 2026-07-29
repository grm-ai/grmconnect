# Railway → AWS EC2 migration runbook

Matches the discussion in chat: single EC2 instance + Docker, SQLite kept
as-is, Vercel frontend untouched. Do this end-to-end in one sitting so the
cutover (step 8) is a single quick DNS/env-var change.

## 0. Prerequisites
- AWS account (free-tier eligible)
- A subdomain you control DNS for, e.g. `api.grmconnect.com`
- Your current Railway env vars (Railway dashboard → Variables tab) — you'll
  copy `API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` from there so existing
  sessions/API keys keep working

## 1. Launch the EC2 instance
- Instance type: `t3.small` (t2/t3.micro is free-tier but only 1GB RAM — tight
  for this app; t3.small is safer, still cheap)
- AMI: Ubuntu 22.04 LTS
- Security group: allow inbound `22` (SSH, your IP only), `80`, `443`
- Allocate an **Elastic IP** and associate it to the instance (so the IP
  doesn't change on reboot — you'll point DNS at it)

## 2. Install Docker on the instance
```bash
ssh ubuntu@<elastic-ip>
sudo apt update && sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx
sudo usermod -aG docker $USER
newgrp docker
```

## 3. Get the code onto the box
```bash
git clone https://github.com/grm-ai/grmconnect.git
cd grmconnect/infrastructure/aws
cp .env.production.example .env
nano .env    # fill in API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY from Railway
```

## 4. Migrate the SQLite database from Railway
Railway's dashboard doesn't give raw file access, so pull it via the running
service's shell (Railway dashboard → your service → the `>_` console icon, or
`railway run bash` if you set up the CLI locally):
```bash
# on Railway's console:
cat /app/data/leadpilot.db | base64 > /tmp/dbdump.b64   # or wherever the file actually lives —
                                                          # check DATABASE_URL in Railway's Variables tab
```
Copy that output, then on the EC2 box decode it back into the volume:
```bash
docker compose up -d          # first boot creates the empty volume + fresh empty db
docker compose down
echo "<pasted base64>" | base64 -d > /tmp/leadpilot.db
docker run --rm -v aws_api_data:/data -v /tmp:/tmp alpine cp /tmp/leadpilot.db /data/leadpilot.db
```
(If this feels fragile — it's the one genuinely fiddly step in this whole
migration — an easier alternative is to add a temporary `/admin/export-db`
endpoint that streams the file, hit it once with curl, then delete it.)

## 5. Start the backend
```bash
docker compose up --build -d
docker compose logs -f       # confirm "Database tables ready" + no errors
curl http://localhost:8000/health
```
`/health` will report `"redis": "error"` — that's expected and harmless, there's no
Redis container in this compose file and the real production code path
(`run_dev.py`) never uses Redis/Celery anyway. Only `"db": "ok"` matters here.

## 6. DNS
Point `api.grmconnect.com` (A record) at the Elastic IP. Propagation is
usually minutes but can take up to an hour.

## 7. Nginx + SSL
```bash
sudo cp nginx.conf /etc/nginx/sites-available/leadpilot
sudo ln -s /etc/nginx/sites-available/leadpilot /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.grmconnect.com     # free SSL cert, auto-renews via cron
```
Confirm: `curl https://api.grmconnect.com/health` works from your own laptop.

## 8. Cutover (the only "live" moment — keep Railway running until this passes)
1. Vercel dashboard → frontend project → Settings → Environment Variables →
   set `NEXT_PUBLIC_API_URL=https://api.grmconnect.com` → redeploy
2. Update the hardcoded API URL in `extension/background.js` and
   `extension/content.js` (search for `grmconnect-production.up.railway.app`),
   then re-sync into `frontend/extension/` per the existing habit, rebuild the
   downloadable zip, commit
3. Test end-to-end on grmconnect.com: login, campaigns page loads, "Fetch &
   Sync" works, a due step actually sends
4. Only once everything above is confirmed working — pause/delete the Railway
   service

## 9. After cutover
- Set up a daily cron `docker run` snapshot of the `api_data` volume (or an
  EBS snapshot of the whole instance) — SQLite has no managed-backup safety
  net like RDS does, so this is now your responsibility
- Consider `t3.small`'s free-tier/credit runway and set a calendar reminder
  before it lapses into normal billing
