# Auto-Reply — Architecture

## System

```
┌──────────────────────────────┐
│  Lovable frontend (React)    │  — profile, dashboard, role review, answer vault UI
└──────────────┬───────────────┘
               │  Supabase client (auth, direct DB reads)
               ▼
┌──────────────────────────────┐
│  Postgres (Supabase)         │  — users, profiles, roles, applications, lessons, answers
└──────────────┬───────────────┘
               │  shared schema (RLS enforced)
               ▲
┌──────────────┴───────────────┐
│  Node backend (Hono)         │  — this project, backend/
│                              │
│  • /sweep       zero-LLM job-board scan over 170+ boards
│  • /evaluate    Blocks A–F scoring against user CV
│  • /tailor      Claude-authored role-specific CV (HTML → PDF)
│  • /answers     long-form answer vault (crash-safe, versioned)
│  • /stage       pre-fill payload for the Chrome extension
└──────────────┬───────────────┘
               │
               ▼
┌──────────────────────────────┐
│  User's Chrome extension     │  — pulls staged payload, fills form in user's own browser,
│  (installs from Web Store)   │    user reviews and clicks Submit themselves
└──────────────────────────────┘
```

## The three things "auto-apply" breaks on

Before anything else — these shape every architectural decision below.

### 1. ATS Terms of Service

Greenhouse's acceptable-use policy and Ashby's and Lever's ToS all prohibit automated submission.
A hosted Playwright worker running against their APIs or forms gets:
- the hosting IP range flagged within days
- the *employer's* ATS account warned or suspended (worse than losing one applicant)
- in Greenhouse's case, legal letters to the operator

**Decision:** no hosted browser worker. All form interaction happens in the **user's own Chrome**,
via an extension they install. The ATS sees a normal user session from a normal residential IP.

### 2. CAPTCHAs

Palantir uses hCaptcha (interactive). Lever applications across the board use hCaptcha. Greenhouse
embeds reCAPTCHA v3 (invisible but can escalate on signal). Ashby runs v3 (invisible). Headless
browsers trip these at scale — CAPTCHA farms exist but are a ToS violation on both sides and
illegal in some jurisdictions.

**Decision:** CAPTCHAs are the user's click, always. The extension stops at the CAPTCHA; the user
completes it and submits.

### 3. Attestations

Every form has fields only the applicant can truthfully complete: arbitration agreements, accuracy
certifications ("I personally completed this application"), demographic consents, salary
expectations when the user has a floor, assessment questions, "why do you want to work here"
answers at employers that forbid AI assistance (Perplexity: permanent DQ).

The `career-ops` project encodes this as a durable rule (`modes/_custom.md:143 Submission Policy`,
`:565 Consent and attestation fields — where the line sits`). Multi-user, this isn't optional
house style — it's load-bearing. A user whose "I personally completed this" was auto-checked by
a service has a wrongful-termination suit if discovered post-hire.

**Decision:** the extension renders every attestation as unchecked and asks the user to review
each. V2 can add a "pre-authorise role N for auto-submit" flow mirroring career-ops clause 1 —
the user names a role in advance, the extension still presents the attestations, the user still
clicks them. The service never checks them without a present human.

## Multi-tenancy

The existing career-ops code was designed with `CAREER_OPS_ROOT` env var overriding the data
root (see `path-resolver.mjs`). Multi-user is enabled by giving each user their own working
directory on object storage and setting `CAREER_OPS_ROOT` per request. The .mjs scripts don't
need to change.

| Resource | Per-user path |
|---|---|
| CV source | `s3://auto-reply/users/{id}/cv.md` |
| Profile | `s3://auto-reply/users/{id}/config/profile.yml` |
| Reports | `s3://auto-reply/users/{id}/reports/*.md` |
| Tailored PDFs | `s3://auto-reply/users/{id}/output/*.pdf` |
| Answers | `s3://auto-reply/users/{id}/data/answers/*.md` |

Postgres holds the index (which roles were evaluated, which applications are staged, status
history, follow-up schedule, lessons triggered). Files hold the human-readable artefacts the
user owns and can export.

## Lessons engine

The 60+ rules in `career-ops/modes/_custom.md` are the moat. They're currently prose. For the
product they move into a structured table:

```sql
CREATE TABLE lessons (
  id            BIGSERIAL PRIMARY KEY,
  ats           TEXT NOT NULL,              -- 'greenhouse', 'ashby', 'lever', 'workday'
  employer      TEXT,                       -- null = applies to all employers on this ATS
  trigger       JSONB NOT NULL,             -- {field: 'phone', action: 'any_value'} etc.
  rule          TEXT NOT NULL,              -- 'country-required-when-phone-set'
  action        JSONB NOT NULL,             -- {field: 'country', set_to: 'United States'}
  evidence_url  TEXT,                       -- the posting that proved it
  learned_at    TIMESTAMPTZ DEFAULT now()
);
```

The extension pulls lessons for the current ATS on every form it sees. New lessons are learned
by watching for submit-failures and feeding the error back to the lessons API — the system gets
smarter with every submission across the entire user base, not just one.

## Data flow for a single application

1. **User sign-up** → Lovable collects CV upload + archetype preferences → stored in Postgres + S3.
2. **Nightly sweep** → backend cron runs `sweep` for each user → writes candidate roles to `roles` table.
3. **User reviews** → Lovable dashboard lists today's candidates with score + band + flags.
4. **User approves** → clicks "Evaluate" → backend runs Blocks A–F via Claude → report stored.
5. **User clicks "Tailor"** → backend builds role-specific CV with Claude, PDF via `generate-pdf.mjs`, fact-check via `verify-cv-facts.mjs`.
6. **User clicks "Draft answers"** → backend reads JD, generates answers for free-text questions, writes to answers vault.
7. **User clicks "Prepare"** → backend stages payload (resume URL, field map, answer blobs) in `stage` endpoint.
8. **User opens the role URL** in Chrome → extension detects ATS, pulls staged payload, fills form.
9. **User reviews, completes attestations and CAPTCHA, hits Submit.** Extension posts result back
   to backend → `applications` table updated → follow-up seeded.

## Infrastructure

| Layer | Choice | Why |
|---|---|---|
| Frontend | Lovable → React → Vercel/Lovable hosting | user's stated choice |
| Auth + DB | Supabase | native Lovable integration, RLS for free |
| Backend | Node 20 + Hono on Fly.io | lightweight, keeps existing .mjs executable |
| LLM | Anthropic Claude (Sonnet 5 default, Opus 5 for high-stakes tailoring) | existing codebase uses it; evaluation framework is tuned to it |
| File storage | Supabase Storage (S3-compatible) | per-user buckets with RLS |
| Jobs | node-cron for v1, BullMQ+Redis for v2 | start simple |
| Browser automation | Chrome extension (user-installed) | avoids ToS, CAPTCHA, IP-reputation issues |

## What's shipped in this scaffold

- `backend/` — Node + Hono API with `/sweep`, `/profile`, `/roles`, `/answers`, `/stage` endpoints
- `schema.sql` — Postgres schema (run against your Supabase instance)
- `extension/` — placeholder with the required manifest and a stubbed content script
- `LOVABLE_BRIEF.md` — exact spec for the Lovable frontend

## Roadmap

**v0 (this scaffold)** — single-user, local-first, proves the backend shape.
**v1 (2 weeks)** — Supabase auth, S3 storage per user, hosted on Fly, Lovable connects.
**v2 (1 month)** — Chrome extension published, lesson-learning closed loop, Stripe billing.
**v3 (2 months)** — approved-list auto-submit (user whitelists roles, extension still handles attestations), outbound email draft for recruiter responses.
**v4 (quarter)** — enterprise mode for recruiting agencies (candidate pool management, placement tracking).
