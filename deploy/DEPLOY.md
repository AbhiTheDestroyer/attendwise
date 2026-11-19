# Deploy AttendWise — a permanent, fast, free link

This guide produces a **real production URL you own** (e.g. `https://yourName.duckdns.org`) that:
- stays online **forever** (not a temporary dev sandbox),
- **never sleeps / no cold-start lag** (dedicated CPU, real SQLite on disk),
- runs on a **real web server** (Caddy, auto-HTTPS) — no Cloudflare involved,
- auto-restarts after reboots (Docker `--restart=always` + systemd).

Total cost: **₹0**. The free tiles used: **Oracle Cloud Always-Free** (the only major cloud with a permanently free real VM: 4 ARM cores / 24 GB RAM / 200 GB disk — the app needs ~0.1% of that) + **DuckDNS** (free subdomain; or use any domain you own).

> Why I can't simply "make the link for you": every permanent host is tied to an account identity (because they'd otherwise be the ones paying). The steps below are everything from a blank screen to a live link — roughly 10–15 minutes, mostly guided point-and-click.

---

## Step 1 — create the free-forever server (~5 min)

1. Sign up at **cloud.oracle.com** → choose **Always Free** home region (Hyderabad `ap-hyderabad-1` or Mumbai is closest to India). A payment card is asked only for identity — the Always-Free tier is never charged.
2. **Create a compute instance**: Image = *Ubuntu 22.04 (AArch64 or x86)*, Shape = **VM.Standard.A1.Flex** (free) with 1 OCPU / 6 GB RAM (or up to 4/24 — all free).
3. Download/save your SSH key. Make a note of the instance's **public IP**.
4. **Open the firewall:** Networking → Virtual Cloud Networks → your subnet → Security List → **Add Ingress Rules**: source `0.0.0.0/0`, TCP **80** and **443**. (Ubuntu's own firewall is off by default.)

## Step 2 — claim a free hostname (~2 min)

1. Go to **www.duckdns.org**, sign in (Google/GitHub — free forever).
2. Add a name, e.g. `myinst-ams` → you get **`myinst-ams.duckdns.org`**.
3. Set its IP = your instance's public IP → *update ip*. (Or skip DuckDNS and use any domain you already own — point an A record at the IP.)

## Step 3 — upload the project & run one command (~4 min)

```bash
ssh ubuntu@<YOUR_IP>                 # using your downloaded key
# one of: clone from your git — or upload the project folder (scp -r ./attendance-system ubuntu@IP:~)
cd ~/attendance-system
sudo DOMAIN=myinst-ams.duckdns.org bash deploy/server-setup.sh
```

`server-setup.sh` installs Docker, builds the app, starts it with auto-restart, installs Caddy and issues the certificate. Check with `docker logs attendwise` / `curl http://localhost:8080/api/health`.

## Step 4 — done 🎉

Open **https://myinst-ams.duckdns.org** — the login page loads, sign in (`admin@git.edu / Admin@123`), install the PWA on phones, share the link with teachers. The URL:

- never expires, never sleeps, handles the whole app stack on dedicated hardware,
- auto-recovers from VM reboots,
- upgrades with `git pull && bash deploy/server-setup.sh`.

**Before handing it to parents/staff (5-minute checklist):** change the demo passwords (Profile → Change password, or Settings → Users), set `SIMULATE_NOTIFICATIONS=false` with real providers in the environment (`SMS_PROVIDER/TWILIO_*` etc., see `.env.example`) for real SMS/WhatsApp/emails, and consider `notifications` → set policy + threshold.

---

## Alternative hosts (faster to click, but trade-offs)

| Host | Setup | Forever-free? | No sleep? |
|---|---|---|---|
| **Oracle Always Free** *(this guide)* | script | ✅ | ✅ |
| Render (uses our `render.yaml`) | one-click Blueprint | ✅ free tier | ❌ sleeps ~15 min idle (cold start lag) |
| Fly.io (uses our `fly.toml`) | `fly deploy` | small free allowance (card needed) | ✅ while running |
| Railway | point at repo / Dockerfile | trial credits only | ✅ while paid |
| Any ₹300–500/mo VPS | same script as Oracle | paid | ✅ |

Files in this folder (`deploy/`) were purpose-built for the project — `server-setup.sh` is idempotent, so re-running it is the full "deploy an update" workflow as well.
