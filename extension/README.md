# extension/

Chrome extension that pre-fills job-application forms using staged payloads from the Auto-Reply backend. User reviews and clicks Submit — the extension never submits automatically.

## Why in-browser

See `../ARCHITECTURE.md` → "The three things 'auto-apply' breaks on". Short version: ATS ToS, CAPTCHAs, and attestations. A user-driven browser avoids all three.

## Status

Stub. The real build:

1. **manifest.json** — MV3, host permissions for `*.greenhouse.io`, `jobs.ashbyhq.com`, `jobs.lever.co`.
2. **content.js** — on each supported ATS, detect the job id in the URL, call `GET /roles?url={current}` to find the user's `role_id`, then `POST /roles/:id/stage` and fill the form from the returned payload.
3. **popup.html** — status indicator ("Role found: Datadog PM II — Click to fill"), big disabled Submit button that says "Your click, not ours."
4. **learn.js** — on form validation errors (e.g., "Country required when phone is set"), post the signal back to `POST /lessons/learn` so the lesson base grows.

## Form rules the content script needs on day one

Pulled from `career-ops/modes/_custom.md`:

- **Greenhouse:** entering phone makes Country required. Autofill resets name fields after a resume upload — refill after Attach returns.
- **Ashby:** `form_input` sets DOM value but not React state — must click the input, send `cmd+a`, delete, then type. Resume autofill clears fields a second time after it appears to finish.
- **Ashby Yes/No groups:** click one at a time with a short wait; batching sets only the last.
- **Datadog:** form is in a Greenhouse iframe at `careers.datadoghq.com`; use the embed URL `job-boards.greenhouse.io/embed/job_app?for=datadog&token={gh_jid}` to drive it.
- **Attestations:** NEVER check accuracy certifications, arbitration agreements, Candidate Privacy Policy understanding, or demographic processing consent. Highlight them yellow and surface a "Your click" badge.
- **CAPTCHAs:** NEVER click. Scroll to and highlight.

## Install (dev)

```bash
# Chrome → chrome://extensions → Developer mode → Load unpacked → select this folder
```
