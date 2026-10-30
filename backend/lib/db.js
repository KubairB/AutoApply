// Postgres connection via `postgres` driver. One pool per process.
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

export const sql = postgres(url, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false,  // Supabase pgbouncer transaction mode doesn't support prepared statements
});

// Convenience: write an audit row. Fire-and-forget; never block the request on this.
export function audit(user_id, action, details = {}) {
  sql`INSERT INTO audit_log (user_id, action, details) VALUES (${user_id}, ${action}, ${sql.json(details)})`
    .catch((e) => console.error('[audit]', action, e.message));
}
