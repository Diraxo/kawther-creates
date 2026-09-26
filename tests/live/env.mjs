// Loads VITE_SUPABASE_* from process.env or .env (never printed, never written anywhere).
import { readFileSync, existsSync } from 'node:fs';
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}
export const URL_ = process.env.VITE_SUPABASE_URL;
export const KEY = process.env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set (.env). Live tests cannot run.');
  process.exit(2);
}
export const stamp = Date.now().toString(36);
export const testEmail = (tag) => `kc.test.${tag}.${stamp}@${process.env.TEST_EMAIL_DOMAIN || 'example.com'}`;
