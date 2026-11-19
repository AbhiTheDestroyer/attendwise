#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# AttendWise one-shot production setup for a fresh Ubuntu/Debian VM
# (Oracle Cloud Always-Free ARM/x86, or any small VPS).
#
#   curl -fsSL https://<your raw git URL>/server-setup.sh | sudo DOMAIN=ams.duckdns.org bash
#   — or from inside the checked-out repo:
#   sudo DOMAIN=ams.duckdns.org bash deploy/server-setup.sh
#
# What it does (idempotent — safe to re-run):
#  1. installs Docker   2. installs Caddy (auto-HTTPS)   3. builds + starts
#     the app with --restart=always   4. exposes HTTPS via Caddy on $DOMAIN
# Env:  DOMAIN (required for HTTPS) · APP_DIR (default /opt/attendwise) · PORT
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/attendwise}"
PORT="${PORT:-8080}"
IMAGE="attendwise:latest"
NAME="attendwise"
VOL="attendwise_data"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

[ -z "${DOMAIN:-}" ] && { echo "ERROR: set DOMAIN=your.hostname (http-only works but HTTPS/PWA need it)"; }

# 1. Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  (curl -fsSL https://get.docker.com | sh) >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y docker.io >/dev/null; }
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# 2. Source tree ────────────────────────────────────────────────────────────
if [ -f "server.js" ] && [ -f "Dockerfile" ]; then
  SRC="$(pwd)"
else
  SRC="$APP_DIR"
  [ -d "$SRC" ] || { say "ERROR: run this from the repo root (curl the script only when piping); no checkout at $SRC"; exit 1; }
fi

# 3. Build + run ────────────────────────────────────────────────────────────
say "Building $IMAGE from $SRC…"
docker build -t "$IMAGE" "$SRC"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker volume create "$VOL" >/dev/null
say "Starting container (auto-restart=always)…"
docker run -d --name "$NAME" --restart=always \
  -p "127.0.0.1:${PORT}:8080" \
  -v "$VOL:/app/data" \
  "$IMAGE"
sleep 3
docker exec "$NAME" wget -qO- http://127.0.0.1:8080/api/health >/dev/null \
  && say "App healthy on :$PORT" || { say "App failed to boot — logs:"; docker logs --tail 40 "$NAME"; exit 1; }

# 4. HTTPS via Caddy ────────────────────────────────────────────────────────
if [ -n "${DOMAIN:-}" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    say "Installing Caddy (auto-HTTPS)…"
    apt-get update -y >/dev/null
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg || true
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y >/dev/null && apt-get install -y caddy >/dev/null
  fi
  say "Writing Caddyfile for https://$DOMAIN …"
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	reverse_proxy 127.0.0.1:${PORT} {
		header_down X-Forwarded-Proto https
	}
}
EOF
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  say "Done. Open:  https://$DOMAIN   (first certificate issue may take ~30 s)"
else
  say "Done (no DOMAIN set). Open:  http://$(hostname -I | awk '{print $1}'):$PORT"
fi

cat <<NOTE

  Auto-restart : --restart=always (container) + caddy/systemd (web server)
  Updates      : cd $SRC && git pull && bash deploy/server-setup.sh
  Logs         : docker logs -f $NAME
  Firewall     : Oracle → networking → ingress: allow TCP 80 + 443 (HTTP-redirect + TLS)

NOTE
