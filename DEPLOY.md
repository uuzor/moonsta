# Moonsta — Production Deploy (Vultr)

## Live box

- Instance: `sentinel` (`505b8aae-d666-4d65-b6a8-5f665c6d8509`), `fra`, `vhp-1c-1gb-amd` ($6/mo ≈ $0.009/hr)
- IP: `45.63.119.34`, Ubuntu 24.04, Docker + Compose v5, 1GB RAM + 2.3GB image swap
- SSH: `ssh -i sentinel-vultr-key root@45.63.119.34` (key at repo root, gitignored; root password in Vultr panel/email)
- Code: `/opt/sentinel`, stack: `docker compose -f docker-compose.prod.yml ...`
- Firewall group `sentinel`: inbound 22/tcp only. Bot uses long polling (outbound) — no inbound app ports.

## Services (all `restart: unless-stopped`)

- `app-bot` — @Clawbuns_bot, turns via Redis queue
- `app-web` — Mini App dashboard + JSON API (:3000, loopback-only)
- `app-scheduler` — sweep/snapshot/drain/digest on BullMQ driver
- `app-worker` — guard loop, **DRY-RUN** (add `--live` deliberately)
- `postgres` (fresh `init.sql` schema), `redis` (internal only)
- Caddy on host — `https://45-63-119-34.sslip.io` → :3000 (needs firewall 80/443)
- Status 2026-11-06: stack rebuilt with action schedule (due-actions + drain every
  minute, Schedules tab in Mini App dist, 007 applied to prod DB). Vultr
  firewall group `sentinel` has 22/80/443 inbound; host ufw allows the same
  three. Caddy holds a valid Let's Encrypt cert —
  https://45-63-119-34.sslip.io serves the Mini App (200, verified).

## Useful commands (on the box)

```bash
cd /opt/sentinel
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f app-bot
docker compose -f docker-compose.prod.yml up -d --build   # redeploy after code sync
```

## Gotchas learned

- `package-lock.json` resolved URLs must point at `registry.npmjs.org`, not the
  sandbox mirror — a lockfile with internal URLs breaks `npm ci` off-sandbox
  with a misleading "Exit handler never called". **Re-run after EVERY local
  `npm install`** (it re-adds mirror URLs):
  `sed -i 's|http://package-firewall\.replit\.internal/npm/|https://registry.npmjs.org/|g' package-lock.json`.
- Ubuntu 24.04 apt has no `docker-compose-plugin` — install via get.docker.com.
- The image already ships active swap; the cloud-init template (`deploy/vultr-cloud-init.sh`) is Docker-only.
- Only ONE bot poller per token: stop local `npm run bot` before starting prod (409 conflicts otherwise).

## Teardown

Vultr panel → destroy `sentinel` (stops billing), optionally delete the
`sentinel` firewall group + `sentinel-deploy` SSH key. Rotate leaked secrets after.
