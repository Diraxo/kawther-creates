// Probe: does the live project have the exercise_unit column yet? (prints only yes/no)
import { URL_, KEY, testEmail } from './env.mjs';
import { SupabaseRepository } from '../../src/data/supabaseRepository.js';
const r = new SupabaseRepository({ url: URL_, anonKey: KEY });
await r.signUp({ name: 'Probe', email: testEmail('probe'), password: 'Test-pass-12345' });
const { error } = await r.sb.from('checkins').select('exercise_unit').limit(1);
console.log(error ? 'exercise_unit column: MISSING (' + error.message + ')' : 'exercise_unit column: present');
await r.signOut();
