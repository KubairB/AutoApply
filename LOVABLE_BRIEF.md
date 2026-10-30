# Lovable Brief — Auto-Reply frontend

What to build in Lovable. The backend is specified in `backend/README.md` and the schema in
`schema.sql`. Lovable connects to the same Supabase instance for auth and direct reads.

## Stack

- **React** (Lovable default)
- **Supabase client** for auth + direct DB reads (profiles, roles, applications)
- **Backend API calls** (fetch) for sweep, evaluate, tailor, stage — the heavy work
- **Tailwind** for styling (Lovable default)

## Supabase env in Lovable

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_BACKEND_URL=https://api.auto-reply.app   # or http://localhost:8787 locally
```

## Pages

### 1. `/signup` and `/login`

Supabase magic-link email auth. No password. After login, redirect:
- new user with no profile → `/onboarding`
- returning user → `/dashboard`

### 2. `/onboarding` (3 steps)

**Step 1: Upload CV.** Accepts `.md` or `.pdf`. If `.pdf`, call `POST /ingest/cv` which runs
pdf-to-text and returns a cleaned `cv.md` the user can edit. Saves to Supabase Storage at
`users/{user_id}/cv.md`.

**Step 2: Profile.** Fields: `legal_name`, `preferred_name`, `email` (prefilled from auth),
`phone`, `legal_address`, `work_location`, `linkedin_url`, `pronouns`, `self_identification`
(sex, race-self-described, EEO category, Hispanic/Latino, veteran status, disability status),
`compensation_floor`, `location_preferences`, `authorized_to_work_us` (bool), `needs_sponsorship`
(bool), `clearance_eligible` (bool). All optional except name, email, phone — but gently nudge:
"forms with blank fields pause for you."

**Step 3: Targets.** Target role titles (array of strings), seniority band (e.g. "PM, Mid–Senior"),
preferred ATSs (checkboxes: Greenhouse/Ashby/Lever/Workday), excluded companies (textarea),
locations (NYC, SF, Remote US — multiselect).

### 3. `/dashboard`

The main screen. Three stacks side-by-side:

**Today's candidates** (left) — results of today's sweep. Each card shows: company, role title,
score (if evaluated), band, location, flags (prior application, cap, missing bar). Actions:
"Evaluate", "Skip", "Save for later".

**In progress** (middle) — roles the user has evaluated and is working on. Shows status
(`evaluated`, `cv_tailored`, `answers_drafted`, `staged`, `submitted`, `rejected`). Actions
contextual to status: "Tailor CV", "Draft answers", "Prepare to apply", "Open in browser".

**Follow-ups due** (right) — applications where follow-up date has passed. Shows days since
applied. Action: "Draft follow-up" (future), "Mark closed-lost".

Top bar: user's week-at-a-glance counters (sweeps, evaluated, applied, follow-ups).

### 4. `/role/:id`

Full view of one role: the archived JD, the Blocks A–F report, the tailored CV preview (PDF
iframe), the drafted answers (editable textareas), the staged form payload, and a big "Open in
browser to apply" button that deep-links to the posting URL with a flag the extension picks up.

### 5. `/answers`

The answer vault. All long-form answers the user has written or Claude has drafted, grouped by
report. Each editable. "Add a new answer" with a free-text question → Claude drafts, user edits.

### 6. `/settings`

Profile edit, Stripe billing (v2), connected ATSs (future), extension install status (deep-link
to Chrome Web Store).

## Direct Supabase reads (RLS-safe)

Lovable can query these tables directly via the Supabase client — all have row-level security on
`user_id = auth.uid()`:

- `profiles` (one row per user)
- `roles` (sweep results, one row per candidate role per user)
- `evaluations` (Blocks A–F reports)
- `answers` (long-form answer vault)
- `applications` (status, follow-up schedule)
- `lessons_triggered` (which rules fired on which applications, read-only)

## Backend API calls (authenticated with the Supabase JWT)

- `POST /sweep` — run a fresh sweep for the user. Returns `{candidates: [...], funnel: {...}}`.
  Rate-limited to 1/hr per user.
- `POST /roles/:id/evaluate` — Blocks A–F against the user's CV. Returns `{score, report, flags}`.
- `POST /roles/:id/tailor` — build a tailored CV. Returns `{cv_html_url, cv_pdf_url, fact_check: 'passed'|'failed'}`.
- `POST /roles/:id/answers` — draft answers for the free-text questions on this role's form.
  Returns `{answers: [{question, answer, question_hash}]}`.
- `POST /roles/:id/stage` — prepare the extension payload. Returns `{payload_id, expires_at}`.
- `POST /ingest/cv` — upload a PDF, get back cleaned `cv.md` text.
- `GET /lessons/:ats` — fetch the lesson base for a given ATS (used by the extension, not Lovable).

All backend calls include `Authorization: Bearer <supabase JWT>`. The backend verifies the JWT
against Supabase's JWKS before responding.

## UX principles taken from career-ops

- **Flag before you spend.** Prior applications, caps, missing years bars, OTE-vs-base — surface
  these in the candidate card, before the user clicks "Evaluate".
- **Write answers to disk first.** The vault is the source of truth, not the browser tab. Every
  answer the user writes is saved before any form is staged.
- **Never auto-check an attestation.** The staged payload fills every text/select field; it leaves
  every checkbox and attestation blank for the user to review.
- **Score before applying.** Below 4.0, show the apply CTA as secondary. Above, primary.

## V1 cut

For the first ship, skip:
- Billing (Stripe)
- Extension (users use the career-ops Chrome-driven method directly, or copy answers manually)
- Lessons closed loop (seed from `modes/_custom.md`; users can't contribute yet)
- Follow-ups page (just show count on dashboard; user handles manually)

Build `/onboarding`, `/dashboard`, `/role/:id`, `/answers`, `/settings` with the direct Supabase
reads and the five backend endpoints. That's the shippable product.
