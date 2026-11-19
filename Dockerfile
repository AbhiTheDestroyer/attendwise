# AttendWise — single-container deploy (one Node process + embedded SQLite).
# Deps: build happens inside the container only; base is Debian (glibc) so the
# better-sqlite3 prebuilt binary always matches — never needs a compiler.
FROM node:20-slim
WORKDIR /app

# Install the single runtime dependency
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# App code (demo seed auto-runs on first boot if the database is empty)
COPY . .

ENV NODE_ENV=production \
    PORT=8080 \
    COOKIE_SECURE=false \
    SIMULATE_NOTIFICATIONS=true

# Optional persistence (keeps DB across redeploys):  docker run -v ams_data:/app/data
# (On Render free tier there is no persistent disk — see deploy/DEPLOY-RENDER.md)
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
