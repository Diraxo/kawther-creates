// Shared PGlite harness: a real Postgres (in-process WASM) with a Supabase-style auth stub, so SQL security properties
// (grants, RLS, RPC behaviour) are tested against actual Postgres semantics. The hosted project is covered by tests/live/.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

export const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

export const STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb,
    encrypted_password text, last_sign_in_at timestamptz, recovery_sent_at timestamptz);
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade);
  create table auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid not null, status text not null default 'unverified');
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable
    as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
`;

/** A fresh database with the Supabase auth stub and the given SQL files applied, in order. */
export async function makeDb(sqlFiles) {
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of sqlFiles) await db.exec(read(f));
  await db.exec('grant usage on schema public to anon, authenticated;');
  return db;
}

export const uuid = (n) => { const h = n.toString(16).padStart(2, '0'); const seg = (len) => h.repeat(len).slice(0, len); return `${seg(8)}-${seg(4)}-4${seg(3)}-8${seg(3)}-${seg(12)}`; };

export function harness(db) {
  /** Runs fn as a Supabase user (null = anon). `claims` are extra JWT claims, e.g. { aal: 'aal2' }. Always resets the role. */
  async function as(uid, fn, claims = {}) {
    await db.exec(uid
      ? `set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false); select set_config('request.jwt.claims', '${JSON.stringify({ sub: uid, ...claims })}', false);`
      : `set role anon; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '', false);`);
    try { return await fn(); } finally {
      await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claims', '', false);`);
    }
  }
  const addUser = (id, name = 'User') => db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${id}', '${id.slice(0, 4)}@x.test', '{"full_name":"${name}"}')`);
  const day = (n = 0) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const payload = (over = {}) => ({
    mood: 'good', weight_kg: 70.5, water_ml: 2000, exercise_type: 'Gym', exercise_minutes: 30, notes: 'n',
    meals: [{ category: 'breakfast', name: 'Eggs', notes: '', eaten_at: '08:30', position: 0 }],
    ...over,
  });
  const save = (uid, date, p) => as(uid, () => db.query('select public.save_checkin($1::date, $2::jsonb) as r', [date, JSON.stringify(p)])).then((r) => r.rows[0].r);
  const journey = (uid, over = {}) => {
    const a = { start: day(-1), dur: 60, sw: 72, gw: 62, water: 2500, ...over };
    return as(uid, () => db.query('select public.create_journey($1::date, $2, $3, $4, $5) as r', [a.start, a.dur, a.sw, a.gw, a.water])).then((r) => r.rows[0].r);
  };
  const resetLimits = () => db.exec('truncate private.rate_events');
  const one = async (sql, args) => (await db.query(sql, args)).rows[0];
  return { as, addUser, day, payload, save, journey, resetLimits, one };
}
