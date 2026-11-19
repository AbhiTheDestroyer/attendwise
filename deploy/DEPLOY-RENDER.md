# AttendWise on Render — permanent link, ₹0, no card (your chosen route)

You get a real URL like **`https://attendwise.onrender.com`** (Render picks the exact name; you choose it). It never expires and requires no card — only a free GitHub + free Render account.

**Two trade-offs you accepted (honest facts, not fine print):**
1. **Sleep/wake lag:** the free service sleeps after ~15 min idle. First visit after sleep = 30–60 s cold start. Browsing after that is fast.
2. **Demo-grade data:** free tier has no persistent disk — attendance entered into the demo database resets to the seeded data if Render restarts/redeploys the service. Fine for demos/exploring; for *real student record-keeping* plan the ₹300/mo VPS path (`deploy/DEPLOY.md` runs on it identically) or Oracle Always-Free when a card becomes possible.

---

### Step 1 — GitHub (free, ~3 min)
1. Go to **github.com** → *Sign up* → verify your email.
2. Create a repository: top-right **+ → New repository**. Name: **`attendwise`** (any name works), Override: *Private* is fine, press **Create repository**.
3. On the empty-repo page, click the small link **“uploading an existing file”**.
4. In this workspace, download **`attendwise-upload.zip`**, extract it, and in a Chrome/Firefox window **drag the whole extracted `attendwise` folder** onto GitHub's upload box (a folder drags all files with structure). **Commit changes**.

### Step 2 — Render (free, ~5 min)
1. Go to **render.com** → *Get Started* → sign up **with GitHub** (OAuth; no card).
2. Dashboard → **New + → Blueprint** (this reads our `render.yaml` automatically).
   - Connect the `attendwise` repo (Render will ask to install on your GitHub account — approve).
   - **Name your service `attendwise`** → your URL will be `https://attendwise.onrender.com`. (If taken, use `attendwise-app`, `git-ams`, etc.)
   - **Apply.** The Docker build runs 3–6 minutes (first deploy only).
3. When the status shows **Live**, click the URL it gives you → AttendWise login page.

### Step 3 — 5-minute safety checklist (do this before sharing)
- Log in as **admin@git.edu / Admin@123** → **Profile → Change password** (do the same for the teacher demo login `anil.verma@git.edu / Teacher@123`, or delete/rename these demo users in **Settings → Users** and add real staff).
- Replace the seeded students with your real CSV import (**Import** tab) — the `samples/` files are only demos.
- Notifications: with no provider credentials they run in the honest **log/simulation** mode (footer badge says so). Real WhatsApp/SMS/email → set the environment variables from `.env.example` in Render → your service → **Environment**.

### Done
Your permanent link: **`https://<name-you-picked>.onrender.com`** — any device, anywhere, forever at ₹0. To update the app: push changes to the GitHub repo → Render auto-redeploys.

**Cold-start tip:** install the PWA on a phone and open it once each morning — one visit wakes the service, and parents never see the lag.
