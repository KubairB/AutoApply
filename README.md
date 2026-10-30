# ApplyAssist

Productised version of the career-ops workflow — multi-tenant, API-first, Lovable-native frontend.

## What it does

1. **Finds roles** — sweeps 170+ ATS boards (Greenhouse, Ashby, Lever) for roles matching the user's archetypes, screens for coding gates, years bars, and known blockers.
2. **Evaluates** — scores each role against the user's CV (Blocks A–F), flags OTE-vs-base, caps and prior applications.
3. **Tailors** — builds a role-specific CV HTML/PDF with Claude, fact-checked against sources.
4. **Drafts answers** — generates long-form application answers from the user's record, saved to a durable vault.
5. **Pre-fills** — pushes staged form data to a user-installed Chrome extension; the user reviews and clicks Submit.

## Architecture (short version)

```
Lovable frontend (React)
    ↓ Supabase auth + direct DB reads
Postgres (Supabase)
    ↑ shared schema
Node backend (this directory)
    ↓
├── Job-board sweep (zero LLM)
├── Claude API (CV tailoring, answer drafting)
├── CV builder (reuses existing .mjs scripts)
└── Form stager (serves to extension)
    ↓
User's Chrome extension
    ↓ fills form in user's own browser
User reviews and submits
```

See `ARCHITECTURE.md` for the full design, trade-offs and roadmap.
See `LOVABLE_BRIEF.md` for the exact UI/UX the frontend needs to build.
See `backend/README.md` to run the API locally.

## Why "apply-assist" and not "auto-apply"

See `ARCHITECTURE.md` → "The three things 'auto-apply' breaks on." Short version: ATS ToS, CAPTCHAs, and attestations the user must personally make. Pre-fill-and-review is the shape that ships without landing accounts in bot-detection or users in permanent-disqualification.

## Status

v0 scaffold — the sweep, Claude wrapper, DB schema and REST API all work. The Chrome extension is a stub; the Lovable frontend is a spec in `LOVABLE_BRIEF.md`.

## License

TBD. The underlying career-ops project is MIT, owned by santifer. This productisation is a derivative work; consult the career-ops LICENSE before commercialising.
