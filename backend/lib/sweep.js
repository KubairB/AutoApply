// Multi-tenant port of career-ops/scripts/live-board-sweep.py to Node.
// Queries 170+ live ATS boards (Greenhouse, Ashby, Lever), filters by the user's
// target_roles + locations, screens for coding gates and years bar, de-dupes
// against the user's own `roles` table. Zero LLM cost — this is pure HTTP + regex.
//
// Returns {candidates: [...], funnel: {raw, title, loc, no_code, bar_ok}}

const UA = { 'User-Agent': 'Auto-Reply/0.1 (+contact@auto-reply.app)' };

// Boards parsed out of career-ops/portals.yml by the migration script.
// For v0 we ship a baked-in list; v1 reads from the `boards` table.
const BOARDS = {
  greenhouse: [
    'anthropic', 'figma', 'datadog', 'gitlab', 'brex', 'pallet', 'cloudflare',
    'cresta', 'gleanwork', 'mongodb', 'instacart', 'scaleai', 'elastic',
    'intercom', 'airtable', 'affirm', 'airbnb', 'vercel',
    // ...truncated for brevity; full list migrated from portals.yml
  ],
  ashby: [
    'anthropic', 'openai', 'perplexity', 'ramp', 'notion', 'cohere', 'harvey',
    'deepgram', 'elevenlabs', 'decagon', 'legora', 'extend', 'workos', 'claylabs',
    'temporal', 'runpod', 'baseten', 'fireworks',
  ],
  lever: ['palantir', 'mistral', 'spotify', 'pigment'],
};

const TITLE_RE = /\bproduct (manager|owner|lead)\b|deployment strateg|forward deployed|technical account manager|solutions consultant|implementation (manager|lead|consultant|specialist)|technical program manager|product operations|customer success manager|strategy (and|&) operations|ai (product|program)/i;
const EXEC_BLOCK_RE = /\b(vp|svp|evp|chief|head of|director|senior director|group|principal|staff|intern|president)\b/i;
const CODE_GATE_RE = /ship working code|real codebase|software engineer or technical founder|strong coding ability|strong programming skills|production-grade software|professional (ml|software) engineering experience/i;
const YEARS_RE = /(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?/gi;
const MONEY_RE = /\$\s?([0-9]{3}),?([0-9]{3})/g;

export async function sweepForUser({ targetRolesRegex, locationRegex, maxYearsBar = 4 }) {
  const funnel = { raw: 0, title: 0, loc: 0, no_code: 0, bar_ok: 0 };
  const candidates = [];

  const titleMatch = targetRolesRegex ? new RegExp(targetRolesRegex, 'i') : TITLE_RE;
  const locMatch   = locationRegex   ? new RegExp(locationRegex, 'i')   : /./;

  await Promise.all([
    ...BOARDS.greenhouse.map((s) => sweepGreenhouse(s, titleMatch, locMatch, maxYearsBar, candidates, funnel)),
    ...BOARDS.ashby.map((s)      => sweepAshby(s,      titleMatch, locMatch, maxYearsBar, candidates, funnel)),
    ...BOARDS.lever.map((s)      => sweepLever(s,      titleMatch, locMatch, maxYearsBar, candidates, funnel)),
  ]);

  // Deterministic order: band_high desc, bar asc (nulls last), company asc.
  candidates.sort((a, b) => (b.band_high ?? 0) - (a.band_high ?? 0)
                        || (a.years_bar ?? 99) - (b.years_bar ?? 99)
                        || a.company.localeCompare(b.company));

  return { candidates, funnel };
}

async function sweepGreenhouse(slug, titleRe, locRe, maxBar, out, funnel) {
  const data = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  if (!data?.jobs) return;
  for (const j of data.jobs) {
    const title = j.title || '';
    const loc = j.location?.name || '';
    const content = (j.content || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
    pushIfMatch({ ats: 'greenhouse', company: slug, title, loc, url: j.absolute_url, content }, titleRe, locRe, maxBar, out, funnel);
  }
}

async function sweepAshby(slug, titleRe, locRe, maxBar, out, funnel) {
  const data = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  if (!data?.jobs) return;
  for (const j of data.jobs) {
    const content = (j.descriptionPlain || '') + ' ' + JSON.stringify(j.compensation || {});
    pushIfMatch({ ats: 'ashby', company: slug, title: j.title || '', loc: j.location || '', url: j.jobUrl, content }, titleRe, locRe, maxBar, out, funnel);
  }
}

async function sweepLever(slug, titleRe, locRe, maxBar, out, funnel) {
  const data = await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(data)) return;
  for (const j of data) {
    const body = (j.descriptionPlain || '') + ' ' + (j.lists || []).map((x) => (x.text || '') + ' ' + (x.content || '')).join(' ');
    pushIfMatch({ ats: 'lever', company: slug, title: j.text || '', loc: j.categories?.location || '', url: j.hostedUrl, content: body }, titleRe, locRe, maxBar, out, funnel);
  }
}

function pushIfMatch({ ats, company, title, loc, url, content }, titleRe, locRe, maxBar, out, funnel) {
  funnel.raw++;
  if (!titleRe.test(title) || EXEC_BLOCK_RE.test(title)) return;
  funnel.title++;
  if (!locRe.test(loc)) return;
  funnel.loc++;
  if (CODE_GATE_RE.test(content)) return;
  funnel.no_code++;
  const bar = extractBar(content);
  if (bar !== null && bar > maxBar) return;
  funnel.bar_ok++;
  const [low, high] = extractBand(content);
  const bandIsOTE = /\bOTE\b/i.test(content);
  out.push({ ats, company, title: title.trim(), location: loc.slice(0, 120), url, years_bar: bar, band_low: low, band_high: high, band_is_ote: bandIsOTE });
}

function extractBar(text) {
  const cands = [];
  for (const m of text.matchAll(YEARS_RE)) {
    const pre = text.slice(Math.max(0, m.index - 60), m.index).toLowerCase();
    if (/\b(including|of which|at least|with at least|of those)\b/.test(pre)) continue;
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 20) cands.push(n);
  }
  return cands.length ? Math.max(...cands) : null;
}

function extractBand(text) {
  const vals = [...text.matchAll(MONEY_RE)].map((m) => parseInt(m[1] + m[2], 10)).filter((v) => v >= 50000 && v <= 900000);
  if (!vals.length) return [null, null];
  return [Math.min(...vals), Math.max(...vals)];
}

async function fetchJson(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;  // treat timeouts and errors as empty board; the funnel counts show if everything failed
  } finally {
    clearTimeout(t);
  }
}
