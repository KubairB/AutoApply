-- Auto-Reply schema. Run against Supabase (or any Postgres 15+).
-- Row-level security is on by default; policies restrict every table to the owning user.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── Profiles ─────────────────────────────────────────────────────────────
CREATE TABLE profiles (
    user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    legal_name          TEXT NOT NULL,
    preferred_name      TEXT,
    email               TEXT NOT NULL,
    phone               TEXT,
    legal_address       TEXT,
    work_location       TEXT,                     -- what the user tells employers (may differ from legal_address)
    linkedin_url        TEXT,
    pronouns            TEXT,
    self_identification JSONB DEFAULT '{}'::jsonb,-- {sex, race_self_described, race_us_eeo_category, hispanic_or_latino, veteran_status, disability_status}
    compensation_floor  INTEGER,                  -- USD, annual base
    office_preference   TEXT,                     -- 'New York', 'San Francisco', 'Remote'
    authorized_to_work_us  BOOLEAN,
    needs_sponsorship      BOOLEAN,
    clearance_eligible     BOOLEAN,
    target_roles        TEXT[],                   -- ['Product Manager', 'Deployment Strategist', ...]
    excluded_companies  TEXT[],
    cv_storage_path     TEXT,                     -- supabase storage key for cv.md
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_owner ON profiles FOR ALL USING (auth.uid() = user_id);

-- ─── Roles (sweep results, one per candidate) ─────────────────────────────
CREATE TABLE roles (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    ats             TEXT NOT NULL,                -- 'greenhouse', 'ashby', 'lever', 'workday'
    company         TEXT NOT NULL,
    title           TEXT NOT NULL,
    location        TEXT,
    posted_date     DATE,
    band_low        INTEGER,                      -- USD annual
    band_high       INTEGER,
    band_is_ote     BOOLEAN DEFAULT false,        -- important for comp-floor comparisons
    years_bar       INTEGER,                      -- null = none stated
    jd_text         TEXT,                         -- archived JD body
    flags           TEXT[],                       -- ['prior_application', 'cap_reached', 'ote_below_gate', 'coding_gate']
    status          TEXT NOT NULL DEFAULT 'candidate',  -- 'candidate', 'skipped', 'evaluated', 'cv_tailored', 'staged', 'applied', 'rejected', 'offer'
    swept_at        TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, url)
);
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY roles_owner ON roles FOR ALL USING (auth.uid() = user_id);
CREATE INDEX roles_user_status_idx ON roles (user_id, status);

-- ─── Evaluations (Blocks A–F reports) ─────────────────────────────────────
CREATE TABLE evaluations (
    id              BIGSERIAL PRIMARY KEY,
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    score           NUMERIC(2,1) NOT NULL,
    report_md       TEXT NOT NULL,                -- full Blocks A–F markdown
    machine_summary JSONB,                        -- the yaml at the end, parsed
    model_used      TEXT NOT NULL,
    tokens_in       INTEGER,
    tokens_out      INTEGER,
    created_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE evaluations ENABLE ROW LEVEL SECURITY;
CREATE POLICY evaluations_owner ON evaluations FOR ALL USING (auth.uid() = user_id);

-- ─── CVs (tailored outputs) ───────────────────────────────────────────────
CREATE TABLE cvs (
    id              BIGSERIAL PRIMARY KEY,
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    html_path       TEXT NOT NULL,                -- supabase storage key
    pdf_path        TEXT NOT NULL,
    fact_check      TEXT NOT NULL,                -- 'passed', 'failed'
    fact_check_errors TEXT[],
    created_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE cvs ENABLE ROW LEVEL SECURITY;
CREATE POLICY cvs_owner ON cvs FOR ALL USING (auth.uid() = user_id);

-- ─── Answers (long-form answer vault, crash-safe) ─────────────────────────
CREATE TABLE answers (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id         BIGINT REFERENCES roles(id) ON DELETE SET NULL,
    question        TEXT NOT NULL,
    question_hash   TEXT NOT NULL,                -- sha256 of normalised question, for de-dup/reuse
    answer          TEXT NOT NULL,
    source          TEXT NOT NULL,                -- 'user', 'claude_draft', 'claude_refined'
    model_used      TEXT,
    char_count      INTEGER GENERATED ALWAYS AS (length(answer)) STORED,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY answers_owner ON answers FOR ALL USING (auth.uid() = user_id);
CREATE INDEX answers_user_hash_idx ON answers (user_id, question_hash);

-- ─── Applications (submission status + follow-ups) ────────────────────────
CREATE TABLE applications (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'staged', -- 'staged', 'applied', 'responded', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'
    submitted_at    TIMESTAMPTZ,
    follow_up_due   DATE,
    notes           TEXT,
    updated_at      TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;
CREATE POLICY applications_owner ON applications FOR ALL USING (auth.uid() = user_id);
CREATE INDEX applications_user_status_idx ON applications (user_id, status);

-- ─── Lessons (shared knowledge base — the moat) ───────────────────────────
-- Not user-scoped: lessons learned from one user's forms help every user. Read-only
-- for everyone; writes come from the backend's learn-from-failure job.
CREATE TABLE lessons (
    id              BIGSERIAL PRIMARY KEY,
    ats             TEXT NOT NULL,                -- 'greenhouse', 'ashby', 'lever', 'workday', '*'
    employer        TEXT,                         -- null = all employers on this ATS
    trigger         JSONB NOT NULL,               -- {kind: 'field_present', field: 'phone'} etc.
    rule            TEXT NOT NULL,                -- human-readable
    action          JSONB,                        -- what to do when trigger matches
    severity        TEXT NOT NULL DEFAULT 'warn', -- 'warn', 'block', 'flag'
    evidence_url    TEXT,                         -- the posting that proved it
    confirmed_times INTEGER DEFAULT 1,
    learned_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX lessons_ats_idx ON lessons (ats, employer);
-- No RLS: lessons are shared knowledge. The backend writes via service role.

CREATE TABLE lessons_triggered (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    lesson_id       BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    outcome         TEXT NOT NULL,                -- 'applied_rule', 'ignored', 'blocked_submit'
    triggered_at    TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE lessons_triggered ENABLE ROW LEVEL SECURITY;
CREATE POLICY lessons_triggered_owner ON lessons_triggered FOR SELECT USING (auth.uid() = user_id);

-- ─── Stage payloads (short-lived, consumed by the extension) ──────────────
CREATE TABLE stage_payloads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role_id         BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    payload         JSONB NOT NULL,               -- {fields: {...}, attestations_blank: [...], cv_pdf_url, cv_pdf_sha256}
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '2 hours'),
    consumed_at    TIMESTAMPTZ
);
ALTER TABLE stage_payloads ENABLE ROW LEVEL SECURITY;
CREATE POLICY stage_payloads_owner ON stage_payloads FOR ALL USING (auth.uid() = user_id);
CREATE INDEX stage_payloads_expiry_idx ON stage_payloads (expires_at) WHERE consumed_at IS NULL;

-- ─── Audit log (what the system did on the user's behalf) ─────────────────
CREATE TABLE audit_log (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    action          TEXT NOT NULL,                -- 'sweep', 'evaluate', 'tailor', 'draft_answer', 'stage', 'extension_submit'
    details         JSONB,
    at              TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_owner ON audit_log FOR SELECT USING (auth.uid() = user_id);

-- ─── Updated-at triggers ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER touch_profiles_updated BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_answers_updated  BEFORE UPDATE ON answers  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER touch_applications_updated BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
