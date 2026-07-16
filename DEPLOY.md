# Deploy runbook — kira-ledger on Fly.io

This is a copy-pasteable runbook to get a **live public URL** for the
kira-ledger Fastify service, with separate **staging** and **prod** apps.

- App (server contract): Node 20, Fastify, listens on `PORT` (default `3000`),
  liveness `GET /healthz`, readiness `GET /readyz`.
- Built from the `Dockerfile` at the repo root.
- IaC: a single `fly.toml` shared by both apps; the target is chosen with the
  `--app` flag at deploy time (see "Why one fly.toml" below).

Two apps:

| Environment | Fly app name          | Public URL                              |
|-------------|-----------------------|-----------------------------------------|
| Staging     | `kira-ledger-staging` | https://kira-ledger-staging.fly.dev     |
| Prod        | `kira-ledger-prod`    | https://kira-ledger-prod.fly.dev        |

---

## 0. Prerequisites (one time)

Install flyctl and log in:

```bash
# macOS / Linux
curl -L https://fly.io/install.sh | sh
# (or: brew install flyctl)

fly auth login
```

---

## 1. Bring STAGING live (do this first)

### 1a. Create the app

```bash
fly apps create kira-ledger-staging
```

> `fly launch` also works, but it tries to auto-generate a fly.toml. We already
> have one, so use `fly apps create` + `fly deploy` and keep our config.

### 1b. Provision managed Postgres and attach it

```bash
# Create a managed Postgres cluster (pick the same region as the app, iad).
fly postgres create --name kira-ledger-db-staging --region iad

# Attach it to the app. This AUTO-SETS the DATABASE_URL secret on the app.
fly postgres attach kira-ledger-db-staging --app kira-ledger-staging
```

> **Fallback if Fly Postgres misbehaves** (Fly PG is unmanaged MPG and can be
> flaky on free tiers): use **Supabase** or **Neon** instead — create a
> database there, copy its connection string, and set it manually:
>
> ```bash
> fly secrets set DATABASE_URL="postgres://user:pass@host:5432/db?sslmode=require" \
>   --app kira-ledger-staging
> ```

### 1c. Set application secrets

```bash
fly secrets set \
  API_KEY="replace-with-real-key" \
  WEBHOOK_SECRET="replace-with-real-secret" \
  CONFIRMATIONS="12" \
  --app kira-ledger-staging
```

> `DATABASE_URL` is already set by `fly postgres attach` (step 1b) — do not set
> it again here unless you are using the Supabase/Neon fallback.

### 1d. Deploy

```bash
fly deploy --app kira-ledger-staging
```

### 1e. Get the URL and verify it is live

```bash
fly status --app kira-ledger-staging
fly open  --app kira-ledger-staging          # opens the URL in a browser

curl https://kira-ledger-staging.fly.dev/healthz   # expect 200 OK
curl https://kira-ledger-staging.fly.dev/readyz    # expect 200 once DB is reachable
```

You now have a live public staging URL. 🎉

---

## 2. Promote to PROD

Same sequence with the `-prod` names. Do this only after staging looks healthy.

```bash
fly apps create kira-ledger-prod

fly postgres create  --name kira-ledger-db-prod --region iad
fly postgres attach  kira-ledger-db-prod --app kira-ledger-prod

fly secrets set \
  API_KEY="replace-with-PROD-key" \
  WEBHOOK_SECRET="replace-with-PROD-secret" \
  CONFIRMATIONS="12" \
  --app kira-ledger-prod

fly deploy --app kira-ledger-prod

curl https://kira-ledger-prod.fly.dev/healthz
```

---

## 3. GitHub Actions CI/CD

Workflow: `.github/workflows/ci.yml`.

- **On every push and PR to `main`:** `npm ci` → `npx tsc --noEmit` → `npm test`.
- **On push to `main` (after tests pass):** auto-deploy to **staging**
  (`flyctl deploy --app kira-ledger-staging --remote-only`).
- **Prod:** NOT automatic. Deploy prod either from your laptop
  (`fly deploy --app kira-ledger-prod`) or via the manual gate: Actions tab →
  "CI" → "Run workflow" → set `deploy_prod = true`.

### Why prod is not auto-deployed

kira-ledger moves money (ledger balances, webhooks, confirmations). A green
build on `main` is necessary but not sufficient to release to prod. We require a
human to (1) verify the change on the live staging URL and (2) choose the
release moment. The `deploy-prod` job is additionally wrapped in a GitHub
`production` Environment — add required reviewers there to force an approval
click before prod ships.

### Set the Fly deploy token as a repo secret

```bash
# Create a scoped deploy token (works for both apps under your org).
fly tokens create deploy --app kira-ledger-staging
```

Copy the printed token (starts with `FlyV1 ...`), then in GitHub:

**Repo → Settings → Secrets and variables → Actions → New repository secret**
- Name: `FLY_API_TOKEN`
- Value: the token you just created

(For a token that can deploy both apps, create an org-scoped token instead:
`fly tokens create org <your-org>`.)

---

## Why one fly.toml (not two)

The runtime shape — Node 20, port 3000, `/healthz` + `/readyz` checks, VM size —
is identical across environments. Only per-app values (secrets, `DATABASE_URL`,
scaling) differ, and those live in Fly app config / secrets, not in the TOML. A
single `fly.toml` with `--app <name>` at deploy time avoids drift between two
near-duplicate files. `fly.toml`'s `app = "kira-ledger-staging"` is just a
default; `--app` always overrides it.

---

## Quick reference — get staging live in ~6 commands

```bash
fly auth login
fly apps create kira-ledger-staging
fly postgres create --name kira-ledger-db-staging --region iad
fly postgres attach kira-ledger-db-staging --app kira-ledger-staging
fly secrets set API_KEY=... WEBHOOK_SECRET=... CONFIRMATIONS=12 --app kira-ledger-staging
fly deploy --app kira-ledger-staging
curl https://kira-ledger-staging.fly.dev/healthz
```
