// Thin Anthropic wrapper for the two product-shaped calls: CV tailoring and answer drafting.
// Model defaults from .env; override per call via `model` arg.
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT = process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-5';
const TAILOR  = process.env.CLAUDE_TAILOR_MODEL  || 'claude-opus-5';

// ─── CV tailoring ────────────────────────────────────────────────────────
// Returns {html: string, used_facts: string[]}. The caller runs the fact-check
// against sources before writing the PDF — same contract as `verify-cv-facts.mjs`.
export async function tailorCV({ cvMarkdown, jobDescription, roleTitle, company, model = TAILOR }) {
  const sys = `You are tailoring a CV for a specific role. You will be given the candidate's canonical CV (markdown) and the job description.

HARD RULES:
- Reorder, reframe, and emphasise facts from the canonical CV. NEVER invent facts, numbers, company names, titles, dates, metrics or scope that the canonical CV does not contain.
- You may rewrite the Professional Summary and Core Competencies freely as long as every claim traces to a bullet in the canonical CV.
- Keep the Work Experience bullets verbatim or lightly reworded. Do not add new bullets. Do not change numbers.
- If the posting asks for an experience the CV does not evidence, do not add it.
- Return a valid HTML document that follows the template shape the caller provides (summary div, competencies grid, work experience as-is).

OUTPUT: a JSON object with two keys. "html" is the complete tailored CV HTML. "used_facts" is an array of short strings naming each cv.md bullet or number you drew on (so a downstream fact-check can verify every claim traces to the source).`;

  const user = `# Canonical CV\n\n${cvMarkdown}\n\n---\n\n# Job description\n\nCompany: ${company}\nTitle: ${roleTitle}\n\n${jobDescription}\n\n---\n\nReturn the JSON only, no prose.`;

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 8000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const text = resp.content.map((b) => b.type === 'text' ? b.text : '').join('');
  const parsed = JSON.parse(text.replace(/^```json\n?|\n?```$/g, ''));
  return { html: parsed.html, used_facts: parsed.used_facts || [], usage: resp.usage };
}

// ─── Answer drafting ─────────────────────────────────────────────────────
// Returns {answer: string}. The caller writes it to the answers table BEFORE
// any form staging — the vault is source of truth.
export async function draftAnswer({ cvMarkdown, jobDescription, question, charHint = 1500, model = DEFAULT }) {
  const sys = `You are drafting an application-form answer. Rules:
- Every quantified claim must trace to the canonical CV. Never invent.
- Match the length hint (${charHint} chars) within ±25%.
- Honest voice. If the posting asks for a credential the candidate lacks, state it plainly and pivot to what they do have.
- No corporate buzzwords. No ChatGPT openers ("I'm excited to..."). Start with the point.
- Return ONLY the answer text. No preamble, no sign-off.`;

  const user = `# Canonical CV\n\n${cvMarkdown}\n\n# Job description\n\n${jobDescription}\n\n# Question\n\n${question}`;

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 2000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const answer = resp.content.map((b) => b.type === 'text' ? b.text : '').join('').trim();
  return { answer, usage: resp.usage };
}

// ─── Evaluation (Blocks A–F) ─────────────────────────────────────────────
// Returns {score, report_md, machine_summary}. Deterministic structure so the
// frontend can render consistently.
export async function evaluateRole({ cvMarkdown, profileYaml, jobDescription, roleTitle, company, model = DEFAULT }) {
  const sys = `You score a job posting against a candidate's record using Blocks A through F. Output format is strict:

## Block A — Role Fit (x/5)
[2-3 paragraph assessment with specific requirement-level matches/misses]

## Block B — Experience Bar (x/5)
[tenure analysis]

## Block C — Company (x/5)
## Block D — Comp (x/5)
## Block E — Location (x/5)
## Block F — Trajectory (x/5)

## Risk Summary
[bullet list]

## Machine Summary
\`\`\`yaml
score: <average, rounded to 1 decimal>
years_bar: <int or null>
clears_bar: <bool>
advertised_comp: <string or null>
decision: <'apply'|'apply-with-reservations'|'skip'>
converting_attributes: [...]
gaps: [...]
\`\`\`

HARD RULES: never invent credentials for the candidate. If a required credential is unstated in the CV, mark it as a gap. Comp claims that are OTE must be noted (OTE 80/20 means base is 80% of the range).`;

  const user = `# Candidate CV\n\n${cvMarkdown}\n\n# Candidate profile\n\n${profileYaml}\n\n# Job\n\nCompany: ${company}\nTitle: ${roleTitle}\n\n${jobDescription}`;

  const resp = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });

  const report_md = resp.content.map((b) => b.type === 'text' ? b.text : '').join('');
  const yamlMatch = report_md.match(/```yaml\n([\s\S]*?)\n```/);
  const machine_summary = yamlMatch ? parseSimpleYaml(yamlMatch[1]) : {};
  const score = parseFloat(machine_summary.score ?? 0);
  return { score, report_md, machine_summary, usage: resp.usage };
}

// Minimal yaml-ish parser for the Machine Summary block. Keep it tight — the model
// is instructed to produce a flat shape with scalars and short arrays.
function parseSimpleYaml(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const [, k, raw] = m;
    const v = raw.trim();
    if (v === 'null') out[k] = null;
    else if (v === 'true') out[k] = true;
    else if (v === 'false') out[k] = false;
    else if (/^-?\d+(\.\d+)?$/.test(v)) out[k] = parseFloat(v);
    else if (v.startsWith('[') && v.endsWith(']')) out[k] = v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    else out[k] = v.replace(/^['"]|['"]$/g, '');
  }
  return out;
}
