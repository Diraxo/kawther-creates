// Movement journal (pure). A day's movement is ONE value on the check-in:
//   null                                   -> rest day
//   { type, duration, muscles, distance, steps, description }
// `duration` is whole minutes or null ("not recorded"). Every detail is optional, and only the details that belong to the
// type are ever kept: Gym -> muscles, Running -> distance (miles), Walking -> steps, Home workout / Other -> description.
// Nothing here invents a value: a missing detail stays missing and is shown as "not recorded".
export const MOVEMENT_TYPES = ['Gym', 'Running', 'Walking', 'Home workout', 'Other'];
export const MOVEMENT_LABELS = { Gym: 'Gym', Running: 'Running', Walking: 'Walking', 'Home workout': 'Home Workout', Other: 'Other' };
export const MUSCLE_SUGGESTIONS = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Legs', 'Glutes', 'Core', 'Full Body'];

export const MAX_DURATION_MINUTES = 1440;
export const MAX_MUSCLES = 12;
export const MAX_MUSCLE_LENGTH = 40;
export const MAX_DESCRIPTION = 500;
export const MAX_DISTANCE_MI = 1000;
export const MAX_STEPS = 200000;

const KEEPS = { Gym: 'muscles', Running: 'distance', Walking: 'steps', 'Home workout': 'description', Other: 'description' };

/** Legacy or unknown type strings still render; they just carry no type-specific details. */
export const movementLabel = (type) => MOVEMENT_LABELS[type] || String(type || '');

// ---------- duration ----------
export const splitMinutes = (total) => (total == null ? { hours: '', minutes: '' } : { hours: total >= 60 ? String(Math.floor(total / 60)) : '', minutes: total % 60 ? String(total % 60) : '' });

/** Hours + minutes text -> { ok, minutes } (null = left empty / zero = not recorded) | { ok:false, error, field }. */
export function parseDuration(hoursRaw, minutesRaw) {
  const h = String(hoursRaw ?? '').trim();
  const m = String(minutesRaw ?? '').trim();
  if (h !== '' && !/^\d{1,2}$/.test(h)) return { ok: false, field: 'hours', error: 'Use whole hours, like 1.' };
  if (m !== '' && !/^\d{1,3}$/.test(m)) return { ok: false, field: 'minutes', error: 'Use whole minutes, like 45.' };
  const hours = h === '' ? 0 : Number(h);
  const mins = m === '' ? 0 : Number(m);
  if (mins > 59) return { ok: false, field: 'minutes', error: 'Minutes go from 0 to 59.' };
  const total = hours * 60 + mins;
  if (total > MAX_DURATION_MINUTES) return { ok: false, field: 'hours', error: 'That is more than 24 hours.' };
  return { ok: true, minutes: total === 0 ? null : total };
}

/** 45 -> "45 min", 60 -> "1 hr", 70 -> "1 hr 10 min", null -> "". */
export function formatDuration(total) {
  if (total == null) return '';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// ---------- distance / steps ----------
/** Miles, decimals allowed (up to 2 places). Empty = not recorded. */
export function parseDistance(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (s === '') return { ok: true, value: null };
  if (!/^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(s)) return { ok: false, error: 'Use miles like 3 or 5.2.' };
  const value = Number(s);
  if (value > MAX_DISTANCE_MI) return { ok: false, error: 'That distance looks too long.' };
  return { ok: true, value: value === 0 ? null : value };
}

/** Whole steps; commas/spaces from the keyboard ("6,420") are fine. Empty = not recorded. */
export function parseSteps(raw) {
  const s = String(raw ?? '').trim().replace(/[,\s]/g, '');
  if (s === '') return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: 'Use whole steps, like 6420.' };
  const value = Number(s);
  if (value > MAX_STEPS) return { ok: false, error: 'That step count looks too high.' };
  return { ok: true, value: value === 0 ? null : value };
}

export const formatDistance = (mi) => (mi == null ? '' : `${Number(mi)} ${Number(mi) === 1 ? 'mile' : 'miles'}`);
export const formatSteps = (n) => (n == null ? '' : `${Number(n).toLocaleString('en-US')} ${Number(n) === 1 ? 'step' : 'steps'}`);

// ---------- normalising ----------
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Trim, drop empties, de-duplicate (case-insensitively), cap the count and the length. */
export function cleanMuscles(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const name = cleanText(raw, MAX_MUSCLE_LENGTH);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_MUSCLES) break;
  }
  return out;
}

/**
 * The one canonical movement shape. Type-incompatible details are DROPPED (switching Gym -> Running never leaves
 * "Chest" behind), and a legacy / partial object (no muscles, no unit ...) is filled with "not recorded" defaults.
 */
export function normalizeExercise(ex) {
  if (!ex || !ex.type) return null;
  const keeps = KEEPS[ex.type];
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    type: ex.type,
    duration: num(ex.duration) > 0 ? Math.round(num(ex.duration)) : null,
    muscles: keeps === 'muscles' ? cleanMuscles(ex.muscles) : [],
    distance: keeps === 'distance' && num(ex.distance) > 0 ? num(ex.distance) : null,
    steps: keeps === 'steps' && num(ex.steps) > 0 ? Math.round(num(ex.steps)) : null,
    description: keeps === 'description' ? cleanText(ex.description, MAX_DESCRIPTION) : '',
  };
}

/**
 * The form's raw values -> { ok:true, exercise } | { ok:false, errors:{ duration?, distance?, steps?, description? } }.
 * Blank optional fields are NOT errors.
 */
export function buildExercise(f) {
  if (!f || !f.type) return { ok: true, exercise: null };
  const errors = {};
  const dur = parseDuration(f.hours, f.minutes);
  if (!dur.ok) errors.duration = dur.error;
  const keeps = KEEPS[f.type];
  const dist = keeps === 'distance' ? parseDistance(f.distance) : { ok: true, value: null };
  if (!dist.ok) errors.distance = dist.error;
  const steps = keeps === 'steps' ? parseSteps(f.steps) : { ok: true, value: null };
  if (!steps.ok) errors.steps = steps.error;
  if (keeps === 'description' && String(f.description ?? '').trim().length > MAX_DESCRIPTION) errors.description = `Keep it under ${MAX_DESCRIPTION} characters.`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    exercise: normalizeExercise({ type: f.type, duration: dur.minutes, muscles: f.muscles, distance: dist.value, steps: steps.value, description: f.description }),
  };
}

// ---------- display ----------
/** The type-specific detail as one line ("Chest · Biceps", "5.2 miles", "6,420 steps", "Abs + cardio"), or ''. */
export function movementDetail(ex) {
  if (!ex) return '';
  switch (KEEPS[ex.type]) {
    case 'muscles': return (ex.muscles || []).join(' · ');
    case 'distance': return formatDistance(ex.distance);
    case 'steps': return formatSteps(ex.steps);
    case 'description': return ex.description || '';
    default: return '';
  }
}

/** What is missing, said plainly, for the day-detail of a check-in that recorded only the type. */
export function missingDetails(ex) {
  if (!ex) return [];
  const out = [];
  if (ex.duration == null) out.push('Duration not recorded');
  switch (KEEPS[ex.type]) {
    case 'muscles': if (!(ex.muscles || []).length) out.push('Muscle groups not recorded'); break;
    case 'distance': if (ex.distance == null) out.push('Distance not recorded'); break;
    case 'steps': if (ex.steps == null) out.push('Steps not recorded'); break;
    case 'description': if (!ex.description) out.push('Details not recorded'); break;
    default: break;
  }
  return out;
}

/** "Gym · 1 hr 10 min" (Home card, completion sheet). Only what was recorded: the type alone is just "Gym". */
export function formatExercise(ex) {
  if (!ex) return '';
  return [movementLabel(ex.type), formatDuration(ex.duration)].filter(Boolean).join(' · ');
}
