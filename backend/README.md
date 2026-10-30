# backend/

Node + Hono API for Auto-Reply.

## Run locally

```bash
cp .env.example .env    # fill in SUPABASE_*, DATABASE_URL, ANTHROPIC_API_KEY
npm install
npm run schema          # runs ../schema.sql against DATABASE_URL
npm run dev             # http://localhost:8787
curl http://localhost:8787/health
```

## Deploy to Fly.io

```bash
fly launch                              # answer prompts, no DB yet
fly secrets set $(cat .env | xargs)
fly deploy
```

## Endpoints

All require `Authorization: Bearer <supabase_jwt>` except `/health`.

| Verb | Path | Purpose |
|---|---|---|
| GET  | `/health` | liveness |
| POST | `/sweep` | fresh sweep for the authed user, writes to `roles` |
| POST | `/roles/:id/evaluate` | Blocks A–F via Claude |
| POST | `/roles/:id/tailor` | tailored CV HTML |
| POST | `/roles/:id/answers` | draft an answer (reuses existing by question hash) |
| POST | `/roles/:id/stage` | prepare the extension payload |
| GET  | `/lessons/:ats` | lesson base for an ATS (used by the extension) |

## What's intentionally missing in v0

- **Supabase Storage integration for CV/PDF files.** The tailor endpoint returns HTML inline; v1 writes to Storage and renders PDF in a worker.
- **JD scraping.** `evaluate` and `tailor` require `roles.jd_text` to be pre-populated; v1 adds a scraper that uses career-ops's `fetch-jd.mjs` logic.
- **Fact-check.** v1 ports `verify-cv-facts.mjs` to run against the tailored HTML before returning it.
- **Lesson learning loop.** v1 adds `POST /lessons/learn` for the extension to report new form behaviours.
- **Rate limiting.** The sweep is expensive-ish (170 boards); v1 adds per-user 1/hr limiter.
- **BullMQ queue** for the sweep so it doesn't block the request thread.

## Reusing the existing career-ops .mjs scripts

Several things in v1 don't need porting — just `spawn` them with the right `CAREER_OPS_ROOT`:

- `generate-pdf.mjs` for HTML → PDF
- `verify-cv-facts.mjs` for fact-check
- `screen-years-bar.mjs` for the regex-based years bar screen

Keep the career-ops repo as a git submodule under `backend/vendor/career-ops`, set
`CAREER_OPS_ROOT=/tmp/users/{user_id}` per request, and shell out. Zero code duplication.
