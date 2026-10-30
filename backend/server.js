// Auto-Reply backend. Hono on Node.
//
// Endpoints (all require Supabase JWT auth except /health):
//   GET  /health
//   POST /sweep                       — run a fresh sweep, write candidates to roles
//   POST /roles/:id/evaluate          — Blocks A–F with Claude
//   POST /roles/:id/tailor            — build a tailored CV
//   POST /roles/:id/answers           — draft answers for form free-text questions
//   POST /roles/:id/stage             — stage form payload for the extension
//   POST /ingest/cv                   — upload a CV markdown/pdf, store
//   GET  /lessons/:ats                — fetch lesson base for an ATS (extension)
//
// All reads are available via direct Supabase queries from the Lovable frontend
// using RLS; this backend only owns writes and the LLM-shaped compute.

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { sql, audit } from './lib/db.js';
import { requireAuth } from './lib/auth.js';
import { sweepForUser } from './lib/sweep.js';
import { tailorCV, draftAnswer, evaluateRole } from './lib/claude.js';
import { createHash } from 'node:crypto';

const app = new Hono();
app.use('*', cors({ origin: process.env.FRONTEND_ORIGIN || '*', credentials: true }));

app.get('/health', (c) => c.json({ ok: true, now: new Date().toISOString() }));

// ─── Sweep ────────────────────────────────────────────────────────────────
app.post('/sweep', requireAuth, async (c) => {
  const user_id = c.get('user_id');
  const [profile] = await sql`SELECT target_roles, office_preference FROM profiles WHERE user_id = ${user_id}`;
  if (!profile) return c.json({ error: 'no_profile' }, 400);

  // Build regexes from the user's targets. If no targets set, use the sweep's default archetypes.
  const targetRolesRegex = profile.target_roles?.length
    ? profile.target_roles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    : null;
  const locationRegex = (profile.office_preference || 'New York|Remote').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const { candidates, funnel } = await sweepForUser({ targetRolesRegex, locationRegex });

  // Insert new candidates; conflict on (user_id, url) keeps the existing row.
  let inserted = 0;
  for (const r of candidates) {
    const result = await sql`
      INSERT INTO roles (user_id, url, ats, company, title, location, band_low, band_high, band_is_ote, years_bar, status)
      VALUES (${user_id}, ${r.url}, ${r.ats}, ${r.company}, ${r.title}, ${r.location}, ${r.band_low}, ${r.band_high}, ${r.band_is_ote}, ${r.years_bar}, 'candidate')
      ON CONFLICT (user_id, url) DO NOTHING
      RETURNING id
    `;
    inserted += result.count;
  }
  audit(user_id, 'sweep', { funnel, candidates: candidates.length, inserted });
  return c.json({ funnel, candidates: candidates.length, inserted });
});

// ─── Evaluate ─────────────────────────────────────────────────────────────
app.post('/roles/:id/evaluate', requireAuth, async (c) => {
  const user_id = c.get('user_id');
  const role_id = parseInt(c.req.param('id'), 10);
  const [role] = await sql`SELECT * FROM roles WHERE id = ${role_id} AND user_id = ${user_id}`;
  if (!role) return c.json({ error: 'not_found' }, 404);

  const [{ cv_markdown, profile_yaml }] = await sql`
    SELECT
      (SELECT convert_from(decode(COALESCE(cv_text, ''), 'escape'), 'UTF8') AS cv_markdown FROM profiles WHERE user_id = ${user_id}),
      ${sql.unsafe("'{}'")} AS profile_yaml
  `.catch(() => [{ cv_markdown: '', profile_yaml: '{}' }]);

  // JD text: use the stored jd_text if present, else fetch from the url (TODO).
  const jd = role.jd_text || '';
  if (!jd) return c.json({ error: 'no_jd_text_cached', hint: 'POST /roles/:id/ingest-jd first' }, 400);

  const result = await evaluateRole({
    cvMarkdown: cv_markdown || '',
    profileYaml: profile_yaml || '{}',
    jobDescription: jd,
    roleTitle: role.title,
    company: role.company,
  });

  const [row] = await sql`
    INSERT INTO evaluations (role_id, user_id, score, report_md, machine_summary, model_used, tokens_in, tokens_out)
    VALUES (${role_id}, ${user_id}, ${result.score}, ${result.report_md}, ${sql.json(result.machine_summary)}, ${process.env.CLAUDE_DEFAULT_MODEL}, ${result.usage.input_tokens}, ${result.usage.output_tokens})
    RETURNING id, score
  `;
  await sql`UPDATE roles SET status = 'evaluated' WHERE id = ${role_id}`;
  audit(user_id, 'evaluate', { role_id, score: result.score });
  return c.json({ evaluation_id: row.id, score: row.score, report_md: result.report_md });
});

// ─── Tailor CV ────────────────────────────────────────────────────────────
app.post('/roles/:id/tailor', requireAuth, async (c) => {
  const user_id = c.get('user_id');
  const role_id = parseInt(c.req.param('id'), 10);
  const [role] = await sql`SELECT * FROM roles WHERE id = ${role_id} AND user_id = ${user_id}`;
  if (!role) return c.json({ error: 'not_found' }, 404);
  // CV markdown comes from Supabase Storage in v1; stubbed here.
  const cvMarkdown = c.req.query('_cv') || '# Stub CV\n\nPlug in storage fetch.';
  const { html, used_facts, usage } = await tailorCV({
    cvMarkdown, jobDescription: role.jd_text || '', roleTitle: role.title, company: role.company,
  });
  // v1: write html to Supabase Storage, render PDF via a worker. Here we return the HTML.
  const [row] = await sql`
    INSERT INTO cvs (role_id, user_id, html_path, pdf_path, fact_check)
    VALUES (${role_id}, ${user_id}, ${'inline'}, ${'pending'}, ${'pending'})
    RETURNING id
  `;
  audit(user_id, 'tailor', { role_id, used_facts, tokens: usage });
  return c.json({ cv_id: row.id, html, used_facts });
});

// ─── Draft answer ─────────────────────────────────────────────────────────
app.post('/roles/:id/answers', requireAuth, async (c) => {
  const user_id = c.get('user_id');
  const role_id = parseInt(c.req.param('id'), 10);
  const { question, char_hint } = await c.req.json();
  if (!question) return c.json({ error: 'question_required' }, 400);
  const [role] = await sql`SELECT * FROM roles WHERE id = ${role_id} AND user_id = ${user_id}`;
  if (!role) return c.json({ error: 'not_found' }, 404);

  // Reuse an existing answer for this question if the user already wrote one for a similar role.
  const qhash = createHash('sha256').update(question.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');
  const existing = await sql`SELECT id, answer FROM answers WHERE user_id = ${user_id} AND question_hash = ${qhash} ORDER BY updated_at DESC LIMIT 1`;
  if (existing.length) return c.json({ answer: existing[0].answer, source: 'reused', reused_from: existing[0].id });

  const cvMarkdown = c.req.query('_cv') || '# Stub CV';
  const { answer, usage } = await draftAnswer({ cvMarkdown, jobDescription: role.jd_text || '', question, charHint: char_hint ?? 1500 });

  const [row] = await sql`
    INSERT INTO answers (user_id, role_id, question, question_hash, answer, source, model_used)
    VALUES (${user_id}, ${role_id}, ${question}, ${qhash}, ${answer}, 'claude_draft', ${process.env.CLAUDE_DEFAULT_MODEL})
    RETURNING id
  `;
  audit(user_id, 'draft_answer', { role_id, question_hash: qhash, chars: answer.length, tokens: usage });
  return c.json({ answer_id: row.id, answer, source: 'drafted' });
});

// ─── Stage for extension ──────────────────────────────────────────────────
app.post('/roles/:id/stage', requireAuth, async (c) => {
  const user_id = c.get('user_id');
  const role_id = parseInt(c.req.param('id'), 10);
  const [role] = await sql`SELECT * FROM roles WHERE id = ${role_id} AND user_id = ${user_id}`;
  if (!role) return c.json({ error: 'not_found' }, 404);
  const [profile] = await sql`SELECT * FROM profiles WHERE user_id = ${user_id}`;
  const answers = await sql`SELECT question, answer FROM answers WHERE user_id = ${user_id} AND role_id = ${role_id}`;
  const [latestCv] = await sql`SELECT pdf_path FROM cvs WHERE role_id = ${role_id} AND user_id = ${user_id} ORDER BY created_at DESC LIMIT 1`;

  const payload = {
    role: { url: role.url, ats: role.ats, company: role.company, title: role.title },
    identity: {
      legal_name: profile?.legal_name,
      preferred_name: profile?.preferred_name,
      email: profile?.email,
      phone: profile?.phone,
      legal_address: profile?.legal_address,
      work_location: profile?.work_location,
      linkedin_url: profile?.linkedin_url,
      pronouns: profile?.pronouns,
    },
    screens: {
      authorized_to_work_us: profile?.authorized_to_work_us,
      needs_sponsorship: profile?.needs_sponsorship,
      clearance_eligible: profile?.clearance_eligible,
    },
    eeo: profile?.self_identification || {},
    answers: Object.fromEntries(answers.map((a) => [a.question, a.answer])),
    cv_pdf_url: latestCv?.pdf_path || null,
    attestations_blank: ['accuracy_certification', 'arbitration_agreement', 'ai_policy', 'demographic_consent'],
  };

  const [row] = await sql`
    INSERT INTO stage_payloads (user_id, role_id, payload)
    VALUES (${user_id}, ${role_id}, ${sql.json(payload)})
    RETURNING id, expires_at
  `;
  audit(user_id, 'stage', { role_id, payload_id: row.id });
  return c.json({ payload_id: row.id, expires_at: row.expires_at });
});

// ─── Lessons (for the extension) ─────────────────────────────────────────
app.get('/lessons/:ats', requireAuth, async (c) => {
  const ats = c.req.param('ats');
  const employer = c.req.query('employer') || null;
  const rows = await sql`
    SELECT ats, employer, trigger, rule, action, severity, evidence_url
    FROM lessons
    WHERE ats IN (${ats}, '*')
      AND (employer IS NULL OR employer = ${employer})
    ORDER BY severity DESC, confirmed_times DESC
  `;
  return c.json({ lessons: rows });
});

// ─── Boot ─────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '8787', 10);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[auto-reply] listening on :${info.port}`);
});
