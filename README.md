# AttendWise — Attendance Management System

A complete, production-ready attendance system for educational institutions: multi-department, multi-section, multi-semester — teachers mark attendance manually or import institution-format CSV/XLSX sheets through a strict **upload → validate → human review → confirm** pipeline; per-subject attendance is computed with exact integer arithmetic; defaulters below configurable thresholds are surfaced in real time; parents are notified through honestly-reported channels; and **every change is recorded in a permanent audit log**.

## Quick start

```bash
npm ci              # installs better-sqlite3 (the single runtime dependency)
npm test            # 42 tests: boundary math, parsing, matching, notifications, full API
npm start           # serves http://localhost:3000 (auto-seeds a demo institution on first run)
```

Open http://localhost:3000 and sign in (demo data):

| Role | Email | Password |
|---|---|---|
| Admin | `admin@git.edu` | `Admin@123` |
| Teacher (GIT CSE Sem-3 subjects) | `anil.verma@git.edu` | `Teacher@123` |

> First login on any account forces a new CSRF token; all passwords are demo-only — change them immediately in production (`NODE_ENV=production` + `AUTH_SECRET` set in `.env`).

Working sample sheets for the import console are in [`samples/`](samples/):

- `cs301-midterm-matrix.csv` — matrix sheet for **CS301** (includes an unknown roll, a roll-only ambiguous match, a duplicate row and an invalid mark — review console shows each)
- `cs302-long-format.csv` — long format for **CS302** with enrollment numbers and mixed date formats
- `new-students-batch.csv` — student bulk upsert (contains a repeat enrollment (upsert demo) + a row missing one on purpose)

## What's inside

| Layer | Tech | Notes |
|---|---|---|
| Backend | Node 20, stdlib `http` router | no framework; `src/app.js` assembles routes |
| DB | SQLite (`better-sqlite3`, WAL) | single runtime dep; FK + CHECK + UNIQUE enforced |
| Frontend | dependency-free SPA (`public/`) | light/dark, SVG charts, keyboard-accessible tables |
| Auth | scrypt sessions (HttpOnly cookie), CSRF token, rate-limited login | forgot/reset flow, optional TOTP field ready |
| Tests | `node --test` → **42 passing** | 74.9/75.0/75.1 exactness, parsing fuzz, notification dedupe, API e2e |



## Sharing it publicly (deployment)

**→ Complete zero-cost permanent-hosting walkthrough: [deploy/DEPLOY.md](deploy/DEPLOY.md)** (Oracle Always-Free + DuckDNS + auto-HTTPS, ~15 min, ₹0 forever).

The dev preview (`https://8080-<sandbox>.e2b.app`) is **private to the signed-in Arena user** by design — others get HTTP 403. To give parents/teachers a real link, deploy the single container anywhere:

```bash
docker build -t attendwise .
docker run -d -p 8080:8080 --name attendwise -v ams_data:/app/data attendwise
# app is now on http://your-host:8080 (put HTTPS in front — Caddy/Nginx — for PWA install + secure cookies)
```

One-click PaaS options (Render/Fly.io/Railway/all fine with the `Dockerfile`): service type *web*, port **8080**, health-check path **`/api/health`**. The seed creates the demo institution on first boot; for production set `SIMULATE_NOTIFICATIONS=false` and configure real providers in the environment (`.env.example`), then import students via **Import**.

## Mobile / desktop app (PWA)

AttendWise **is** an installable app — a full Progressive Web App (manifest + service-worker app shell). Open it over HTTPS and:

- **Android (Chrome/Edge):** tap "Install app" banner or menu → *Install app* / *Add to Home screen*. Launches fullscreen, own icon, no browser chrome.
- **iOS (Safari):** Share → *Add to Home Screen* — icon works like a native app.
- **Desktop (Chrome/Edge):** install icon in the address bar (or menu → *Install AttendWise*).

The service worker caches only the app shell; **all /api/ traffic is strictly network** (no stale sessions, no cached 401s — learned the hard way) and shows an honest "offline" message when the connection drops. Play-Store-style native packaging is possible by wrapping the same web app with **Capacitor** (`npm i @capacitor/core @capacitor/cli`, point `webDir` at `public/`) if store distribution is ever needed.

### Student / parent self-service lookup (no login)

Public page at ****: parents or students check attendance with **enrollment/roll number + date of birth**. Hardened by design: hard rate limit of 5 attempts / 10 min / IP, an identical error message whether the number or the DOB is wrong (no hinting which), and minimal exposure — it returns only attendance views, never parent contact details or internal ids. DOB is set by the admin (student add/edit form, or the `dob` column in CSV import) and is seeded for demo students.

### Data honesty (reads the noisy world carefully)

- Import **never writes directly**: staged rows get per-row findings (unknown roll, ambiguous name match, duplicate, invalid mark, conflict with existing record, out-of-section roll, impossible date). You fix or ignore rows in the review console; only then does a transaction copy them into `attendance_records`. Conflicting rows prompt **Keep existing / Replace (audited)**.
- PDF/photo scans are **declined with a clear message** — no fake OCR.
- Notifications are **webhook-based** (`EMAIL_WEBHOOK_URL` / `SMS_WEBHOOK_URL` / `WHATSAPP_WEBHOOK_URL` in `.env`). With `SIMULATE_NOTIFICATIONS=true` messages are written to `data/notifications.log` and flagged as such. With nothing configured, sends fail **visibly** with the reason — the UI never claims a message went out when it didn't.
- Rules fire on **meaningful state changes only** (crossing below threshold, re-arming above, new absence streak, recovery) — page refreshes, recalcs and restarts cannot spam parents. Cross-subject "overall" alerts dedupe to one message per student per day.

### Attendance math (exact at the boundary)

Percentages are recomputed from records on every read — never stored as a percentage. Holiday/Cancelled classes are excluded; Excused counts as attended. Threshold comparisons use integer cross-multiplication (`present*100 >= total*threshold`), so **75.0 is compliant, 74.99… is not**. Per-subject threshold overrides supported.

### Roles

- **Admin** — everything: users, subjects, students, imports, thresholds, rules, templates, audit log, reports, settings.
- **Teacher** — their assigned subjects: take/edit attendance, own imports, defaulters + notifications for their students, reports, student profiles.

## Configuration

Copy `.env.example` → `.env`. Highlights:

```bash
PORT=3000
AUTH_SECRET=change-me            # required in production
DEMO_SEED=true                   # seed demo institution when DB is empty
SIMULATE_NOTIFICATIONS=true      # log provider instead of webhooks
EMAIL_WEBHOOK_URL=               # POST {to,subject,body} endpoints your infra provides
SMS_WEBHOOK_URL=
WHATSAPP_WEBHOOK_URL=
WEBHOOK_TOKEN=
TIMEZONE=Asia/Kolkata
ALERT_THRESHOLD=75               # institution default; overridable per subject in Settings
```

## Repository layout

```
src/            backend (router, routes, calc, parsing, matching, notify, seed, xlsx, dashboard)
public/         SPA (styles.css, js/core.js, js/pages1-3.js)
samples/        demo CSV sheets for the import console
test/           node:test suites (42 tests)
data/           sqlite db + notifications.log (created at runtime)
```

## API sketch

All endpoints return JSON `{...}` or `{error:{code,message,details}}`; mutating calls require `x-csrf-token`. Full list in `src/app.js` route registry — key ones:

`POST /api/auth/login|logout|forgot|reset` · `GET/PUT auth/me|password|mfa` ·
`GET /api/dashboard` · `GET/POST /api/students` · `GET/PUT/DELETE /api/students/:id` · `POST /api/students/import` ·
`GET/POST /api/subjects` · `GET /api/meta` · `GET /api/attendance` · `GET /api/attendance/roster` ·
`POST /api/attendance/bulk` · `PUT/DELETE /api/attendance/:id` · `GET /api/attendance/defaulters` ·
`POST /api/attendance/import` · `GET /api/attendance/import/:id` · `PUT …/rows/:rowId` · `POST …/confirm|cancel` ·
`GET /api/notifications` · `POST /api/notifications/send|test` · `POST /api/notifications/:id/retry` ·
`GET/POST /api/notification-rules` · `GET/PUT /api/notification-templates` · `GET /api/audit-logs` ·
`GET /api/reports/monthly|defaulters|subject-attendance` · `GET /api/settings[/thresholds]` (+admin writes)
```

*Built to be boring in the best way: deterministic math, explicit review queues, honest failure states, and an audit row for everything.*
