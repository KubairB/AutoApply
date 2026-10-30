// Supabase JWT verification middleware. Verifies the Authorization: Bearer <jwt>
// header against Supabase's JWKS and attaches { user_id, email } to the context.
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS = createRemoteJWKSet(new URL(process.env.SUPABASE_JWKS_URL));

export async function requireAuth(c, next) {
  const h = c.req.header('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return c.json({ error: 'missing_bearer' }, 401);
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `${process.env.SUPABASE_URL}/auth/v1`,
    });
    c.set('user_id', payload.sub);
    c.set('email', payload.email);
    await next();
  } catch (e) {
    return c.json({ error: 'invalid_token', detail: e.message }, 401);
  }
}
